//! The icon set of the museum: stroke paths on a 24 unit grid (the Lucide drawing convention: round caps and joins), flattened into
//! round-capped `line` items of the draw list. One table, so every exhibit draws the same glyphs: `draw(dl, "file", cx, cy, size, ..)`.
//! A path is `M` (move), `L` (line), `C` (cubic), `Z` (close to the subpath start) and `Arc` (centre, radius, start and end angle in
//! degrees, screen orientation: 0 is +x, 90 is +y, the sweep follows the sign of end - start).
use super::draw::*;
#[path = "icons_gen.rs"]
mod gen;

#[derive(Clone, Copy)]
pub enum Cmd {
    M(f32, f32),
    L(f32, f32),
    C(f32, f32, f32, f32, f32, f32),
    Z,
    Arc(f32, f32, f32, f32, f32),
}
use Cmd::*;

pub struct Icon {
    pub name: &'static str,
    /// stroke width relative to the standard one (solid glyphs such as play use a heavy stroke)
    pub weight: f32,
    pub path: &'static [Cmd],
}

pub const ICONS: &[Icon] = &[
    // a document with a folded corner: a source file
    Icon { name: "file", weight: 1.0, path: &[M(14.0, 3.0), L(7.0, 3.0), C(5.9, 3.0, 5.0, 3.9, 5.0, 5.0), L(5.0, 19.0), C(5.0, 20.1, 5.9, 21.0, 7.0, 21.0), L(17.0, 21.0), C(18.1, 21.0, 19.0, 20.1, 19.0, 19.0), L(19.0, 8.0), Z, M(14.0, 3.0), L(14.0, 8.0), L(19.0, 8.0)] },
    // a shell prompt: a compile or run action
    Icon { name: "terminal", weight: 1.0, path: &[M(4.0, 17.0), L(10.0, 11.0), L(4.0, 5.0), M(12.0, 19.0), L(20.0, 19.0)] },
    // a bolt: a proc macro
    Icon { name: "bolt", weight: 1.0, path: &[M(13.0, 2.0), L(4.0, 14.0), L(11.5, 14.0), L(10.5, 22.0), L(20.0, 10.0), L(12.5, 10.0), Z] },
    // play in a circle: a step that runs a program
    Icon { name: "play-circle", weight: 1.0, path: &[Arc(12.0, 12.0, 10.0, 0.0, 360.0), M(10.0, 8.0), L(16.0, 12.0), L(10.0, 16.0), Z] },
    // a package: the final artifact
    Icon { name: "box", weight: 1.0, path: &[M(21.0, 8.0), L(12.0, 3.0), L(3.0, 8.0), L(3.0, 16.0), L(12.0, 21.0), L(21.0, 16.0), Z, M(3.0, 8.0), L(12.0, 13.0), L(21.0, 8.0), M(12.0, 13.0), L(12.0, 21.0)] },
    Icon { name: "check", weight: 1.15, path: &[M(5.0, 12.5), L(10.0, 17.0), L(19.0, 7.5)] },
    // clockwise arrows: rebuilding
    Icon { name: "refresh", weight: 1.0, path: &[Arc(12.0, 12.0, 9.0, 0.0, 270.0), C(14.52, 3.0, 16.93, 4.0, 18.74, 5.74), L(21.0, 8.0), M(21.0, 3.0), L(21.0, 8.0), L(16.0, 8.0)] },
    // counter-clockwise arrow: reset
    Icon { name: "reset", weight: 1.0, path: &[Arc(12.0, 12.0, 9.0, 180.0, -90.0), C(9.48, 3.0, 7.07, 4.0, 5.26, 5.74), L(3.0, 8.0), M(3.0, 3.0), L(3.0, 8.0), L(8.0, 8.0)] },
    // solid transport glyphs: heavy strokes close the interior
    Icon { name: "play", weight: 2.4, path: &[M(9.0, 6.5), L(17.5, 12.0), L(9.0, 17.5), Z] },
    Icon { name: "pause", weight: 2.6, path: &[M(9.0, 7.0), L(9.0, 17.0), M(15.0, 7.0), L(15.0, 17.0)] },
    Icon { name: "step", weight: 2.0, path: &[M(7.0, 7.0), L(14.0, 12.0), L(7.0, 17.0), Z, M(17.5, 6.5), L(17.5, 17.5)] },
];

pub fn find(name: &str) -> Option<&'static Icon> {
    ICONS.iter().find(|i| i.name == name)
}

/// Flatten a path into segments (x0, y0, x1, y1) on the 24 grid.
fn flatten(path: &[Cmd], out: &mut Vec<[f32; 4]>) {
    let (mut cur, mut start) = ((0.0f32, 0.0f32), (0.0f32, 0.0f32));
    let mut seg = |a: (f32, f32), b: (f32, f32)| out.push([a.0, a.1, b.0, b.1]);
    for c in path {
        match *c {
            M(x, y) => {
                cur = (x, y);
                start = cur;
            }
            L(x, y) => {
                seg(cur, (x, y));
                cur = (x, y);
            }
            C(x1, y1, x2, y2, x, y) => {
                const N: usize = 4;
                let mut p = cur;
                for k in 1..=N {
                    let t = k as f32 / N as f32;
                    let m = 1.0 - t;
                    let q = (m * m * m * cur.0 + 3.0 * m * m * t * x1 + 3.0 * m * t * t * x2 + t * t * t * x, m * m * m * cur.1 + 3.0 * m * m * t * y1 + 3.0 * m * t * t * y2 + t * t * t * y);
                    seg(p, q);
                    p = q;
                }
                cur = (x, y);
            }
            Z => {
                if cur != start {
                    seg(cur, start);
                }
                cur = start;
            }
            Arc(cx, cy, r, a0, a1) => {
                let n = (((a1 - a0).abs() / 30.0).ceil() as usize).max(2);
                let at = |a: f32| (cx + r * a.to_radians().cos(), cy + r * a.to_radians().sin());
                let mut p = at(a0);
                for k in 1..=n {
                    let q = at(a0 + (a1 - a0) * k as f32 / n as f32);
                    seg(p, q);
                    p = q;
                }
                cur = p;
                start = at(a0);
            }
        }
    }
}

/// Draw icon `name` centred at (cx, cy), `size` em square, rotated `rot` degrees clockwise, with opacity `a`. An unknown name draws nothing.
pub fn draw(dl: &mut DrawList, name: &str, cx: f32, cy: f32, size: f32, rot: f32, tone: f32, a: f32) {
    if a <= 0.0 {
        return;
    }
    // file-type icons (Material Icon Theme, generated filled triangles): the set draws its own colours, `tone == ACCENT` means "lit": full colour
    if let Some(i) = gen::FILE_ICONS.iter().position(|n| *n == name) {
        dl.push([cx - size / 2.0, cy - size / 2.0, size, size, ICON, INK, ((if tone == ACCENT { F_SELECTED } else { 0 }) | DrawList::alpha_flag(a)) as f32, i as f32]);
        return;
    }
    let Some(icon) = find(name) else { return };
    let mut segs = Vec::with_capacity(24);
    flatten(icon.path, &mut segs);
    let k = size / 24.0;
    let stroke = size * (2.25 / 24.0) * icon.weight;
    let (s, c) = rot.to_radians().sin_cos();
    let map = |x: f32, y: f32| {
        let (dx, dy) = ((x - 12.0) * k, (y - 12.0) * k);
        (cx + dx * c - dy * s, cy + dx * s + dy * c)
    };
    for g in segs {
        let (p, q) = (map(g[0], g[1]), map(g[2], g[3]));
        dl.line_a(p.0, p.1, q.0 - p.0, q.1 - p.1, stroke, tone, a);
    }
}
