//! Engine-owned scroll (docs/READING_GPU.md, "Scroll (lane R)"): wheel, drag, fling, rubber-band, keyboard and smooth scroll-to.
//!
//! Pure physics, no Flecs: `ScrollSim` is the data of the `ScrollSim` singleton and `reading.rs` drives it. Everything is in CSS px and
//! seconds. Every motion is integrated with its exact solution (critically damped spring, exponential decay, closed-form ease), and
//! `ScrollSim::step` splits a step at the instant a motion ends or changes kind, so a step of dt equals any split of dt: the result does
//! not depend on the frame rate. Pointer samples carry their own timestamps as f64 ms (an f32 `performance.now()` has under 1 ms resolution only below about 16 s of page life, so the ABI passes f64).

use flecs_ecs::prelude::*;

/// Critically damped glide of a discrete mouse wheel notch (95 percent in about 120 ms).
pub const OMEGA_GLIDE: f32 = 40.0;
/// Critically damped spring back from the rubber band (about 0.35 s to settle).
pub const OMEGA_BAND: f32 = 14.0;
/// iOS UIScrollView normal deceleration: 0.998 per ms.
pub const FLING_RATE_PER_MS: f32 = 0.998;
/// Time constant of `v(t) = v0 * exp(-t / tau)` in seconds: 1 / (-1000 ln 0.998), about 0.4995 s.
pub const TAU: f32 = 0.499_499_83; // checked against the formula in the `constants` test
/// A fling stops below this speed (px/s).
pub const STOP_SPEED: f32 = 5.0;
/// Velocity window of a release (ms).
pub const VEL_WINDOW_MS: f64 = 100.0;
/// iOS rubber-band constant.
pub const BAND_C: f32 = 0.55;
/// Page step of Space, PageUp and PageDown: viewport minus this (px).
pub const PAGE_OVERLAP: f32 = 40.0;
/// Arrow key step (px).
pub const ARROW_STEP: f32 = 60.0;
/// How long a direct (trackpad) wheel stream keeps the mode `Wheel` after its last event (s).
pub const DIRECT_HOLD_S: f32 = 0.12;
pub const MIN_ANIM_S: f32 = 0.25;
pub const MAX_ANIM_S: f32 = 0.7;
const SAMPLES: usize = 16;

/// `ScrollMode` as stored in the state vector.
pub const MODE_IDLE: u32 = 0;
pub const MODE_WHEEL: u32 = 1;
pub const MODE_DRAG: u32 = 2;
pub const MODE_FLING: u32 = 3;
pub const MODE_ANIMATE: u32 = 4;
pub const MODE_RUBBER: u32 = 5;

/// `reading_key` codes.
pub const KEY_SPACE: u32 = 1;
pub const KEY_PAGE_DOWN: u32 = 2;
pub const KEY_PAGE_UP: u32 = 3;
pub const KEY_HOME: u32 = 4;
pub const KEY_END: u32 = 5;
pub const KEY_DOWN: u32 = 6;
pub const KEY_UP: u32 = 7;

/// `reading_pointer` kinds; the id word is `pointerId | pointerType << 16` (0 mouse, 1 touch, 2 pen).
pub const PTR_DOWN: u32 = 1;
pub const PTR_MOVE: u32 = 2;
pub const PTR_UP: u32 = 3;
pub const PTR_CANCEL: u32 = 4;

#[derive(Component, Clone, Copy)]
pub struct ScrollSim {
    /// Displayed scroll position (px). Outside [0, max] only while the rubber band is out.
    pub y: f32,
    /// Velocity (px/s).
    pub v: f32,
    pub max: f32,
    pub view_h: f32,
    pub mode: u32,
    pub reduced: bool,
    glide: bool,
    target: f32,
    hold: f32,
    from: f32,
    to: f32,
    t: f32,
    dur: f32,
    edge: f32,
    pid: u32,
    p0: f32,
    raw0: f32,
    last_t: f64,
    n: usize,
    st: [f64; SAMPLES],
    sy: [f32; SAMPLES],
    prev_y: f32,
}

impl Default for ScrollSim {
    fn default() -> Self {
        ScrollSim {
            y: 0.0,
            v: 0.0,
            max: 0.0,
            view_h: 1.0,
            mode: MODE_IDLE,
            reduced: false,
            glide: false,
            target: 0.0,
            hold: 0.0,
            from: 0.0,
            to: 0.0,
            t: 0.0,
            dur: 1.0,
            edge: 0.0,
            pid: 0,
            p0: 0.0,
            raw0: 0.0,
            last_t: 0.0,
            n: 0,
            st: [0.0; SAMPLES],
            sy: [0.0; SAMPLES],
            prev_y: 0.0,
        }
    }
}

/// iOS rubber band: displacement of the content for a finger that is `x` px past the edge, `d` the viewport height. Always below `d`.
pub fn band(x: f32, d: f32) -> f32 {
    (1.0 - 1.0 / (x * BAND_C / d + 1.0)) * d
}

/// Inverse of [`band`] for `0 <= b < d`.
pub fn unband(b: f32, d: f32) -> f32 {
    let u = (b / d).min(0.999_999);
    d / BAND_C * (1.0 / (1.0 - u) - 1.0)
}

/// Slope of [`band`].
fn band_slope(x: f32, d: f32) -> f32 {
    let q = x * BAND_C / d + 1.0;
    BAND_C / (q * q)
}

/// Critically damped spring toward `target`, exact for any dt.
fn spring(x: &mut f32, v: &mut f32, target: f32, omega: f32, dt: f32) {
    let d = *x - target;
    let e = (-omega * dt).exp();
    let k = *v + omega * d;
    *x = target + (d + k * dt) * e;
    *v = (*v - omega * k * dt) * e;
}

/// Ease-in-out cubic and its derivative.
fn ease(p: f32) -> f32 {
    if p < 0.5 {
        4.0 * p * p * p
    } else {
        let q = 2.0 - 2.0 * p;
        1.0 - q * q * q / 2.0
    }
}
fn ease_slope(p: f32) -> f32 {
    if p < 0.5 {
        12.0 * p * p
    } else {
        let q = 2.0 - 2.0 * p;
        3.0 * q * q
    }
}

/// Duration of a smooth scroll over `dist` px: 450 ms at one viewport, growing with the square root of the distance, 250..700 ms.
pub fn anim_duration(dist: f32, view_h: f32) -> f32 {
    (0.45 * (dist / view_h.max(1.0)).sqrt()).clamp(MIN_ANIM_S, MAX_ANIM_S)
}

/// A wheel stream from a discrete mouse wheel: line or page units, or px in multiples of 100 or 120.
pub fn is_discrete(dy: f32, delta_mode: u32) -> bool {
    if delta_mode != 0 {
        return true;
    }
    let a = dy.abs();
    a >= 100.0 && ((a % 100.0).abs() < 1e-3 || (a % 120.0).abs() < 1e-3)
}

impl ScrollSim {
    fn range(&self) -> f32 {
        self.max.max(0.0)
    }

    fn clamp(&self, y: f32) -> f32 {
        y.clamp(0.0, self.range())
    }

    fn idle(&mut self) {
        self.mode = MODE_IDLE;
        self.v = 0.0;
        self.glide = false;
        self.hold = 0.0;
    }

    /// Something outside moved the position (`reading_set_scroll`, a text size change): drop every motion and follow it.
    pub fn sync(&mut self, y: f32) {
        if (self.y - y).abs() > 0.01 + y.abs() * 1e-6 {
            self.y = y;
            self.prev_y = y;
            self.idle();
        }
    }

    fn base(&self) -> f32 {
        match self.mode {
            MODE_ANIMATE => self.to,
            MODE_WHEEL if self.glide => self.target,
            _ => self.clamp(self.y),
        }
    }

    // ---- wheel ----

    /// `line_px`: the px a line of `deltaMode` 1 is worth. Returns false for an event that is ignored (pinch zoom, no vertical delta).
    pub fn wheel(&mut self, dy: f32, delta_mode: u32, ctrl: bool, line_px: f32) -> bool {
        if ctrl || dy == 0.0 || self.mode == MODE_DRAG {
            return false;
        }
        let px = match delta_mode {
            0 => dy,
            1 => dy * line_px,
            _ => dy * self.view_h,
        };
        if is_discrete(dy, delta_mode) && !self.reduced {
            self.glide_by(px);
        } else {
            let from = if self.mode == MODE_ANIMATE { self.y } else { self.clamp(self.y) };
            self.y = self.clamp(from + px);
            self.v = 0.0;
            self.glide = false;
            self.hold = DIRECT_HOLD_S;
            self.mode = MODE_WHEEL;
        }
        true
    }

    /// Move the glide target by `px` (accumulates while a glide runs).
    fn glide_by(&mut self, px: f32) {
        let continuing = self.mode == MODE_WHEEL && self.glide;
        let base = self.base();
        self.target = self.clamp(base + px);
        if !continuing {
            self.v = 0.0;
            if self.mode == MODE_RUBBER {
                self.y = self.clamp(self.y);
            }
        }
        self.glide = true;
        self.hold = 0.0;
        self.mode = MODE_WHEEL;
    }

    // ---- pointer ----

    /// Touch and pen drag. Returns true while this pointer is the one driving the scroll.
    pub fn pointer(&mut self, kind: u32, id: u32, y: f32, t_ms: f64) -> bool {
        let ptype = id >> 16;
        if ptype == 0 {
            return false; // a mouse selects text, it does not drag the page
        }
        let d = self.view_h.max(1.0);
        match kind {
            PTR_DOWN => {
                if self.mode == MODE_DRAG {
                    return self.pid == id;
                }
                self.pid = id;
                self.p0 = y;
                // the raw (unbanded) position under the finger: catching a rubber-banded page keeps it where it is
                self.raw0 = if self.y < 0.0 {
                    -unband(-self.y, d)
                } else if self.y > self.range() {
                    self.range() + unband(self.y - self.range(), d)
                } else {
                    self.y
                };
                self.n = 0;
                self.push(t_ms, self.raw0);
                self.mode = MODE_DRAG;
                self.glide = false;
                self.hold = 0.0;
                self.v = 0.0;
                true
            }
            PTR_MOVE => {
                if self.mode != MODE_DRAG || self.pid != id {
                    return false;
                }
                let raw = self.raw0 + (self.p0 - y);
                self.push(t_ms, raw);
                self.y = self.display(raw, d);
                true
            }
            PTR_UP | PTR_CANCEL => {
                if self.mode != MODE_DRAG || self.pid != id {
                    return false;
                }
                let v = if kind == PTR_UP { self.release_velocity(t_ms) } else { 0.0 };
                self.release(v, d);
                false
            }
            _ => false,
        }
    }

    fn display(&self, raw: f32, d: f32) -> f32 {
        let max = self.range();
        if self.reduced {
            raw.clamp(0.0, max)
        } else if raw < 0.0 {
            -band(-raw, d)
        } else if raw > max {
            max + band(raw - max, d)
        } else {
            raw
        }
    }

    fn push(&mut self, t: f64, raw: f32) {
        if self.n == SAMPLES {
            self.st.copy_within(1.., 0);
            self.sy.copy_within(1.., 0);
            self.n -= 1;
        }
        self.st[self.n] = t;
        self.sy[self.n] = raw;
        self.n += 1;
        self.last_t = t;
    }

    /// Velocity (px/s of scroll position) over the samples in the last 100 ms before the release.
    fn release_velocity(&self, t_up: f64) -> f32 {
        let lo = t_up - VEL_WINDOW_MS;
        let mut first = None;
        for i in 0..self.n {
            if self.st[i] >= lo {
                first = Some(i);
                break;
            }
        }
        let Some(i) = first else { return 0.0 };
        let j = self.n - 1;
        if j <= i {
            return 0.0;
        }
        let dt = (self.st[j] - self.st[i]) / 1000.0;
        if dt < 1e-3 {
            return 0.0;
        }
        ((self.sy[j] - self.sy[i]) as f64 / dt) as f32
    }

    /// Finger lifted with scroll velocity `v` (px/s of the raw position).
    fn release(&mut self, v: f32, d: f32) {
        let max = self.range();
        self.glide = false;
        self.hold = 0.0;
        if self.y < 0.0 || self.y > max {
            if self.reduced {
                self.y = self.clamp(self.y);
                self.idle();
                return;
            }
            let (edge, off) = if self.y < 0.0 { (0.0, -self.y) } else { (max, self.y - max) };
            self.edge = edge;
            // displayed velocity = raw velocity times the slope of the band at the finger
            self.v = v * band_slope(unband(off, d), d);
            self.mode = MODE_RUBBER;
        } else if self.reduced || v.abs() <= STOP_SPEED {
            self.idle();
        } else {
            self.v = v;
            self.mode = MODE_FLING;
        }
    }

    // ---- keyboard ----

    /// Returns true when the key is a scroll key (the page consumes it).
    pub fn key(&mut self, code: u32, shift: bool) -> bool {
        let page = (self.view_h - PAGE_OVERLAP).max(PAGE_OVERLAP);
        match code {
            KEY_SPACE | KEY_PAGE_DOWN | KEY_PAGE_UP => {
                if self.mode == MODE_DRAG {
                    return true;
                }
                let up = code == KEY_PAGE_UP || (code == KEY_SPACE && shift);
                let to = self.base() + if up { -page } else { page };
                self.scroll_to(to, true);
                true
            }
            KEY_HOME => {
                if self.mode != MODE_DRAG {
                    self.scroll_to(0.0, true);
                }
                true
            }
            KEY_END => {
                if self.mode != MODE_DRAG {
                    self.scroll_to(self.range(), true);
                }
                true
            }
            KEY_DOWN | KEY_UP => {
                if self.mode != MODE_DRAG {
                    let px = if code == KEY_UP { -ARROW_STEP } else { ARROW_STEP };
                    if self.reduced {
                        self.y = self.clamp(self.base() + px);
                        self.idle();
                    } else {
                        self.glide_by(px);
                    }
                }
                true
            }
            _ => false,
        }
    }

    // ---- scroll to ----

    /// Scroll to `y` (clamped). Instant when `smooth` is false or reduced motion is on.
    pub fn scroll_to(&mut self, y: f32, smooth: bool) {
        let to = self.clamp(y);
        let dist = (to - self.y).abs();
        if !smooth || self.reduced || dist < 0.5 {
            self.y = to;
            self.idle();
            return;
        }
        self.from = self.y;
        self.to = to;
        self.t = 0.0;
        self.dur = anim_duration(dist, self.view_h);
        self.v = 0.0;
        self.glide = false;
        self.hold = 0.0;
        self.mode = MODE_ANIMATE;
    }

    /// Duration (s) of the running smooth scroll.
    pub fn anim_dur(&self) -> f32 {
        self.dur
    }

    // ---- integration ----

    /// Advance `dt` seconds. The result is the same for any split of `dt`.
    pub fn step(&mut self, dt: f32) {
        let before = self.y;
        let mut rem = dt.max(0.0);
        let mut guard = 0;
        while guard < 8 {
            guard += 1;
            rem = self.advance(rem);
            if rem <= 0.0 {
                break;
            }
        }
        if (self.mode == MODE_DRAG || (self.mode == MODE_WHEEL && !self.glide)) && dt > 0.0 {
            self.v = (self.y - before) / dt;
        }
        self.prev_y = self.y;
    }

    /// Run the current motion for at most `rem`; returns the time left over after a motion that ended or changed kind.
    fn advance(&mut self, rem: f32) -> f32 {
        let max = self.range();
        match self.mode {
            MODE_IDLE => {
                if self.y > max || self.y < 0.0 {
                    self.y = self.clamp(self.y);
                }
                0.0
            }
            MODE_DRAG => 0.0,
            MODE_WHEEL => {
                if self.glide {
                    self.target = self.clamp(self.target);
                    let tg = self.target;
                    spring(&mut self.y, &mut self.v, tg, OMEGA_GLIDE, rem);
                    if (self.y - tg).abs() < 0.05 && self.v.abs() < 2.0 {
                        self.y = tg;
                        self.idle();
                    }
                } else {
                    self.y = self.clamp(self.y);
                    self.hold -= rem;
                    if self.hold <= 0.0 {
                        self.idle();
                    }
                }
                0.0
            }
            MODE_ANIMATE => {
                self.t += rem;
                if self.t >= self.dur {
                    let left = self.t - self.dur;
                    self.y = self.clamp(self.to);
                    self.idle();
                    return left;
                }
                let p = self.t / self.dur;
                let delta = self.to - self.from;
                self.y = self.from + delta * ease(p);
                self.v = delta * ease_slope(p) / self.dur;
                0.0
            }
            MODE_FLING => {
                let speed = self.v.abs();
                if speed <= STOP_SPEED {
                    self.idle();
                    return 0.0;
                }
                let dir = self.v.signum();
                let t_stop = TAU * (speed / STOP_SPEED).ln();
                let to_edge = if dir > 0.0 { max - self.y } else { self.y }.max(0.0);
                let reach = speed * TAU;
                let t_edge = if to_edge < reach { -TAU * (1.0 - to_edge / reach).ln() } else { f32::INFINITY };
                let t = rem.min(t_stop).min(t_edge);
                let e = (-t / TAU).exp();
                self.y += self.v * TAU * (1.0 - e);
                self.v *= e;
                if t_edge <= rem && t_edge <= t_stop {
                    // the fling reached the edge: its velocity goes into the band
                    self.edge = if dir > 0.0 { max } else { 0.0 };
                    self.y = self.edge;
                    if self.reduced {
                        self.idle();
                    } else {
                        self.mode = MODE_RUBBER;
                    }
                    rem - t
                } else if t_stop <= rem {
                    self.idle();
                    rem - t
                } else {
                    0.0
                }
            }
            MODE_RUBBER => {
                let d = self.view_h.max(1.0);
                let edge = self.edge.clamp(0.0, max);
                self.edge = edge;
                let mut off = self.y - edge;
                spring(&mut off, &mut self.v, 0.0, OMEGA_BAND, rem);
                // the band never shows more than a viewport
                off = off.clamp(-d, d);
                self.y = edge + off;
                if off.abs() < 0.05 && self.v.abs() < 1.0 {
                    self.y = edge;
                    self.idle();
                }
                0.0
            }
            _ => {
                self.idle();
                0.0
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const VIEW: f32 = 800.0;

    fn sim(max: f32) -> ScrollSim {
        ScrollSim { max, view_h: VIEW, ..ScrollSim::default() }
    }

    /// Step `secs` at `hz` (whole frames; secs is a multiple of every period used).
    fn run(s: &mut ScrollSim, hz: u32, secs: f32) {
        let n = (secs * hz as f32).round() as u32;
        let dt = 1.0 / hz as f32;
        for _ in 0..n {
            s.step(dt);
        }
    }

    const RATES: [u32; 4] = [30, 60, 120, 240];

    fn spread(v: &[f32]) -> f32 {
        v.iter().cloned().fold(f32::MIN, f32::max) - v.iter().cloned().fold(f32::MAX, f32::min)
    }

    #[test]
    fn constants() {
        // tau from 0.998 per ms
        assert!((TAU - 1.0 / (-1000.0 * FLING_RATE_PER_MS.ln())).abs() < 1e-5, "tau {TAU}");
        assert!((FLING_RATE_PER_MS.powf(1000.0) - (-1000.0 * 0.002f32).exp()).abs() < 0.01);
    }

    /// Drag, release and run: identical at every frame rate (events at multiples of 1/30 s).
    fn drag_fling(hz: u32) -> f32 {
        let mut s = sim(100_000.0);
        s.y = 5000.0;
        s.prev_y = 5000.0;
        let id = 1 << 16 | 7;
        let mut t = 0.0f64;
        s.pointer(PTR_DOWN, id, 600.0, t);
        // finger moves 300 px up over 100 ms in 3 events at 1/30 s: velocity 3000 px/s
        for k in 1..=3 {
            let step_s = 1.0 / 30.0;
            // advance the clock to the event time at this frame rate
            run(&mut s, hz, step_s);
            t += 1000.0 / 30.0;
            s.pointer(PTR_MOVE, id, 600.0 - 100.0 * k as f32, t);
        }
        s.pointer(PTR_UP, id, 300.0, t);
        run(&mut s, hz, 6.0);
        s.y
    }

    #[test]
    fn frame_rate_independent_fling() {
        let ys: Vec<f32> = RATES.iter().map(|&hz| drag_fling(hz)).collect();
        assert!(spread(&ys) < 1.0, "fling end positions {ys:?}");
        // and it travelled: 300 px of drag plus about v0 * tau
        assert!(ys[0] > 5000.0 + 300.0 + 1000.0);
    }

    fn wheel_glide(hz: u32) -> f32 {
        let mut s = sim(100_000.0);
        s.wheel(100.0, 0, false, 27.0);
        run(&mut s, hz, 1.0 / 30.0 * 3.0);
        s.wheel(120.0, 0, false, 27.0); // 120 is discrete too
        run(&mut s, hz, 1.0);
        s.y
    }

    #[test]
    fn frame_rate_independent_wheel() {
        let ys: Vec<f32> = RATES.iter().map(|&hz| wheel_glide(hz)).collect();
        assert!(spread(&ys) < 1.0, "{ys:?}");
        assert!((ys[0] - 220.0).abs() < 0.1);
    }

    fn animate(hz: u32) -> Vec<f32> {
        let mut s = sim(100_000.0);
        s.scroll_to(2000.0, true);
        let mut out = vec![];
        for _ in 0..3 {
            run(&mut s, hz, 0.2);
            out.push(s.y);
        }
        run(&mut s, hz, 1.0);
        out.push(s.y);
        out
    }

    #[test]
    fn frame_rate_independent_animate_and_rubber() {
        let base = animate(240);
        for hz in [30, 60, 120] {
            let a = animate(hz);
            for (x, y) in a.iter().zip(&base) {
                assert!((x - y).abs() < 1.0, "{hz}: {a:?} vs {base:?}");
            }
        }
        // fling into the bottom edge, then the spring back
        let end = |hz: u32| {
            let mut s = sim(1000.0);
            s.y = 900.0;
            s.v = 4000.0;
            s.mode = MODE_FLING;
            let mut mid = vec![];
            for _ in 0..3 {
                run(&mut s, hz, 0.1);
                mid.push(s.y);
            }
            run(&mut s, hz, 3.0);
            (mid, s.y)
        };
        let (mid240, y240) = end(240);
        for hz in [30, 60, 120] {
            let (mid, y) = end(hz);
            assert!((y - y240).abs() < 1.0 && (y - 1000.0).abs() < 1e-3, "{hz} {y}");
            for (a, b) in mid.iter().zip(&mid240) {
                assert!((a - b).abs() < 1.0, "{hz}: {mid:?} vs {mid240:?}");
            }
        }
    }

    #[test]
    fn fling_distance_is_v0_tau() {
        for v0 in [800.0f32, 2000.0, 5000.0] {
            for hz in RATES {
                let mut s = sim(1.0e9);
                s.y = 10_000.0;
                s.v = v0;
                s.mode = MODE_FLING;
                run(&mut s, hz, 8.0);
                let dist = s.y - 10_000.0;
                let want = v0 * TAU;
                assert!((dist - want).abs() <= 0.05 * want, "v0 {v0} hz {hz}: {dist} vs {want}");
                assert_eq!(s.mode, MODE_IDLE);
            }
        }
        // downward too
        let mut s = sim(1.0e9);
        s.y = 50_000.0;
        s.v = -2000.0;
        s.mode = MODE_FLING;
        run(&mut s, 60, 8.0);
        assert!((50_000.0 - s.y - 2000.0 * TAU).abs() < 0.05 * 2000.0 * TAU);
    }

    #[test]
    fn band_never_exceeds_d() {
        for d in [300.0f32, 800.0, 1200.0] {
            let mut x = 0.0;
            while x < 1.0e6 {
                let b = band(x, d);
                assert!(b >= 0.0 && b < d, "band({x}) = {b} d {d}");
                let back = unband(b, d);
                if b < d * 0.99 {
                    assert!((back - x).abs() < 0.01 * x.max(1.0), "unband {back} vs {x}");
                }
                x = x * 1.7 + 1.0;
            }
        }
        // a dragged page never shows more than d past the edge, however far the finger goes
        let mut s = sim(1000.0);
        let id = 2 << 16;
        s.pointer(PTR_DOWN, id, 100.0, 0.0);
        s.pointer(PTR_MOVE, id, 100.0 + 50_000.0, 16.0);
        assert!(s.y < 0.0 && -s.y < VIEW, "{}", s.y);
        s.pointer(PTR_MOVE, id, 100.0 - 90_000.0, 32.0);
        assert!(s.y > 1000.0 && s.y - 1000.0 < VIEW, "{}", s.y);
    }

    #[test]
    fn rubber_settles_inside_range_without_overshoot_past_d() {
        // a hard fling into the top edge
        let mut s = sim(1000.0);
        s.y = 10.0;
        s.v = -30_000.0;
        s.mode = MODE_FLING;
        let mut min = 0.0f32;
        for _ in 0..(240 * 4) {
            s.step(1.0 / 240.0);
            min = min.min(s.y);
            assert!(s.y >= -VIEW, "band exceeded d: {}", s.y);
        }
        assert!(min < -10.0, "the band did not open: {min}");
        assert_eq!(s.mode, MODE_IDLE);
        assert!(s.y >= 0.0 && s.y <= 1000.0);
        // released after dragging 200 px past the bottom: returns to max in about 0.35 s
        let mut s = sim(1000.0);
        s.y = 1000.0;
        let id = 1 << 16 | 1;
        s.pointer(PTR_DOWN, id, 500.0, 0.0);
        s.pointer(PTR_MOVE, id, 200.0, 16.0);
        s.pointer(PTR_MOVE, id, 200.0, 400.0); // finger rests before lifting: no velocity
        s.pointer(PTR_UP, id, 200.0, 500.0);
        assert_eq!(s.mode, MODE_RUBBER);
        assert!(s.y > 1000.0);
        run(&mut s, 60, 0.35);
        assert!(s.y - 1000.0 < 0.05 * (band(300.0, VIEW)) + 5.0, "{}", s.y);
        run(&mut s, 60, 1.0);
        assert_eq!(s.y, 1000.0);
        assert_eq!(s.mode, MODE_IDLE);
    }

    #[test]
    fn settle_ends_inside_range() {
        // random-ish releases: always end in [0, max]
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / 16_777_216.0
        };
        for _ in 0..200 {
            let max = 500.0 + rnd() * 5000.0;
            let mut s = sim(max);
            s.y = rnd() * max;
            let id = 1 << 16 | 3;
            let mut t = 0.0;
            s.pointer(PTR_DOWN, id, 400.0, t);
            let mut fy = 400.0;
            for _ in 0..6 {
                t += 16.0;
                fy += (rnd() - 0.5) * 400.0;
                s.pointer(PTR_MOVE, id, fy, t);
                s.step(0.016);
            }
            s.pointer(if rnd() < 0.8 { PTR_UP } else { PTR_CANCEL }, id, fy, t + 8.0);
            run(&mut s, 60, 10.0);
            assert_eq!(s.mode, MODE_IDLE);
            assert!(s.y >= 0.0 && s.y <= max, "{} not in [0, {max}]", s.y);
        }
    }

    #[test]
    fn velocity_uses_the_last_100ms_only() {
        let mut s = sim(1.0e6);
        s.y = 1000.0;
        let id = 1 << 16 | 9;
        s.pointer(PTR_DOWN, id, 500.0, 0.0);
        // fast at first (4000 px/s up the page), then slow (500 px/s) over the last 100 ms
        let mut t = 0.0;
        let mut fy = 500.0;
        for _ in 0..10 {
            t += 10.0;
            fy -= 40.0;
            s.pointer(PTR_MOVE, id, fy, t);
        }
        for _ in 0..10 {
            t += 10.0;
            fy -= 5.0;
            s.pointer(PTR_MOVE, id, fy, t);
        }
        s.pointer(PTR_UP, id, fy, t);
        assert_eq!(s.mode, MODE_FLING);
        assert!((s.v - 500.0).abs() < 60.0, "v {}", s.v);
        // a long pause before the lift: no fling
        let mut s = sim(1.0e6);
        s.y = 1000.0;
        s.pointer(PTR_DOWN, id, 500.0, 0.0);
        s.pointer(PTR_MOVE, id, 300.0, 10.0);
        s.pointer(PTR_UP, id, 300.0, 300.0);
        assert_eq!(s.mode, MODE_IDLE);
        // mouse never drags
        assert!(!s.pointer(PTR_DOWN, 5, 0.0, 0.0));
    }

    #[test]
    fn keyboard_distances() {
        let mut s = sim(100_000.0);
        s.y = 1000.0;
        assert!(s.key(KEY_SPACE, false));
        assert_eq!(s.mode, MODE_ANIMATE);
        run(&mut s, 60, 1.0);
        assert!((s.y - (1000.0 + VIEW - 40.0)).abs() < 0.01, "{}", s.y);
        assert!(s.key(KEY_SPACE, true));
        run(&mut s, 60, 1.0);
        assert!((s.y - 1000.0).abs() < 0.01);
        s.key(KEY_PAGE_DOWN, false);
        run(&mut s, 60, 1.0);
        s.key(KEY_PAGE_UP, false);
        run(&mut s, 60, 1.0);
        assert!((s.y - 1000.0).abs() < 0.01);
        // two quick presses accumulate
        s.key(KEY_PAGE_DOWN, false);
        run(&mut s, 60, 0.1);
        s.key(KEY_PAGE_DOWN, false);
        run(&mut s, 60, 2.0);
        assert!((s.y - (1000.0 + 2.0 * (VIEW - 40.0))).abs() < 0.01, "{}", s.y);
        s.key(KEY_END, false);
        run(&mut s, 60, 2.0);
        assert!((s.y - 100_000.0).abs() < 0.01);
        s.key(KEY_HOME, false);
        run(&mut s, 60, 2.0);
        assert_eq!(s.y, 0.0);
        // arrows: 60 px glides
        s.key(KEY_DOWN, false);
        s.key(KEY_DOWN, false);
        run(&mut s, 60, 1.0);
        assert!((s.y - 120.0).abs() < 0.1, "{}", s.y);
        s.key(KEY_UP, false);
        run(&mut s, 60, 1.0);
        assert!((s.y - 60.0).abs() < 0.1);
        // not a scroll key
        assert!(!s.key(99, false));
        // clamped at the end
        let mut s = sim(300.0);
        s.key(KEY_SPACE, false);
        run(&mut s, 60, 1.0);
        assert_eq!(s.y, 300.0);
    }

    #[test]
    fn smooth_scroll_duration_clamps() {
        assert_eq!(anim_duration(1.0, VIEW), MIN_ANIM_S);
        assert_eq!(anim_duration(1.0e6, VIEW), MAX_ANIM_S);
        assert!((anim_duration(VIEW, VIEW) - 0.45).abs() < 1e-6);
        for dist in [10.0, 500.0, 2000.0, 90_000.0] {
            let mut s = sim(1.0e6);
            s.scroll_to(dist, true);
            let d = s.anim_dur();
            assert!((MIN_ANIM_S..=MAX_ANIM_S).contains(&d), "{d}");
            // it is still moving just before d and done just after
            run(&mut s, 1000, d - 0.01);
            assert_eq!(s.mode, MODE_ANIMATE);
            run(&mut s, 1000, 0.02);
            assert_eq!(s.mode, MODE_IDLE);
            assert_eq!(s.y, dist);
        }
        // monotone ease
        let mut s = sim(1.0e6);
        s.scroll_to(3000.0, true);
        let mut last = 0.0;
        for _ in 0..200 {
            s.step(0.005);
            assert!(s.y >= last);
            last = s.y;
        }
    }

    #[test]
    fn reduced_motion_is_instant() {
        let mut s = sim(10_000.0);
        s.reduced = true;
        s.scroll_to(2500.0, true);
        assert_eq!((s.y, s.mode), (2500.0, MODE_IDLE));
        s.key(KEY_SPACE, false);
        assert_eq!(s.y, 2500.0 + VIEW - 40.0);
        s.wheel(100.0, 0, false, 27.0);
        assert_eq!(s.y, 2500.0 + VIEW - 40.0 + 100.0);
        s.key(KEY_DOWN, false);
        assert_eq!(s.mode, MODE_IDLE);
    }

    #[test]
    fn wheel_units_and_pinch() {
        let mut s = sim(100_000.0);
        assert!(!s.wheel(100.0, 0, true, 27.0), "ctrl (pinch) ignored");
        assert_eq!(s.y, 0.0);
        assert_eq!(s.mode, MODE_IDLE);
        // trackpad: direct, no smoothing
        assert!(s.wheel(7.0, 0, false, 27.0));
        assert_eq!(s.y, 7.0);
        s.step(0.016);
        s.wheel(-3.0, 0, false, 27.0);
        assert_eq!(s.y, 4.0);
        run(&mut s, 60, 0.2);
        assert_eq!(s.mode, MODE_IDLE);
        // lines and pages glide to the exact target
        let mut s = sim(100_000.0);
        s.wheel(3.0, 1, false, 27.0);
        run(&mut s, 60, 1.0);
        assert!((s.y - 81.0).abs() < 0.1);
        s.wheel(1.0, 2, false, 27.0);
        run(&mut s, 60, 1.0);
        assert!((s.y - (81.0 + VIEW)).abs() < 0.1);
        // 100-multiple notches are discrete, 7 is not
        assert!(is_discrete(100.0, 0) && is_discrete(-240.0, 0) && is_discrete(300.0, 0));
        assert!(!is_discrete(7.0, 0) && !is_discrete(101.0, 0) && !is_discrete(99.0, 0));
        // a glide takes about 120 ms to arrive (95 percent)
        let mut s = sim(100_000.0);
        s.wheel(100.0, 0, false, 27.0);
        run(&mut s, 1000, 0.12);
        assert!(s.y > 90.0 && s.y < 100.0);
        // the glide is clamped at the end
        let mut s = sim(50.0);
        s.wheel(300.0, 0, false, 27.0);
        run(&mut s, 60, 1.0);
        assert_eq!(s.y, 50.0);
    }

    /// Planted-bug control: a sim that applies dt as a per-frame constant (the fling decays by a fixed factor per call, the
    /// glide by a fixed fraction) is frame-rate dependent, and the same measurement that passes `ScrollSim` flags it.
    #[test]
    fn planted_bug_per_frame_constant_is_caught() {
        fn buggy_fling(hz: u32) -> f32 {
            let (mut y, mut v) = (0.0f32, 3000.0f32);
            for _ in 0..(hz * 6) {
                y += v / 60.0; // dt taken as 1/60 per frame
                v *= 0.9835; // decay per frame
            }
            y
        }
        let ys: Vec<f32> = RATES.iter().map(|&hz| buggy_fling(hz)).collect();
        assert!(spread(&ys) > 100.0, "the planted bug should differ across rates: {ys:?}");
        // and the real one, under the identical harness, does not
        let real: Vec<f32> = RATES
            .iter()
            .map(|&hz| {
                let mut s = sim(1.0e9);
                s.v = 3000.0;
                s.mode = MODE_FLING;
                run(&mut s, hz, 6.0);
                s.y
            })
            .collect();
        assert!(spread(&real) < 1.0, "{real:?}");
    }

    #[test]
    fn catching_a_banded_page_keeps_it() {
        let mut s = sim(1000.0);
        s.y = -120.0;
        s.mode = MODE_RUBBER;
        s.edge = 0.0;
        let id = 1 << 16 | 4;
        s.pointer(PTR_DOWN, id, 300.0, 0.0);
        assert!((s.y + 120.0).abs() < 1e-3);
        s.pointer(PTR_MOVE, id, 300.0, 16.0);
        assert!((s.y + 120.0).abs() < 0.05, "{}", s.y);
        assert_eq!(s.mode, MODE_DRAG);
    }
}
