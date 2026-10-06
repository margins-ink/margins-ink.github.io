//! The book: a choreographed take-off-the-shelf, carry, open and the mirrored close (spec: docs/BOOK.md).
//!
//! Model. The article entity IS the book. Its state is an exclusive relation `(BookPhase, X)` with X one of the tags in `phase`
//! (OnShelf, Lifting, Carrying, Opening, Reading, Closing), plus one component per channel family, each a set of damped springs
//! with its own omega and zeta (data, `BookRig` holds the tuning):
//!   `BookPose`      lift, carry, face           (where the cover board object is: off the shelf, along the arc, turned to the reader)
//!   `Hinge`         the front cover about the spine, 0 closed .. 1 open, with a contact (landing and closing impacts)
//!   `SpreadReveal`  the first spread under the cover (gutter shade, ink)
//!   `Backdrop`      world dim and camera dolly
//!   `BookClock`     seconds in the current phase, numeric mirror of the phase
//! Intent is the tag `WantOpen`; `BookActive` marks the one book being simulated (systems cost nothing for the others).
//! Parts (prefabs `CoverFront`, `CoverBack`, `Spine`, `PageBlock`, `FlutterSheet`, instances are children of the book while it is open)
//! carry thickness and the follow-springs of the sheets that flutter under the cover.
//!
//! Pipeline (custom phases chained by DependsOn, all after OnUpdate): BookSelect (state machine, targets) -> BookSpring (integrate,
//! contacts, crossing events) -> BookPack (state buffer for the renderer). Observers on phase entry emit the sound events.
//! Time is only `it.delta_time()`: every spring is the exact solution, so any frame rate gives the same motion, and every transition
//! keeps the current position and velocity of every channel, so a reversal at any instant is continuous.
//!
//! Hand-off: the cover board is the shelf card (a 3D box, rotates freely) in Lifting and Carrying. Carrying ends when the card has
//! arrived exactly at the reading pose (the `carry` channel clamps at 1), `Hinge.pages` becomes 1, the card is parked and the page
//! renderer draws the closed book (identical pose), then the cover swings. Closing is the mirror.
use crate::components::Article;
use crate::Output;
use flecs_ecs::prelude::*;
use std::cell::RefCell;
use std::collections::VecDeque;

thread_local! {
    // part prefab ids by name: the prefabs live in the module's scope, so a root `lookup(name)` cannot find them
    static PART_PROTOS: RefCell<Vec<(&'static str, u64)>> = const { RefCell::new(Vec::new()) };
}

pub const EV_SOUND: u32 = 11;
pub const EV_PHASE: u32 = 12;
const EV_OPENED: u32 = 1;

/// Sound ids carried in an `EV_SOUND` event: arg = id << 8 | velocity (0..255). Ids match the audio crate kinds by name
/// (grab, whoosh -> scroll today, paperTurn, open, close, place); the mapping lives in World.svelte.
pub const SND_GRAB: u32 = 0;
pub const SND_WHOOSH: u32 = 1;
pub const SND_PAPER: u32 = 2;
pub const SND_OPEN: u32 = 3;
pub const SND_CLOSE: u32 = 4;
pub const SND_PLACE: u32 = 5;

// ---- state buffer slots (shared with reader.rs STATE and world.ts RS) ----
pub const S_T: usize = 0;
pub const S_WANT: usize = 1;
pub const S_LIFT: usize = 6;
pub const S_DOLLY: usize = 7;
pub const S_CARD: usize = 12;
pub const S_PHASE: usize = 40;
pub const S_CARRY: usize = 41;
pub const S_FACE: usize = 42;
pub const S_HINGE: usize = 43;
pub const S_REVEAL: usize = 44;
pub const S_DIM: usize = 45;
pub const S_CARD_ON: usize = 46;
pub const S_PAGES_ON: usize = 47;
pub const S_CARD_LIGHT: usize = 48;
pub const S_CURL: usize = 49;
pub const S_BANK: usize = 50;
pub const S_FLUTTER: usize = 52;

/// One damped spring toward `to`, optionally with hard stops (`lo`, `hi`) that bounce with restitution `rest`.
#[derive(Clone, Copy)]
pub struct Ch {
    pub x: f32,
    pub v: f32,
    pub to: f32,
    pub omega: f32,
    pub zeta: f32,
    pub lo: f32,
    pub hi: f32,
    pub rest: f32,
}
impl Default for Ch {
    fn default() -> Self {
        Ch { x: 0.0, v: 0.0, to: 0.0, omega: 10.0, zeta: 1.0, lo: -1e9, hi: 1e9, rest: 0.0 }
    }
}
impl Ch {
    fn new(omega: f32, zeta: f32) -> Self {
        Ch { omega, zeta, ..Default::default() }
    }
    fn bounded(self, lo: f32, hi: f32, rest: f32) -> Self {
        Ch { lo, hi, rest, ..self }
    }
    fn at(self, x: f32) -> Self {
        Ch { x, to: x, v: 0.0, ..self }
    }
}

/// Impact speeds of the last step (0 = no contact): at the upper and the lower stop.
#[derive(Clone, Copy, Default)]
struct Contact {
    hi: f32,
    lo: f32,
}

/// Exact step of x'' = -2 zeta omega x' - omega^2 (x - to), any dt, then the stops.
fn step(c: &mut Ch, dt: f32) -> Contact {
    let d = c.x - c.to;
    let w = c.omega;
    if c.zeta >= 0.999 {
        let e = (-w * dt).exp();
        let k = c.v + w * d;
        c.x = c.to + (d + k * dt) * e;
        c.v = (c.v - w * k * dt) * e;
    } else {
        let z = c.zeta;
        let wd = w * (1.0 - z * z).sqrt();
        let e = (-z * w * dt).exp();
        let (s, co) = (wd * dt).sin_cos();
        let b = (c.v + z * w * d) / wd;
        c.x = c.to + e * (d * co + b * s);
        c.v = e * (c.v * co - ((z * w * c.v + w * w * d) / wd) * s);
    }
    let mut hit = Contact::default();
    if c.x > c.hi {
        let imp = c.v.max(0.0);
        c.x = c.hi;
        c.v = if imp > 0.25 { -c.rest * imp } else { 0.0 };
        if imp > 0.25 {
            hit.hi = imp;
        }
    } else if c.x < c.lo {
        let imp = (-c.v).max(0.0);
        c.x = c.lo;
        c.v = if imp > 0.25 { c.rest * imp } else { 0.0 };
        if imp > 0.25 {
            hit.lo = imp;
        }
    }
    hit
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

// ---- components ----

/// Where the cover board object is. lift: off the shelf (negative = the small pull-back of the anticipation), carry: 0 shelf .. 1 reading
/// pose along the arc, face: 0 leaning .. 1 turned square to the reader.
#[derive(Component, Clone, Copy, Default)]
pub struct BookPose {
    pub lift: Ch,
    pub carry: Ch,
    pub face: Ch,
}
/// The front cover about the spine: a.x 0 closed .. 1 open (the page renderer maps it to the leaf angle), `pages` 1 once the page renderer
/// owns the book (the card is parked), `landed` latches the landing event.
#[derive(Component, Clone, Copy, Default)]
pub struct Hinge {
    pub a: Ch,
    pub pages: f32,
}
/// The first spread revealed under the cover: 0 hidden .. 1 fully there (gutter shade and the ink arriving).
#[derive(Component, Clone, Copy, Default)]
pub struct SpreadReveal {
    pub a: Ch,
}
/// The world around the book: dim 0 none .. 1 full, dolly 0 shelf camera .. 1 reading camera (the renderer blends camera poses by it).
#[derive(Component, Clone, Copy, Default)]
pub struct Backdrop {
    pub dim: Ch,
    pub dolly: Ch,
}
/// Seconds in the current phase; `phase` is the numeric mirror of the relation target (0 OnShelf .. 5 Closing) for packing.
#[derive(Component, Clone, Copy, Default)]
pub struct BookClock {
    pub t: f32,
    pub phase: f32,
}
/// The shelf pose of the book's magazine row (28 floats, the shader's object layout), its object index and its lean.
#[derive(Component, Clone, Copy, Default)]
pub struct Shelf {
    pub obj: f32,
    pub lean: f32,
    pub row: [f32; 28],
}
/// A part of the book. kind 0 cover front, 1 cover back, 2 spine, 3 page block, 4 flutter sheet; thick in metres; share: fraction of the
/// cover's hinge it follows; flutter: peak extra angle (hinge units) mid-swing; slot: index into the flutter slots of the state buffer.
#[derive(Component, Clone, Copy, Default)]
pub struct Part {
    pub kind: f32,
    pub thick: f32,
    pub share: f32,
    pub flutter: f32,
    pub slot: f32,
    pub owner: u64,
}
/// A part's own follow-spring.
#[derive(Component, Clone, Copy, Default)]
pub struct PartAngle {
    pub a: Ch,
}

/// Tuning (metres, seconds, radians; springs are omega rad/s and zeta). One singleton; edit and rebuild, or move to Flecs script later.
#[derive(Component, Clone, Copy)]
pub struct BookRig {
    pub lift_omega: f32,
    pub lift_zeta: f32,
    pub carry_omega: f32,
    pub face_omega: f32,
    pub face_zeta: f32,
    pub hinge_omega: f32,
    pub reveal_omega: f32,
    pub dim_omega: f32,
    pub dolly_omega: f32,
    /// seconds the anticipation pull-back lasts and how far (lift units, negative target)
    pub anticip_s: f32,
    pub anticip_dip: f32,
    /// lift units to metres: out of the shelf (z), up (y), and the top edge tilt (rad)
    pub lift_z: f32,
    pub lift_y: f32,
    pub tilt: f32,
    /// arc bulge at mid carry, metres: toward the viewer (z) and up (y)
    pub bulge_z: f32,
    pub bulge_y: f32,
    /// roll radians per unit of carry speed, and its limit
    pub bank_gain: f32,
    pub bank_max: f32,
    /// the carry spring aims this far past 1 and stops at 1: a finite-time soft landing, not an asymptote
    pub carry_aim: f32,
    pub hinge_aim: f32,
    /// cover curl: radians the free edge trails per unit of hinge speed, and its limit
    pub curl_gain: f32,
    pub curl_max: f32,
    pub thickness: f32,
    pub dim_lift: f32,
    pub dim_carry: f32,
    pub dim_open: f32,
}
impl Default for BookRig {
    fn default() -> Self {
        BookRig {
            lift_omega: 16.0,
            lift_zeta: 0.55,
            carry_omega: 8.5,
            face_omega: 9.0,
            face_zeta: 0.8,
            hinge_omega: 9.0,
            reveal_omega: 8.0,
            dim_omega: 3.5,
            dolly_omega: 4.0,
            anticip_s: 0.09,
            anticip_dip: 0.10,
            lift_z: 0.07,
            lift_y: 0.025,
            tilt: 0.10,
            bulge_z: 0.10,
            bulge_y: 0.04,
            bank_gain: 0.035,
            bank_max: 0.12,
            carry_aim: 1.012,
            hinge_aim: 1.06,
            curl_gain: 0.55,
            curl_max: 0.6,
            thickness: 0.012,
            dim_lift: 0.10,
            dim_carry: 0.55,
            dim_open: 0.90,
        }
    }
}
/// Where the book reads: centre of the right sheet (cx, cy, cz) and its half size, the spine x, the sheet plane z, the page bow, narrow class.
/// `ready` is false from `begin` until the host has sent the pose of the article being opened.
#[derive(Component, Clone, Copy, Default)]
pub struct ReadPose {
    pub cx: f32,
    pub cy: f32,
    pub cz: f32,
    pub hw: f32,
    pub hh: f32,
    pub spine_x: f32,
    pub plane_z: f32,
    pub bow: f32,
    pub single: f32,
    pub ready: f32,
}
/// Output ring for the host (kind << 24 | arg).
#[derive(Component, Clone, Default)]
pub struct BookEvents {
    pub q: VecDeque<u32>,
}

macro_rules! tags {
    ($($n:ident),*) => { $( #[derive(Component, Clone, Copy, Default)] pub struct $n; )* };
}
tags!(WantOpen, BookActive);
/// Relation `(BookPhase, phase::X)`, exclusive.
#[derive(Component, Clone, Copy, Default)]
pub struct BookPhase;
pub mod phase {
    use flecs_ecs::prelude::*;
    tags!(OnShelf, Lifting, Carrying, Opening, Reading, Closing);
}
#[derive(Component)]
pub struct BookModule;

#[derive(Clone, Copy, PartialEq, Eq)]
enum Ph {
    OnShelf = 0,
    Lifting = 1,
    Carrying = 2,
    Opening = 3,
    Reading = 4,
    Closing = 5,
}
impl Ph {
    fn from_f(f: f32) -> Ph {
        match f as i32 {
            1 => Ph::Lifting,
            2 => Ph::Carrying,
            3 => Ph::Opening,
            4 => Ph::Reading,
            5 => Ph::Closing,
            _ => Ph::OnShelf,
        }
    }
    fn entity(self, w: &World) -> Entity {
        match self {
            Ph::OnShelf => w.component_id::<phase::OnShelf>(),
            Ph::Lifting => w.component_id::<phase::Lifting>(),
            Ph::Carrying => w.component_id::<phase::Carrying>(),
            Ph::Opening => w.component_id::<phase::Opening>(),
            Ph::Reading => w.component_id::<phase::Reading>(),
            Ph::Closing => w.component_id::<phase::Closing>(),
        }
    }
}

fn emit(w: &World, kind: u32, arg: u32) {
    w.get::<&mut BookEvents>(|e| e.q.push_back(kind << 24 | (arg & 0xffffff)));
}
fn sound(w: &World, id: u32, vel: f32) {
    emit(w, EV_SOUND, id << 8 | (vel.clamp(0.0, 1.0) * 255.0) as u32);
}

/// Next event for the host, if any.
pub fn poll(w: &World) -> Option<u32> {
    w.get::<&mut BookEvents>(|e| e.q.pop_front())
}

fn rig_of(w: &World) -> BookRig {
    w.try_cloned::<&BookRig>().unwrap_or_default()
}

/// Fresh channels at rest on the shelf.
fn channels(r: &BookRig) -> (BookPose, Hinge, SpreadReveal, Backdrop) {
    (
        BookPose {
            lift: Ch::new(r.lift_omega, r.lift_zeta),
            carry: Ch::new(r.carry_omega, 1.0).bounded(-1e9, 1.0, 0.0),
            face: Ch::new(r.face_omega, r.face_zeta),
        },
        Hinge { a: Ch::new(r.hinge_omega, 1.0).bounded(0.0, 1.0, 0.15), pages: 0.0 },
        SpreadReveal { a: Ch::new(r.reveal_omega, 1.0) },
        Backdrop { dim: Ch::new(r.dim_omega, 1.0), dolly: Ch::new(r.dolly_omega, 1.0) },
    )
}

impl Module for BookModule {
    fn module(world: &World) {
        world.component_named::<BookPose>("BookPose");
        world.component_named::<Hinge>("Hinge");
        world.component_named::<SpreadReveal>("SpreadReveal");
        world.component_named::<Backdrop>("Backdrop");
        world.component_named::<BookClock>("BookClock");
        world.component_named::<Shelf>("Shelf");
        world.component_named::<Part>("Part");
        world.component_named::<PartAngle>("PartAngle");
        world.component::<BookRig>();
        world.component::<ReadPose>();
        world.component::<BookEvents>();
        world.component::<WantOpen>();
        world.component::<BookActive>();
        world.component::<BookPhase>();
        world.component::<phase::OnShelf>();
        world.component::<phase::Lifting>();
        world.component::<phase::Carrying>();
        world.component::<phase::Opening>();
        world.component::<phase::Reading>();
        world.component::<phase::Closing>();
        // one phase at a time: adding a new target replaces the old one (OnRemove then OnAdd fire)
        world.entity_from_id(world.component_id::<BookPhase>()).add_trait::<flecs::Exclusive>();

        let rig = BookRig::default();
        world.set(rig);
        world.set(ReadPose::default());
        world.set(BookEvents::default());

        // part prefabs: cover boards, spine, page block, the sheets that flutter under the cover
        let part = world.prefab_named("BookPart").set(Part::default());
        let t = rig.thickness;
        for (name, p) in [
            ("CoverFront", Part { kind: 0.0, thick: t * 0.17, share: 1.0, flutter: 0.0, slot: -1.0, owner: 0 }),
            ("CoverBack", Part { kind: 1.0, thick: t * 0.17, share: 0.0, flutter: 0.0, slot: -1.0, owner: 0 }),
            ("Spine", Part { kind: 2.0, thick: t, share: 0.0, flutter: 0.0, slot: -1.0, owner: 0 }),
            ("PageBlock", Part { kind: 3.0, thick: t * 0.66, share: 0.0, flutter: 0.0, slot: -1.0, owner: 0 }),
            ("FlutterSheet", Part { kind: 4.0, thick: 0.0002, share: 0.0, flutter: 0.16, slot: 0.0, owner: 0 }),
        ] {
            let proto = world.prefab_named(name).is_a(part).set(p);
            PART_PROTOS.with(|v| v.borrow_mut().push((name, *proto.id())));
        }

        let select_ph = world.entity_named("BookSelectPhase").add(flecs::pipeline::Phase).depends_on(flecs::pipeline::OnUpdate);
        let spring_ph = world.entity_named("BookSpringPhase").add(flecs::pipeline::Phase).depends_on(select_ph);
        let pack_ph = world.entity_named("BookPackPhase").add(flecs::pipeline::Phase).depends_on(spring_ph);
        systems(world, select_ph, spring_ph, pack_ph);
        observers(world);
    }
}

/// Install the module and give every article the book components. Called once after the world is built.
pub fn setup(world: &World, articles: &[u64], out: &Output) {
    world.import::<BookModule>();
    let rig = rig_of(world);
    let (p, h, r, b) = channels(&rig);
    for (i, &id) in articles.iter().enumerate() {
        let a = world.entity_from_id(id);
        let obj = out.links.get(i).copied().unwrap_or(u32::MAX);
        let mut shelf = Shelf { obj: -1.0, ..Default::default() };
        if obj != u32::MAX {
            let o = obj as usize * 28;
            shelf.row.copy_from_slice(&out.objs[o..o + 28]);
            shelf.obj = obj as f32;
            // rot row 2 of lean(a) is [0, sin a, cos a]
            shelf.lean = shelf.row[17].atan2(shelf.row[18]);
        }
        a.set(p).set(h).set(r).set(b).set(BookClock::default()).set(shelf);
        a.add((world.component_id::<BookPhase>(), Ph::OnShelf.entity(world)));
    }
}

// ---- state machine ----

fn spread_open(w: &World) -> bool {
    w.try_cloned::<&crate::magazine::Spread>().is_some_and(|s| s.layer > 0.5 || s.f > 0.01)
}

fn systems(world: &World, select_ph: EntityView, spring_ph: EntityView, pack_ph: EntityView) {
    // ---- Select: transitions and per-phase targets. Positions and velocities are never touched, so any transition is continuous. ----
    world
        .system_named::<(&mut BookPose, &mut Hinge, &mut SpreadReveal, &mut Backdrop, &mut BookClock)>("BookSelect")
        .kind(select_ph)
        .with(BookActive::id())
        .each_iter(|it, row, (pose, hinge, rev, back, clk)| {
            let w = it.world();
            let e = it.entity(row);
            let rig = rig_of(&w);
            let rp = w.try_cloned::<&ReadPose>().unwrap_or_default();
            let want = e.has(WantOpen::id());
            let ph = Ph::from_f(clk.phase);
            clk.t += it.delta_time();
            let held = spread_open(&w);
            let mut next = ph;
            match ph {
                Ph::OnShelf => {
                    if want {
                        next = Ph::Lifting;
                    }
                }
                Ph::Lifting => {
                    if !want {
                        next = Ph::Closing;
                    } else if clk.t > rig.anticip_s + 0.05 && pose.lift.x > 0.75 && rp.ready > 0.5 {
                        next = Ph::Carrying;
                    }
                }
                Ph::Carrying => {
                    if !want {
                        next = Ph::Closing;
                    } else if pose.carry.x >= 0.9999 && pose.face.x > 0.995 && pose.face.v.abs() < 0.05 {
                        next = Ph::Opening;
                    }
                }
                Ph::Opening => {
                    if !want {
                        next = Ph::Closing;
                    } else if hinge.a.x >= 0.9999 && rev.a.x > 0.97 {
                        next = Ph::Reading;
                    }
                }
                Ph::Reading => {
                    if !want {
                        next = Ph::Closing;
                    }
                }
                Ph::Closing => {
                    if want {
                        next = if hinge.pages > 0.5 {
                            Ph::Opening
                        } else if pose.carry.x > 0.05 {
                            Ph::Carrying
                        } else {
                            Ph::Lifting
                        };
                    } else if hinge.pages < 0.5 && pose.carry.x < 0.002 && pose.lift.x < 0.002 && pose.lift.v.abs() < 0.05 {
                        next = Ph::OnShelf;
                    }
                }
            }
            if next != ph {
                clk.t = 0.0;
                clk.phase = next as i32 as f32;
                if next == Ph::Opening {
                    // the hand-off: the card is exactly at the reading pose, the page renderer takes over this frame
                    hinge.pages = 1.0;
                }
                if next == Ph::Closing && held {
                    crate::magazine::close_full();
                }
                e.add((w.component_id::<BookPhase>(), next.entity(&w)));
            }
            let ph = next;
            // targets for this phase
            let c = pose.carry.x;
            let h = hinge.a.x;
            match ph {
                Ph::OnShelf => {
                    pose.lift.to = 0.0;
                    pose.carry.to = 0.0;
                    pose.face.to = 0.0;
                    hinge.a.to = 0.0;
                    rev.a.to = 0.0;
                    back.dim.to = 0.0;
                    back.dolly.to = 0.0;
                }
                Ph::Lifting => {
                    pose.lift.to = if clk.t < rig.anticip_s { -rig.anticip_dip } else { 1.0 };
                    pose.carry.to = 0.0;
                    pose.face.to = 0.0;
                    back.dim.to = rig.dim_lift;
                    back.dolly.to = 0.0;
                }
                Ph::Carrying => {
                    pose.lift.to = 1.0;
                    pose.carry.to = rig.carry_aim;
                    pose.face.to = if c > 0.2 { 1.0 } else { 0.0 };
                    back.dim.to = rig.dim_carry;
                    back.dolly.to = if c > 0.12 { 1.0 } else { 0.0 };
                }
                Ph::Opening | Ph::Reading => {
                    pose.lift.to = 1.0;
                    pose.carry.to = rig.carry_aim;
                    pose.face.to = 1.0;
                    hinge.a.to = rig.hinge_aim;
                    rev.a.to = if ph == Ph::Reading { 1.0 } else { smoothstep(0.3, 1.0, h) };
                    back.dim.to = if ph == Ph::Reading { 1.0 } else { rig.dim_open };
                    back.dolly.to = 1.0;
                }
                Ph::Closing => {
                    // the cover goes first (held while the full-text layer is still open), then the card goes home along the same arc
                    if hinge.pages > 0.5 {
                        hinge.a.to = if held { rig.hinge_aim } else { -0.06 };
                        if h <= 0.0 && hinge.a.v >= -0.02 && !held {
                            hinge.pages = 0.0; // swap back to the card, same pose
                        }
                    }
                    rev.a.to = smoothstep(0.3, 1.0, h);
                    let pages = hinge.pages > 0.5;
                    pose.carry.to = if pages { rig.carry_aim } else { 0.0 };
                    pose.face.to = if c < 0.8 && !pages { 0.0 } else { 1.0 };
                    pose.lift.to = if c < 0.35 && !pages { 0.0 } else { 1.0 };
                    back.dim.to = if pages { rig.dim_open } else { lerp(rig.dim_lift, rig.dim_carry, c) };
                    back.dolly.to = if c > 0.9 || pages { 1.0 } else { 0.0 };
                }
            }
        });

    // ---- Spring: integrate every channel, contacts, sounds from impacts and crossings ----
    world
        .system_named::<(&mut BookPose, &mut Hinge, &mut SpreadReveal, &mut Backdrop, &BookClock)>("BookSpring")
        .kind(spring_ph)
        .with(BookActive::id())
        .each_iter(|it, _, (pose, hinge, rev, back, clk)| {
            let dt = it.delta_time();
            let w = it.world();
            let closing = clk.phase as i32 == Ph::Closing as i32;
            let _ = step(&mut pose.face, dt);
            // the shelf is a floor for the card while it comes home (the anticipation pull-back may dip below 0)
            pose.lift.lo = if closing { 0.0 } else { -1e9 };
            pose.lift.rest = 0.25;
            let hit = step(&mut pose.lift, dt);
            if hit.lo > 0.0 {
                sound(&w, SND_PLACE, hit.lo / 2.0);
            }
            let _ = step(&mut pose.carry, dt);
            let before = hinge.a.x;
            let hit = step(&mut hinge.a, dt);
            if hit.hi > 0.0 {
                sound(&w, SND_PLACE, hit.hi / 1.0);
            }
            if hit.lo > 0.0 {
                sound(&w, SND_CLOSE, hit.lo / 1.0);
            }
            let after = hinge.a.x;
            if (before < 0.5 && after >= 0.5) || (before > 0.5 && after <= 0.5) {
                sound(&w, SND_PAPER, hinge.a.v.abs() / 1.0);
            }
            let _ = step(&mut rev.a, dt);
            let _ = step(&mut back.dim, dt);
            let _ = step(&mut back.dolly, dt);
        });

    // sheets that flutter under the cover follow the hinge with their own springs
    world.system_named::<(&Part, &mut PartAngle)>("PartFollow").kind(spring_ph).each_iter(|it, row, (p, a)| {
        let _ = row;
        let Some(h) = it.world().entity_from_id(p.owner).try_cloned::<&Hinge>() else { return };
        let x = h.a.x.clamp(0.0, 1.0);
        a.a.omega = 11.0 - 2.5 * p.slot;
        a.a.zeta = 0.5;
        a.a.to = p.share * x + p.flutter * 4.0 * x * (1.0 - x);
        let _ = step(&mut a.a, it.delta_time());
    });

    // ---- Pack: the renderer's state buffer ----
    world
        .system_named::<(&BookPose, &Hinge, &SpreadReveal, &Backdrop, &BookClock, &Shelf, &Article)>("BookPack")
        .kind(pack_ph)
        .with(BookActive::id())
        .each_iter(|it, row, (pose, hinge, rev, back, clk, shelf, art)| {
            let w = it.world();
            let rig = rig_of(&w);
            let rp = w.try_cloned::<&ReadPose>().unwrap_or_default();
            let e = it.entity(row);
            let want = e.has(WantOpen::id());
            let ph = Ph::from_f(clk.phase);
            let c = pose.carry.x.clamp(0.0, 1.0);
            let lift = pose.lift.x;
            let h = hinge.a.x.clamp(0.0, 1.0);
            // `t` is what the page shader already understands (magazine.wgsl gates the card at 0.9): the card travels 0..0.9 while the
            // lift and carry run, and the cover hinge drives 0.9..1 once the page renderer owns the book
            let t = if hinge.pages > 0.5 { 0.9 + 0.1 * h } else { (lift.clamp(0.0, 1.0) * 0.1 + c * 0.8).min(0.899) };
            let t = if ph == Ph::Reading { 1.0 } else { t };
            let card_on = if hinge.pages > 0.5 { 0.0 } else { 1.0 };
            // the card lights up like the paper by the time it arrives, so the hand-off has no brightness step
            let card_light = smoothstep(0.0, 1.0, c);
            let bank = (-rig.bank_gain * pose.carry.v).clamp(-rig.bank_max, rig.bank_max);
            let curl = (rig.curl_gain * hinge.a.v).clamp(-rig.curl_max, rig.curl_max);
            let row28 = card_row(&rig, &rp, shelf, pose, bank);
            crate::reader::with_state(|st| {
                st[S_T] = t;
                st[S_WANT] = if want { 1.0 } else { 0.0 };
                st[S_LIFT] = lift;
                st[1] = if want { 1.0 } else { 0.0 };
                st[4] = if rp.ready > 0.5 { art.index as f32 } else { -1.0 };
                st[5] = shelf.obj;
                st[S_DOLLY] = back.dolly.x.clamp(0.0, 1.0);
                st[S_CARD..S_CARD + 28].copy_from_slice(&row28);
                st[S_PHASE] = clk.phase;
                st[S_CARRY] = c;
                st[S_FACE] = pose.face.x;
                st[S_HINGE] = h;
                st[S_REVEAL] = rev.a.x.clamp(0.0, 1.0);
                st[S_DIM] = back.dim.x.clamp(0.0, 1.0);
                st[S_CARD_ON] = card_on;
                st[S_PAGES_ON] = hinge.pages;
                st[S_CARD_LIGHT] = card_light;
                st[S_CURL] = curl;
                st[S_BANK] = bank;
            });
        });

    world.system_named::<(&Part, &PartAngle)>("PartPack").kind(pack_ph).each(|(p, a)| {
        if p.slot >= 0.0 && (p.slot as usize) < 4 {
            let i = S_FLUTTER + p.slot as usize;
            crate::reader::with_state(|st| st[i] = a.a.x);
        }
    });
}

fn mul3(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}

/// The cover board object as a 28-float shader row. Rows of the rotation are the transpose of the object's world rotation (the
/// exporter's convention: lean(a) is Rx(a) rows, which is a physical Rx(-a): the top leans back toward the wall).
fn card_row(rig: &BookRig, rp: &ReadPose, shelf: &Shelf, pose: &BookPose, bank: f32) -> [f32; 28] {
    let row = &shelf.row;
    let l = pose.lift.x;
    let c = pose.carry.x.clamp(0.0, 1.0);
    let f = pose.face.x;
    // the pose at the end of the carry is the reading pose the page renderer starts from: centred on the right sheet, square to the camera
    let hz = 0.006;
    let end = [rp.cx, rp.cy, rp.cz];
    let p0 = [row[0], row[1] + rig.lift_y * l, row[2] + rig.lift_z * l];
    let arc = (std::f32::consts::PI * c).sin();
    let pos = [
        lerp(p0[0], end[0], c),
        lerp(p0[1], end[1], c) + rig.bulge_y * arc,
        lerp(p0[2], end[2], c) + rig.bulge_z * arc,
    ];
    // physical rotation Q = Ry(yaw) Rx(pitch) Rz(roll): pitch is minus the lean (top back), the lift tilts the top out, face squares it up
    let lean = (shelf.lean - rig.tilt * l) * (1.0 - f);
    let (sp, cp) = (-lean).sin_cos();
    let (sy, cy) = (0.0f32, 1.0f32);
    let (sr, cr) = bank.sin_cos();
    let ry = [[cy, 0.0, sy], [0.0, 1.0, 0.0], [-sy, 0.0, cy]];
    let rx = [[1.0, 0.0, 0.0], [0.0, cp, -sp], [0.0, sp, cp]];
    let rz = [[cr, -sr, 0.0], [sr, cr, 0.0], [0.0, 0.0, 1.0]];
    let q = mul3(mul3(ry, rx), rz);
    let mut o = *row;
    o[0..3].copy_from_slice(&pos);
    o[4] = lerp(row[4], rp.hw, c);
    o[5] = lerp(row[5], rp.hh, c);
    o[6] = lerp(row[6], hz, c);
    for i in 0..3 {
        // rows = transpose of Q
        o[8 + 4 * i] = q[0][i];
        o[9 + 4 * i] = q[1][i];
        o[10 + 4 * i] = q[2][i];
        o[11 + 4 * i] = 0.0;
    }
    o
}

fn observers(world: &World) {
    let rel = world.component_id::<BookPhase>();
    // every phase entry: a PhaseChanged event for the UI
    for ph in [Ph::OnShelf, Ph::Lifting, Ph::Carrying, Ph::Opening, Ph::Reading, Ph::Closing] {
        let tgt = ph.entity(world);
        world.observer::<flecs::OnAdd, ()>().with((rel, tgt)).each_iter(move |it, _, _| emit(&it.world(), EV_PHASE, ph as u32));
    }
    // the sounds that belong to a phase, not to an impact: grab off the shelf, the whoosh of the carry, the cover scrape of the opening
    for (ph, snd, vel) in [(Ph::Lifting, SND_GRAB, 0.5), (Ph::Carrying, SND_WHOOSH, 0.55), (Ph::Opening, SND_OPEN, 0.45)] {
        let tgt = ph.entity(world);
        world.observer::<flecs::OnAdd, ()>().with((rel, tgt)).each_iter(move |it, _, _| sound(&it.world(), snd, vel));
    }
    // arriving in Reading is the legacy Opened event (article index)
    let reading = Ph::Reading.entity(world);
    world.observer::<flecs::OnAdd, ()>().with((rel, reading)).each_iter(|it, row, _| {
        let idx = it.entity(row).try_cloned::<&Article>().map_or(0, |a| a.index);
        emit(&it.world(), EV_OPENED, idx);
    });
}

// ---- host glue (called from reader.rs; the world handle is passed in) ----

/// Ask the book to open (true) or close (false). Opening makes it the simulated book.
pub fn want(w: &World, art: u64, open: bool) {
    let e = w.entity_from_id(art);
    if !open && !e.has(BookActive::id()) {
        return;
    }
    if open {
        e.add(BookActive::id());
        e.add(WantOpen::id());
    } else {
        e.remove(WantOpen::id());
    }
}

/// A click: start lifting at once, before the article bytes arrive. The reading pose is not known yet (`ready` false).
pub fn begin(w: &World, art: u64) {
    w.get::<&mut ReadPose>(|p| p.ready = 0.0);
    want(w, art, true);
}

/// The book is home: not wanted, on the shelf.
pub fn is_home(w: &World, art: u64) -> bool {
    let e = w.entity_from_id(art);
    !e.has(WantOpen::id()) && e.try_cloned::<&BookClock>().map_or(true, |c| c.phase as i32 == Ph::OnShelf as i32)
}

/// Put away a book that is no longer wanted once it is home (never opened far enough for the reader to know it).
pub fn settle_idle(w: &World, art: u64) {
    let e = w.entity_from_id(art);
    if e.has(BookActive::id()) && is_home(w, art) {
        reset(w, art);
    }
}

/// Cold deep link: every channel at its end state, phase Reading, no events but the Opened one.
pub fn snap_open(w: &World, art: u64) {
    let e = w.entity_from_id(art);
    let rig = rig_of(w);
    let (mut p, mut h, mut r, mut b) = channels(&rig);
    p.lift = p.lift.at(1.0);
    p.carry = p.carry.at(1.0);
    p.face = p.face.at(1.0);
    h.a = h.a.at(1.0);
    h.pages = 1.0;
    r.a = r.a.at(1.0);
    b.dim = b.dim.at(1.0);
    b.dolly = b.dolly.at(1.0);
    e.set(p).set(h).set(r).set(b).set(BookClock { t: 0.0, phase: Ph::Reading as i32 as f32 });
    e.add(BookActive::id());
    e.add(WantOpen::id());
    e.add((w.component_id::<BookPhase>(), Ph::Reading.entity(w)));
}

/// Back to rest on the shelf: channels cleared, tags removed, parts gone.
pub fn reset(w: &World, art: u64) {
    let e = w.entity_from_id(art);
    let rig = rig_of(w);
    let (p, h, r, b) = channels(&rig);
    e.set(p).set(h).set(r).set(b).set(BookClock::default());
    e.remove(WantOpen::id());
    e.remove(BookActive::id());
    e.add((w.component_id::<BookPhase>(), Ph::OnShelf.entity(w)));
    let mut ids = Vec::new();
    w.new_query::<&Part>().each_entity(|p, part| {
        if part.owner == *e.id() {
            ids.push(*p.id());
        }
    });
    for id in ids {
        let p = w.entity_from_id(id);
        if p.is_alive() {
            p.destruct();
        }
    }
}

/// Make the part entities of an opened book (children of the article, instances of the part prefabs).
pub fn spawn_parts(w: &World, art: u64) {
    let e = w.entity_from_id(art);
    let mut have = false;
    w.new_query::<&Part>().each_entity(|p, part| {
        if part.owner == *e.id() {
            have = true;
        }
    });
    if have {
        return;
    }
    for (name, slot) in [("CoverFront", -1.0), ("CoverBack", -1.0), ("Spine", -1.0), ("PageBlock", -1.0), ("FlutterSheet", 0.0), ("FlutterSheet", 1.0)] {
        let id = PART_PROTOS.with(|v| v.borrow().iter().find(|(n, _)| *n == name).map(|&(_, id)| id)).expect("part prefab registered by BookModule");
        let proto = w.entity_from_id(id);
        let mut part = proto.try_cloned::<&Part>().unwrap_or_default();
        part.slot = slot;
        part.owner = *e.id();
        w.entity().is_a(proto).child_of(e).set(part).set(PartAngle::default());
    }
}

pub fn set_pose(w: &World, cx: f32, cy: f32, cz: f32, hw: f32, hh: f32) {
    w.get::<&mut ReadPose>(|p| {
        p.cx = cx;
        p.cy = cy;
        p.cz = cz;
        p.hw = hw;
        p.hh = hh;
        p.ready = 1.0;
    });
}
