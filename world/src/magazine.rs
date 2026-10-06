//! The magazine's ECS side (spec: src/lib/ecs/magazine.ts, docs/MAGAZINE.md section 5 and "Flecs vocabulary").
//!
//! One module (`MagazineModule`, `world.import`). All book state is singleton components: `Spread`, `Turn`, `Corner`, `Overview`,
//! `Bounce`, `Book`, and the two output buffers `Events` (ring polled by TS) and `Export` (the packed state and figure clocks).
//! Singleton tags: `Opened` (full layer open), `OverviewOn`, `Closing`, `Grabbed`, `Reduced`, `Settled` (the book is open on screen:
//! figures wait for it). Singleton relations (exclusive): `(Focus, figure)`, `(Hover, figure)`, `(Scrubbing, figure)`, `(CurrentLeaf, leaf)`.
//! Entities: leaves (`LeafPrefab` instances, `Next`-chained) and one entity per figure (`FigurePrefab` instances: `Figure` meta,
//! `FigureTime` clock, `(OnSpread, leaf)`; tags `Active` on a visible leaf, `Scrubbed` while the pointer holds it).
//!
//! Pipeline phases (custom, chained by DependsOn): Spring -> Settle -> Cull -> Pack.
//!   Spring  SpreadSpring, CornerSpring, OverviewSpring, BounceDecay
//!   Settle  TurnProgress, LayerLand (close finishes)
//!   Cull    LeafCull (Visible), BookCursor ((CurrentLeaf, leaf) from round(f)), FigureCull (Active from the figure's OnSpread leaf)
//!   Pack    FigureAdvance (hold, momentum, autoplay), ClockExport, PackMag
//! Observers (the only writers of the event ring): OnAdd/OnRemove Opened -> LayerOpened/LayerClosed; OverviewOn -> OverviewChanged;
//! (Focus, *) -> FigureFocus; (Hover, *) -> FigureHover; (CurrentLeaf, *) -> SpreadChanged; (Scrubbing, *) tags the target `Scrubbed`.
//! Event kinds through event_poll: 5 SpreadChanged, 6 LayerOpened, 7 LayerClosed, 8 FigureFocus(id, 0xffffff cleared),
//! 9 OverviewChanged(on), 10 FigureHover(id, 0xffffff cleared).
use crate::components::{Next, Visible};
use flecs_ecs::prelude::*;
use std::cell::RefCell;
use std::collections::VecDeque;

pub const STATE_LEN: usize = 16;
const SPREAD_OMEGA: f32 = 11.0;
const CORNER_OMEGA: f32 = 14.0;
const OVERVIEW_OMEGA: f32 = 9.0;
/// Bounce half-life 120 ms: decay per second = ln(2) / 0.12
const BOUNCE_K: f32 = 5.776_226_5;
const FLICK: f32 = 1.2;
/// A scrubbed figure waits this long (s) after the last touch before autoplay resumes.
const IDLE_S: f32 = 2.0;
/// A figure shows its poster this long (s) once the book has settled, then plays.
const HOLD_S: f32 = 1.0;
/// Scrub momentum decay per second (velocity in timeline seconds per second).
const MOMENTUM_K: f32 = 4.5;

pub const EV_SPREAD: u32 = 5;
pub const EV_OPENED: u32 = 6;
pub const EV_CLOSED: u32 = 7;
pub const EV_FOCUS: u32 = 8;
pub const EV_OVERVIEW: u32 = 9;
pub const EV_HOVER: u32 = 10;
const NONE_ID: u32 = 0xffffff;

/// f: 0 distilled, 1..N full text; target: where it springs; layer 0 | 1.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Spread {
    pub f: f32,
    pub target: f32,
    pub vel: f32,
    pub layer: f32,
}
/// Leaf in motion: dir -1 | 1 (last motion), progress 0..1 within the current leaf. (`Grabbed` is a tag.)
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Turn {
    pub progress: f32,
    pub dir: f32,
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
/// n: full text spreads of the resident article.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Book {
    pub n: f32,
}
/// One spread slot of the resident article: index into the binary's spread table and its layer.
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Leaf {
    pub index: f32,
    pub layer: f32,
}
/// A figure's static description: id (index in the binary), duration and poster time in seconds, mode (FigureMode: 0 loop 1 once 2 scrub 3 static).
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct Figure {
    pub id: f32,
    pub duration: f32,
    pub poster: f32,
    pub mode: f32,
}
/// A figure's clock: t seconds on its timeline, vel scrub momentum (timeline s per s), auto seconds left before autoplay (0 plays).
#[derive(Component, Clone, Copy, Default)]
#[flecs(meta)]
pub struct FigureTime {
    pub t: f32,
    pub vel: f32,
    pub auto: f32,
}

/// Output ring for TS (kind << 24 | arg).
#[derive(Component, Clone, Default)]
pub struct Events {
    pub q: VecDeque<u32>,
}
/// Packed buffers TS reads through pointers: the book state (STATE_LEN f32) and one clock f32 per figure id.
#[derive(Component, Clone)]
pub struct Export {
    pub state: Box<[f32; STATE_LEN]>,
    pub clock: Vec<f32>,
}
impl Default for Export {
    fn default() -> Self {
        Export { state: Box::new([0.0; STATE_LEN]), clock: Vec::new() }
    }
}
/// Prefab entity ids.
#[derive(Component, Clone, Copy, Default)]
pub struct Prefabs {
    pub leaf: u64,
    pub fig: [u64; 4],
}

macro_rules! tags {
    ($($(#[$m:meta])* $n:ident),*) => { $( $(#[$m])* #[derive(Component, Clone, Copy, Default)] pub struct $n; )* };
}
tags!(Active, Scrubbed, Opened, OverviewOn, Peeled, Closing, Grabbed, Reduced, Settled);
/// Relation `(Focus, figure)`: the keyboard-focused figure.
#[derive(Component, Clone, Copy, Default)]
pub struct Focus;
/// Relation `(Hover, figure)`: the figure under the pointer.
#[derive(Component, Clone, Copy, Default)]
pub struct Hover;
/// Relation `(Scrubbing, figure)`: the figure the pointer holds.
#[derive(Component, Clone, Copy, Default)]
pub struct Scrubbing;
/// Relation `(CurrentLeaf, leaf)`: the leaf at round(f).
#[derive(Component, Clone, Copy, Default)]
pub struct CurrentLeaf;
/// Relation `(OnSpread, leaf)` on a figure.
#[derive(Component, Clone, Copy, Default)]
pub struct OnSpread;

/// The module root.
#[derive(Component)]
pub struct MagazineModule;

thread_local! {
    /// The one handle at the FFI boundary: the wasm exports have no world argument. Systems never read it.
    static WORLD: RefCell<Option<World>> = const { RefCell::new(None) };
}

fn emit(w: &World, kind: u32, arg: u32) {
    w.get::<&mut Events>(|e| e.q.push_back(kind << 24 | (arg & 0xffffff)));
}

pub fn poll() -> u32 {
    with_world(|w| w.get::<&mut Events>(|e| e.q.pop_front())).flatten().unwrap_or(0)
}

/// critically damped spring, exact for any dt (no overshoot)
fn spring(x: &mut f32, v: &mut f32, target: f32, omega: f32, dt: f32) {
    let d = *x - target;
    let e = (-omega * dt).exp();
    let k = *v + omega * d;
    *x = target + (d + k * dt) * e;
    *v = (*v - omega * k * dt) * e;
}

fn with_world<T>(f: impl FnOnce(&World) -> T) -> Option<T> {
    WORLD.with(|w| w.borrow().as_ref().map(f))
}

fn spread_of(w: &World) -> Spread {
    w.try_cloned::<&Spread>().unwrap_or_default()
}

impl Module for MagazineModule {
    fn module(world: &World) {
        world.component_named::<Spread>("Spread");
        world.component_named::<Turn>("Turn");
        world.component_named::<Corner>("Corner");
        world.component_named::<Overview>("Overview");
        world.component_named::<Bounce>("Bounce");
        world.component_named::<Book>("Book");
        world.component_named::<Leaf>("Leaf");
        world.component_named::<Figure>("Figure");
        world.component_named::<FigureTime>("FigureTime");
        world.component::<Events>();
        world.component::<Export>();
        world.component::<Prefabs>();
        world.component::<Active>();
        world.component::<Scrubbed>();
        world.component::<Opened>();
        world.component::<OverviewOn>();
        world.component::<Peeled>();
        world.component::<Closing>();
        world.component::<Grabbed>();
        world.component::<Reduced>();
        world.component::<Settled>();
        world.component::<OnSpread>();
        // one target at a time: adding a new one replaces the old (and fires OnRemove then OnAdd)
        for rel in rels(world) {
            world.entity_from_id(rel).add_trait::<flecs::Exclusive>();
        }

        let leaf = world.prefab_named("LeafPrefab").set(Leaf::default());
        let fig_proto = world.prefab_named("FigurePrefab").set(Figure::default()).set(FigureTime::default());
        let mut figs = [0u64; 4];
        for (i, name) in ["FigureLoop", "FigureOnce", "FigureScrub", "FigureStatic"].into_iter().enumerate() {
            figs[i] = *world.prefab_named(name).is_a(fig_proto).set(Figure { mode: i as f32, ..Default::default() }).id();
        }
        world.set(Prefabs { leaf: *leaf.id(), fig: figs });
        world.set(Spread::default());
        world.set(Turn { dir: 1.0, ..Default::default() });
        world.set(Corner::default());
        world.set(Overview::default());
        world.set(Bounce::default());
        world.set(Book::default());
        world.set(Events::default());
        world.set(Export::default());

        let spring_ph = world.entity_named("SpringPhase").add(flecs::pipeline::Phase).depends_on(flecs::pipeline::OnUpdate);
        let settle_ph = world.entity_named("SettlePhase").add(flecs::pipeline::Phase).depends_on(spring_ph);
        let cull_ph = world.entity_named("CullPhase").add(flecs::pipeline::Phase).depends_on(settle_ph);
        let pack_ph = world.entity_named("PackPhase").add(flecs::pipeline::Phase).depends_on(cull_ph);

        systems(world, spring_ph, settle_ph, cull_ph, pack_ph);
        observers(world);
    }
}

/// The four singleton relations as entity ids.
fn rels(w: &World) -> [Entity; 4] {
    [w.component_id::<Focus>(), w.component_id::<Hover>(), w.component_id::<Scrubbing>(), w.component_id::<CurrentLeaf>()]
}

fn systems(world: &World, spring_ph: EntityView, settle_ph: EntityView, cull_ph: EntityView, pack_ph: EntityView) {
    // ---- Spring ---- (terms with a singleton source: `set_src(T::id())`)
    world
        .system_named::<(&mut Spread, &Turn)>("SpreadSpring")
        .kind(spring_ph)
        .term_at(0).set_src(Spread::id())
        .term_at(1).set_src(Turn::id())
        .each_iter(|it, _, (s, _t)| {
            let dt = it.delta_time();
            if it.world().has(Grabbed::id()) {
                return;
            }
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

    world
        .system_named::<(&mut Corner, &Spread)>("CornerSpring")
        .kind(spring_ph)
        .term_at(0).set_src(Corner::id())
        .term_at(1).set_src(Spread::id())
        .each_iter(|it, _, (c, s)| {
            if c.dragging > 0.5 || s.layer > 0.5 {
                return;
            }
            let target = if c.open > 0.5 { 1.0 } else { 0.0 };
            c.drag += (target - c.drag) * (1.0 - (-CORNER_OMEGA * it.delta_time()).exp());
            if (c.drag - target).abs() < 2e-3 {
                c.drag = target;
            }
        });

    world.system_named::<&mut Overview>("OverviewSpring").kind(spring_ph).term_at(0).set_src(Overview::id()).each_iter(|it, _, o| {
        let (mut t, mut v) = (o.t, o.vel);
        spring(&mut t, &mut v, o.target, OVERVIEW_OMEGA, it.delta_time());
        if (t - o.target).abs() < 1e-3 && v.abs() < 1e-2 {
            t = o.target;
            v = 0.0;
        }
        o.t = t;
        o.vel = v;
    });

    world.system_named::<&mut Bounce>("BounceDecay").kind(spring_ph).term_at(0).set_src(Bounce::id()).each_iter(|it, _, b| {
        let k = (-BOUNCE_K * it.delta_time()).exp();
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
    world
        .system_named::<(&Spread, &mut Turn)>("TurnProgress")
        .kind(settle_ph)
        .term_at(0).set_src(Spread::id())
        .term_at(1).set_src(Turn::id())
        .each_iter(|it, _, (s, t)| {
            // forward leaf shows floor(f), backward shows ceil(f); progress counts from that side
            let fl = s.f.floor();
            let fr = s.f - fl;
            if !it.world().has(Grabbed::id()) && (s.target - s.f).abs() > 1e-3 {
                t.dir = if s.target > s.f { 1.0 } else { -1.0 };
            }
            t.progress = if !(1e-3..=1.0 - 1e-3).contains(&fr) {
                0.0
            } else if t.dir >= 0.0 {
                fr
            } else {
                1.0 - fr
            };
        });

    world
        .system_named::<&mut Spread>("LayerLand")
        .kind(settle_ph)
        .term_at(0).set_src(Spread::id())
        .each_iter(|it, _, s| {
            let w = it.world();
            if w.has(Closing::id()) && s.f <= 1e-3 && !w.has(Grabbed::id()) {
                s.layer = 0.0;
                s.f = 0.0;
                s.target = 0.0;
                w.remove(Closing::id());
                w.remove(Opened::id());
            }
        });

    // ---- Cull ----
    world.system_named::<&Leaf>("LeafCull").kind(cull_ph).each_iter(|it, row, l| {
        let s = spread_of(&it.world());
        let e = it.entity(row);
        if l.index == s.f.floor() || l.index == s.f.ceil() {
            e.add(Visible::id());
        } else {
            e.remove(Visible::id());
        }
    });

    // the leaf at round(f) becomes the target of the exclusive (CurrentLeaf, *); an observer announces the change
    world.system_named::<&Spread>("BookCursor").kind(cull_ph).term_at(0).set_src(Spread::id()).each_iter(|it, _, s| {
        let w = it.world();
        let n = s.f.round().max(0.0);
        let mut hit = None;
        w.new_query::<&Leaf>().each_entity(|l, lf| {
            if lf.index == n {
                hit = Some(l.id());
            }
        });
        if let Some(l) = hit {
            if w.target(CurrentLeaf::id(), Some(0)).id() != l {
                w.add((CurrentLeaf::id(), l));
            }
        }
    });

    world.system_named::<&Figure>("FigureCull").kind(cull_ph).with((OnSpread::id(), flecs::Wildcard::ID)).each_entity(|e, _| {
        let on = e.target(OnSpread::id(), 0).is_some_and(|l| l.has(Visible::id()));
        if on {
            e.add(Active::id());
        } else {
            e.remove(Active::id());
        }
    });

    // ---- Pack ----
    // Active figures only (off screen costs nothing), and only once the book has settled on screen. A scrubbed figure is held by the pointer.
    world
        .system_named::<(&Figure, &mut FigureTime)>("FigureAdvance")
        .kind(pack_ph)
        .with(Active::id())
        .without(Scrubbed::id())
        .each_iter(|it, _, (f, c)| {
            let w = it.world();
            if f.mode >= 3.0 {
                c.t = f.poster;
                return;
            }
            if !w.has(Settled::id()) {
                return;
            }
            let dt = it.delta_time();
            // the idle countdown runs from release, alongside momentum
            c.auto = (c.auto - dt).max(0.0);
            if c.vel != 0.0 {
                c.t += c.vel * dt;
                c.vel *= (-MOMENTUM_K * dt).exp();
                if c.vel.abs() < 0.02 {
                    c.vel = 0.0;
                }
                if f.mode < 0.5 {
                    c.t = wrap(c.t, f.duration);
                } else {
                    let hi = f.duration.max(0.0);
                    if c.t <= 0.0 || c.t >= hi {
                        c.vel = 0.0; // a wall stops momentum
                    }
                    c.t = c.t.clamp(0.0, hi);
                }
            } else if c.auto <= 0.0 && !w.has(Reduced::id()) {
                if f.mode < 0.5 {
                    c.t = wrap(c.t + dt, f.duration);
                } else if f.mode < 1.5 {
                    c.t = (c.t + dt).min(f.duration);
                }
            }
        });

    world.system_named::<(&Figure, &FigureTime)>("ClockExport").kind(pack_ph).each_iter(|it, _, (f, c)| {
        let (id, t) = (f.id as usize, c.t);
        it.world().get::<&mut Export>(|e| {
            if let Some(slot) = e.clock.get_mut(id) {
                *slot = t;
            }
        });
    });

    world.system_named::<()>("PackMag").kind(pack_ph).run(|mut it| {
        while it.next() {
            let w = it.world();
            let (s, t, c, o, bo, b) = (
                spread_of(&w),
                w.try_cloned::<&Turn>().unwrap_or_default(),
                w.try_cloned::<&Corner>().unwrap_or_default(),
                w.try_cloned::<&Overview>().unwrap_or_default(),
                w.try_cloned::<&Bounce>().unwrap_or_default(),
                w.try_cloned::<&Book>().unwrap_or_default(),
            );
            if c.drag > 1e-3 {
                w.add(Peeled::id());
            } else {
                w.remove(Peeled::id());
            }
            let fig_id = |rel: Entity| -> f32 {
                if !w.has((rel, flecs::Wildcard::ID)) {
                    return -1.0;
                }
                w.target(rel, Some(0)).try_cloned::<&Figure>().map_or(-1.0, |f| f.id)
            };
            let index = if t.progress == 0.0 {
                s.f.round()
            } else if t.dir >= 0.0 {
                s.f.floor()
            } else {
                s.f.ceil()
            };
            let (focus, hover) = (fig_id(w.component_id::<Focus>()), fig_id(w.component_id::<Hover>()));
            w.get::<&mut Export>(|e| {
                let st = &mut e.state;
                st[0] = s.f;
                st[1] = s.target;
                st[2] = s.vel;
                st[3] = s.layer;
                st[4] = c.drag;
                st[5] = c.open;
                st[6] = t.progress;
                st[7] = if t.progress == 0.0 { 0.0 } else { t.dir };
                st[8] = if w.has(Grabbed::id()) { 1.0 } else { 0.0 };
                st[9] = o.t;
                st[10] = focus;
                st[11] = bo.x;
                st[12] = bo.pulse;
                st[13] = b.n;
                st[14] = index;
                st[15] = hover;
            });
        }
    });
}

fn wrap(t: f32, duration: f32) -> f32 {
    if duration > 0.0 {
        t.rem_euclid(duration)
    } else {
        0.0
    }
}

fn observers(world: &World) {
    world.observer::<flecs::OnAdd, ()>().with(Opened::id()).each_iter(|it, _, _| emit(&it.world(), EV_OPENED, 0));
    world.observer::<flecs::OnRemove, ()>().with(Opened::id()).each_iter(|it, _, _| emit(&it.world(), EV_CLOSED, 0));
    world.observer::<flecs::OnAdd, ()>().with(OverviewOn::id()).each_iter(|it, _, _| emit(&it.world(), EV_OVERVIEW, 1));
    world.observer::<flecs::OnRemove, ()>().with(OverviewOn::id()).each_iter(|it, _, _| emit(&it.world(), EV_OVERVIEW, 0));
    // an event for a relation target: the figure id (or the leaf index) rides in the event
    for (rel, kind) in [(world.component_id::<Focus>(), EV_FOCUS), (world.component_id::<Hover>(), EV_HOVER)] {
        world.observer::<flecs::OnAdd, ()>().with((rel, flecs::Wildcard::ID)).each_iter(move |it, _, _| {
            let w = it.world();
            let id = w.target(rel, Some(0)).try_cloned::<&Figure>().map_or(NONE_ID, |f| f.id as u32);
            emit(&w, kind, id);
        });
        world.observer::<flecs::OnRemove, ()>().with((rel, flecs::Wildcard::ID)).each_iter(move |it, _, _| emit(&it.world(), kind, NONE_ID));
    }
    world.observer::<flecs::OnAdd, ()>().with((CurrentLeaf::id(), flecs::Wildcard::ID)).each_iter(|it, _, _| {
        let w = it.world();
        let n = w.target(CurrentLeaf::id(), Some(0)).try_cloned::<&Leaf>().map_or(0, |l| l.index as u32);
        emit(&w, EV_SPREAD, n);
    });
    // (Scrubbing, f) puts the Scrubbed tag on f; losing the pair takes it off, so FigureAdvance skips exactly the held figure
    world.observer::<flecs::OnAdd, ()>().with((Scrubbing::id(), flecs::Wildcard::ID)).each_iter(|it, _, _| {
        let w = it.world();
        w.target(Scrubbing::id(), Some(0)).add(Scrubbed::id());
    });
    world.observer::<flecs::OnRemove, ()>().with((Scrubbing::id(), flecs::Wildcard::ID)).each_iter(|it, _, _| {
        let w = it.world();
        w.query::<()>().with(Scrubbed::id()).build().each_entity(|e, _| { e.remove(Scrubbed::id()); });
    });
}

/// Install the module. Called once after the world is built.
pub fn setup(world: &World) {
    world.import::<MagazineModule>();
    WORLD.with(|w| *w.borrow_mut() = Some(world.clone()));
}

// ---- exports (thin; all mutation goes through the singletons and entities) -------------------------------

fn lo_hi(w: &World) -> (f32, f32) {
    let (s, b) = (spread_of(w), w.try_cloned::<&Book>().unwrap_or_default());
    if s.layer > 0.5 || w.has(Closing::id()) {
        (1.0, b.n.max(1.0))
    } else {
        (0.0, 0.0)
    }
}

fn clear_children(w: &World) {
    let mut ids = Vec::new();
    w.new_query::<&Leaf>().each_entity(|e, _| ids.push(e.id()));
    w.new_query::<&Figure>().each_entity(|e, _| ids.push(e.id()));
    for id in ids {
        let e = w.entity_from_id(*id);
        if e.is_alive() {
            e.destruct();
        }
    }
}

pub fn spread_init(n: u32) {
    with_world(|w| {
        clear_children(w);
        w.remove(Opened::id());
        w.remove(OverviewOn::id());
        w.remove(Closing::id());
        w.remove(Grabbed::id());
        for rel in rels(w) {
            w.remove((rel, flecs::Wildcard::ID));
        }
        w.set(Spread::default());
        w.set(Turn { dir: 1.0, ..Default::default() });
        w.set(Corner::default());
        w.set(Overview::default());
        w.set(Bounce::default());
        w.set(Book { n: n as f32 });
        w.get::<&mut Export>(|e| e.clock.clear());
        // leaves 0..=n, chained with Next
        let proto = w.entity_from_id(w.cloned::<&Prefabs>().leaf);
        let mut prev: Option<EntityView> = None;
        let mut first = None;
        for i in 0..=n {
            let l = w.entity().is_a(proto).set(Leaf { index: i as f32, layer: if i == 0 { 0.0 } else { 1.0 } });
            if let Some(p) = prev {
                p.add((Next::id(), l));
            } else {
                first = Some(l);
            }
            prev = Some(l);
        }
        if let Some(l) = first {
            w.add((CurrentLeaf::id(), l));
        }
        w.get::<&mut Events>(|e| e.q.clear());
    });
}

pub fn open_full(n: u32) {
    with_world(|w| {
        let (s, b) = (spread_of(w), w.try_cloned::<&Book>().unwrap_or_default());
        let n = (n as f32).clamp(1.0, b.n.max(1.0));
        w.set(Spread { layer: 1.0, target: n, ..s });
        w.remove(Closing::id());
        w.set(Corner::default());
        w.add(Opened::id());
    });
}

pub fn close_full() {
    with_world(|w| {
        let s = spread_of(w);
        if s.layer < 0.5 {
            return;
        }
        w.set(Spread { target: 0.0, ..s });
        w.add(Closing::id());
    });
}

pub fn spread_goto(n: u32) {
    if n == 0 {
        close_full();
        return;
    }
    if with_world(|w| spread_of(w).layer).unwrap_or(0.0) < 0.5 {
        open_full(n);
        return;
    }
    with_world(|w| {
        let (s, b) = (spread_of(w), w.try_cloned::<&Book>().unwrap_or_default());
        w.set(Spread { target: (n as f32).clamp(1.0, b.n.max(1.0)), ..s });
        w.remove(Closing::id());
    });
}

pub fn spread_by(df: f32) {
    with_world(|w| {
        let (s, t, bo) = (spread_of(w), w.try_cloned::<&Turn>().unwrap_or_default(), w.try_cloned::<&Bounce>().unwrap_or_default());
        let (lo, hi) = lo_hi(w);
        if hi <= lo && s.layer < 0.5 {
            // distilled spread: nothing to turn to, a rubber band instead
            w.set(Bounce { x: (bo.x + df).clamp(-1.0, 1.0), ..bo });
            return;
        }
        let dir = if df > 0.0 { 1.0 } else if df < 0.0 { -1.0 } else { t.dir };
        if w.has(Grabbed::id()) {
            let f = (s.f + df).clamp(lo, hi);
            w.set(Spread { f, target: f, vel: 0.0, ..s });
            w.set(Turn { dir, ..t });
        } else {
            w.set(Spread { target: (s.target + df).clamp(lo, hi), ..s });
        }
    });
}

pub fn spread_grab(dir: i32) {
    with_world(|w| {
        let (s, t) = (spread_of(w), w.try_cloned::<&Turn>().unwrap_or_default());
        w.add(Grabbed::id());
        w.set(Turn { dir: if dir < 0 { -1.0 } else { 1.0 }, ..t });
        w.set(Spread { vel: 0.0, target: s.f, ..s });
    });
}

pub fn spread_release(vel: f32) {
    with_world(|w| {
        let (s, t) = (spread_of(w), w.try_cloned::<&Turn>().unwrap_or_default());
        let (lo, hi) = lo_hi(w);
        let mut tg = if vel.abs() > FLICK {
            if vel > 0.0 { s.f.floor() + 1.0 } else { s.f.ceil() - 1.0 }
        } else {
            s.f.round()
        };
        // below the first full text spread the leaf closes the full layer (the reversed turn lands on the distilled spread)
        let closing = s.layer > 0.5 && tg < 1.0;
        tg = if closing { 0.0 } else { tg.clamp(lo, hi.max(lo)) };
        w.remove(Grabbed::id());
        w.set(Turn { dir: if tg >= s.f { 1.0 } else { -1.0 }, ..t });
        w.set(Spread { target: tg, ..s });
        if closing {
            w.add(Closing::id());
        }
    });
}

pub fn corner_drag(frac: f32) {
    with_world(|w| {
        if spread_of(w).layer > 0.5 {
            return;
        }
        w.set(Corner { drag: frac.clamp(0.0, 1.0), open: 0.0, dragging: 1.0 });
    });
}

pub fn corner_release(open: u32) {
    with_world(|w| {
        let c = w.try_cloned::<&Corner>().unwrap_or_default();
        w.set(Corner { dragging: 0.0, open: if open != 0 { 1.0 } else { 0.0 }, ..c });
    });
}

pub fn bounce() {
    with_world(|w| {
        let b = w.try_cloned::<&Bounce>().unwrap_or_default();
        w.set(Bounce { x: 1.0, ..b });
    });
}

pub fn pulse_tab() {
    with_world(|w| {
        let b = w.try_cloned::<&Bounce>().unwrap_or_default();
        w.set(Bounce { pulse: 1.0, ..b });
    });
}

fn find_figure(w: &World, id: u32) -> Option<EntityView<'_>> {
    let mut hit = None;
    w.new_query::<&Figure>().each_entity(|e, f| {
        if f.id as u32 == id {
            hit = Some(e.id());
        }
    });
    hit.map(|h| w.entity_from_id(*h))
}

/// Point a singleton relation at figure `id` (or clear it for a negative id).
fn point(w: &World, rel: Entity, id: i32) {
    if id < 0 {
        w.remove((rel, flecs::Wildcard::ID));
    } else if let Some(f) = find_figure(w, id as u32) {
        if w.target(rel, Some(0)).id() != f.id() {
            w.add((rel, f));
        }
    }
}

pub fn figure_focus(id: i32) {
    with_world(|w| point(w, w.component_id::<Focus>(), id));
}

pub fn figure_hover(id: i32) {
    with_world(|w| point(w, w.component_id::<Hover>(), id));
}

/// The pointer takes the figure: autoplay and momentum stop, the idle countdown restarts.
pub fn figure_scrub_begin(id: u32) {
    with_world(|w| {
        if let Some(f) = find_figure(w, id) {
            if let Some(c) = f.try_cloned::<&FigureTime>() {
                f.set(FigureTime { vel: 0.0, auto: IDLE_S, ..c });
            }
            point(w, w.component_id::<Scrubbing>(), id as i32);
        }
    });
}

/// Move a held figure by `dt` timeline seconds (loop figures wrap, the others clamp).
pub fn figure_scrub_by(id: u32, dt: f32) {
    with_world(|w| {
        if let (Some(f), true) = (find_figure(w, id), true) {
            if let (Some(fig), Some(c)) = (f.try_cloned::<&Figure>(), f.try_cloned::<&FigureTime>()) {
                let t = if fig.mode < 0.5 { wrap(c.t + dt, fig.duration) } else { (c.t + dt).clamp(0.0, fig.duration.max(0.0)) };
                f.set(FigureTime { t, vel: 0.0, auto: IDLE_S });
            }
        }
    });
}

/// Release with the pointer's timeline velocity (s per s): momentum, then `IDLE_S` of rest before autoplay resumes.
pub fn figure_scrub_end(id: u32, vel: f32) {
    with_world(|w| {
        if let Some(f) = find_figure(w, id) {
            if let Some(c) = f.try_cloned::<&FigureTime>() {
                f.set(FigureTime { vel: if w.has(Reduced::id()) { 0.0 } else { vel }, auto: IDLE_S, ..c });
            }
        }
        w.remove((Scrubbing::id(), flecs::Wildcard::ID));
    });
}

pub fn figure_seek(id: u32, t: f32) {
    with_world(|w| {
        if let Some(f) = find_figure(w, id) {
            if let (Some(fig), Some(c)) = (f.try_cloned::<&Figure>(), f.try_cloned::<&FigureTime>()) {
                let t = if fig.duration > 0.0 { t.clamp(0.0, fig.duration) } else { t.max(0.0) };
                f.set(FigureTime { t, vel: 0.0, auto: IDLE_S });
                let _ = c;
                w.get::<&mut Export>(|e| {
                    if let Some(s) = e.clock.get_mut(id as usize) {
                        *s = t;
                    }
                });
            }
        }
    });
}

/// Declare a figure of the resident article: its spread index, mode (FigureMode), duration and poster time in seconds.
pub fn figure_define(id: u32, spread: u32, mode: u32, duration: f32, poster: f32) {
    with_world(|w| {
        let proto = w.entity_from_id(w.cloned::<&Prefabs>().fig[(mode as usize).min(3)]);
        let mut leaf = None;
        w.new_query::<&Leaf>().each_entity(|l, lf| {
            if lf.index as u32 == spread {
                leaf = Some(l.id());
            }
        });
        let f = w
            .entity()
            .is_a(proto)
            .set(Figure { id: id as f32, duration, poster, mode: mode as f32 })
            .set(FigureTime { t: poster, vel: 0.0, auto: HOLD_S });
        if let Some(l) = leaf {
            f.add((OnSpread::id(), w.entity_from_id(*l)));
        }
        w.get::<&mut Export>(|e| {
            if e.clock.len() <= id as usize {
                e.clock.resize(id as usize + 1, 0.0);
            }
            e.clock[id as usize] = poster;
        });
    });
}

pub fn set_reduced_motion(on: u32) {
    with_world(|w| {
        if on != 0 {
            w.add(Reduced::id());
        } else {
            w.remove(Reduced::id());
        }
    });
}

/// The book is open on screen (the fly-in finished): figures start their hold, then play. Off again when it closes.
pub fn book_settled(on: u32) {
    with_world(|w| {
        if on != 0 {
            w.add(Settled::id());
        } else {
            w.remove(Settled::id());
            // back to the poster for the next opening
            w.new_query::<(&Figure, &mut FigureTime)>().each(|(f, c)| {
                c.t = f.poster;
                c.vel = 0.0;
                c.auto = HOLD_S;
            });
        }
    });
}

pub fn overview_set(on: u32) {
    with_world(|w| {
        let o = w.try_cloned::<&Overview>().unwrap_or_default();
        w.set(Overview { target: if on != 0 { 1.0 } else { 0.0 }, ..o });
        if on != 0 {
            w.add(OverviewOn::id());
        } else {
            w.remove(OverviewOn::id());
        }
    });
}

pub fn clock_ptr() -> *const f32 {
    with_world(|w| w.get::<&Export>(|e| e.clock.as_ptr())).unwrap_or(std::ptr::null())
}

pub fn clock_len() -> u32 {
    with_world(|w| w.get::<&Export>(|e| e.clock.len() as u32)).unwrap_or(0)
}

pub fn state_ptr() -> *const f32 {
    with_world(|w| w.get::<&Export>(|e| e.state.as_ptr())).unwrap_or(std::ptr::null())
}
