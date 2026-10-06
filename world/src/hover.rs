//! The hover affordance of a shelf book: it lifts off the shelf, tilts toward the viewer, its cover cracks open a few degrees (a page
//! block shows behind it) and the free edge gets an amber rim, then it settles back with a spring when the pointer leaves.
//!
//! Model. `HoverFocus` is a singleton entity; the host sets the exclusive relation `(Hovered, book)` on it (`hover_set`: the pointer's
//! hit region or the keyboard-selected book, one source of truth). Every article has a `Hover` component with two springs, `amount`
//! (lift, tilt, rim) and `crack` (the cover angle), each with its own omega and zeta read from `HoverTune` (a component on the
//! `Magazine` prefab in world/scene/10-prefabs.flecs, hot reloadable). `Nudge` (`hover_nudge`) is the touch-device invitation: one slow
//! open and close of the cover, driven through the same springs.
//!
//! Output. Rows of the cover and of its page block are written into a small buffer (`hover_state_ptr`); the host copies each entry's rows
//! into the GPU object buffer. A book is emitted while its springs move, once more when it comes to rest (the exact shelf row), and its
//! page block is parked once while the book is out (the book module's card path draws the cover then, see `book::card_row`).
//! Kinematics: tilt about the bottom edge (it never sinks into the shelf), lift up and out, the cover turns about the spine (left edge);
//! the page block follows the tilt and lift. Spacing: neighbours are 0.62 m apart for a 0.42 m cover, the crack swings the free edge by
//! 0.42 sin(crack) toward the viewer only, and the amount is clamped to 1.2, so books never meet.
use crate::book::{mul3, step, Ch, BookClock, Shelf};
use crate::components::{Article, HoverTune};
use flecs_ecs::prelude::*;
use std::cell::{Cell, RefCell};

type M3 = [[f32; 3]; 3];

pub const HOVER_MAX: usize = 32;
const HDR: usize = 4;
const ENTRY: usize = 4 + 56;
pub const HOVER_LEN: usize = HDR + HOVER_MAX * ENTRY;
const PARK_Y: f32 = 50.0;

thread_local! {
    static OUT: RefCell<[f32; HOVER_LEN]> = const { RefCell::new([0.0; HOVER_LEN]) };
    static FOCUS: Cell<u64> = const { Cell::new(0) };
    static TUNE: Cell<Option<HoverTune>> = const { Cell::new(None) };
}

/// The hover state of one book. `sent`: 0 the host must be sent the rows, 1 the settled rows are on the GPU, 2 the page block is parked.
#[derive(Component, Clone, Copy)]
pub struct Hover {
    pub amount: Ch,
    pub crack: Ch,
    /// seconds into the invitation, negative when none
    pub nudge: f32,
    pub sent: u8,
}
impl Default for Hover {
    fn default() -> Self {
        Hover { amount: Ch::default(), crack: Ch::default(), nudge: -1.0, sent: 1 }
    }
}

/// Relation `(Hovered, book)` on the `HoverFocus` singleton, exclusive.
#[derive(Component, Clone, Copy, Default)]
pub struct Hovered;

/// The tunables of this frame (read once per frame from the `Magazine` prefab, so a hot reload applies at once).
pub fn tune_of(_w: &World) -> HoverTune {
    TUNE.with(|t| t.get()).unwrap_or_default()
}

pub fn install(world: &World, spring_ph: EntityView, pack_ph: EntityView) {
    world.component::<Hover>();
    world.component::<Hovered>();
    world.entity_from_id(world.component_id::<Hovered>()).add_trait::<flecs::Exclusive>();
    let focus = world.entity_named("HoverFocus");
    FOCUS.with(|f| f.set(*focus.id()));

    world.system_named::<()>("HoverFrame").kind(spring_ph).run(|mut it| {
        while it.next() {
            let w = it.world();
            let t = w.try_lookup("Magazine").and_then(|m| m.try_cloned::<&HoverTune>()).unwrap_or_default();
            TUNE.with(|c| c.set(Some(t)));
            OUT.with(|o| {
                let mut o = o.borrow_mut();
                o[0] = 0.0;
                o[1] = 0.0;
            });
        }
    });

    world.system_named::<(&mut Hover, &BookClock)>("HoverSpring").kind(spring_ph).each_iter(|it, row, (hv, clk)| {
        let w = it.world();
        let dt = it.delta_time();
        let t = tune_of(&w);
        let id = *it.entity(row).id();
        let focus = w.entity_from_id(FOCUS.with(|f| f.get()));
        let hovered = focus.target(w.component_id::<Hovered>(), 0).is_some_and(|b| *b.id() == id);
        // a book that is out of the shelf is not hovered (the card path owns it; the springs fade the hover pose out)
        let mut u = if hovered && clk.phase < 0.5 { 1.0 } else { 0.0 };
        if hv.nudge >= 0.0 {
            hv.nudge += dt;
            let p = hv.nudge / t.nudge_s.max(0.1);
            if p >= 1.0 {
                hv.nudge = -1.0;
            } else {
                u = f32::max(u, t.nudge_amount * (std::f32::consts::PI * p).sin());
            }
        }
        hv.amount.omega = t.omega;
        hv.amount.zeta = t.zeta;
        hv.amount.to = u;
        hv.amount.lo = 0.0;
        hv.crack.omega = t.crack_omega;
        hv.crack.zeta = t.crack_zeta;
        hv.crack.to = u * t.crack_deg.to_radians();
        hv.crack.lo = 0.0;
        let _ = step(&mut hv.amount, dt);
        let _ = step(&mut hv.crack, dt);
        for c in [&mut hv.amount, &mut hv.crack] {
            // land exactly: a rest state is the shelf row bit for bit
            if (c.x - c.to).abs() < 1e-4 && c.v.abs() < 1e-3 {
                c.x = c.to;
                c.v = 0.0;
            }
        }
    });

    world.system_named::<(&mut Hover, &Shelf, &BookClock)>("HoverPack").kind(pack_ph).each_iter(|it, _, (hv, shelf, clk)| {
        if shelf.obj < 0.0 {
            return;
        }
        let t = tune_of(&it.world());
        let parked = clk.phase > 0.5;
        let busy = !parked && (hv.amount.x != hv.amount.to || hv.amount.v != 0.0 || hv.crack.x != hv.crack.to || hv.crack.v != 0.0);
        let state = if parked { 2 } else if busy { 0 } else { 1 };
        if state == hv.sent && !busy {
            return;
        }
        OUT.with(|o| {
            let mut o = o.borrow_mut();
            let n = o[0] as usize;
            if n >= HOVER_MAX {
                return; // sent stays stale: retried next frame
            }
            let at = HDR + n * ENTRY;
            let (cover, pages) = if parked { (shelf.row, parked_row(&shelf.pages)) } else { rows(&t, shelf, hv.amount.x, hv.crack.x) };
            let mask = if parked { 0.0 } else { 1.0 } + if shelf.pages_obj >= 0.0 { 2.0 } else { 0.0 };
            o[at] = shelf.obj;
            o[at + 1] = shelf.pages_obj;
            o[at + 2] = mask;
            o[at + 4..at + 32].copy_from_slice(&cover);
            o[at + 32..at + 60].copy_from_slice(&pages);
            o[0] = (n + 1) as f32;
            if busy {
                o[1] = 1.0;
            }
            hv.sent = state;
        });
    });
}

fn parked_row(row: &[f32; 28]) -> [f32; 28] {
    let mut r = *row;
    r[1] -= PARK_Y;
    r
}

fn transpose(a: M3) -> M3 {
    [[a[0][0], a[1][0], a[2][0]], [a[0][1], a[1][1], a[2][1]], [a[0][2], a[1][2], a[2][2]]]
}
fn mulv(a: M3, v: [f32; 3]) -> [f32; 3] {
    [0, 1, 2].map(|i| a[i][0] * v[0] + a[i][1] * v[1] + a[i][2] * v[2])
}
fn rx(t: f32) -> M3 {
    let (s, c) = t.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}
fn ry(t: f32) -> M3 {
    let (s, c) = t.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}
fn add(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}
fn sub(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}
/// The stored rotation rows of a row (local axes in world space) as a matrix S; local to world is S transposed.
fn stored(row: &[f32; 28]) -> M3 {
    [[row[8], row[9], row[10]], [row[12], row[13], row[14]], [row[16], row[17], row[18]]]
}
fn set_rot(row: &mut [f32; 28], r: M3) {
    let s = transpose(r);
    for i in 0..3 {
        // the w of each rotation row is the material (roughness, metallic, spare): untouched
        row[8 + 4 * i..11 + 4 * i].copy_from_slice(&s[i]);
    }
}

/// The cover row and the page block row of a book at hover amount `a` (lift, tilt, rim) and cover angle `crack` (rad).
pub fn rows(t: &HoverTune, shelf: &Shelf, a: f32, crack: f32) -> ([f32; 28], [f32; 28]) {
    if a == 0.0 && crack == 0.0 {
        return (shelf.row, shelf.pages);
    }
    let a = a.clamp(0.0, 1.2);
    let row = &shelf.row;
    let r0 = transpose(stored(row));
    let d = rx(t.tilt_deg.to_radians() * a);
    let r1 = mul3(d, r0);
    let c0 = [row[0], row[1], row[2]];
    let (hx, hy) = (row[4], row[5]);
    // tilt about the bottom edge, then lift up and out
    let b = add(c0, mulv(r0, [0.0, -hy, 0.0]));
    let lift = [0.0, t.lift_y * a, t.lift_z * a];
    let xf = |p: [f32; 3]| add(add(b, mulv(d, sub(p, b))), lift);

    // the cover turns about the spine: the free edge (right) comes toward the viewer
    let spine = xf(add(c0, mulv(r0, [-hx, 0.0, 0.0])));
    let rc = mul3(r1, ry(-crack));
    let mut cover = *row;
    cover[0..3].copy_from_slice(&add(spine, mulv(rc, [hx, 0.0, 0.0])));
    set_rot(&mut cover, rc);
    // rim: alb.w is the amount, r2.w the intensity (shader: kind 2)
    cover[19] = t.rim;
    cover[23] = a.min(1.0);

    let mut pages = shelf.pages;
    let pp = [pages[0], pages[1], pages[2]];
    pages[0..3].copy_from_slice(&xf(pp));
    set_rot(&mut pages, r1);
    (cover, pages)
}

// ---- host glue (exported in lib.rs) ----

fn article(w: &World, index: i32) -> Option<u64> {
    if index < 0 {
        return None;
    }
    let mut found = None;
    w.new_query::<&Article>().each_entity(|e, a| {
        if a.index == index as u32 {
            found = Some(*e.id());
        }
    });
    found
}

/// Attach the hover state to an article.
pub fn attach(world: &World, id: u64) {
    world.entity_from_id(id).set(Hover::default());
}

/// Hot reload: the shelf rows changed, send them again.
pub fn resend(world: &World, id: u64) {
    let e = world.entity_from_id(id);
    if let Some(mut h) = e.try_cloned::<&Hover>() {
        h.sent = 0;
        e.set(h);
    }
}

/// The hovered book (article index), or none (negative): the pointer's hit region or the keyboard selection.
pub fn set(index: i32) {
    let Some(w) = crate::reader::world() else { return };
    let focus = w.entity_from_id(FOCUS.with(|f| f.get()));
    let rel = w.component_id::<Hovered>();
    match article(&w, index) {
        Some(id) => {
            focus.add((rel, w.entity_from_id(id).id()));
        }
        None => {
            if let Some(t) = focus.target(rel, 0) {
                focus.remove((rel, t.id()));
            }
        }
    }
}

/// Start the invitation on one book (one slow open and close), or cancel every invitation (negative).
pub fn nudge(index: i32) {
    let Some(w) = crate::reader::world() else { return };
    let target = article(&w, index);
    w.new_query::<&Article>().each_entity(|e, _| {
        if let Some(mut h) = e.try_cloned::<&Hover>() {
            h.nudge = if Some(*e.id()) == target { 0.0 } else { -1.0 };
            e.set(h);
        }
    });
}

pub fn state_ptr() -> *const f32 {
    OUT.with(|o| o.as_ptr() as *const f32)
}
