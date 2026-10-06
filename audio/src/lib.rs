//! Procedural room audio. All sound is synthesised with fundsp; no samples.
//! Raw wasm exports (no wasm-bindgen); see docs/AUDIO.md for the contract.
//! Single-threaded: the AudioWorklet owns the one instance.

use fundsp::prelude32::*;

const MAX_FRAMES: usize = 4096;
const MAX_VOICES: usize = 24;
const TAU: f32 = core::f32::consts::TAU;

type Unit = Box<dyn AudioUnit>;

/// Loudness ceiling of the soft limiter (linear, about -4.4 dBFS): output never exceeds it.
const CEILING: f32 = 0.6;
/// Level range of the one-shot velocity curve: velocity 0 is this many dB below velocity 1.
const VEL_RANGE_DB: f32 = 36.0;
/// Impact brightness: lowpass cutoff runs exponentially from LP_MIN (v = 0) to LP_MAX (v = 1).
const LP_MIN: f32 = 500.0;
const LP_MAX: f32 = 16000.0;
/// Velocity used by the legacy `audio_event` (no velocity argument): -7 dB, a firm but not hard touch.
const DEFAULT_VELOCITY: f32 = 0.8;
/// Time constant of the elevator speed smoothing (seconds).
const SPEED_TAU: f32 = 0.3;
/// Parked hum level (linear, about -34 dB below full speed).
const PARKED: f32 = 0.02;

/// One-shot velocity (0..1) to linear gain: dB-linear, 0 dB at 1 and -VEL_RANGE_DB at 0.
fn vel_gain(v: f32) -> f32 {
    10f32.powf(-VEL_RANGE_DB * (1.0 - v) / 20.0)
}
/// Impact velocity to lowpass cutoff in Hz.
fn vel_cutoff(v: f32) -> f32 {
    LP_MIN * (LP_MAX / LP_MIN).powf(v)
}
/// Elevator smoothed speed (0..1) to hum level: roughly speed^1.5 over a faint parked hum.
fn elev_level(s: f32) -> f32 {
    PARKED + (1.0 - PARKED) * s * s.sqrt()
}
fn clamp01(x: f32, default: f32) -> f32 {
    if x.is_finite() { x.clamp(0.0, 1.0) } else { default }
}

#[derive(Clone, Copy)]
enum Kind {
    FloorPass,
    Ding,
    Grab,
    Place,
    PaperTurn,
    Open,
    Close,
    Scroll,
}

fn kind_from(k: u32) -> Option<Kind> {
    Some(match k {
        0 => Kind::FloorPass,
        1 => Kind::Ding,
        2 => Kind::Grab,
        3 => Kind::Place,
        4 => Kind::PaperTurn,
        5 => Kind::Open,
        6 => Kind::Close,
        7 => Kind::Scroll,
        _ => return None,
    })
}

struct Voice {
    parts: Vec<Unit>,
    age: u32,
    len: u32,
    gain: f32,
    gl: f32,
    gr: f32,
    /// one-pole lowpass coefficient (impact brightness) and its two states
    lp: f32,
    z1: f32,
    z2: f32,
}

struct Part {
    parts: Vec<Unit>,
    secs: f32,
}

struct Builder {
    sr: f64,
    seed: u64,
}

impl Builder {
    fn finish(&mut self, mut u: Unit) -> Unit {
        self.seed = self.seed.wrapping_add(0x9E37_79B9_7F4A_7C15);
        u.ping(false, AttoHash::new(self.seed));
        u.set_sample_rate(self.sr);
        u
    }

    /// Exponentially decaying sine (one mode of a bell or a wooden body).
    fn mode(&mut self, f: f32, amp: f32, decay: f32) -> Unit {
        let u = sine_hz(f) * envelope(move |t: f32| amp * (-t * decay).exp());
        self.finish(Box::new(u))
    }

    /// Band-passed noise: attack ramp, exponential decay, optional flutter.
    #[allow(clippy::too_many_arguments)]
    fn noise(&mut self, fc: f32, q: f32, amp: f32, atk: f32, decay: f32, flutter_hz: f32, flutter: f32) -> Unit {
        let u = (white() >> bandpass_hz(fc, q))
            * envelope(move |t: f32| {
                let a = (t / atk).min(1.0);
                let fl = 1.0 - flutter * (0.5 + 0.5 * (TAU * flutter_hz * t + 1.7 * (TAU * 3.1 * t).sin()).sin());
                amp * a * (-t * decay).exp() * fl
            });
        self.finish(Box::new(u))
    }

    fn lowpassed_noise(&mut self, fc: f32, amp: f32, decay: f32) -> Unit {
        let u = (white() >> lowpass_hz(fc, 0.7)) * envelope(move |t: f32| amp * (-t * decay).exp());
        self.finish(Box::new(u))
    }
}

fn build(b: &mut Builder, kind: Kind, i: f32) -> Part {
    match kind {
        // Bell ding: inharmonic partials of a small hotel bell, about A5.
        Kind::Ding => Part {
            parts: vec![
                b.mode(880.0, 0.50, 2.6),
                b.mode(880.0 * 2.76, 0.22, 4.2),
                b.mode(880.0 * 5.40, 0.10, 7.5),
                b.mode(880.0 * 8.93, 0.04, 12.0),
                b.mode(881.7, 0.30, 2.9), // slow beating pair
            ],
            secs: 2.2,
        },
        // Passing a floor: a faint ratchet tick plus a short air whoosh.
        Kind::FloorPass => Part {
            parts: vec![b.noise(900.0, 1.2, 0.35, 0.01, 12.0, 0.0, 0.0), b.mode(110.0, 0.30, 22.0)],
            secs: 0.45,
        },
        // Book grab: cloth/cardboard scrape with irregular amplitude chatter.
        Kind::Grab => Part {
            parts: vec![
                b.noise(1900.0, 0.6, 0.75, 0.03, 6.0, 31.0, 0.55),
                b.noise(520.0, 0.9, 0.5, 0.02, 9.0, 17.0, 0.4),
            ],
            secs: 0.6,
        },
        // Set down on wood: modal thump. Heavier (intensity up) means a bigger body, lower pitch.
        Kind::Place => {
            let f0 = 210.0 - 130.0 * i;
            Part {
                parts: vec![
                    b.mode(f0, 0.85, 26.0 - 10.0 * i),
                    b.mode(f0 * 2.32, 0.40, 38.0),
                    b.mode(f0 * 4.25, 0.20, 60.0),
                    b.mode(f0 * 6.63, 0.09, 90.0),
                    b.lowpassed_noise(1400.0, 0.5, 70.0),
                ],
                secs: 0.9,
            }
        }
        Kind::PaperTurn => Part {
            parts: vec![
                b.noise(3800.0, 0.7, 0.7, 0.02, 7.0, 24.0, 0.7),
                b.noise(7000.0, 1.0, 0.25, 0.01, 9.0, 37.0, 0.8),
            ],
            secs: 0.5,
        },
        // Opening a piece: cover scrape, then a page whisper.
        Kind::Open => Part {
            parts: vec![
                b.noise(1500.0, 0.6, 0.55, 0.05, 5.0, 19.0, 0.5),
                b.noise(4200.0, 0.7, 0.4, 0.15, 6.0, 26.0, 0.6),
                b.mode(150.0, 0.25, 30.0),
            ],
            secs: 0.8,
        },
        // Fast scroll or page flick: a short dry rustle (loudness and brightness come from velocity).
        Kind::Scroll => Part {
            parts: vec![b.noise(5200.0, 0.8, 0.5, 0.01, 16.0, 40.0, 0.8), b.noise(2400.0, 0.7, 0.3, 0.02, 14.0, 23.0, 0.6)],
            secs: 0.3,
        },
        Kind::Close => Part {
            parts: vec![
                b.mode(130.0, 0.5, 32.0),
                b.mode(130.0 * 2.32, 0.2, 48.0),
                b.noise(2600.0, 0.7, 0.4, 0.02, 14.0, 0.0, 0.0),
                b.lowpassed_noise(1000.0, 0.3, 60.0),
            ],
            secs: 0.6,
        },
    }
}

struct Elevator {
    pitch: Shared,
    level: Shared,
    rattle: Shared,
    unit: Unit,
}

impl Elevator {
    fn new(b: &mut Builder) -> Self {
        let pitch = shared(34.0);
        let level = shared(0.0);
        let rattle = shared(0.0);
        let f = || var(&pitch) >> follow(0.25);
        let hum = (f() >> sine()) * 0.55
            + ((f() * 2.0) >> sine()) * 0.28
            + ((f() * 3.0) >> saw() >> lowpass_hz(170.0, 0.7)) * 0.10
            + ((f() * 0.5) >> sine()) * 0.30;
        let gain = var(&level) >> follow(0.35);
        // cable and car rattle: low rumble plus band-passed ticking
        let rumble = (brown() >> lowpass_hz(260.0, 0.7)) * 5.0;
        let tick = (white() >> bandpass_hz(820.0, 1.4))
            * envelope(|t: f32| 0.5 + 0.5 * (TAU * 6.3 * t + 2.0 * (TAU * 0.7 * t).sin()).sin().max(0.0));
        let rat = (var(&rattle) >> follow(0.4)) * (rumble * 0.5 + tick * 0.35);
        let unit: Unit = b.finish(Box::new((hum * gain) + rat));
        Self { pitch, level, rattle, unit }
    }
}

pub struct Synth {
    sr: f64,
    b: Builder,
    voices: Vec<Voice>,
    elev: Elevator,
    reverb: Unit,
    wet: f32,
    scale: f32,
    master: f32,
    master_target: f32,
    last_speed: f32,
    last_floor: i32,
    speed_target: f32,
    speed_sm: f32,
    speed_k: f32,
    floor_off: f32,
    /// Test-only planted bug: bypasses every velocity curve (flat gain, no brightness, no duration change).
    flat: bool,
    left: Vec<f32>,
    right: Vec<f32>,
}

fn make_reverb(b: &mut Builder, w: f32, d: f32, h: f32) -> Unit {
    let v = (w * d * h).max(1.0);
    let s = 2.0 * (w * d + w * h + d * h);
    // Sabine RT60 with a mean absorption of 0.3
    let rt60 = (0.161 * v / (0.30 * s.max(1.0))).clamp(0.3, 2.5);
    let size = (v.cbrt() * 2.0).clamp(10.0, 60.0);
    b.finish(Box::new(reverb_stereo(size, rt60, 0.6)))
}

impl Synth {
    fn new(sr: f64) -> Self {
        let mut b = Builder { sr, seed: 1 };
        let elev = Elevator::new(&mut b);
        let reverb = make_reverb(&mut b, 6.0, 8.0, 3.0);
        Self {
            sr,
            b,
            voices: Vec::new(),
            elev,
            reverb,
            wet: 0.22,
            scale: 1.0,
            master: 0.0,
            master_target: 0.0,
            last_speed: 0.0,
            last_floor: 0,
            speed_target: 0.0,
            speed_sm: 0.0,
            floor_off: 0.0,
            speed_k: 1.0 - (-1.0 / (SPEED_TAU * sr as f32)).exp(),
            flat: false,
            left: vec![0.0; MAX_FRAMES],
            right: vec![0.0; MAX_FRAMES],
        }
    }

    fn event(&mut self, kind: Kind, intensity: f32, pan: f32, velocity: f32) {
        let i = clamp01(intensity, 0.5);
        let v = if self.flat { 1.0 } else { clamp01(velocity, DEFAULT_VELOCITY) };
        let part = build(&mut self.b, kind, i);
        let kind_gain = match kind {
            Kind::Ding => 0.55,
            Kind::FloorPass => 0.5,
            _ => 1.0,
        };
        let p = if pan.is_finite() { pan.clamp(-1.0, 1.0) } else { 0.0 };
        let ang = (p + 1.0) * 0.25 * core::f32::consts::PI;
        if self.voices.len() >= MAX_VOICES {
            self.voices.remove(0);
        }
        // Soft hits are shorter as well as quieter and duller.
        let dur = if self.flat { 1.0 } else { 0.5 + 0.5 * v };
        let lp = if self.flat { 1.0 } else { 1.0 - (-TAU * vel_cutoff(v) / self.sr as f32).exp() };
        self.voices.push(Voice {
            parts: part.parts,
            age: 0,
            len: (part.secs * dur * self.sr as f32) as u32,
            gain: kind_gain * (0.25 + 0.75 * i) * if self.flat { 1.0 } else { vel_gain(v) },
            gl: ang.cos(),
            gr: ang.sin(),
            lp,
            z1: 0.0,
            z2: 0.0,
        });
    }

    /// `speed` is normalised 0..1 (|speed| / max speed). Auto-fires floorPass and the arrival ding.
    fn set_elevator(&mut self, speed: f32, floor: i32) {
        let s = if speed.is_finite() { speed.abs().clamp(0.0, 1.0) } else { 0.0 };
        self.speed_target = s;
        self.floor_off = 0.4 * floor.rem_euclid(8) as f32;
        if floor != self.last_floor && s > 0.05 {
            self.event(Kind::FloorPass, 0.4 + 0.4 * s, 0.0, s);
        }
        if self.last_speed > 0.05 && s <= 0.02 {
            self.event(Kind::Ding, 0.8, 0.0, 0.8);
        }
        self.last_speed = s;
        self.last_floor = floor;
    }

    fn render(&mut self, n: usize) {
        let n = Ord::min(n, MAX_FRAMES);
        let k = 0.0015_f32; // master smoothing, about 15 ms
        for j in 0..n {
            // smoothed speed drives pitch, level and rattle: no step at start or stop
            self.speed_sm += (self.speed_target - self.speed_sm) * self.speed_k;
            let sm = self.speed_sm;
            self.elev.pitch.set(30.0 + 34.0 * sm + self.floor_off);
            if self.flat {
                self.elev.level.set(1.0);
                self.elev.rattle.set(1.0);
            } else {
                self.elev.level.set(elev_level(sm));
                self.elev.rattle.set(sm * sm * sm.sqrt());
            }
            let e = self.elev.unit.get_mono() * 0.22;
            let mut l = e * 0.7;
            let mut r = e * 0.7;
            for v in self.voices.iter_mut() {
                let mut s = 0.0;
                for p in v.parts.iter_mut() {
                    s += p.get_mono();
                }
                v.z1 += (s - v.z1) * v.lp;
                v.z2 += (v.z1 - v.z2) * v.lp;
                let rem = v.len.saturating_sub(v.age) as f32;
                let fade = (rem / (0.25 * v.len as f32).max(1.0)).min(1.0);
                s = v.z2 * v.gain * 0.9 * fade;
                l += s * v.gl;
                r += s * v.gr;
                v.age += 1;
            }
            self.master += (self.master_target - self.master) * k;
            let mut wet = [0.0_f32; 2];
            self.reverb.tick(&[l, r], &mut wet);
            let g = self.master * self.scale;
            // soft limiter: smooth knee, hard ceiling at CEILING
            self.left[j] = CEILING * ((l + wet[0] * self.wet) * g / CEILING).tanh();
            self.right[j] = CEILING * ((r + wet[1] * self.wet) * g / CEILING).tanh();
        }
        self.voices.retain(|v| v.age < v.len);
    }
}

static mut SYNTH: Option<Synth> = None;

#[allow(static_mut_refs)]
fn synth() -> Option<&'static mut Synth> {
    // SAFETY: wasm32-unknown-unknown is single-threaded and the worklet owns the sole instance;
    // no reference outlives one export call.
    unsafe { SYNTH.as_mut() }
}

#[no_mangle]
pub extern "C" fn audio_init(sample_rate: f32) {
    // SAFETY: single-threaded, see synth().
    unsafe { SYNTH = Some(Synth::new(sample_rate as f64)) };
}
#[no_mangle]
pub extern "C" fn audio_max_frames() -> u32 {
    MAX_FRAMES as u32
}
#[no_mangle]
pub extern "C" fn audio_left_ptr() -> *const f32 {
    synth().map_or(core::ptr::null(), |s| s.left.as_ptr())
}
#[no_mangle]
pub extern "C" fn audio_right_ptr() -> *const f32 {
    synth().map_or(core::ptr::null(), |s| s.right.as_ptr())
}
#[no_mangle]
pub extern "C" fn audio_render(frames: u32) {
    if let Some(s) = synth() {
        s.render(frames as usize);
    }
}
#[no_mangle]
pub extern "C" fn audio_event(kind: u32, intensity: f32, pan: f32) {
    audio_event_v(kind, intensity, pan, DEFAULT_VELOCITY);
}
/// One-shot with impact velocity 0..1 (scales gain by a dB curve, brightness and duration).
#[no_mangle]
pub extern "C" fn audio_event_v(kind: u32, intensity: f32, pan: f32, velocity: f32) {
    if let (Some(s), Some(k)) = (synth(), kind_from(kind)) {
        s.event(k, intensity, pan, velocity);
    }
}
#[no_mangle]
pub extern "C" fn audio_set_elevator(speed: f32, floor: i32) {
    if let Some(s) = synth() {
        s.set_elevator(speed, floor);
    }
}
#[no_mangle]
pub extern "C" fn audio_set_room(w: f32, d: f32, h: f32) {
    if let Some(s) = synth() {
        let r = make_reverb(&mut s.b, w.max(1.0), d.max(1.0), h.max(1.0));
        s.reverb = r;
    }
}
/// Master level, 0 = muted (smoothed). Default level and mute are chosen by the host.
#[no_mangle]
pub extern "C" fn audio_set_master(g: f32) {
    if let Some(s) = synth() {
        s.master_target = g.clamp(0.0, 1.0);
    }
}
/// Multiplier on top of master (prefers-reduced-motion passes 0.5).
#[no_mangle]
pub extern "C" fn audio_set_scale(g: f32) {
    if let Some(s) = synth() {
        s.scale = g.clamp(0.0, 1.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    const SR: f64 = 48000.0;

    fn synth_for_test(flat: bool) -> Synth {
        let mut s = Synth::new(SR);
        s.master_target = 0.5;
        s.flat = flat;
        s.render(0); // no-op, keeps API parity
        s
    }

    fn render(s: &mut Synth, secs: f32) -> Vec<f32> {
        let mut out = Vec::new();
        let mut left = (secs * SR as f32) as usize;
        while left > 0 {
            let n = Ord::min(left, 128);
            s.render(n);
            out.extend_from_slice(&s.left[..n]);
            left -= n;
        }
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }
    fn db(a: f32, b: f32) -> f32 {
        20.0 * (a / b).log10()
    }

    fn wav(name: &str, x: &[f32]) {
        let dir = "/Volumes/Projects/tmp/audio-velocity";
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let mut b = Vec::new();
        let n = x.len() as u32;
        b.extend(b"RIFF");
        b.extend((36 + n * 4).to_le_bytes());
        b.extend(b"WAVEfmt ");
        b.extend(16u32.to_le_bytes());
        b.extend(3u16.to_le_bytes());
        b.extend(1u16.to_le_bytes());
        b.extend((SR as u32).to_le_bytes());
        b.extend((SR as u32 * 4).to_le_bytes());
        b.extend(4u16.to_le_bytes());
        b.extend(32u16.to_le_bytes());
        b.extend(b"data");
        b.extend((n * 4).to_le_bytes());
        for v in x {
            b.extend(v.to_le_bytes());
        }
        if let Ok(mut f) = std::fs::File::create(format!("{dir}/{name}.wav")) {
            let _ = f.write_all(&b);
        }
    }

    const SPEEDS: [f32; 3] = [0.15, 0.5, 1.0];

    fn elevator_rms(flat: bool, speed: f32) -> f32 {
        let mut s = synth_for_test(flat);
        s.set_elevator(speed, 0);
        let x = render(&mut s, 4.0);
        wav(&format!("elevator_{}{}", (speed * 100.0) as u32, if flat { "_flat" } else { "" }), &x);
        rms(&x[(3.0 * SR as f32) as usize..])
    }

    fn oneshot_rms(flat: bool, kind: Kind, v: f32) -> f32 {
        let mut s = synth_for_test(flat);
        s.event(kind, 0.7, 0.0, v);
        let x = render(&mut s, 1.5);
        wav(&format!("{}_{}{}", kind as u32, (v * 100.0) as u32, if flat { "_flat" } else { "" }), &x);
        // subtract the parked elevator hum (same seeds, so identical without the event)
        let base = render(&mut synth_for_test(flat), 1.5);
        (rms(&x).powi(2) - rms(&base).powi(2)).max(1e-12).sqrt()
    }

    const KINDS: [Kind; 6] = [Kind::Grab, Kind::Place, Kind::PaperTurn, Kind::Open, Kind::Close, Kind::Scroll];

    /// True when every series is monotone in velocity and slow is at least 12 dB below fast.
    fn velocity_aware(flat: bool) -> bool {
        let mut series: Vec<[f32; 3]> = Vec::new();
        series.push(SPEEDS.map(|v| elevator_rms(flat, v)));
        for k in KINDS {
            series.push(SPEEDS.map(|v| oneshot_rms(flat, k, v)));
        }
        series.iter().enumerate().all(|(i, r)| {
            eprintln!("series {i}: rms {:.5} {:.5} {:.5}, slow vs fast {:.1} dB", r[0], r[1], r[2], db(r[0], r[2]));
            r[0] < r[1] && r[1] < r[2] && db(r[0], r[2]) <= -12.0
        })
    }

    #[test]
    fn velocity_scales_every_sound() {
        assert!(velocity_aware(false));
    }

    /// Planted-bug control: with the velocity curves bypassed the same check must fail.
    #[test]
    fn flat_gain_is_caught() {
        assert!(!velocity_aware(true));
    }

    #[test]
    fn limiter_holds_ceiling() {
        let mut s = synth_for_test(false);
        s.master_target = 1.0;
        for _ in 0..4 {
            for k in [0, 1, 2, 3, 4, 5, 6, 7] {
                s.event(kind_from(k).unwrap(), 1.0, 0.0, 1.0);
            }
        }
        s.set_elevator(1.0, 1);
        let x = render(&mut s, 2.0);
        let peak = x.iter().fold(0f32, |a, v| a.max(v.abs()));
        eprintln!("stress peak {peak:.3}");
        assert!(peak <= CEILING);
    }

    #[test]
    fn elevator_start_has_no_step() {
        let mut s = synth_for_test(false);
        render(&mut s, 0.5);
        s.set_elevator(1.0, 0);
        let x = render(&mut s, 0.1);
        // first 20 ms after a full-speed command stays near parked level
        assert!(rms(&x[..960]) < 0.02, "rms {}", rms(&x[..960]));
    }
}
