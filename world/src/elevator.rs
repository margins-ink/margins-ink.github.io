//! The elevator: a state machine in Flecs (docs/ELEVATOR.md). Nothing here is verified by a build yet.
//!
//! One entity, `cab` (an instance of the `Lift` prefab), carries the state:
//!   `Elevator {floor, target, pos, vel}` (pos in floors, 0 = top floor, growing downward), `Slide {gate, doors, t}` (linear
//!   progress 0 closed .. 1 open), `Latch` (the brake settle spring, metres), `Needle` (dial spring), `Lights`, `Glance`,
//!   `ScrollIn` (the page scroll fed by TS). Three exclusive relations hold the machine state:
//!   `(Car, Parked | Travelling | Latching)`, `(Doors, Open | Closed | Opening | Closing)`, `(Gate, Open | Closed | Opening | Closing)`.
//! Pipeline phases (custom, chained by DependsOn from OnUpdate): LiftInput -> LiftMove -> LiftSequence -> LiftPack.
//!   Input     DetentSelect (scroll to target, magnetic with hysteresis)
//!   Move      CarTravel, CarLatch, DoorsOpening/Closing, GateOpening/Closing, NeedleSpring, DialLights, LiftClock, GlanceTick
//!   Sequence  Sequencer (leave: doors close, gate closes, car departs; arrive: observers open gate then doors; interrupt = reverse)
//!   Pack      PackState (state buffer), PackCab (rewrites the rows of every `Rig` part)
//! Observers (OnAdd of the relation pairs) turn state changes into audio events; nothing else emits them.
//! Own exports (no_mangle, so lib.rs only needs `mod elevator;`): elevator_tick, elevator_scroll, elevator_goto, elevator_hold,
//! elevator_event_poll, elevator_state_ptr, elevator_rows_ptr.
use crate::components::*;
use crate::export::euler;
use flecs_ecs::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::f32::consts::FRAC_PI_2;

pub const STATE_LEN: usize = 40;
pub const MAX_FLOORS: usize = 8;
/// tan of the half field of view inside the cab (about 45 degrees). The room view uses the renderer's own.
pub const TH_CAB: f32 = 1.0;
pub const EYE: f32 = 1.55;
/// Camera dolly toward the door while the doors open, metres (state[14] is its 0..1 factor).
pub const PUSH: f32 = 0.35;

// events from elevator_event_poll: kind << 24 | arg
pub const EV_GATE: u32 = 1; // arg 1 opening, 0 closing
pub const EV_DOOR: u32 = 2; // arg 1 opening, 0 closing
pub const EV_CLUNK: u32 = 3; // arg impact 0..255
pub const EV_DING: u32 = 4; // arg floor
pub const EV_STEP: u32 = 5; // arg floor: the nearest floor changed while travelling (dial relay)
pub const EV_DEPART: u32 = 6; // arg 1 going down, 0 up
pub const EV_STOP: u32 = 7; // arg bit1 gate (else doors), bit0 now open (else closed)

// motion, floors and seconds
const V_MAX: f32 = 1.8;
const A_MAX: f32 = 1.4;
const A_BRAKE: f32 = 2.4;
const V_CREEP: f32 = 0.10;
const SNAP_D: f32 = 0.012;
const HYST: f32 = 0.12;
const GATE_T_OPEN: f32 = 0.95;
const GATE_T_CLOSE: f32 = 0.8;
const DOOR_T_OPEN: f32 = 1.25;
const DOOR_T_CLOSE: f32 = 1.0;
const LATCH_W: f32 = 30.0;
const LATCH_Z: f32 = 0.22;
const LATCH_MIN_T: f32 = 0.5;
const NEEDLE_W: f32 = 8.0;
const NEEDLE_Z: f32 = 0.38;
const ARC: f32 = 1.0472; // 60 degrees each side of vertical

// cab frame geometry (see 11-elevator.flecs)
const GATE_X0: f32 = -1.0;
const GATE_W: f32 = 2.0;
const GATE_U: usize = 4;
const GATE_R: usize = 4;
const GATE_Z: f32 = 4.4;
const BAR_Y0: f32 = 0.06;
const ROW_H: f32 = 0.47;
const COLLAPSED_W: f32 = 0.06;
const GATE_SHIFT: f32 = 0.12;
const HUB: [f32; 3] = [0.0, 2.08, 4.348];
const ARC_R: f32 = 0.26;
const NEEDLE_HALF: f32 = 0.11;
const LEAF_Z: f32 = 3.84;
const PLATE_PITCH: f32 = 1.2;

#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Elevator {
    pub floor: i32,
    pub target: i32,
    pub pos: f32,
    pub vel: f32,
}
/// Gate and door progress, 0 closed .. 1 open (the eased value is `ease(progress)`), and a running clock for jitter.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Slide {
    pub gate: f32,
    pub doors: f32,
    pub t: f32,
}
/// Brake settle: vertical offset in metres (positive is further down) and its velocity; `age` is seconds since the
/// car left (while travelling) or latched (while latching).
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Latch {
    pub off: f32,
    pub vel: f32,
    pub age: f32,
}
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Needle {
    pub ang: f32,
    pub vel: f32,
}
/// Page scroll progress 0..1; `fresh` is 1 until DetentSelect consumed it.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct ScrollIn {
    pub p: f32,
    pub fresh: f32,
}
/// Brightness of the dial lamps and call buttons (0..1, incandescent lag).
#[derive(Component, Clone, Copy, Default)]
pub struct Lights {
    pub dial: [f32; MAX_FLOORS],
    pub btn: [f32; MAX_FLOORS],
}
/// The look toward the control panel when the car is called away: `t` seconds since it started, `on` 1 while running.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Glance {
    pub t: f32,
    pub on: f32,
}

// relations and their targets
#[derive(Component, Clone, Copy, Default)]
pub struct Car;
#[derive(Component, Clone, Copy, Default)]
pub struct Doors;
#[derive(Component, Clone, Copy, Default)]
pub struct Gate;
#[derive(Component, Clone, Copy, Default)]
pub struct Parked;
#[derive(Component, Clone, Copy, Default)]
pub struct Travelling;
#[derive(Component, Clone, Copy, Default)]
pub struct Latching;
#[derive(Component, Clone, Copy, Default)]
pub struct Open;
#[derive(Component, Clone, Copy, Default)]
pub struct Closed;
#[derive(Component, Clone, Copy, Default)]
pub struct Opening;
#[derive(Component, Clone, Copy, Default)]
pub struct Closing;
/// Tag on the cab: do not leave this floor (an article is being read).
#[derive(Component, Clone, Copy, Default)]
pub struct Hold;

thread_local! {
    static WORLD: RefCell<Option<World>> = const { RefCell::new(None) };
    static CAB: Cell<u64> = const { Cell::new(0) };
    static DT: Cell<f32> = const { Cell::new(0.0) };
    static N: Cell<usize> = const { Cell::new(1) };
    static LH: Cell<f32> = const { Cell::new(3.28) };
    static MUTE: Cell<bool> = const { Cell::new(false) };
    static IMPACT: Cell<f32> = const { Cell::new(0.0) };
    static EVENTS: RefCell<VecDeque<u32>> = const { RefCell::new(VecDeque::new()) };
    static STATE: RefCell<[f32; STATE_LEN]> = const { RefCell::new([0.0; STATE_LEN]) };
    static ROWS: RefCell<Vec<f32>> = const { RefCell::new(Vec::new()) };
}

fn emit(kind: u32, arg: u32) {
    if MUTE.with(|m| m.get()) {
        return;
    }
    EVENTS.with(|e| e.borrow_mut().push_back(kind << 24 | (arg & 0xffffff)));
}

fn smooth(x: f32) -> f32 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    smooth((x - a) / (b - a))
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}
/// Gate and door travel: eased, with a soft start and stop.
fn ease(u: f32) -> f32 {
    smooth(u)
}

/// Damped spring, sub-stepped so the stiff latch and needle stay stable at any frame time.
fn spring2(x: &mut f32, v: &mut f32, target: f32, w: f32, z: f32, dt: f32) {
    let n = ((dt * w * 4.0).ceil() as u32).clamp(1, 64);
    let h = dt / n as f32;
    for _ in 0..n {
        let a = -w * w * (*x - target) - 2.0 * z * w * *v;
        *v += a * h;
        *x += *v * h;
    }
}

/// Dial angle for a floor position: +60 degrees (top floor, left) to -60 degrees (last floor, right).
fn needle_target(pos: f32, n: usize) -> f32 {
    let f = if n > 1 { pos / (n as f32 - 1.0) } else { 0.0 };
    ARC - 2.0 * ARC * f.clamp(0.0, 1.0)
}

pub fn set_dt(dt_ms: f32) {
    DT.with(|d| d.set((dt_ms / 1000.0).clamp(0.0, 0.1)));
}

pub fn poll() -> u32 {
    EVENTS.with(|e| e.borrow_mut().pop_front()).unwrap_or(0)
}

/// Create the cab entity and the rig parts that depend on the floor count (gate bars, door leaves, dial lamps, call
/// buttons, door seams). Call after the scripts ran and before `export::pack_cab`.
pub fn spawn<'a>(world: &'a World, n: usize, existing: Option<u64>) -> EntityView<'a> {
    let n = n.clamp(1, MAX_FLOORS);
    // a hot reload re-instances the same cab entity, so the state on it (position, doors, springs) and the ids the systems hold survive
    let cab = match existing {
        Some(id) => world.entity_from_id(id),
        None => world.entity_named("cab"),
    }
    .is_a(world.lookup("Lift"));
    let bar = world.lookup("CabGateBar");
    for r in 0..GATE_R {
        for u in 0..GATE_U {
            for d in 0..2 {
                world
                    .entity()
                    .is_a(bar)
                    .child_of(cab)
                    .set(Rig { role: 1, a: r as f32, b: (u * 2 + d) as f32, row: 0 });
            }
        }
    }
    let leaf = world.lookup("CabLeaf");
    let lamp = world.lookup("CabDialLamp");
    let button = world.lookup("CabButton");
    for k in 0..n {
        for side in [-1.0f32, 1.0] {
            world
                .entity()
                .is_a(leaf)
                .child_of(cab)
                .set(Rig { role: 3, a: k as f32, b: side, row: 0 });
        }
        // dial lamp on the arc, top floor left
        let ang = needle_target(k as f32, n);
        world.entity().is_a(lamp).child_of(cab).set(Rig { role: 5, a: k as f32, b: 0.0, row: 0 }).set(Center {
            x: -ARC_R * ang.sin(),
            y: HUB[1] + ARC_R * ang.cos(),
            z: 4.338,
        });
        // call button on the right wall plate: two columns of five
        world.entity().is_a(button).child_of(cab).set(Rig { role: 6, a: k as f32, b: 0.0, row: 0 }).set(Center {
            x: 1.372,
            y: 1.52 - 0.095 * (k % 5) as f32,
            z: 4.56 + 0.08 * (k / 5) as f32,
        });
    }
    cab
}

fn needle_angle_state(pos: f32, n: usize) -> Needle {
    Needle { ang: needle_target(pos, n), vel: 0.0 }
}

/// Register components, relations, phases, systems and observers, and put the cab at floor 0 with gate and doors open.
/// `rows` is `export::pack_cab(..).rows` (the live cab list, rewritten by PackCab).
pub fn setup(world: &World, cab: EntityView, rows: Vec<f32>, n: usize, level_h: f32) {
    let n = n.clamp(1, MAX_FLOORS);
    WORLD.with(|w| *w.borrow_mut() = Some(world.clone()));
    CAB.with(|c| c.set(*cab.id()));
    N.with(|c| c.set(n));
    LH.with(|c| c.set(level_h));
    EVENTS.with(|e| e.borrow_mut().clear());
    ROWS.with(|r| *r.borrow_mut() = rows);

    world.component_named::<Elevator>("Elevator");
    world.component_named::<Slide>("Slide");
    world.component_named::<Latch>("Latch");
    world.component_named::<Needle>("Needle");
    world.component_named::<ScrollIn>("ScrollIn");
    world.component_named::<Lights>("Lights");
    world.component_named::<Glance>("Glance");
    world.component_named::<Hold>("Hold");
    for r in [world.component_named::<Car>("Car").id(), world.component_named::<Doors>("Doors").id(), world.component_named::<Gate>("Gate").id()] {
        world.entity_from_id(*r).add_trait::<flecs::Exclusive>();
    }
    world.component_named::<Parked>("Parked");
    world.component_named::<Travelling>("Travelling");
    world.component_named::<Latching>("Latching");
    world.component_named::<Open>("Open");
    world.component_named::<Closed>("Closed");
    world.component_named::<Opening>("Opening");
    world.component_named::<Closing>("Closing");

    let mut lights = Lights::default();
    lights.dial[0] = 1.0;
    cab.set(Elevator::default())
        .set(Slide { gate: 1.0, doors: 1.0, t: 0.0 })
        .set(Latch::default())
        .set(needle_angle_state(0.0, n))
        .set(ScrollIn::default())
        .set(lights)
        .set(Glance::default())
        .add((Doors::id(), Open::id()))
        .add((Gate::id(), Open::id()))
        .add((Car::id(), Parked::id()));

    // ---- phases ----
    let input_ph = world.entity_named("LiftInputPhase").add(flecs::pipeline::Phase).depends_on(flecs::pipeline::OnUpdate);
    let move_ph = world.entity_named("LiftMovePhase").add(flecs::pipeline::Phase).depends_on(input_ph);
    let seq_ph = world.entity_named("LiftSequencePhase").add(flecs::pipeline::Phase).depends_on(move_ph);
    let pack_ph = world.entity_named("LiftPackPhase").add(flecs::pipeline::Phase).depends_on(seq_ph);

    // ---- Input: scroll position to a target floor. Magnetic detents: the target only changes once the scroll is more
    // than HYST past the halfway point to another floor, so free scrolling never leaves the car between floors at rest.
    world
        .system_named::<(&mut Elevator, &mut ScrollIn)>("DetentSelect")
        .kind(input_ph)
        .each_entity(|e, (el, si)| {
            if si.fresh < 0.5 {
                return;
            }
            si.fresh = 0.0;
            if e.has(Hold::id()) {
                return;
            }
            let n = N.with(|c| c.get()) as i32;
            let s = si.p.clamp(0.0, 1.0) * (n - 1).max(0) as f32;
            if (s - el.target as f32).abs() > 0.5 + HYST {
                el.target = (s.round() as i32).clamp(0, n - 1);
            }
        });

    // ---- Move ----
    // Travelling: braking curve v = sqrt(2 a d) capped at V_MAX, a soft start (acceleration ramps up over 0.8 s), a creep
    // speed so it never asymptotes. Within SNAP_D of the target it latches: the remaining offset becomes the latch spring.
    world
        .system_named::<(&mut Elevator, &mut Latch)>("CarTravel")
        .kind(move_ph)
        .with((Car::id(), Travelling::id()))
        .each_entity(|e, (el, la)| {
            let dt = DT.with(|c| c.get());
            let n = N.with(|c| c.get()) as i32;
            let lh = LH.with(|c| c.get());
            la.age += dt;
            let tgt = el.target as f32;
            let d = tgt - el.pos;
            let dist = d.abs();
            let dir = if d >= 0.0 { 1.0 } else { -1.0 };
            if dist <= SNAP_D && el.vel.abs() < 0.8 {
                let v_m = el.vel * lh;
                la.off = (el.pos - tgt) * lh;
                la.vel = dir * (0.10 + 0.5 * v_m.abs().min(1.0));
                la.age = 0.0;
                IMPACT.with(|c| c.set((v_m.abs() / 1.0).min(1.0)));
                el.pos = tgt;
                el.vel = 0.0;
                el.floor = el.target;
                e.add((Car::id(), Latching::id()));
                return;
            }
            let v_brake = (2.0 * A_BRAKE * (dist - 0.5 * SNAP_D).max(0.0)).sqrt();
            let v_want = dir * v_brake.max(V_CREEP).min(V_MAX);
            let ramp = 0.12 + 0.88 * smooth(la.age / 0.8);
            let braking = el.vel * dir < 0.0 || v_want.abs() < el.vel.abs();
            let a = if braking { A_BRAKE } else { A_MAX * ramp };
            el.vel += (v_want - el.vel).clamp(-a * dt, a * dt);
            el.pos = (el.pos + el.vel * dt).clamp(0.0, (n - 1).max(0) as f32);
            let nf = el.pos.round() as i32;
            if nf != el.floor {
                el.floor = nf;
                emit(EV_STEP, nf as u32);
            }
        });

    // Latching: the cab jolts past the sill and the latch pulls it back, a few cm with a small overshoot; when it has
    // settled the car is Parked and the gate starts to open (the OnAdd observers play the ding and the sequence).
    world
        .system_named::<&mut Latch>("CarLatch")
        .kind(move_ph)
        .with((Car::id(), Latching::id()))
        .each_entity(|e, la| {
            let dt = DT.with(|c| c.get());
            spring2(&mut la.off, &mut la.vel, 0.0, LATCH_W, LATCH_Z, dt);
            la.age += dt;
            if la.age > LATCH_MIN_T && la.off.abs() < 4e-4 && la.vel.abs() < 4e-3 {
                la.off = 0.0;
                la.vel = 0.0;
                e.add((Car::id(), Parked::id()));
                e.add((Gate::id(), Opening::id()));
            }
        });

    // Door and gate slides: linear progress per state, eased when drawn. A reversal just flips the state and keeps the progress.
    world.system_named::<&mut Slide>("DoorsOpening").kind(move_ph).with((Doors::id(), Opening::id())).each_entity(|e, s| {
        s.doors = (s.doors + DT.with(|c| c.get()) / DOOR_T_OPEN).min(1.0);
        if s.doors >= 1.0 {
            e.add((Doors::id(), Open::id()));
        }
    });
    world.system_named::<&mut Slide>("DoorsClosing").kind(move_ph).with((Doors::id(), Closing::id())).each_entity(|e, s| {
        s.doors = (s.doors - DT.with(|c| c.get()) / DOOR_T_CLOSE).max(0.0);
        if s.doors <= 0.0 {
            e.add((Doors::id(), Closed::id()));
        }
    });
    world.system_named::<&mut Slide>("GateOpening").kind(move_ph).with((Gate::id(), Opening::id())).each_entity(|e, s| {
        s.gate = (s.gate + DT.with(|c| c.get()) / GATE_T_OPEN).min(1.0);
        if s.gate >= 1.0 {
            e.add((Gate::id(), Open::id()));
        }
    });
    world.system_named::<&mut Slide>("GateClosing").kind(move_ph).with((Gate::id(), Closing::id())).each_entity(|e, s| {
        s.gate = (s.gate - DT.with(|c| c.get()) / GATE_T_CLOSE).max(0.0);
        if s.gate <= 0.0 {
            e.add((Gate::id(), Closed::id()));
        }
    });

    // The dial needle chases the continuous position with a mechanical lag and overshoot.
    world.system_named::<(&mut Needle, &Elevator)>("NeedleSpring").kind(move_ph).each(|(nd, el)| {
        let dt = DT.with(|c| c.get());
        let n = N.with(|c| c.get());
        spring2(&mut nd.ang, &mut nd.vel, needle_target(el.pos, n), NEEDLE_W, NEEDLE_Z, dt);
    });

    // Floor lamps step with the nearest floor, call buttons stay lit while their floor is the target and the car is away.
    world.system_named::<(&mut Lights, &Elevator)>("DialLights").kind(move_ph).each_entity(|e, (li, el)| {
        let dt = DT.with(|c| c.get());
        let n = N.with(|c| c.get());
        let k = 1.0 - (-14.0 * dt).exp();
        let near = el.pos.round().max(0.0) as usize;
        let parked_here = e.has((Car::id(), Parked::id())) && el.floor == el.target;
        for i in 0..n {
            let want = if i == near { 1.0 } else { 0.05 };
            li.dial[i] += (want - li.dial[i]) * k;
            let b = if i as i32 == el.target && !parked_here { 1.0 } else { 0.0 };
            li.btn[i] += (b - li.btn[i]) * k;
        }
    });

    world.system_named::<&mut Slide>("LiftClock").kind(move_ph).each(|s| {
        s.t += DT.with(|c| c.get());
    });
    world.system_named::<&mut Glance>("GlanceTick").kind(move_ph).each(|g| {
        if g.on > 0.5 {
            g.t += DT.with(|c| c.get());
            if g.t > 2.0 {
                g.on = 0.0;
                g.t = 0.0;
            }
        }
    });

    // ---- Sequence: the interlock between gate, doors and car. One transition per tick.
    world
        .system_named::<(&Elevator, &mut Slide, &mut Latch, &mut Glance)>("Sequencer")
        .kind(seq_ph)
        .each_entity(|e, (el, _s, la, gl)| {
            if !e.has((Car::id(), Parked::id())) {
                return;
            }
            let want_leave = el.target != el.floor && !e.has(Hold::id());
            let d_open = e.has((Doors::id(), Open::id()));
            let d_opening = e.has((Doors::id(), Opening::id()));
            let d_closing = e.has((Doors::id(), Closing::id()));
            let d_closed = e.has((Doors::id(), Closed::id()));
            let g_open = e.has((Gate::id(), Open::id()));
            let g_opening = e.has((Gate::id(), Opening::id()));
            let g_closing = e.has((Gate::id(), Closing::id()));
            let g_closed = e.has((Gate::id(), Closed::id()));
            if want_leave {
                if d_open || d_opening {
                    // leaving: doors first, then the gate (also interrupts an opening in progress)
                    e.add((Doors::id(), Closing::id()));
                    gl.t = 0.0;
                    gl.on = 1.0;
                } else if d_closed && (g_open || g_opening) {
                    e.add((Gate::id(), Closing::id()));
                } else if d_closed && g_closed {
                    la.age = 0.0;
                    e.add((Car::id(), Travelling::id()));
                }
            } else if d_closing {
                // called back before it left: reverse
                e.add((Doors::id(), Opening::id()));
            } else if g_closing && d_closed {
                e.add((Gate::id(), Opening::id()));
            } else if g_closed && d_closed {
                e.add((Gate::id(), Opening::id()));
            }
        });

    // ---- Pack ----
    world
        .system_named::<(&Elevator, &Slide, &Latch, &Needle, &Lights, &Glance)>("PackState")
        .kind(pack_ph)
        .each_entity(|e, (el, sl, la, nd, li, gl)| {
            let n = N.with(|c| c.get());
            let lh = LH.with(|c| c.get());
            let pos_m = el.pos * lh + la.off;
            let s = (el.vel.abs() / V_MAX).min(1.0);
            let t = sl.t;
            let rumble = 0.0012 * s * ((t * 53.0).sin() + 0.6 * (t * 97.0 + 1.3).sin());
            let sway = 0.0035 * s * ((t * 7.1).sin() + 0.5 * (t * 13.3).sin());
            let gate_e = ease(sl.gate);
            let doors_e = ease(sl.doors);
            let lens = smoothstep(0.35, 1.0, doors_e);
            let span = (n as f32 - 1.0).max(1.0);
            let code = |rel_open: bool, opening: bool, closing: bool| -> f32 {
                if opening {
                    1.0
                } else if closing {
                    3.0
                } else if rel_open {
                    2.0
                } else {
                    0.0
                }
            };
            let car = if e.has((Car::id(), Travelling::id())) {
                1.0
            } else if e.has((Car::id(), Latching::id())) {
                2.0
            } else {
                0.0
            };
            let (gm, gp) = if gl.on > 0.5 {
                let t = gl.t;
                (smoothstep(0.0, 0.35, t) * (1.0 - smoothstep(1.0, 1.6, t)), 1.0)
            } else {
                (0.0, 0.0)
            };
            let _ = gp;
            STATE.with(|st| {
                let mut st = st.borrow_mut();
                st[0] = pos_m + rumble;
                st[1] = (el.pos + la.off / lh) / span;
                st[2] = s;
                st[3] = el.floor as f32;
                st[4] = el.target as f32;
                st[5] = gate_e;
                st[6] = doors_e;
                st[7] = lens;
                st[8] = el.target as f32 / span;
                st[9] = nd.ang;
                st[10] = car;
                st[11] = code(e.has((Doors::id(), Open::id())), e.has((Doors::id(), Opening::id())), e.has((Doors::id(), Closing::id())));
                st[12] = code(e.has((Gate::id(), Open::id())), e.has((Gate::id(), Opening::id())), e.has((Gate::id(), Closing::id())));
                st[13] = sway;
                st[14] = lens;
                st[15] = n as f32;
                st[16] = 0.42 * gm; // yaw toward +x (the control panel)
                st[17] = -0.16 * gm; // pitch (negative looks down)
                st[18] = TH_CAB;
                st[19] = if doors_e > 0.999 { 1.0 } else { 0.0 };
                st[20..28].copy_from_slice(&li.dial);
                st[28..36].copy_from_slice(&li.btn);
                // cab list location in objs, written by cab_info (indices 36, 37), eye height and dolly
                st[38] = EYE;
                st[39] = PUSH;
            });
        });

    world.system_named::<&Rig>("PackCab").kind(pack_ph).each(|rig| pack_rig(rig));

    // ---- Observers: state changes become audio events ----
    let cab_id = *cab.id();
    let _ = cab_id;
    world.observer::<flecs::OnAdd, ()>().with((Gate::id(), Opening::id())).each_entity(|_, _| emit(EV_GATE, 1));
    world.observer::<flecs::OnAdd, ()>().with((Gate::id(), Closing::id())).each_entity(|_, _| emit(EV_GATE, 0));
    world.observer::<flecs::OnAdd, ()>().with((Doors::id(), Opening::id())).each_entity(|_, _| emit(EV_DOOR, 1));
    world.observer::<flecs::OnAdd, ()>().with((Doors::id(), Closing::id())).each_entity(|_, _| emit(EV_DOOR, 0));
    world.observer::<flecs::OnAdd, ()>().with((Gate::id(), Open::id())).each_entity(|e, _| {
        emit(EV_STOP, 3);
        // arrival: gate open, now the doors (unless the car was called away meanwhile; the Sequencer closes them again)
        if let Some(el) = e.try_cloned::<&Elevator>() {
            if e.has((Car::id(), Parked::id())) && el.target == el.floor {
                e.add((Doors::id(), Opening::id()));
            }
        }
    });
    world.observer::<flecs::OnAdd, ()>().with((Gate::id(), Closed::id())).each_entity(|_, _| emit(EV_STOP, 2));
    world.observer::<flecs::OnAdd, ()>().with((Doors::id(), Open::id())).each_entity(|_, _| emit(EV_STOP, 1));
    world.observer::<flecs::OnAdd, ()>().with((Doors::id(), Closed::id())).each_entity(|_, _| emit(EV_STOP, 0));
    world.observer::<flecs::OnAdd, ()>().with((Car::id(), Travelling::id())).each_entity(|e, _| {
        let down = e.try_cloned::<&Elevator>().is_some_and(|el| el.target as f32 > el.pos);
        emit(EV_DEPART, down as u32);
    });
    world
        .observer::<flecs::OnAdd, ()>()
        .with((Car::id(), Latching::id()))
        .each_entity(|_, _| emit(EV_CLUNK, (IMPACT.with(|c| c.get()) * 255.0) as u32));
    world.observer::<flecs::OnAdd, ()>().with((Car::id(), Parked::id())).each_entity(|e, _| {
        let f = e.try_cloned::<&Elevator>().map_or(0, |el| el.floor);
        emit(EV_DING, f as u32);
    });

    // first values for the state buffer (the systems run every tick; the host reads after the first tick)
    STATE.with(|st| {
        let mut st = st.borrow_mut();
        st[15] = n as f32;
        st[18] = TH_CAB;
        st[38] = EYE;
        st[39] = PUSH;
    });
}

/// Rewrite the row of one rig part from the state buffer. Only the fields that move are touched (centre, half extents,
/// rotation axes, emission); everything else keeps the exporter's values. Cab frame, see docs/ELEVATOR.md.
fn pack_rig(rig: &Rig) {
    let s = STATE.with(|st| *st.borrow());
    let n = N.with(|c| c.get());
    let lh = LH.with(|c| c.get());
    let pos_m = s[0];
    let t = CLOCK.with(|c| c.get());
    let a = rig.a;
    let b = rig.b;
    ROWS.with(|rows| {
        let mut rows = rows.borrow_mut();
        let base = rig.row as usize * 28;
        if base + 28 > rows.len() {
            return;
        }
        let row = &mut rows[base..base + 28];
        let set_c = |row: &mut [f32], x: f32, y: f32, z: f32| {
            row[0] = x;
            row[1] = y;
            row[2] = z;
        };
        let set_h = |row: &mut [f32], x: f32, y: f32, z: f32| {
            row[4] = x;
            row[5] = y;
            row[6] = z;
        };
        let set_rot = |row: &mut [f32], m: [[f32; 3]; 3]| {
            row[8..11].copy_from_slice(&m[0]);
            row[12..15].copy_from_slice(&m[1]);
            row[16..19].copy_from_slice(&m[2]);
        };
        let set_glow = |row: &mut [f32], g: [f32; 3]| {
            row[24] = g[0];
            row[25] = g[1];
            row[26] = g[2];
            row[27] = 1.0;
        };
        let gate_e = s[5];
        let doors_e = s[6];
        let gate_w = lerp(GATE_W / GATE_U as f32, COLLAPSED_W, gate_e);
        let gate_x0 = GATE_X0 - GATE_SHIFT * gate_e;
        let gate_edge = gate_x0 + GATE_U as f32 * gate_w;
        let gate_moving = (s[12] == 1.0 || s[12] == 3.0) as u32 as f32;
        match rig.role {
            // scissor gate: X of two bars per cell, the bars lengthen and steepen as the cell narrows
            1 => {
                let u = (b as u32 / 2) as f32;
                let dirn = if (b as u32) % 2 == 0 { 1.0 } else { -1.0 };
                let xc = gate_x0 + (u + 0.5) * gate_w;
                let yc = BAR_Y0 + (a + 0.5) * ROW_H;
                let len = (gate_w * gate_w + ROW_H * ROW_H).sqrt();
                let jitter = 0.012 * gate_moving * (t * 61.0 + b * 1.7 + a * 2.3).sin();
                let th = dirn * ROW_H.atan2(gate_w) + jitter;
                set_c(row, xc, yc, GATE_Z + 0.011 * dirn);
                set_h(row, len * 0.5, 0.011, 0.011);
                set_rot(row, euler(0.0, 0.0, th as f64));
            }
            // rails (bottom, top) span the gate, the front post rides its edge, the hinge post its start
            2 => match a as u32 {
                0 | 1 => {
                    let y = if a < 0.5 { 0.03 } else { 1.97 };
                    set_c(row, 0.5 * (gate_x0 + gate_edge), y, GATE_Z);
                    set_h(row, 0.5 * (gate_edge - gate_x0) + 0.03, 0.03, 0.02);
                }
                2 => set_c(row, gate_edge, 1.0, GATE_Z),
                _ => set_c(row, gate_x0, 1.0, GATE_Z),
            },
            // hall door leaf of floor `a`, side `b` (-1 left, +1 right): slides into the wall pocket behind the hall wall
            3 => {
                let open = if s[3] as i32 == a as i32 { doors_e } else { 0.0 };
                let x = b * (0.5 + 1.02 * open);
                let y = 1.0 + (pos_m - a * lh);
                set_c(row, x, y, LEAF_Z + if b > 0.0 { 0.02 } else { 0.0 });
            }
            // needle: pivots on the hub, angle from vertical, positive leans left
            4 => {
                let ang = s[9];
                set_c(row, HUB[0] - NEEDLE_HALF * ang.sin(), HUB[1] + NEEDLE_HALF * ang.cos(), HUB[2] - 0.005);
                set_rot(row, euler(0.0, 0.0, (FRAC_PI_2 + ang) as f64));
            }
            5 => {
                let i = (a as usize).min(MAX_FLOORS - 1);
                let v = 0.15 + 5.0 * s[20 + i];
                set_glow(row, [1.0 * v, 0.62 * v, 0.2 * v]);
            }
            6 => {
                let i = (a as usize).min(MAX_FLOORS - 1);
                let v = 3.5 * s[28 + i];
                set_glow(row, [1.0 * v, 0.72 * v, 0.3 * v]);
            }
            // rail fishplate: fixed in the building, so it scrolls past the cab
            7 => {
                let rel = (pos_m + b * PLATE_PITCH).rem_euclid(4.0 * PLATE_PITCH) - 0.5 * PLATE_PITCH;
                set_c(row, a * 0.93, rel, 4.08);
            }
            // counterweight and cables: opposite travel, slide behind the right jamb while the doors open
            8 | 9 => {
                let p = (n as f32 - 1.0) * lh;
                let tuck = 0.8 * (doors_e * 4.0).min(1.0);
                let cw_y = 2.0 * pos_m - p + 0.6;
                if rig.role == 8 {
                    set_c(row, 0.62 + tuck, cw_y, 4.12);
                } else {
                    let lo = cw_y + 0.6;
                    let hi = 2.2 + pos_m;
                    if hi > lo {
                        set_c(row, 0.55 + 0.14 * a + tuck, 0.5 * (lo + hi), 4.12);
                        set_h(row, 0.007, 0.5 * (hi - lo), 0.007);
                    } else {
                        set_c(row, 0.55 + 0.14 * a + tuck, -50.0, 4.12);
                    }
                }
            }
            // ceiling lamp flickers a little while the car runs
            11 => {
                let f = 1.0 - 0.05 * s[2] * (t * 41.0).sin();
                set_glow(row, [6.5 * f, 4.2 * f, 2.1 * f]);
            }
            _ => {}
        }
    });
}

thread_local! {
    static CLOCK: Cell<f32> = const { Cell::new(0.0) };
}

fn with_cab<T>(f: impl FnOnce(EntityView) -> T) -> Option<T> {
    let world = WORLD.with(|w| w.borrow().clone())?;
    let id = CAB.with(|c| c.get());
    if id == 0 {
        return None;
    }
    Some(f(world.entity_from_id(id)))
}

// ---- exports (thin; every change goes through the cab entity) ----------------------------------------------------

/// Advance the elevator by `dt_ms`. Call before `world_tick` (which runs the pipeline) in the same frame.
#[no_mangle]
pub extern "C" fn elevator_tick(dt_ms: f32) {
    set_dt(dt_ms);
    CLOCK.with(|c| c.set(c.get() + DT.with(|d| d.get())));
}

/// Page scroll progress 0..1 (the landing scroll). DetentSelect turns it into a target floor.
#[no_mangle]
pub extern "C" fn elevator_scroll(p: f32) {
    if !p.is_finite() {
        return;
    }
    with_cab(|e| {
        e.set(ScrollIn { p, fresh: 1.0 });
    });
}

/// Send the car to `floor`. With `snap` it appears there at once with gate and doors open and no events.
#[no_mangle]
pub extern "C" fn elevator_goto(floor: u32, snap: u32) {
    let n = N.with(|c| c.get()) as i32;
    let f = (floor as i32).clamp(0, n - 1);
    with_cab(|e| {
        let Some(el) = e.try_cloned::<&Elevator>() else { return };
        if snap == 0 {
            e.set(Elevator { target: f, ..el });
            return;
        }
        MUTE.with(|m| m.set(true));
        let sl = e.try_cloned::<&Slide>().unwrap_or_default();
        e.set(Elevator { floor: f, target: f, pos: f as f32, vel: 0.0 })
            .set(Slide { gate: 1.0, doors: 1.0, t: sl.t })
            .set(Latch::default())
            .set(needle_angle_state(f as f32, n as usize))
            .add((Car::id(), Parked::id()))
            .add((Gate::id(), Open::id()))
            .add((Doors::id(), Open::id()));
        MUTE.with(|m| m.set(false));
    });
}

/// 1: stay at this floor with the doors open (an article is being read); 0: release.
#[no_mangle]
pub extern "C" fn elevator_hold(on: u32) {
    with_cab(|e| {
        if on != 0 {
            e.add(Hold::id());
        } else {
            e.remove(Hold::id());
        }
    });
}

/// 0 none; kind << 24 | arg (1 gate, 2 door, 3 clunk, 4 ding, 5 step, 6 depart, 7 stop).
#[no_mangle]
pub extern "C" fn elevator_event_poll() -> u32 {
    poll()
}

/// STATE_LEN f32 (layout in docs/ELEVATOR.md); indices 36 and 37 are the cab list start and count in objs.
#[no_mangle]
pub extern "C" fn elevator_state_ptr() -> *const f32 {
    STATE.with(|s| s.as_ptr() as *const f32)
}

/// The live cab list, `count * 28` f32 in the objs row format, rewritten every tick.
#[no_mangle]
pub extern "C" fn elevator_rows_ptr() -> *const f32 {
    ROWS.with(|r| r.borrow().as_ptr())
}

/// Hot reload: the cab list was re-packed (new rows, maybe a new level height). State and phases are untouched.
pub fn reload(rows: Vec<f32>, level_h: f32) {
    LH.with(|c| c.set(level_h));
    ROWS.with(|r| *r.borrow_mut() = rows);
}

/// Record where the cab list sits in objs (from `export::pack`); the host reads these from the state buffer.
pub fn cab_info(start: u32, count: u32) {
    STATE.with(|st| {
        let mut st = st.borrow_mut();
        st[36] = start as f32;
        st[37] = count as f32;
    });
}
