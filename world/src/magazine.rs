//! The magazine's ECS side (spec: src/lib/ecs/magazine.ts, docs/MAGAZINE.md section 5 and "Flecs vocabulary").
//!
//! Entities: `OpenBook` (the open book; state components below), its children the spread slots (`ChildOf Magazine`, instances of
//! the `Leaf` prefab, chained with `(HasPage, leaf)` on the book and `(Next, ..)` / `(Prev, ..)` between leaves) and the figures
//! (`ChildOf Magazine`, instances of the `FigureLoop | FigureOnce | FigureScrub | FigureStatic` prefabs, each carrying
//! `(OnSpread, leaf)`). Tags: `Current` (leaf at round(f)), `Visible` (leaves being shown or turning), `Active` (figures on a
//! visible leaf), `Opened` (full layer open), `OverviewOn`, `Peeled` (corner lifted), relation `(Focus, figure)` on the book.
//!
//! Pipeline phases (custom, chained by DependsOn): Spring -> Settle -> Cull -> Pack.
//!   Spring  SpreadSpring, CornerSpring, OverviewSpring, BounceDecay
//!   Settle  TurnProgress (progress, direction, SpreadChanged), LayerLand (close finishes)
//!   Cull    LeafCull (Current, Visible), FigureCull (Active from the figure's OnSpread leaf)
//!   Pack    FigureClock (advances Active figures; static and reduced motion pin the poster), PackFigures, PackMag
//! Observers: OnAdd/OnRemove Opened -> LayerOpened/LayerClosed events; OnAdd/OnRemove OverviewOn -> OverviewChanged;
//! OnAdd/OnRemove (Focus, *) -> FigureFocus. Events go through event_poll (5 SpreadChanged, 6 LayerOpened, 7 LayerClosed,
//! 8 FigureFocus(id, 0xffffff cleared), 9 OverviewChanged(on)).
use crate::components::{HasPage, Next, Prev, Visible};
use flecs_ecs::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

pub const STATE_LEN: usize = 16;
pub const MAX_FIGURES: usize = 64;
const SPREAD_OMEGA: f32 = 11.0;
const CORNER_OMEGA: f32 = 14.0;
const OVERVIEW_OMEGA: f32 = 9.0;
/// Bounce half-life 120 ms: decay per second = ln(2) / 0.12
const BOUNCE_K: f32 = 5.776_226_5;
const FLICK: f32 = 1.2;

pub const EV_SPREAD: u32 = 5;
pub const EV_OPENED: u32 = 6;
pub const EV_CLOSED: u32 = 7;
pub const EV_FOCUS: u32 = 8;
pub const EV_OVERVIEW: u32 = 9;

/// f: 0 distilled, 1..N full text; target: where it springs; layer 0 | 1.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Spread {
    pub f: f32,
    pub target: f32,
    pub vel: f32,
    pub layer: f32,
}
/// Leaf in motion. dir -1 | 1 (last motion), progress 0..1 within the current leaf, grabbed 0 | 1.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Turn {
    pub progress: f32,
    pub dir: f32,
    pub grabbed: f32,
}
/// The Full text peel: drag 0..1 of the sheet width, open: released toward open, dragging while the pointer holds it.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Corner {
    pub drag: f32,
    pub open: f32,
    pub dragging: f32,
}
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Overview {
    pub t: f32,
    pub vel: f32,
    pub target: f32,
}
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Bounce {
    pub x: f32,
    pub pulse: f32,
}
/// n: full text spreads; closing: close_full in flight; reduced: reduced motion; last: last announced spread.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Book {
    pub n: f32,
    pub closing: f32,
    pub reduced: f32,
    pub last: f32,
}
/// One spread slot of the resident article: index into the binary's spread table and its layer.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Leaf {
    pub index: f32,
    pub layer: f32,
}
/// One figure: id (index in the binary), t seconds, duration, poster time, mode (FigureMode: 0 loop 1 once 2 scrub 3 static).
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Figure {
    pub id: f32,
    pub t: f32,
    pub duration: f32,
    pub poster: f32,
    pub mode: f32,
}

#[derive(Component, Clone, Copy, Default)]
pub struct Current;
#[derive(Component, Clone, Copy, Default)]
pub struct Active;
#[derive(Component, Clone, Copy, Default)]
pub struct Opened;
#[derive(Component, Clone, Copy, Default)]
pub struct OverviewOn;
#[derive(Component, Clone, Copy, Default)]
pub struct Peeled;
/// Relation `(Focus, figure)` on the book.
#[derive(Component, Clone, Copy, Default)]
pub struct Focus;
/// Relation `(OnSpread, leaf)` on a figure.
#[derive(Component, Clone, Copy, Default)]
pub struct OnSpread;

thread_local! {
    static WORLD: RefCell<Option<World>> = const { RefCell::new(None) };
    static DT: Cell<f32> = const { Cell::new(0.0) };
    static EVENTS: RefCell<VecDeque<u32>> = const { RefCell::new(VecDeque::new()) };
    static STATE: RefCell<[f32; STATE_LEN]> = const { RefCell::new([0.0; STATE_LEN]) };
    static CLOCK: RefCell<[f32; MAX_FIGURES]> = const { RefCell::new([0.0; MAX_FIGURES]) };
}

fn emit(kind: u32, arg: u32) {
    EVENTS.with(|e| e.borrow_mut().push_back(kind << 24 | (arg & 0xffffff)));
}

pub fn poll() -> u32 {
    EVENTS.with(|e| e.borrow_mut().pop_front()).unwrap_or(0)
}

pub fn set_dt(dt: f32) {
    DT.with(|d| d.set(dt));
}

/// critically damped spring, exact for any dt (no overshoot)
fn spring(x: &mut f32, v: &mut f32, target: f32, omega: f32, dt: f32) {
    let d = *x - target;
    let e = (-omega * dt).exp();
    let k = *v + omega * d;
    *x = target + (d + k * dt) * e;
    *v = (*v - omega * k * dt) * e;
}

fn with_book<T>(f: impl FnOnce(&World, EntityView) -> T) -> Option<T> {
    WORLD.with(|w| {
        let w = w.borrow();
        let w = w.as_ref()?;
        let e = w.lookup("OpenBook");
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
    world.component_named::<Leaf>("Leaf");
    world.component_named::<Figure>("Figure");
    world.component_named::<Current>("Current");
    world.component_named::<Active>("Active");
    world.component_named::<Opened>("Opened");
    world.component_named::<OverviewOn>("OverviewOn");
    world.component_named::<Peeled>("Peeled");
    world.component_named::<Focus>("Focus");
    world.component_named::<OnSpread>("OnSpread");
}

/// Create the OpenBook entity, prefabs, phases, systems and observers. Called once after the world is built.
pub fn setup(world: &World) {
    register(world);

    // prefabs: types with overrides
    let leaf = world.prefab_named("LeafPrefab").set(Leaf::default());
    let fig = world.prefab_named("FigurePrefab").set(Figure::default());
    for (name, mode) in [("FigureLoop", 0.0), ("FigureOnce", 1.0), ("FigureScrub", 2.0), ("FigureStatic", 3.0)] {
        world.prefab_named(name).is_a(fig).set(Figure { mode, ..Default::default() });
    }
    let _ = leaf;

    let mag = world.entity_named("OpenBook");
    mag.set(Spread::default())
        .set(Turn { dir: 1.0, ..Default::default() })
        .set(Corner::default())
        .set(Overview::default())
        .set(Bounce::default())
        .set(Book::default());
    WORLD.with(|w| *w.borrow_mut() = Some(world.clone()));
    EVENTS.with(|e| e.borrow_mut().clear());

    // phases
    let spring_ph = world.entity_named("SpringPhase").add(flecs::pipeline::Phase).depends_on(flecs::pipeline::OnUpdate);
    let settle_ph = world.entity_named("SettlePhase").add(flecs::pipeline::Phase).depends_on(spring_ph);
    let cull_ph = world.entity_named("CullPhase").add(flecs::pipeline::Phase).depends_on(settle_ph);
    let pack_ph = world.entity_named("PackPhase").add(flecs::pipeline::Phase).depends_on(cull_ph);

    // ---- Spring ----
    world.system_named::<(&mut Spread, &Turn)>("SpreadSpring").kind(spring_ph).each(|(s, t)| {
        if t.grabbed >= 0.5 {
            return;
        }
        let dt = DT.with(|d| d.get());
        if (s.f - s.target).abs() < 1e-3 && s.vel.abs() < 1e-2 {
            s.f = s.target;
            s.vel = 0.0;
            return;
        }
        let (mut f, mut v) = (s.f, s.vel);
        spring(&mut f, &mut v, s.target, SPREAD_OMEGA, dt);
        if (f - s.target).abs() < 1e-3 && v.abs() < 1e-2 {
            f = s.target;
            v = 0.0;
        }
        s.f = f;
        s.vel = v;
    });

    world.system_named::<(&mut Corner, &Spread)>("CornerSpring").kind(spring_ph).each(|(c, s)| {
        if c.dragging > 0.5 || s.layer > 0.5 {
            return;
        }
        let dt = DT.with(|d| d.get());
        let target = if c.open > 0.5 { 1.0 } else { 0.0 };
        c.drag += (target - c.drag) * (1.0 - (-CORNER_OMEGA * dt).exp());
        if (c.drag - target).abs() < 2e-3 {
            c.drag = target;
        }
    });

    world.system_named::<&mut Overview>("OverviewSpring").kind(spring_ph).each(|o| {
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

    world.system_named::<&mut Bounce>("BounceDecay").kind(spring_ph).each(|b| {
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

    // ---- Settle ----
    world.system_named::<(&Spread, &mut Turn, &mut Book)>("TurnProgress").kind(settle_ph).each(|(s, t, b)| {
        // forward leaf shows floor(f), backward shows ceil(f); progress counts from that side
        let fl = s.f.floor();
        let fr = s.f - fl;
        if t.grabbed < 0.5 && (s.target - s.f).abs() > 1e-3 {
            t.dir = if s.target > s.f { 1.0 } else { -1.0 };
        }
        t.progress = if !(1e-3..=1.0 - 1e-3).contains(&fr) {
            0.0
        } else if t.dir >= 0.0 {
            fr
        } else {
            1.0 - fr
        };
        let n = s.f.round().max(0.0);
        if n != b.last {
            b.last = n;
            emit(EV_SPREAD, n as u32);
        }
    });

    world
        .system_named::<(&mut Spread, &Turn, &mut Book)>("LayerLand")
        .kind(settle_ph)
        .each_entity(|e, (s, t, b)| {
            if b.closing > 0.5 && s.f <= 1e-3 && t.grabbed < 0.5 {
                b.closing = 0.0;
                s.layer = 0.0;
                s.f = 0.0;
                s.target = 0.0;
                e.remove(Opened::id());
            }
        });

    // ---- Cull ----
    world.system_named::<(&Leaf,)>("LeafCull").kind(cull_ph).each_entity(|e, (l,)| {
        let Some(m) = e.parent() else { return };
        let Some(s) = m.try_cloned::<&Spread>() else { return };
        let (lo, hi) = (s.f.floor(), s.f.ceil());
        if l.index == s.f.round() {
            e.add(Current::id());
        } else {
            e.remove(Current::id());
        }
        if l.index == lo || l.index == hi {
            e.add(Visible::id());
        } else {
            e.remove(Visible::id());
        }
    });

    world
        .system_named::<(&Figure,)>("FigureCull")
        .kind(cull_ph)
        .with((OnSpread::id(), flecs::Wildcard::ID))
        .each_entity(|e, _| {
            let on = e.target(OnSpread::id(), 0).is_some_and(|l| l.has(Visible::id()));
            if on {
                e.add(Active::id());
            } else {
                e.remove(Active::id());
            }
        });

    // ---- Pack ----
    world.system_named::<(&mut Figure, &Book)>("FigureClock").kind(pack_ph).each(|(f, b)| {
        // inactive figures hold; static figures and reduced motion pin the poster (Active gating is in the query below)
        if b.reduced > 0.5 || f.mode >= 3.0 {
            f.t = f.poster;
        }
    });
    // the Active-only advance runs as its own query so loop/once figures off screen cost nothing
    world.system_named::<&mut Figure>("FigureAdvance").kind(pack_ph).with(Active::id()).each(|f| {
        let dt = DT.with(|d| d.get());
        if f.mode >= 2.0 {
            return;
        }
        if f.mode < 0.5 {
            f.t += dt;
            if f.duration > 0.0 && f.t >= f.duration {
                f.t -= f.duration * (f.t / f.duration).floor();
            }
        } else {
            f.t = (f.t + dt).min(f.duration);
        }
    });

    world.system_named::<&Figure>("PackFigures").kind(pack_ph).each(|f| {
        CLOCK.with(|c| {
            if let Some(slot) = c.borrow_mut().get_mut(f.id as usize) {
                *slot = f.t;
            }
        });
    });

    world
        .system_named::<(&Spread, &Turn, &Corner, &Overview, &Bounce, &Book)>("PackMag")
        .kind(pack_ph)
        .each_entity(|e, (s, t, c, o, bo, b)| {
            if c.drag > 1e-3 {
                e.add(Peeled::id());
            } else {
                e.remove(Peeled::id());
            }
            let focus = e.target(Focus::id(), 0).and_then(|f| f.try_cloned::<&Figure>()).map_or(-1.0, |f| f.id);
            let index = if t.progress == 0.0 {
                s.f.round()
            } else if t.dir >= 0.0 {
                s.f.floor()
            } else {
                s.f.ceil()
            };
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
                st[10] = focus;
                st[11] = bo.x;
                st[12] = bo.pulse;
                st[13] = b.n;
                st[14] = index;
                st[15] = 0.0;
            });
        });

    // ---- observers ----
    world.observer::<flecs::OnAdd, ()>().with(Opened::id()).each_entity(|_, _| emit(EV_OPENED, 0));
    world.observer::<flecs::OnRemove, ()>().with(Opened::id()).each_entity(|_, _| emit(EV_CLOSED, 0));
    world.observer::<flecs::OnAdd, ()>().with(OverviewOn::id()).each_entity(|_, _| emit(EV_OVERVIEW, 1));
    world.observer::<flecs::OnRemove, ()>().with(OverviewOn::id()).each_entity(|_, _| emit(EV_OVERVIEW, 0));
    world
        .observer::<flecs::OnAdd, ()>()
        .with((Focus::id(), flecs::Wildcard::ID))
        .each_entity(|e, _| {
            let id = e.target(Focus::id(), 0).and_then(|f| f.try_cloned::<&Figure>()).map_or(0xffffff, |f| f.id as u32);
            emit(EV_FOCUS, id);
        });
    world
        .observer::<flecs::OnRemove, ()>()
        .with((Focus::id(), flecs::Wildcard::ID))
        .each_entity(|_, _| emit(EV_FOCUS, 0xffffff));
}

// ---- exports (thin; all mutation goes through the entities) -------------------------------------------------

fn lo_hi(s: &Spread, b: &Book) -> (f32, f32) {
    if s.layer > 0.5 || b.closing > 0.5 {
        (1.0, b.n.max(1.0))
    } else {
        (0.0, 0.0)
    }
}

fn clear_children(world: &World) {
    let mut ids = Vec::new();
    world.new_query::<&Leaf>().each_entity(|e, _| ids.push(e.id()));
    world.new_query::<&Figure>().each_entity(|e, _| ids.push(e.id()));
    for id in ids {
        let e = world.entity_from_id(*id);
        if e.is_alive() {
            e.destruct();
        }
    }
}

pub fn spread_init(n: u32) {
    with_book(|w, e| {
        clear_children(w);
        e.remove(Opened::id());
        e.remove(OverviewOn::id());
        e.remove((Focus::id(), flecs::Wildcard::ID));
        e.set(Spread::default());
        e.set(Turn { dir: 1.0, ..Default::default() });
        e.set(Corner::default());
        e.set(Overview::default());
        e.set(Bounce::default());
        e.set(Book { n: n as f32, ..Default::default() });
        // leaves 0..=n chained with HasPage / Next / Prev
        let proto = w.lookup("LeafPrefab");
        let mut prev: Option<EntityView> = None;
        for i in 0..=n {
            let l = w.entity().is_a(proto).child_of(e).set(Leaf { index: i as f32, layer: if i == 0 { 0.0 } else { 1.0 } });
            e.add((HasPage::id(), l));
            if let Some(p) = prev {
                p.add((Next::id(), l));
                l.add((Prev::id(), p));
            }
            prev = Some(l);
        }
    });
    CLOCK.with(|c| *c.borrow_mut() = [0.0; MAX_FIGURES]);
}

pub fn open_full(n: u32) {
    with_book(|_, e| {
        let (s, b) = (get::<Spread>(e), get::<Book>(e));
        let n = (n as f32).clamp(1.0, b.n.max(1.0));
        e.set(Spread { layer: 1.0, target: n, ..s });
        e.set(Book { closing: 0.0, ..b });
        e.set(Corner::default());
        e.add(Opened::id());
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
    if with_book(|_, e| get::<Spread>(e).layer).unwrap_or(0.0) < 0.5 {
        open_full(n);
        return;
    }
    with_book(|_, e| {
        let (s, b) = (get::<Spread>(e), get::<Book>(e));
        e.set(Spread { target: (n as f32).clamp(1.0, b.n.max(1.0)), ..s });
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
            e.set(Spread { target: (s.target + df).clamp(lo, hi), ..s });
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
        // below the first full text spread the leaf closes the full layer (the reversed turn lands on the distilled spread)
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
        if get::<Spread>(e).layer > 0.5 {
            return;
        }
        e.set(Corner { drag: frac.clamp(0.0, 1.0), open: 0.0, dragging: 1.0 });
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

fn find_figure(w: &World, id: u32) -> Option<u64> {
    let mut hit = None;
    w.new_query::<&Figure>().each_entity(|e, f| {
        if f.id as u32 == id {
            hit = Some(*e.id());
        }
    });
    hit
}

pub fn figure_focus(id: i32) {
    with_book(|w, e| {
        e.remove((Focus::id(), flecs::Wildcard::ID));
        if id >= 0 {
            if let Some(f) = find_figure(w, id as u32) {
                e.add((Focus::id(), w.entity_from_id(f)));
            }
        }
    });
}

pub fn figure_seek(id: u32, t: f32) {
    with_book(|w, _| {
        if let Some(f) = find_figure(w, id) {
            let e = w.entity_from_id(f);
            if let Some(fig) = e.try_cloned::<&Figure>() {
                let t = if fig.duration > 0.0 { t.clamp(0.0, fig.duration) } else { t.max(0.0) };
                e.set(Figure { t, ..fig });
                CLOCK.with(|c| {
                    if let Some(s) = c.borrow_mut().get_mut(id as usize) {
                        *s = t;
                    }
                });
            }
        }
    });
}

/// Declare a figure of the resident article: its spread index, mode (FigureMode), duration and poster time in seconds.
pub fn figure_define(id: u32, spread: u32, mode: u32, duration: f32, poster: f32) {
    with_book(|w, e| {
        let proto = w.lookup(["FigureLoop", "FigureOnce", "FigureScrub", "FigureStatic"][(mode as usize).min(3)]);
        let mut leaf = None;
        w.new_query::<&Leaf>().each_entity(|l, lf| {
            if lf.index as u32 == spread {
                leaf = Some(*l.id());
            }
        });
        let f = w.entity().is_a(proto).child_of(e).set(Figure { id: id as f32, t: poster, duration, poster, mode: mode as f32 });
        if let Some(l) = leaf {
            f.add((OnSpread::id(), w.entity_from_id(l)));
        }
        CLOCK.with(|c| {
            if let Some(s) = c.borrow_mut().get_mut(id as usize) {
                *s = poster;
            }
        });
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
        if on != 0 {
            e.add(OverviewOn::id());
        } else {
            e.remove(OverviewOn::id());
        }
    });
}

pub fn clock_ptr() -> *const f32 {
    CLOCK.with(|c| c.as_ptr() as *const f32)
}

pub fn state_ptr() -> *const f32 {
    STATE.with(|s| s.as_ptr() as *const f32)
}
