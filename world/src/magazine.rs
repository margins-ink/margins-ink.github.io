//! The magazine's ECS side (spec: src/lib/ecs/magazine.ts, docs/MAGAZINE.md section 5).
//! One `Magazine` entity carries Spread, Turn, Corner, Overview, Bounce and Book; the figure clocks live in a table the
//! FigureClock system advances. Systems, in order: SpreadSpring, TurnProgress, CornerSpring, OverviewSpring, BounceDecay,
//! FigureClock, PackMag (writes the 16-float state buffer the host reads). JS owns no runtime state: every gesture is one
//! of the exports in lib.rs. Events (shared queue in reader.rs): SpreadChanged(n) 5, LayerOpened 6, LayerClosed 7,
//! FigureFocus(id) 8 (0xffffff = cleared), OverviewChanged(on) 9.
use flecs_ecs::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

pub const STATE_LEN: usize = 16;
pub const MAX_FIGURES: usize = 64;
const SPREAD_OMEGA: f32 = 11.0;
const CORNER_OMEGA: f32 = 14.0;
const OVERVIEW_OMEGA: f32 = 9.0;
/// Bounce half-life 120 ms: decay per second = ln(2) / 0.12
const BOUNCE_K: f32 = 5.7762265;
const FLICK: f32 = 1.2;

pub const EV_SPREAD: u32 = 5;
pub const EV_OPENED: u32 = 6;
pub const EV_CLOSED: u32 = 7;
pub const EV_FOCUS: u32 = 8;
pub const EV_OVERVIEW: u32 = 9;

/// f: 0 distilled, 1..N full text; target: where it springs; layer 0 | 1.
#[derive(Component, Clone, Copy, Default)]
pub struct Spread {
    pub f: f32,
    pub target: f32,
    pub vel: f32,
    pub layer: f32,
}
/// Leaf in motion. dir -1 | 1 (last motion), progress 0..1 within the current leaf, grabbed 0 | 1.
#[derive(Component, Clone, Copy, Default)]
pub struct Turn {
    pub progress: f32,
    pub dir: f32,
    pub grabbed: f32,
}
/// The Full text peel: drag 0..1 of the sheet width, open: released toward open, dragging while the pointer holds it.
#[derive(Component, Clone, Copy, Default)]
pub struct Corner {
    pub drag: f32,
    pub open: f32,
    pub dragging: f32,
}
#[derive(Component, Clone, Copy, Default)]
pub struct Overview {
    pub t: f32,
    pub vel: f32,
    pub target: f32,
}
#[derive(Component, Clone, Copy, Default)]
pub struct Bounce {
    pub x: f32,
    pub pulse: f32,
}
/// n: number of full text spreads; closing: close_full in flight; focus: figure id or -1; reduced: reduced motion.
#[derive(Component, Clone, Copy, Default)]
pub struct Book {
    pub n: f32,
    pub closing: f32,
    pub focus: f32,
    pub reduced: f32,
    pub last: f32,
}

#[derive(Clone, Copy, Default)]
struct Fig {
    t: f32,
    duration: f32,
    poster: f32,
    spread: i32,
    mode: u32,
    live: bool,
}

thread_local! {
    static WORLD: RefCell<Option<World>> = const { RefCell::new(None) };
    static DT: Cell<f32> = const { Cell::new(0.0) };
    static EVENTS: RefCell<VecDeque<u32>> = const { RefCell::new(VecDeque::new()) };
    static STATE: RefCell<[f32; STATE_LEN]> = const { RefCell::new([0.0; STATE_LEN]) };
    static FIGS: RefCell<[Fig; MAX_FIGURES]> = const { RefCell::new([Fig { t: 0.0, duration: 0.0, poster: 0.0, spread: -1, mode: 3, live: false }; MAX_FIGURES]) };
    static CLOCK: RefCell<[f32; MAX_FIGURES]> = const { RefCell::new([0.0; MAX_FIGURES]) };
}

fn emit(kind: u32, arg: u32) {
    EVENTS.with(|e| e.borrow_mut().push_back(kind << 24 | (arg & 0xffffff)));
}

pub fn poll() -> u32 {
    EVENTS.with(|e| e.borrow_mut().pop_front()).unwrap_or(0)
}

/// critically damped spring, exact for any dt (no overshoot)
fn spring(x: &mut f32, v: &mut f32, target: f32, omega: f32, dt: f32) {
    let d = *x - target;
    let e = (-omega * dt).exp();
    let k = *v + omega * d;
    *x = target + (d + k * dt) * e;
    *v = (*v - omega * k * dt) * e;
}

pub fn set_dt(dt: f32) {
    DT.with(|d| d.set(dt));
}

fn with_book<T>(f: impl FnOnce(&World, EntityView) -> T) -> Option<T> {
    WORLD.with(|w| {
        let w = w.borrow();
        let w = w.as_ref()?;
        let e = w.lookup("Magazine");
        Some(f(w, e))
    })
}

fn get<T: ComponentId + DataComponent + Copy + Default>(e: EntityView) -> T
where
    T::UnderlyingType: Copy,
{
    e.try_cloned::<&T>().unwrap_or_default()
}

pub fn register(world: &World) {
    world.component_named::<Spread>("Spread");
    world.component_named::<Turn>("Turn");
    world.component_named::<Corner>("Corner");
    world.component_named::<Overview>("Overview");
    world.component_named::<Bounce>("Bounce");
    world.component_named::<Book>("Book");
}

/// Create the Magazine entity and the systems. Called once after the world is built.
pub fn setup(world: &World) {
    register(world);
    world
        .entity_named("Magazine")
        .set(Spread::default())
        .set(Turn { dir: 1.0, ..Default::default() })
        .set(Corner::default())
        .set(Overview::default())
        .set(Bounce::default())
        .set(Book { focus: -1.0, ..Default::default() });
    WORLD.with(|w| *w.borrow_mut() = Some(world.clone()));
    FIGS.with(|f| *f.borrow_mut() = [Fig { spread: -1, mode: 3, ..Default::default() }; MAX_FIGURES]);
    EVENTS.with(|e| e.borrow_mut().clear());

    world.system_named::<(&mut Spread, &mut Turn, &mut Book)>("SpreadSpring").each(|(s, t, b)| {
        let dt = DT.with(|d| d.get());
        if t.grabbed < 0.5 {
            let d = s.f - s.target;
            if d.abs() < 1e-3 && s.vel.abs() < 1e-2 {
                s.f = s.target;
                s.vel = 0.0;
            } else {
                spring(&mut s.f, &mut s.vel, s.target, SPREAD_OMEGA, dt);
                if (s.f - s.target).abs() < 1e-3 && s.vel.abs() < 1e-2 {
                    s.f = s.target;
                    s.vel = 0.0;
                }
            }
        }
        // close lands: the reversed turn reached the distilled spread
        if b.closing > 0.5 && s.f <= 1e-3 && t.grabbed < 0.5 {
            b.closing = 0.0;
            s.layer = 0.0;
            s.f = 0.0;
            s.target = 0.0;
            emit(EV_CLOSED, 0);
        }
        let n = s.f.round().max(0.0);
        if n != b.last {
            b.last = n;
            emit(EV_SPREAD, n as u32);
        }
    });

    world.system_named::<(&Spread, &mut Turn)>("TurnProgress").each(|(s, t)| {
        // the leaf in motion: forward (dir +1) shows floor(f), backward shows ceil(f); progress counts from that side
        let fl = s.f.floor();
        let fr = s.f - fl;
        if fr < 1e-3 || fr > 1.0 - 1e-3 {
            t.progress = 0.0;
        } else if t.dir >= 0.0 {
            t.progress = fr;
        } else {
            t.progress = 1.0 - fr;
        }
        // a spring that is settling toward a target decides the direction when nothing is grabbed
        if t.grabbed < 0.5 && (s.target - s.f).abs() > 1e-3 {
            t.dir = if s.target > s.f { 1.0 } else { -1.0 };
        }
    });

    world.system_named::<(&mut Corner, &Spread)>("CornerSpring").each(|(c, s)| {
        let dt = DT.with(|d| d.get());
        if c.dragging > 0.5 || s.layer > 0.5 {
            return;
        }
        let target = if c.open > 0.5 { 1.0 } else { 0.0 };
        let mut v = 0.0;
        // first order approach (the corner has no momentum): exponential
        let _ = &mut v;
        c.drag += (target - c.drag) * (1.0 - (-CORNER_OMEGA * dt).exp());
        if (c.drag - target).abs() < 2e-3 {
            c.drag = target;
        }
    });

    world.system_named::<&mut Overview>("OverviewSpring").each(|o| {
        let dt = DT.with(|d| d.get());
        let (mut t, mut v) = (o.t, o.vel);
        spring(&mut t, &mut v, o.target, OVERVIEW_OMEGA, dt);
        if (t - o.target).abs() < 1e-3 && v.abs() < 1e-2 {
            t = o.target;
            v = 0.0;
        }
        o.t = t;
        o.vel = v;
    });

    world.system_named::<&mut Bounce>("BounceDecay").each(|b| {
        let dt = DT.with(|d| d.get());
        let k = (-BOUNCE_K * dt).exp();
        b.x *= k;
        b.pulse *= k;
        if b.x.abs() < 1e-3 {
            b.x = 0.0;
        }
        if b.pulse < 1e-3 {
            b.pulse = 0.0;
        }
    });

    world.system_named::<(&Spread, &Turn, &Book)>("FigureClock").each(|(s, _t, b)| {
        let dt = DT.with(|d| d.get());
        let lo = s.f.floor() as i32;
        let hi = s.f.ceil() as i32;
        FIGS.with(|f| {
            let mut f = f.borrow_mut();
            CLOCK.with(|c| {
                let mut c = c.borrow_mut();
                for (i, g) in f.iter_mut().enumerate() {
                    if !g.live {
                        continue;
                    }
                    let layer_ok = (g.spread == 0) == (s.layer < 0.5) || g.spread == lo || g.spread == hi;
                    let on = layer_ok && (g.spread == lo || g.spread == hi);
                    if b.reduced > 0.5 || g.mode == 3 {
                        g.t = g.poster;
                    } else if on {
                        match g.mode {
                            0 => {
                                g.t += dt;
                                if g.duration > 0.0 && g.t >= g.duration {
                                    g.t -= g.duration * (g.t / g.duration).floor();
                                }
                            }
                            1 => g.t = (g.t + dt).min(g.duration),
                            _ => {}
                        }
                    }
                    c[i] = g.t;
                }
            });
        });
    });

    world
        .system_named::<(&Spread, &Turn, &Corner, &Overview, &Bounce, &Book)>("PackMag")
        .each(|(s, t, c, o, bo, b)| {
            // index and progress for the shader: forward leaf shows floor(f), backward shows ceil(f)
            let index = if t.progress == 0.0 { s.f.round() } else if t.dir >= 0.0 { s.f.floor() } else { s.f.ceil() };
            STATE.with(|st| {
                let mut st = st.borrow_mut();
                st[0] = s.f;
                st[1] = s.target;
                st[2] = s.vel;
                st[3] = s.layer;
                st[4] = c.drag;
                st[5] = c.open;
                st[6] = t.progress;
                st[7] = if t.progress == 0.0 { 0.0 } else { t.dir };
                st[8] = t.grabbed;
                st[9] = o.t;
                st[10] = b.focus;
                st[11] = bo.x;
                st[12] = bo.pulse;
                st[13] = b.n;
                st[14] = index;
                st[15] = 0.0;
            });
        });
}

// ---- exports (thin; all mutation goes through the entity) -------------------------------------------------

fn lo_hi(s: &Spread, b: &Book) -> (f32, f32) {
    if s.layer > 0.5 || b.closing > 0.5 {
        (1.0, b.n.max(1.0))
    } else {
        (0.0, 0.0)
    }
}

pub fn spread_init(n: u32) {
    with_book(|_, e| {
        e.set(Spread::default());
        e.set(Turn { dir: 1.0, ..Default::default() });
        e.set(Corner::default());
        e.set(Overview::default());
        e.set(Bounce::default());
        let b = get::<Book>(e);
        e.set(Book { n: n as f32, closing: 0.0, focus: -1.0, last: 0.0, ..b });
    });
    FIGS.with(|f| *f.borrow_mut() = [Fig { spread: -1, mode: 3, ..Default::default() }; MAX_FIGURES]);
    CLOCK.with(|c| *c.borrow_mut() = [0.0; MAX_FIGURES]);
}

pub fn open_full(n: u32) {
    with_book(|_, e| {
        let (s, b) = (get::<Spread>(e), get::<Book>(e));
        let n = (n as f32).clamp(1.0, b.n.max(1.0));
        e.set(Spread { layer: 1.0, target: n, ..s });
        e.set(Book { closing: 0.0, ..b });
        e.set(Corner { drag: 0.0, open: 0.0, dragging: 0.0 });
        emit(EV_OPENED, 0);
    });
}

pub fn close_full() {
    with_book(|_, e| {
        let (s, b) = (get::<Spread>(e), get::<Book>(e));
        if s.layer < 0.5 {
            return;
        }
        e.set(Spread { target: 0.0, ..s });
        e.set(Book { closing: 1.0, ..b });
    });
}

pub fn spread_goto(n: u32) {
    if n == 0 {
        close_full();
        return;
    }
    let layer = with_book(|_, e| get::<Spread>(e).layer).unwrap_or(0.0);
    if layer < 0.5 {
        open_full(n);
        return;
    }
    with_book(|_, e| {
        let (s, b) = (get::<Spread>(e), get::<Book>(e));
        let t = (n as f32).clamp(1.0, b.n.max(1.0));
        e.set(Spread { target: t, ..s });
        e.set(Book { closing: 0.0, ..b });
    });
}

pub fn spread_by(df: f32) {
    with_book(|_, e| {
        let (s, t, b, bo) = (get::<Spread>(e), get::<Turn>(e), get::<Book>(e), get::<Bounce>(e));
        let (lo, hi) = lo_hi(&s, &b);
        if hi <= lo && s.layer < 0.5 {
            // distilled spread: nothing to turn to, a rubber band instead
            e.set(Bounce { x: (bo.x + df).clamp(-1.0, 1.0), ..bo });
            return;
        }
        let dir = if df > 0.0 { 1.0 } else if df < 0.0 { -1.0 } else { t.dir };
        if t.grabbed > 0.5 {
            let f = (s.f + df).clamp(lo, hi);
            e.set(Spread { f, target: f, vel: 0.0, ..s });
            e.set(Turn { dir, ..t });
        } else {
            let tg = (s.target + df).clamp(lo, hi);
            e.set(Spread { target: tg, ..s });
        }
    });
}

pub fn spread_grab(dir: i32) {
    with_book(|_, e| {
        let (s, t) = (get::<Spread>(e), get::<Turn>(e));
        e.set(Turn { grabbed: 1.0, dir: if dir < 0 { -1.0 } else { 1.0 }, ..t });
        e.set(Spread { vel: 0.0, target: s.f, ..s });
    });
}

pub fn spread_release(vel: f32) {
    with_book(|_, e| {
        let (s, t, b) = (get::<Spread>(e), get::<Turn>(e), get::<Book>(e));
        let (lo, hi) = lo_hi(&s, &b);
        let mut tg = if vel.abs() > FLICK {
            if vel > 0.0 { s.f.floor() + 1.0 } else { s.f.ceil() - 1.0 }
        } else {
            s.f.round()
        };
        // below the first full text spread the leaf closes the full layer: target 0 (the reversed turn lands on the distilled spread)
        let closing = s.layer > 0.5 && tg < 1.0;
        tg = if closing { 0.0 } else { tg.clamp(lo, hi.max(lo)) };
        e.set(Turn { grabbed: 0.0, dir: if tg >= s.f { 1.0 } else { -1.0 }, ..t });
        e.set(Spread { target: tg, ..s });
        if closing {
            e.set(Book { closing: 1.0, ..b });
        }
    });
}

pub fn corner_drag(frac: f32) {
    with_book(|_, e| {
        let (s, c) = (get::<Corner>(e), get::<Spread>(e));
        if c.layer > 0.5 {
            return;
        }
        e.set(Corner { drag: frac.clamp(0.0, 1.0), open: 0.0, dragging: 1.0 });
        let _ = s;
    });
}

pub fn corner_release(open: u32) {
    with_book(|_, e| {
        let c = get::<Corner>(e);
        e.set(Corner { dragging: 0.0, open: if open != 0 { 1.0 } else { 0.0 }, ..c });
    });
}

pub fn bounce() {
    with_book(|_, e| {
        let b = get::<Bounce>(e);
        e.set(Bounce { x: 1.0, ..b });
    });
}

pub fn pulse_tab() {
    with_book(|_, e| {
        let b = get::<Bounce>(e);
        e.set(Bounce { pulse: 1.0, ..b });
    });
}

pub fn figure_focus(id: i32) {
    with_book(|_, e| {
        let b = get::<Book>(e);
        e.set(Book { focus: id as f32, ..b });
    });
    emit(EV_FOCUS, if id < 0 { 0xffffff } else { id as u32 });
}

pub fn figure_seek(id: u32, t: f32) {
    FIGS.with(|f| {
        if let Some(g) = f.borrow_mut().get_mut(id as usize) {
            g.t = t.clamp(0.0, g.duration.max(t.min(1e6)));
            if g.duration > 0.0 {
                g.t = t.clamp(0.0, g.duration);
            }
            CLOCK.with(|c| c.borrow_mut()[id as usize] = g.t);
        }
    });
}

/// Declare a figure of the resident article: its spread (index in the binary), mode (FigureMode), duration and poster time (s).
pub fn figure_define(id: u32, spread: u32, mode: u32, duration: f32, poster: f32) {
    FIGS.with(|f| {
        if let Some(g) = f.borrow_mut().get_mut(id as usize) {
            *g = Fig { t: poster, duration, poster, spread: spread as i32, mode, live: true };
            CLOCK.with(|c| c.borrow_mut()[id as usize] = poster);
        }
    });
}

pub fn set_reduced_motion(on: u32) {
    with_book(|_, e| {
        let b = get::<Book>(e);
        e.set(Book { reduced: if on != 0 { 1.0 } else { 0.0 }, ..b });
    });
}

pub fn overview_set(on: u32) {
    with_book(|_, e| {
        let o = get::<Overview>(e);
        e.set(Overview { target: if on != 0 { 1.0 } else { 0.0 }, ..o });
    });
    emit(EV_OVERVIEW, on);
}

pub fn clock_ptr() -> *const f32 {
    CLOCK.with(|c| c.as_ptr() as *const f32)
}

pub fn state_ptr() -> *const f32 {
    STATE.with(|s| s.as_ptr() as *const f32)
}
