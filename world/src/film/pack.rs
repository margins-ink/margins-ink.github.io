//! The stage as a draw list: a pure function of (definition, timeline, time). Items use the exhibit draw format (`XD`, stride 8) in a fixed 32 x 18
//! unit frame (1 unit = 1/32 of the frame width); the page maps the frame onto the canvas. Per-item opacity rides in flags bits 16..23 (0 = opaque).
use super::model::*;
use super::timeline::*;
use crate::museum::draw::*;

pub const FRAME_W: f32 = 32.0;
pub const FRAME_H: f32 = 18.0;
/// meta layout (f32 slots): scene, scene time, clamped time, total, scene start, scene end, mount count, reserved; then 8 per mount.
pub const META_HEAD: usize = 8;
pub const META_MOUNT: usize = 8;
pub const MAX_MOUNTS: usize = 6;
pub const LINE_H: f32 = 1.5;

fn alpha_bits(a: f32) -> Option<u32> {
    if a <= 0.004 {
        return None;
    }
    Some(if a >= 0.996 { 0 } else { ((a * 255.0).round().clamp(1.0, 254.0) as u32) << 16 })
}

fn hash(a: u32, b: u32, c: u32) -> f32 {
    let mut x = a.wrapping_mul(0x9E37_79B1) ^ b.wrapping_mul(0x85EB_CA77) ^ c.wrapping_mul(0xC2B2_AE3D);
    x ^= x >> 15;
    x = x.wrapping_mul(0x2C1B_3C6D);
    x ^= x >> 12;
    x = x.wrapping_mul(0x297A_2D39);
    x ^= x >> 15;
    (x & 0xFFFF) as f32 / 65535.0
}

struct View {
    cx: f32,
    cy: f32,
    z: f32,
}
impl View {
    fn x(&self, x: f32) -> f32 {
        (x - self.cx) * self.z + FRAME_W / 2.0
    }
    fn y(&self, y: f32) -> f32 {
        (y - self.cy) * self.z + FRAME_H / 2.0
    }
}

pub fn pack(def: &FilmDef, tl: &Timeline, t: f32, dl: &mut DrawList, meta: &mut Vec<f32>) {
    dl.clear();
    let f = eval(def, tl, t);
    let sc = &def.scenes[f.scene];
    let st = &tl.scenes[f.scene];
    let v = View { cx: f.cam[0], cy: f.cam[1], z: f.cam[2].max(0.05) };
    meta.clear();
    meta.resize(META_HEAD, 0.0);
    meta[0] = f.scene as f32;
    meta[1] = f.ts;
    meta[2] = t.clamp(0.0, tl.total);
    meta[3] = tl.total;
    meta[4] = st.start;
    meta[5] = st.end;
    let mut order: Vec<usize> = (0..sc.props.len()).collect();
    order.sort_by_key(|&i| (sc.props[i].layer, i));
    let mut mounts = 0usize;
    for &i in &order {
        let p = &sc.props[i];
        let s = &f.props[i];
        if let Some(m) = &p.mount {
            if mounts < MAX_MOUNTS && s.alpha > 0.004 {
                let id = dl.intern(&m.id) as f32;
                let rect = [v.x(m.dock[0]), v.y(m.dock[1]), m.dock[2] * v.z, m.dock[3] * v.z];
                meta.extend_from_slice(&[rect[0], rect[1], rect[2], rect[3], s.alpha, id, i as f32, m.grabbable as u32 as f32]);
                mounts += 1;
            }
            continue;
        }
        let Some(ab) = alpha_bits(s.alpha) else { continue };
        let tone = p.tone as f32;
        let z = v.z;
        match p.form {
            FormKind::Box => {
                let (w, h) = (s.size[0] * z, s.size[1] * z);
                dl.push([v.x(s.pos[0]) - w / 2.0, v.y(s.pos[1]) - h / 2.0, w, h, RRECT, tone, ab as f32, s.rad * z]);
            }
            FormKind::Disc => {
                let d = s.rad.max(0.0) * 2.0 * z;
                dl.push([v.x(s.pos[0]) - d / 2.0, v.y(s.pos[1]) - d / 2.0, d, d, DOT, tone, ab as f32, 0.0]);
            }
            FormKind::Ring => {
                let (w, h) = (s.size[0] * z, s.size[1] * z);
                dl.push([v.x(s.pos[0]) - w / 2.0, v.y(s.pos[1]) - h / 2.0, w, h, RING, tone, ab as f32, s.rad * z]);
            }
            FormKind::Line | FormKind::Arrow => {
                let shape = if p.form == FormKind::Line { LINE } else { ARROW };
                dl.push([v.x(s.pos[0]), v.y(s.pos[1]), s.size[0] * z, s.size[1] * z, shape, tone, ab as f32, s.stroke * z]);
            }
            FormKind::Hatch => {
                let (w, h) = (s.size[0] * z, s.size[1] * z);
                dl.push([v.x(s.pos[0]) - w / 2.0, v.y(s.pos[1]) - h / 2.0, w, h, HATCH, tone, ab as f32, 0.5 * z]);
            }
            FormKind::Label => label(dl, &v, p, s, ab),
        }
        // rings pulsing out of the prop
        for &(age, dur) in &f.rings[i] {
            let u = (age / dur).clamp(0.0, 1.0);
            let base = match p.form {
                FormKind::Disc => s.rad,
                _ => s.size[0].max(s.size[1]) / 2.0,
            };
            let r = (base.max(0.3) * (1.0 + 1.6 * u)) * z;
            if let Some(rb) = alpha_bits(s.alpha * (1.0 - u) * 0.9) {
                dl.push([v.x(s.pos[0]) - r, v.y(s.pos[1]) - r, 2.0 * r, 2.0 * r, RING, ACCENT, rb as f32, r]);
            }
        }
        // closed-form particles
        if let Some(e) = &p.emit {
            for (bi, &(age, n)) in f.bursts[i].iter().enumerate() {
                for k in 0..n {
                    let (r1, r2, r3) = (hash(e.seed, k, bi as u32), hash(e.seed ^ 0xA5A5, k, bi as u32), hash(e.seed ^ 0x5A5A, k, bi as u32));
                    let life = e.life * (0.6 + 0.4 * r3);
                    if age >= life {
                        continue;
                    }
                    let ang = -std::f32::consts::FRAC_PI_2 + (r1 - 0.5) * e.spread;
                    let sp = e.speed * (0.4 + 0.6 * r2);
                    let x = s.pos[0] + ang.cos() * sp * age;
                    let y = s.pos[1] + ang.sin() * sp * age + 0.5 * e.gravity * age * age;
                    if let Some(pb) = alpha_bits(s.alpha * (1.0 - age / life)) {
                        let d = 0.16 * z;
                        dl.push([v.x(x) - d / 2.0, v.y(y) - d / 2.0, d, d, DOT, tone, pb as f32, 0.0]);
                    }
                }
            }
        }
    }
    // dissolve in from the ground at the scene start
    if sc.fade_in > 0.0 && f.ts < sc.fade_in {
        if let Some(ab) = alpha_bits(1.0 - f.ts / sc.fade_in) {
            dl.push([0.0, 0.0, FRAME_W, FRAME_H, RRECT, GROUND, ab as f32, 0.0]);
        }
    }
    meta[6] = mounts as f32;
}

fn label(dl: &mut DrawList, v: &View, p: &PropDef, s: &PropS, ab: u32) {
    let total: usize = p.text.chars().count();
    let shown = ((s.reveal.clamp(0.0, 1.0) * total as f32).ceil() as usize).min(total);
    let typing = s.reveal > 0.0 && s.reveal < 1.0;
    let align = match p.align {
        1 => ALIGN_CENTRE,
        2 => ALIGN_RIGHT,
        _ => 0,
    };
    let mono = if p.mono { F_MONO } else { 0 };
    let lh = s.em * LINE_H;
    let lines: Vec<&str> = p.text.split('\n').collect();
    let mut used = 0usize; // characters (and newlines) before this line
    for (i, line) in lines.iter().enumerate() {
        let n = line.chars().count();
        if shown <= used && i > 0 {
            break;
        }
        let take = shown.saturating_sub(used).min(n);
        let mut text: String = line.chars().take(take).collect();
        if typing && shown >= used && shown <= used + n {
            text.push('_');
        }
        used += n + 1;
        let tone = if (s.lit - i as f32).abs() < 0.5 { ACCENT } else { p.tone as f32 };
        dl.push_label(v.x(s.pos[0]), v.y(s.pos[1] + lh * i as f32), s.em * v.z, if s.size[0] > 1.0 { s.size[0] * v.z } else { 0.0 }, &text, tone, ab | align | mono);
    }
}
