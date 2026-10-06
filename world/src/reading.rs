//! The reading module: one scrolling page as Flecs entities (docs/READING.md sections 5, 6 and 9, docs/READING_CONTRACT.md).
//!
//! The wire contract is `src/lib/reading/abi.ts` (load buffer, `RD` state indices, events, `INPUT` kinds, exports). This file
//! implements it and nothing else: JS owns the DOM, the GPU resources and the strings; Flecs owns the reading state.
//!
//! Entities. `article` (anonymous, replaced by every load) holds everything as `(ChildOf, article)`:
//!   Block   prefab `BlockPrefab {Rect, BlockInfo}`; one prefab per `BlockKind` (`HeadingBlock`, `FigureBlock`, `FoldBlock`, ...) IsA it.
//!           Created in reading order, chained by the exclusive `(Next, block)`. `Anchor {string_off}` on blocks that have one,
//!           `(InFold, fold)` on every block with `BlockFlag.folded`. A figure block also carries `Figure` and `FigureTime`.
//!   Note    prefab `NotePrefab {Rect, NoteInfo}`, `(NoteOf, block)`.
//!   Link    `Link {block, kind, line}` with `(Targets, block)` for an internal link and `(Cites, ref)` for a reference (`RefEntry`).
//! Singletons: `Scroll {y, vel, max}`, `Viewport {w, h, dpr, class}`, `Typography {scale, em_px}`, `Fold {t, target, vel, y, h, peek}`,
//! `Doc` (the exported y arrays the culling binary-searches, the figure rows and the packed caches), `Events` (ring polled by JS).
//! Singleton tags: `Settled` (the fold spring is at rest), `Expanded` (fold target 1), `Reduced` (reduced motion).
//! Exclusive relations on the world (each change is an event through an observer): `(Reading, heading)`, `(Hover, block)`,
//! `(Focus, block)`, `(Scrubbing, figure block)`, `(Open, block)`. Tag `Visible` marks figures inside the data lookahead.
//!
//! Pipeline (custom phases chained by DependsOn after OnUpdate): Input -> Spring -> Layout -> Cull -> Pack. (Spring runs before Layout so the
//! document height of a frame already carries that frame's fold position.)
//!   Input   ScrollTrack      idle time and velocity from `Scroll.y` as written by `reading_set_scroll`
//!   Spring  FoldSpring       critically damped, omega 14, instant under reduced motion
//!   Layout  DocMetrics       fold clip, document height, `Scroll.max`
//!   Cull    CullBlocks       binary searches over the exported y arrays (blocks, notes), recomputed only when scroll, viewport or clip moved
//!           ReadingSpy       the current heading
//!           FigureClock      per figure: on screen, live (60 percent in the viewport), data lookahead (`Visible`)
//!   Pack    FigureAdvance    clocks: autoplay, scrub momentum
//!           PackState        the 64 float `RD` buffer
//! Event ring: kind in the top byte (1-based index into READING_EVENTS), argument in the low 24 bits (`NONE` for cleared).
//! A cleared event directly followed by a set of the same kind collapses into the set (an exclusive relation replace fires both).
//!
//! Deviations from abi.ts: none. Interpretations the page lane may rely on:
//!   * `RD.visFirst/visCount` is one contiguous range in document space; while the fold is collapsed and the viewport straddles the clip
//!     line the hidden folded blocks between are inside it (the page pass clips at `RD.foldClipEm`).
//!   * The per figure flag at `RD.figBase + 2i + 1` is "intersects the viewport" (draw it); `figVisFirst/figVisCount` is the 1.5 viewport data range.
//!   * A figure autoplays only while 60 percent of it (or 60 percent of the viewport height) is inside the viewport, the page has been
//!     idle for 0.2 s, nothing holds it, and the user has not touched it for 1.5 s (`USER_HOLD_S`).
use crate::scroll::{self, ScrollSim};
use flecs_ecs::prelude::*;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};

pub const STATE_LEN: usize = 64;
pub const MAX_FIG_STATE: usize = 16;

const FOLD_OMEGA: f32 = 14.0;
/// Scrub momentum decay per second (velocity in timeline seconds per second).
const MOMENTUM_K: f32 = 4.5;
const LIVE_FRAC: f32 = 0.6;
const IDLE_GATE_S: f32 = 0.2;
/// Autoplay waits this long (s) after the last touch of a figure.
const USER_HOLD_S: f32 = 1.5;
/// A heading is current once it is within this many em of the viewport top.
const SPY_EM: f32 = 3.0;
const TEXT_AHEAD: f32 = 0.25;
const FIG_AHEAD: f32 = 1.5;
const NONE: u32 = 0xff_ffff;
/// Body line height in em (`LINE_EM` in src/lib/reading/metrics.ts): a wheel line is this many em.
const LINE_EM: f32 = 1.62;
const MAX_EVENTS: usize = 256;

// events (1-based index into READING_EVENTS)
const EV_SECTION: u32 = 1;
const EV_FOLD_SETTLED: u32 = 2;
const EV_FOLD_EXPAND: u32 = 3;
const EV_FIG_VISIBLE: u32 = 4;
const EV_FIG_HIDDEN: u32 = 5;
const EV_OPEN: u32 = 6;
const EV_FOCUS: u32 = 7;
const EV_HOVER: u32 = 8;
const EV_LAYOUT: u32 = 9;

// RD indices (abi.ts)
const RD_SCROLL: usize = 0;
const RD_SCROLL_MAX: usize = 1;
const RD_FOLD_T: usize = 2;
const RD_FOLD_TARGET: usize = 3;
const RD_FOLD_CLIP: usize = 4;
const RD_DOC_H: usize = 5;
const RD_VIS_FIRST: usize = 6;
const RD_VIS_COUNT: usize = 7;
const RD_NOTE_FIRST: usize = 8;
const RD_NOTE_COUNT: usize = 9;
const RD_SECTION: usize = 10;
const RD_READING_BLOCK: usize = 11;
const RD_PROGRESS: usize = 12;
const RD_DIRTY: usize = 13;
const RD_HOVER: usize = 14;
const RD_FOCUS: usize = 15;
const RD_SCRUB: usize = 16;
const RD_OPEN: usize = 17;
const RD_FIG_VIS_FIRST: usize = 18;
const RD_FIG_VIS_COUNT: usize = 19;
const RD_FOLD_SETTLED: usize = 20;
const RD_WIDTH_CLASS: usize = 21;
const RD_IDLE: usize = 22;
const RD_EM_PX: usize = 23;
const RD_VIEWPORT_EM: usize = 24;
/// Engine-owned scroll (docs/READING_GPU.md): CSS px, not em. scrollY may be outside [0, max] while the rubber band is out.
const RD_SCROLL_Y_PX: usize = 25;
const RD_SCROLL_MAX_PX: usize = 26;
/// 0 idle, 1 wheel, 2 drag, 3 fling, 4 animate, 5 rubber (`scroll::MODE_*`)
const RD_SCROLL_MODE: usize = 27;
/// px/s
const RD_VELOCITY: usize = 28;
const RD_FIG_BASE: usize = 32;

// dirty bits
const D_SCROLL: u32 = 1;
const D_SPRING: u32 = 2;
const D_FIG: u32 = 4;
const D_HOVER: u32 = 8;
const D_LAYOUT: u32 = 16;

// INPUT kinds (abi.ts)
const IN_HOVER: u32 = 1;
const IN_FOCUS: u32 = 2;
const IN_OPEN: u32 = 3;
const IN_SCRUB_BEGIN: u32 = 4;
const IN_SCRUB_TO: u32 = 5;
const IN_SCRUB_END: u32 = 6;
const IN_FIG_STEP: u32 = 7;
const IN_FIG_PLAY: u32 = 8;
const IN_FIG_HOME: u32 = 9;
const IN_FOLD_SET: u32 = 10;
const IN_REDUCED: u32 = 11;

// load buffer layout (abi.ts)
const LOAD_HEADER: usize = 16;
const LOAD_BLOCK: usize = 8;
const LOAD_NOTE: usize = 6;
const LOAD_FIGURE: usize = 6;
const LOAD_ANCHOR: usize = 3;
const LOAD_LINK: usize = 5;

// BlockKind / BlockFlag / FigureMode (format.ts)
const KIND_HEADING: u32 = 1;
const KIND_FIGURE: u32 = 7;
const KIND_FOLD: u32 = 11;
const FLAG_FOLDED: u32 = 2;
const MODE_LOOP: u32 = 0;
const MODE_ONCE: u32 = 1;
const MODE_STATIC: u32 = 3;
const KIND_NAMES: [&str; 21] = [
    "HeroBlock",
    "HeadingBlock",
    "ParagraphBlock",
    "CodeBlock",
    "QuoteBlock",
    "ListBlock",
    "ImageBlock",
    "FigureBlock",
    "RuleBlock",
    "MathBlock",
    "TableBlock",
    "FoldBlock",
    "RefsBlock",
    "FootnotesBlock",
    "CaptionBlock",
    "PullQuoteBlock",
    "NumeralsBlock",
    "NoteBlock",
    "LabelBlock",
    "NextPrevBlock",
    "TakeawayBlock",
];
/// Index of the base block prefab and of the note prefab in `Doc.protos` (after the 21 kinds).
const PROTO_BLOCK: usize = KIND_NAMES.len();
const PROTO_NOTE: usize = KIND_NAMES.len() + 1;

// ---- components ----

/// Box of a block or note in document em.
#[derive(Component, Clone, Copy, Default)]
pub struct Rect {
    pub x0: f32,
    pub x1: f32,
    pub y0: f32,
    pub y1: f32,
}
/// `index` is the position in reading order, `section` the h2 section it belongs to (format.ts Block.section).
#[derive(Component, Clone, Copy, Default)]
pub struct BlockInfo {
    pub index: u32,
    pub kind: u32,
    pub level: u32,
    pub flags: u32,
    pub section: u32,
}
/// String-table offset of the heading or figure id.
#[derive(Component, Clone, Copy, Default)]
pub struct Anchor {
    pub string_off: u32,
}
#[derive(Component, Clone, Copy, Default)]
pub struct NoteInfo {
    pub index: u32,
    pub anchor_line: u32,
}
#[derive(Component, Clone, Copy, Default)]
pub struct Link {
    pub block: u32,
    pub kind: u32,
    pub line: u32,
}
#[derive(Component, Clone, Copy, Default)]
pub struct RefEntry {
    pub index: u32,
}
/// A figure's static description (on its block entity): index in figure order, id, FigureMode, duration and poster time in seconds.
#[derive(Component, Clone, Copy, Default)]
pub struct Figure {
    pub index: u32,
    pub id: u32,
    pub mode: u32,
    pub duration: f32,
    pub poster: f32,
    pub alt: u32,
}
/// A figure's clock: t seconds, vel scrub momentum (s per s), hold seconds left after a touch, play (autoplay wanted).
#[derive(Component, Clone, Copy, Default)]
pub struct FigureTime {
    pub t: f32,
    pub vel: f32,
    pub hold: f32,
    pub play: bool,
}

#[derive(Component, Clone, Copy, Default)]
pub struct Scroll {
    pub y: f32,
    pub vel: f32,
    pub max: f32,
}
#[derive(Component, Clone, Copy, Default)]
pub struct Viewport {
    pub w: f32,
    pub h: f32,
    pub dpr: f32,
    pub class: u32,
}
#[derive(Component, Clone, Copy)]
pub struct Typography {
    pub scale: f32,
    pub em_px: f32,
}
impl Default for Typography {
    fn default() -> Self {
        Typography { scale: 1.0, em_px: 16.0 }
    }
}
/// The expand spring: t 0 collapsed .. 1 expanded; y, h, peek describe the folded region of the loaded article (em).
#[derive(Component, Clone, Copy, Default)]
pub struct Fold {
    pub t: f32,
    pub target: f32,
    pub vel: f32,
    pub y: f32,
    pub h: f32,
    pub peek: f32,
}

/// One figure row of `Doc`.
#[derive(Clone, Default)]
struct Fig {
    ent: u64,
    y0: f32,
    y1: f32,
    t: f32,
    onscreen: bool,
    live: bool,
    data_vis: bool,
}

/// The exported arrays and caches. Blocks and notes are in reading order; the culling searches `pmax` (prefix maximum of y1) for the
/// first block that can reach the window and `smin` (suffix minimum of y0) for the end, so it stays correct even when wide blocks overlap.
#[derive(Component, Clone)]
pub struct Doc {
    protos: Vec<u64>,
    article: u64,
    epoch: u32,
    block_ent: Vec<u64>,
    y0: Vec<f32>,
    pmax: Vec<f32>,
    smin: Vec<f32>,
    section_of: Vec<u32>,
    headings: Vec<u32>,
    n_pmax: Vec<f32>,
    n_smin: Vec<f32>,
    figs: Vec<Fig>,
    fold_y: f32,
    fold_h: f32,
    peek_h: f32,
    doc_h: f32,
    width_class: u32,
    // derived by the systems
    clip: f32,
    fold_off: f32,
    height: f32,
    view_em: f32,
    vis_first: u32,
    vis_count: u32,
    note_first: u32,
    note_count: u32,
    fig_first: u32,
    fig_count: u32,
    cull_key: [f32; 4],
    cull_valid: bool,
    cull_changed: bool,
    spy_valid: bool,
    last_y: f32,
    idle: f32,
    // caches of the relations (block index or figure index, -1 none)
    hover: i32,
    focus: i32,
    open: i32,
    scrub: i32,
    reading_block: i32,
    section: i32,
    reduced: bool,
    dirty: u32,
}
impl Default for Doc {
    fn default() -> Self {
        Doc {
            protos: Vec::new(),
            article: 0,
            epoch: 0,
            block_ent: Vec::new(),
            y0: Vec::new(),
            pmax: Vec::new(),
            smin: Vec::new(),
            section_of: Vec::new(),
            headings: Vec::new(),
            n_pmax: Vec::new(),
            n_smin: Vec::new(),
            figs: Vec::new(),
            fold_y: 0.0,
            fold_h: 0.0,
            peek_h: 0.0,
            doc_h: 0.0,
            width_class: 0,
            clip: 0.0,
            fold_off: 0.0,
            height: 0.0,
            view_em: 0.0,
            vis_first: 0,
            vis_count: 0,
            note_first: 0,
            note_count: 0,
            fig_first: 0,
            fig_count: 0,
            cull_key: [0.0; 4],
            cull_valid: false,
            cull_changed: false,
            spy_valid: false,
            last_y: 0.0,
            idle: 0.0,
            hover: -1,
            focus: -1,
            open: -1,
            scrub: -1,
            reading_block: -1,
            section: -1,
            reduced: false,
            dirty: 0,
        }
    }
}
impl Doc {
    fn has_fold(&self) -> bool {
        self.fold_h > 0.0
    }
    /// Page y (what the scroller shows) to document y: below the clip line the folded blocks that are hidden are skipped.
    fn to_doc(&self, p: f32) -> f32 {
        if self.has_fold() && p > self.clip {
            p + self.fold_off
        } else {
            p
        }
    }
    /// The page extent of a document span, or None when the fold hides it.
    fn page_span(&self, y0: f32, y1: f32) -> Option<(f32, f32)> {
        if !self.has_fold() {
            return Some((y0, y1));
        }
        if y0 >= self.fold_y + self.fold_h {
            Some((y0 - self.fold_off, y1 - self.fold_off))
        } else if y0 >= self.clip {
            None
        } else {
            Some((y0, y1.min(self.clip)))
        }
    }
}

/// Output ring for JS (kind << 24 | arg).
#[derive(Component, Clone, Default)]
pub struct Events {
    pub q: VecDeque<u32>,
}

macro_rules! tags {
    ($($(#[$m:meta])* $n:ident),*) => { $( $(#[$m])* #[derive(Component, Clone, Copy, Default)] pub struct $n; )* };
}
tags!(
    /// Figure inside the data lookahead (1.5 viewports).
    Visible,
    /// Fold target is 1.
    Expanded,
    /// The fold spring is at rest.
    Settled,
    Reduced,
    /// Relation `(Next, block)`: the following block, exclusive.
    Next,
    /// Relation `(Targets, block)` on a Link.
    Targets,
    /// Relation `(Cites, ref)` on a Link.
    Cites,
    /// Relation `(NoteOf, block)` on a note.
    NoteOf,
    /// Relation `(InFold, fold)` on a block after the fold.
    InFold,
    /// Relation `(Reading, heading)`: the current heading.
    Reading,
    Hover,
    Focus,
    Scrubbing,
    /// Relation `(Open, block)`: popover or lightbox target.
    Open
);

#[derive(Component)]
pub struct ReadingModule;

thread_local! {
    /// The one handle at the FFI boundary: the wasm exports have no world argument. Systems never read it.
    static WORLD: RefCell<Option<World>> = const { RefCell::new(None) };
    static LOAD: RefCell<Vec<u32>> = const { RefCell::new(Vec::new()) };
    static RD: RefCell<[f32; STATE_LEN]> = const { RefCell::new([0.0; STATE_LEN]) };
}

fn with_world<T>(f: impl FnOnce(&World) -> T) -> Option<T> {
    WORLD.with(|w| w.borrow().as_ref().map(f))
}

fn emit(w: &World, kind: u32, arg: u32) {
    w.get::<&mut Events>(|e| {
        let arg = arg & NONE;
        if arg != NONE && e.q.back() == Some(&(kind << 24 | NONE)) {
            e.q.pop_back();
        }
        if e.q.len() >= MAX_EVENTS {
            e.q.pop_front();
        }
        e.q.push_back(kind << 24 | arg);
    });
}

fn mark(w: &World, bits: u32) {
    w.get::<&mut Doc>(|d| d.dirty |= bits);
}

/// Critically damped spring, exact for any dt (no overshoot).
fn spring(x: &mut f32, v: &mut f32, target: f32, omega: f32, dt: f32) {
    let d = *x - target;
    let e = (-omega * dt).exp();
    let k = *v + omega * d;
    *x = target + (d + k * dt) * e;
    *v = (*v - omega * k * dt) * e;
}

fn wrap(t: f32, duration: f32) -> f32 {
    if duration > 0.0 {
        t.rem_euclid(duration)
    } else {
        0.0
    }
}

fn rd_reset() {
    RD.with(|s| {
        let mut s = s.borrow_mut();
        *s = [0.0; STATE_LEN];
        for i in [RD_SECTION, RD_READING_BLOCK, RD_HOVER, RD_FOCUS, RD_SCRUB, RD_OPEN] {
            s[i] = -1.0;
        }
        s[RD_FOLD_SETTLED] = 1.0;
    });
}

impl Module for ReadingModule {
    fn module(world: &World) {
        world.component::<Rect>();
        world.component::<BlockInfo>();
        world.component::<Anchor>();
        world.component::<NoteInfo>();
        world.component::<Link>();
        world.component::<RefEntry>();
        world.component::<Figure>();
        world.component::<FigureTime>();
        world.component::<Scroll>();
        world.component::<ScrollSim>();
        world.component::<Viewport>();
        world.component::<Typography>();
        world.component::<Fold>();
        world.component::<Doc>();
        world.component::<Events>();
        world.component::<Visible>();
        world.component::<Expanded>();
        world.component::<Settled>();
        world.component::<Reduced>();
        world.component::<Next>();
        world.component::<Targets>();
        world.component::<Cites>();
        world.component::<NoteOf>();
        world.component::<InFold>();
        world.component::<Reading>();
        world.component::<Hover>();
        world.component::<Focus>();
        world.component::<Scrubbing>();
        world.component::<Open>();
        // one target at a time: adding a new one replaces the old (and fires OnRemove then OnAdd)
        for rel in [
            world.component_id::<Next>(),
            world.component_id::<Targets>(),
            world.component_id::<Cites>(),
            world.component_id::<NoteOf>(),
            world.component_id::<InFold>(),
            world.component_id::<Reading>(),
            world.component_id::<Hover>(),
            world.component_id::<Focus>(),
            world.component_id::<Scrubbing>(),
            world.component_id::<Open>(),
        ] {
            world.entity_from_id(rel).add_trait::<flecs::Exclusive>();
        }

        // prefabs: Block {Rect, BlockInfo}, one per BlockKind, and the note
        let block = world.prefab_named("BlockPrefab").set(Rect::default()).set(BlockInfo::default());
        let mut protos = Vec::with_capacity(KIND_NAMES.len() + 2);
        for (kind, name) in KIND_NAMES.iter().enumerate() {
            let p = world.prefab_named(name).is_a(block);
            if kind as u32 == KIND_FIGURE {
                p.set(Figure::default()).set(FigureTime::default());
            }
            protos.push(*p.id());
        }
        protos.push(*block.id());
        protos.push(*world.prefab_named("NotePrefab").set(Rect::default()).set(NoteInfo::default()).id());

        world.set(Doc { protos, ..Doc::default() });
        world.set(Scroll::default());
        world.set(ScrollSim::default());
        world.set(Viewport::default());
        world.set(Typography::default());
        world.set(Fold::default());
        world.set(Events::default());
        world.add(Settled::id());

        let input_ph = world.entity_named("ReadInputPhase").add(flecs::pipeline::Phase).depends_on(flecs::pipeline::OnUpdate);
        let spring_ph = world.entity_named("ReadSpringPhase").add(flecs::pipeline::Phase).depends_on(input_ph);
        let layout_ph = world.entity_named("ReadLayoutPhase").add(flecs::pipeline::Phase).depends_on(spring_ph);
        let cull_ph = world.entity_named("ReadCullPhase").add(flecs::pipeline::Phase).depends_on(layout_ph);
        let pack_ph = world.entity_named("ReadPackPhase").add(flecs::pipeline::Phase).depends_on(cull_ph);

        systems(world, input_ph, spring_ph, layout_ph, cull_ph, pack_ph);
        observers(world);
    }
}

// ---- systems ----

fn systems(world: &World, input_ph: EntityView, spring_ph: EntityView, layout_ph: EntityView, cull_ph: EntityView, pack_ph: EntityView) {
    // ---- Input ---- (the scroll integrator first: ScrollTrack then sees the new `Scroll.y`)
    world.system_named::<()>("ScrollSim").kind(input_ph).run(|mut it| {
        while it.next() {
            scroll_step(&it.world(), it.delta_time());
        }
    });
    world.system_named::<()>("ScrollTrack").kind(input_ph).run(|mut it| {
        while it.next() {
            scroll_track(&it.world(), it.delta_time());
        }
    });

    // ---- Spring ---- (a term with a singleton source: `set_src(T::id())`)
    world.system_named::<&mut Fold>("FoldSpring").kind(spring_ph).term_at(0).set_src(Fold::id()).each_iter(|it, _, f| {
        if f.t == f.target && f.vel == 0.0 {
            return;
        }
        let w = it.world();
        if w.has(Reduced::id()) {
            f.t = f.target;
            f.vel = 0.0;
        } else {
            let (mut t, mut v) = (f.t, f.vel);
            spring(&mut t, &mut v, f.target, FOLD_OMEGA, it.delta_time());
            if (t - f.target).abs() < 1e-3 && v.abs() < 1e-2 {
                t = f.target;
                v = 0.0;
            }
            f.t = t;
            f.vel = v;
        }
        mark(&w, D_SPRING | D_LAYOUT);
        if f.t == f.target && f.vel == 0.0 {
            w.add(Settled::id());
        }
    });

    // ---- Layout ----
    world.system_named::<()>("DocMetrics").kind(layout_ph).run(|mut it| {
        while it.next() {
            metrics(&it.world());
        }
    });

    // ---- Cull ----
    world.system_named::<()>("CullBlocks").kind(cull_ph).run(|mut it| {
        while it.next() {
            cull(&it.world());
        }
    });
    world.system_named::<()>("ReadingSpy").kind(cull_ph).run(|mut it| {
        while it.next() {
            spy(&it.world());
        }
    });
    world.system_named::<()>("FigureClock").kind(cull_ph).run(|mut it| {
        while it.next() {
            figure_clock(&it.world());
        }
    });

    // ---- Pack ----
    // Figures in the data range only (off screen costs nothing).
    world.system_named::<(&Figure, &mut FigureTime)>("FigureAdvance").kind(pack_ph).with(Visible::id()).each_iter(|it, _, (f, c)| {
        advance(&it.world(), it.delta_time(), f, c);
    });
    world.system_named::<()>("PackState").kind(pack_ph).run(|mut it| {
        while it.next() {
            pack(&it.world());
        }
    });
}

fn scroll_track(w: &World, dt: f32) {
    let y = w.try_cloned::<&Scroll>().map_or(0.0, |s| s.y);
    let vel = w.get::<&mut Doc>(|d| {
        let dy = y - d.last_y;
        if dy.abs() > 1e-4 {
            d.idle = 0.0;
            d.last_y = y;
            d.dirty |= D_SCROLL;
            dy / dt.max(1e-3)
        } else {
            d.idle += dt;
            0.0
        }
    });
    w.get::<&mut Scroll>(|s| s.vel = vel);
}

/// Run `f` on the scroll simulation after syncing it with the singletons (page size, viewport, reduced motion, a `Scroll.y` that
/// someone else wrote), then write the position back. The simulation lives in px, `Scroll.y` in em.
fn with_sim<T>(w: &World, f: impl FnOnce(&mut ScrollSim, f32) -> T) -> T {
    let em = w.try_cloned::<&Typography>().map_or(16.0, |t| t.em_px).max(1e-3);
    let sc = w.try_cloned::<&Scroll>().unwrap_or_default();
    let vp = w.try_cloned::<&Viewport>().unwrap_or_default();
    let mut sim = w.try_cloned::<&ScrollSim>().unwrap_or_default();
    sim.max = sc.max * em;
    sim.view_h = vp.h.max(1.0);
    sim.reduced = w.has(Reduced::id());
    sim.sync(sc.y * em);
    let r = f(&mut sim, em);
    w.get::<&mut Scroll>(|s| s.y = sim.y / em);
    w.set(sim);
    r
}

/// Advance the scroll simulation by `dt` seconds.
fn scroll_step(w: &World, dt: f32) {
    let moving = with_sim(w, |sim, _| {
        sim.step(dt);
        sim.mode != scroll::MODE_IDLE && sim.mode != scroll::MODE_DRAG
    });
    if moving {
        mark(w, D_SPRING);
    }
}

/// Fold clip line, document height and `Scroll.max`.
fn metrics(w: &World) {
    let t = w.try_cloned::<&Fold>().map_or(0.0, |f| f.t).clamp(0.0, 1.0);
    let vp = w.try_cloned::<&Viewport>().unwrap_or_default();
    let ty = w.try_cloned::<&Typography>().unwrap_or_default();
    let view_em = vp.h / ty.em_px.max(1e-3);
    let max = w.get::<&mut Doc>(|d| {
        let (clip, off, height) = if d.has_fold() {
            let clip = d.fold_y + d.peek_h + t * (d.fold_h - d.peek_h);
            let tail = (d.doc_h - d.fold_y - d.fold_h).max(0.0);
            (clip, d.fold_y + d.fold_h - clip, clip + tail)
        } else {
            (d.doc_h, 0.0, d.doc_h)
        };
        if clip != d.clip || height != d.height || view_em != d.view_em {
            d.dirty |= D_LAYOUT;
        }
        d.clip = clip;
        d.fold_off = off.max(0.0);
        d.height = height;
        d.view_em = view_em;
        (height - view_em).max(0.0)
    });
    w.get::<&mut Scroll>(|s| s.max = max);
}

/// Visible block and note ranges by binary search; only when scroll, viewport or the clip line moved.
fn cull(w: &World) {
    let y = w.try_cloned::<&Scroll>().map_or(0.0, |s| s.y);
    w.get::<&mut Doc>(|d| {
        let key = [y, d.view_em, d.clip, d.epoch as f32];
        if d.cull_valid && key == d.cull_key {
            return;
        }
        d.cull_valid = true;
        d.cull_key = key;
        d.cull_changed = true;
        let v = d.view_em;
        let lo = d.to_doc(y - TEXT_AHEAD * v);
        let hi = d.to_doc(y + v + TEXT_AHEAD * v);
        let first = d.pmax.partition_point(|&m| m < lo);
        let end = d.smin.partition_point(|&m| m <= hi);
        d.vis_first = first as u32;
        d.vis_count = end.saturating_sub(first) as u32;
        let first = d.n_pmax.partition_point(|&m| m < lo);
        let end = d.n_smin.partition_point(|&m| m <= hi);
        d.note_first = first as u32;
        d.note_count = end.saturating_sub(first) as u32;
    });
}

/// The last heading (kind heading, level 1 or 2) whose top is at most `SPY_EM` below the viewport top. The relation changes only when it differs.
fn spy(w: &World) {
    let y = w.try_cloned::<&Scroll>().map_or(0.0, |s| s.y);
    let change = w.get::<&mut Doc>(|d| {
        if !d.cull_changed && d.spy_valid {
            return None;
        }
        d.spy_valid = true;
        let mut best: Option<u32> = None;
        for &h in &d.headings {
            let y0 = d.y0[h as usize];
            match d.page_span(y0, y0) {
                Some((py, _)) if py <= y + SPY_EM => best = Some(h),
                Some(_) => break,
                None => {}
            }
        }
        let new = best.map_or(-1, |h| h as i32);
        if new == d.reading_block {
            return None;
        }
        d.reading_block = new;
        d.section = best.map_or(-1, |h| d.section_of[h as usize] as i32);
        Some(best.map(|h| d.block_ent[h as usize]))
    });
    match change {
        Some(Some(id)) => {
            w.add((Reading::id(), w.entity_from_id(id)));
        }
        Some(None) => {
            w.remove((Reading::id(), flecs::Wildcard::ID));
        }
        None => {}
    }
}

/// Per figure: on screen, live (60 percent inside the viewport) and the `Visible` data range. Runs when the cull window moved.
fn figure_clock(w: &World) {
    let y = w.try_cloned::<&Scroll>().map_or(0.0, |s| s.y);
    w.get::<&mut Doc>(|d| {
        if !d.cull_changed {
            return;
        }
        d.cull_changed = false;
        let v = d.view_em;
        let (top, bot) = (y, y + v);
        let flo = d.to_doc(top - FIG_AHEAD * v);
        let fhi = d.to_doc(bot + FIG_AHEAD * v);
        let (mut first, mut last) = (usize::MAX, 0usize);
        for i in 0..d.figs.len() {
            let (y0, y1) = (d.figs[i].y0, d.figs[i].y1);
            let in_data = d.figs[i].ent != 0 && y1 >= flo && y0 <= fhi;
            let (on, live) = match d.page_span(y0, y1) {
                Some((a, b)) => {
                    let overlap = (b.min(bot) - a.max(top)).max(0.0);
                    let frac = if y1 > y0 { overlap / (y1 - y0) } else { 1.0 };
                    (overlap > 0.0, frac >= LIVE_FRAC || (v > 0.0 && overlap >= LIVE_FRAC * v))
                }
                None => (false, false),
            };
            let g = &mut d.figs[i];
            g.onscreen = on;
            g.live = live;
            if in_data {
                first = first.min(i);
                last = i;
            }
            if in_data != g.data_vis {
                g.data_vis = in_data;
                let e = w.entity_from_id(g.ent);
                if in_data {
                    e.add(Visible::id());
                } else {
                    e.remove(Visible::id());
                }
            }
        }
        if first == usize::MAX {
            d.fig_first = 0;
            d.fig_count = 0;
        } else {
            d.fig_first = first as u32;
            d.fig_count = (last - first + 1) as u32;
        }
    });
}

/// Autoplay and momentum of one figure clock. Only the modes loop and once play by themselves; scrub and static figures move on input.
fn advance(w: &World, dt: f32, f: &Figure, c: &mut FigureTime) {
    let (live, idle, held, reduced) = w.get::<&Doc>(|d| (d.figs.get(f.index as usize).is_some_and(|g| g.live), d.idle, d.scrub == f.index as i32, d.reduced));
    let before = c.t;
    c.hold = (c.hold - dt).max(0.0);
    let hi = f.duration.max(0.0);
    if held || reduced || f.mode == MODE_STATIC {
        c.vel = 0.0;
    } else if c.vel != 0.0 {
        c.t += c.vel * dt;
        c.vel *= (-MOMENTUM_K * dt).exp();
        if c.vel.abs() < 0.02 {
            c.vel = 0.0;
        }
        if f.mode == MODE_LOOP {
            c.t = wrap(c.t, f.duration);
        } else {
            if c.t <= 0.0 || c.t >= hi {
                c.vel = 0.0; // a wall stops momentum
            }
            c.t = c.t.clamp(0.0, hi);
        }
    } else if c.play && live && idle >= IDLE_GATE_S && c.hold <= 0.0 {
        c.t = if f.mode == MODE_LOOP { wrap(c.t + dt, f.duration) } else { (c.t + dt).min(hi) };
    }
    if c.t != before {
        let (i, t) = (f.index as usize, c.t);
        w.get::<&mut Doc>(|d| {
            if let Some(g) = d.figs.get_mut(i) {
                g.t = t;
            }
            d.dirty |= D_FIG;
        });
    }
}

/// Write the 64 float `RD` buffer.
fn pack(w: &World) {
    let s = w.try_cloned::<&Scroll>().unwrap_or_default();
    let fold = w.try_cloned::<&Fold>().unwrap_or_default();
    let ty = w.try_cloned::<&Typography>().unwrap_or_default();
    let sim = w.try_cloned::<&ScrollSim>().unwrap_or_default();
    let mut out = [0.0f32; STATE_LEN];
    w.get::<&Doc>(|d| {
        out[RD_SCROLL] = s.y;
        out[RD_SCROLL_Y_PX] = s.y * ty.em_px;
        out[RD_SCROLL_MAX_PX] = s.max * ty.em_px;
        out[RD_SCROLL_MODE] = sim.mode as f32;
        out[RD_VELOCITY] = sim.v;
        out[RD_SCROLL_MAX] = s.max;
        out[RD_FOLD_T] = fold.t;
        out[RD_FOLD_TARGET] = fold.target;
        out[RD_FOLD_CLIP] = d.clip;
        out[RD_DOC_H] = d.height;
        out[RD_VIS_FIRST] = d.vis_first as f32;
        out[RD_VIS_COUNT] = d.vis_count as f32;
        out[RD_NOTE_FIRST] = d.note_first as f32;
        out[RD_NOTE_COUNT] = d.note_count as f32;
        out[RD_SECTION] = d.section as f32;
        out[RD_READING_BLOCK] = d.reading_block as f32;
        out[RD_PROGRESS] = if s.max > 0.0 { (s.y / s.max).clamp(0.0, 1.0) } else { 0.0 };
        out[RD_DIRTY] = d.dirty as f32;
        out[RD_HOVER] = d.hover as f32;
        out[RD_FOCUS] = d.focus as f32;
        out[RD_SCRUB] = d.scrub as f32;
        out[RD_OPEN] = d.open as f32;
        out[RD_FIG_VIS_FIRST] = d.fig_first as f32;
        out[RD_FIG_VIS_COUNT] = d.fig_count as f32;
        out[RD_FOLD_SETTLED] = if fold.t == fold.target && fold.vel == 0.0 { 1.0 } else { 0.0 };
        out[RD_WIDTH_CLASS] = d.width_class as f32;
        out[RD_IDLE] = d.idle;
        out[RD_EM_PX] = ty.em_px;
        out[RD_VIEWPORT_EM] = d.view_em;
        for (i, g) in d.figs.iter().take(MAX_FIG_STATE).enumerate() {
            out[RD_FIG_BASE + 2 * i] = g.t;
            out[RD_FIG_BASE + 2 * i + 1] = if g.onscreen { 1.0 } else { 0.0 };
        }
    });
    RD.with(|st| *st.borrow_mut() = out);
}

/// The layout-dependent systems, run synchronously after a load or a viewport change so the host can read the new document height at once.
fn refresh(w: &World) {
    metrics(w);
    cull(w);
    spy(w);
    figure_clock(w);
    pack(w);
}

// ---- observers (the only writers of the event ring besides the exports) ----

fn observers(world: &World) {
    // an event for a relation target: the block index (the section index for Reading) rides in the event
    for (rel, kind) in [
        (world.component_id::<Reading>(), EV_SECTION),
        (world.component_id::<Open>(), EV_OPEN),
        (world.component_id::<Focus>(), EV_FOCUS),
        (world.component_id::<Hover>(), EV_HOVER),
    ] {
        world.observer::<flecs::OnAdd, ()>().with((rel, flecs::Wildcard::ID)).each_iter(move |it, _, _| {
            let w = it.world();
            let arg = w.target(rel, Some(0)).try_cloned::<&BlockInfo>().map_or(NONE, |b| if kind == EV_SECTION { b.section } else { b.index });
            emit(&w, kind, arg);
        });
        world.observer::<flecs::OnRemove, ()>().with((rel, flecs::Wildcard::ID)).each_iter(move |it, _, _| emit(&it.world(), kind, NONE));
    }
    world.observer::<flecs::OnAdd, ()>().with(Settled::id()).each_iter(|it, _, _| emit(&it.world(), EV_FOLD_SETTLED, 0));
    world.observer::<flecs::OnAdd, ()>().with(Expanded::id()).each_iter(|it, _, _| emit(&it.world(), EV_FOLD_EXPAND, 1));
    world.observer::<flecs::OnRemove, ()>().with(Expanded::id()).each_iter(|it, _, _| emit(&it.world(), EV_FOLD_EXPAND, 0));
    // a figure entering or leaving the data lookahead: the host fetches or evicts its data, the clock starts or pauses
    world.observer::<flecs::OnAdd, ()>().with(Visible::id()).with(Figure::id()).each_iter(|it, row, _| {
        let idx = it.entity(row).try_cloned::<&Figure>().map_or(NONE, |f| f.index);
        emit(&it.world(), EV_FIG_VISIBLE, idx);
    });
    world.observer::<flecs::OnRemove, ()>().with(Visible::id()).with(Figure::id()).each_iter(|it, row, _| {
        let idx = it.entity(row).try_cloned::<&Figure>().map_or(NONE, |f| f.index);
        emit(&it.world(), EV_FIG_HIDDEN, idx);
    });
}

// ---- host side (called from lib.rs) ----

/// Install the module on `world` and remember the handle. Called by `reading_init` (bare world) and by `world_build` (the room).
pub fn setup(world: &World) {
    world.import::<ReadingModule>();
    WORLD.with(|w| *w.borrow_mut() = Some(world.clone()));
    rd_reset();
}

/// A bare world with only the reading module (reader-only mode). 0 ok.
pub fn init() -> u32 {
    let world = World::new();
    setup(&world);
    0
}

/// Advance the bare world (the room goes through `reader::tick`, which runs the same systems).
pub fn tick(dt_ms: f32) {
    let dt = (dt_ms / 1000.0).clamp(0.0, 0.1);
    let Some(world) = with_world(|w| w.clone()) else { return };
    world.progress_time(dt);
}

pub fn buf(words: u32) -> *mut u32 {
    LOAD.with(|b| {
        let mut b = b.borrow_mut();
        if b.len() < words as usize {
            b.resize(words as usize, 0);
        }
        b.as_mut_ptr()
    })
}

pub fn state_ptr() -> *const f32 {
    RD.with(|s| s.as_ptr() as *const f32)
}

pub fn poll() -> u32 {
    with_world(|w| w.get::<&mut Events>(|e| e.q.pop_front())).flatten().unwrap_or(0)
}

pub fn entity_count() -> u32 {
    with_world(|w| w.count(flecs::Wildcard::ID).max(0) as u32).unwrap_or(0)
}

pub fn ack_dirty() {
    with_world(|w| {
        w.get::<&mut Doc>(|d| d.dirty = 0);
        RD.with(|s| s.borrow_mut()[RD_DIRTY] = 0.0);
    });
}

/// First block with y1 > `y_em` (document space); -1 when there are no blocks.
pub fn block_at(y_em: f32) -> i32 {
    with_world(|w| {
        w.get::<&Doc>(|d| {
            if d.pmax.is_empty() {
                -1
            } else {
                d.pmax.partition_point(|&m| m <= y_em).min(d.pmax.len() - 1) as i32
            }
        })
    })
    .unwrap_or(-1)
}

pub fn set_scroll(y_px: f32) {
    with_world(|w| {
        let em = w.try_cloned::<&Typography>().map_or(16.0, |t| t.em_px).max(1e-3);
        w.get::<&mut Scroll>(|s| s.y = y_px / em);
    });
}

/// `reading_wheel`: a wheel event (`deltaMode` 0 px, 1 lines, 2 pages). Pinch (ctrl) is ignored. Returns 1 when the event scrolls.
pub fn wheel(dx: f32, dy: f32, delta_mode: u32, ctrl: bool) -> u32 {
    let _ = dx;
    with_world(|w| {
        let r = with_sim(w, |sim, em| sim.wheel(dy, delta_mode, ctrl, em * LINE_EM));
        if r {
            mark(w, D_SCROLL);
        }
        r as u32
    })
    .unwrap_or(0)
}

/// `reading_pointer`: kind 1 down, 2 move, 3 up, 4 cancel; `id` is `pointerId | pointerType << 16` (0 mouse, 1 touch, 2 pen); `y` CSS px;
/// `t_ms` the event time (f64, `event.timeStamp`). Returns 1 while this pointer drives the scroll.
pub fn pointer(kind: u32, id: u32, _x: f32, y: f32, t_ms: f64) -> u32 {
    with_world(|w| {
        let r = with_sim(w, |sim, _| sim.pointer(kind, id, y, t_ms));
        mark(w, D_SCROLL);
        r as u32
    })
    .unwrap_or(0)
}

/// `reading_key`: a `scroll::KEY_*` code. Returns 1 when consumed.
pub fn key(code: u32, shift: bool) -> u32 {
    with_world(|w| {
        let r = with_sim(w, |sim, _| sim.key(code, shift));
        if r {
            mark(w, D_SCROLL);
            scroll_instant_refresh(w);
        }
        r as u32
    })
    .unwrap_or(0)
}

/// `reading_scroll_to`: `y` CSS px, `smooth` animates (instant under reduced motion).
pub fn scroll_to(y_px: f32, smooth: bool) {
    with_world(|w| {
        with_sim(w, |sim, _| sim.scroll_to(y_px, smooth));
        mark(w, D_SCROLL);
        scroll_instant_refresh(w);
    });
}

/// An instant move (a key under reduced motion, a non-smooth scroll-to) is visible in the state vector at once, before the next tick.
fn scroll_instant_refresh(w: &World) {
    if w.try_cloned::<&ScrollSim>().is_some_and(|s| s.mode == scroll::MODE_IDLE) {
        refresh(w);
    }
}

pub fn set_viewport(w_px: f32, h_px: f32, dpr: f32, em_px: f32, class: u32) {
    with_world(|w| {
        let old = (w.try_cloned::<&Viewport>().unwrap_or_default(), w.try_cloned::<&Typography>().unwrap_or_default());
        let em_px = em_px.max(1e-3);
        // informational: the text scale against the base size of the contract (clamp(17, 15.6 + 0.0036 w, 21))
        let scale = em_px / (15.6 + 0.0036 * w_px).clamp(17.0, 21.0);
        w.set(Viewport { w: w_px, h: h_px, dpr, class });
        w.set(Typography { scale, em_px });
        let changed = old.0.w != w_px || old.0.h != h_px || old.0.dpr != dpr || old.0.class != class || old.1.em_px != em_px;
        w.get::<&mut Doc>(|d| {
            d.width_class = class;
            if changed {
                d.dirty |= D_LAYOUT;
            }
        });
        if changed {
            refresh(w);
            emit(w, EV_LAYOUT, class);
        }
    });
}

/// Parse the load buffer into entities, replacing the previous article. 0 ok, 1 malformed or no world.
pub fn load() -> u32 {
    with_world(|w| LOAD.with(|b| load_into(w, &b.borrow()))).unwrap_or(1)
}

fn load_into(w: &World, b: &[u32]) -> u32 {
    if b.len() < LOAD_HEADER {
        return 1;
    }
    let f = |i: usize| f32::from_bits(b[i]);
    let (nb, nn, nf, na, nl) = (b[0] as usize, b[1] as usize, b[2] as usize, b[3] as usize, b[4] as usize);
    let need = LOAD_HEADER + nb * LOAD_BLOCK + nn * LOAD_NOTE + nf * LOAD_FIGURE + na * LOAD_ANCHOR + nl * LOAD_LINK;
    if b.len() < need {
        return 1;
    }
    let (doc_h, fold_y, fold_h, peek_h, class) = (f(5), f(6), f(7).max(0.0), f(8), b[9]);

    // the previous article goes (its children with it); the relations pointing into it are removed by Flecs
    let old = w.cloned::<&Doc>();
    if old.article != 0 {
        let e = w.entity_from_id(old.article);
        if e.is_alive() {
            e.destruct();
        }
    }
    let protos = old.protos;
    let proto = |i: usize| w.entity_from_id(protos[i]);
    let mut d = Doc { protos: protos.clone(), epoch: old.epoch.wrapping_add(1), reduced: old.reduced, width_class: class, ..Doc::default() };
    let art = w.entity();
    d.article = *art.id();
    d.doc_h = doc_h;
    d.fold_y = fold_y;
    d.fold_h = fold_h;
    d.peek_h = peek_h.clamp(0.0, fold_h);

    // blocks, in reading order: Next chain, folded blocks into the fold
    let mut o = LOAD_HEADER;
    let mut prev: Option<EntityView> = None;
    let mut fold_ent: Option<EntityView> = None;
    let mut y1s = Vec::with_capacity(nb);
    for i in 0..nb {
        let (y0, y1, x0, x1) = (f(o), f(o + 1), f(o + 2), f(o + 3));
        let (kind, level, flags) = (b[o + 4] & 0xff, (b[o + 4] >> 8) & 0xff, (b[o + 4] >> 16) & 0xff);
        let (section, anchor) = (b[o + 5], b[o + 6]);
        o += LOAD_BLOCK;
        let p = proto(if (kind as usize) < KIND_NAMES.len() { kind as usize } else { PROTO_BLOCK });
        let e = w
            .entity()
            .is_a(p)
            .child_of(art)
            .set(Rect { x0, x1, y0, y1 })
            .set(BlockInfo { index: i as u32, kind, level, flags, section });
        if anchor != 0 {
            e.set(Anchor { string_off: anchor });
        }
        if let Some(q) = prev {
            q.add((Next::id(), e));
        }
        if kind == KIND_FOLD && fold_ent.is_none() {
            fold_ent = Some(e);
        }
        if flags & FLAG_FOLDED != 0 {
            if let Some(fe) = fold_ent {
                e.add((InFold::id(), fe));
            }
        }
        if kind == KIND_HEADING && level <= 2 {
            d.headings.push(i as u32);
        }
        prev = Some(e);
        d.block_ent.push(*e.id());
        d.y0.push(y0);
        y1s.push(y1);
        d.section_of.push(section);
    }
    d.pmax = prefix_max(&y1s);
    d.smin = suffix_min(&d.y0);

    // notes
    let (mut n_y0, mut n_y1) = (Vec::with_capacity(nn), Vec::with_capacity(nn));
    for i in 0..nn {
        let (y0, y1, x0, x1, anchor_block, anchor_line) = (f(o), f(o + 1), f(o + 2), f(o + 3), b[o + 4] as usize, b[o + 5]);
        o += LOAD_NOTE;
        let e = w.entity().is_a(proto(PROTO_NOTE)).child_of(art).set(Rect { x0, x1, y0, y1 }).set(NoteInfo { index: i as u32, anchor_line });
        if let Some(&blk) = d.block_ent.get(anchor_block) {
            e.add((NoteOf::id(), w.entity_from_id(blk)));
        }
        n_y0.push(y0);
        n_y1.push(y1);
    }
    d.n_pmax = prefix_max(&n_y1);
    d.n_smin = suffix_min(&n_y0);

    // figures: the clock lives on the figure's block entity
    for i in 0..nf {
        let (id, mode, duration, poster, block, alt) = (b[o], b[o + 1], f(o + 2), f(o + 3), b[o + 4] as usize, b[o + 5]);
        o += LOAD_FIGURE;
        let mut row = Fig { t: poster, ..Fig::default() };
        if let Some(&blk) = d.block_ent.get(block) {
            let e = w.entity_from_id(blk);
            e.set(Figure { index: i as u32, id, mode, duration, poster, alt });
            e.set(FigureTime { t: poster, vel: 0.0, hold: 0.0, play: mode == MODE_LOOP || mode == MODE_ONCE });
            row.ent = blk;
            row.y0 = d.y0[block];
            row.y1 = y1s[block];
        }
        d.figs.push(row);
    }

    // anchors: the block record already names its anchor; the table fills the blocks that have none
    for _ in 0..na {
        let (off, block) = (b[o], b[o + 1] as usize);
        o += LOAD_ANCHOR;
        if let Some(&blk) = d.block_ent.get(block) {
            let e = w.entity_from_id(blk);
            if !e.has(Anchor::id()) {
                e.set(Anchor { string_off: off });
            }
        }
    }

    // links: (Targets, block) for an internal link, (Cites, ref) for a reference
    let mut refs: HashMap<u32, u64> = HashMap::new();
    for _ in 0..nl {
        let (block, kind, target, ref_index, line) = (b[o], b[o + 1], b[o + 2] as i32, b[o + 3] as i32, b[o + 4]);
        o += LOAD_LINK;
        let e = w.entity().child_of(art).set(Link { block, kind, line });
        if let Some(&tb) = usize::try_from(target).ok().and_then(|t| d.block_ent.get(t)) {
            e.add((Targets::id(), w.entity_from_id(tb)));
        }
        if ref_index >= 0 {
            let r = *refs.entry(ref_index as u32).or_insert_with(|| *w.entity().child_of(art).set(RefEntry { index: ref_index as u32 }).id());
            e.add((Cites::id(), w.entity_from_id(r)));
        }
    }

    // a new article starts collapsed and at rest
    w.set(Fold { t: 0.0, target: 0.0, vel: 0.0, y: fold_y, h: fold_h, peek: d.peek_h });
    w.remove(Expanded::id());
    w.add(Settled::id());
    d.dirty = D_LAYOUT | D_SCROLL;
    d.last_y = w.try_cloned::<&Scroll>().map_or(0.0, |s| s.y);
    w.set(d);
    rd_reset();
    // events of the teardown go; the ones of the first cull (the current heading, figures in range) stay for the host
    w.get::<&mut Events>(|e| e.q.clear());
    refresh(w);
    emit(w, EV_LAYOUT, class);
    0
}

fn prefix_max(v: &[f32]) -> Vec<f32> {
    let mut m = f32::NEG_INFINITY;
    v.iter()
        .map(|&x| {
            m = m.max(x);
            m
        })
        .collect()
}

fn suffix_min(v: &[f32]) -> Vec<f32> {
    let mut m = f32::INFINITY;
    let mut out: Vec<f32> = v
        .iter()
        .rev()
        .map(|&x| {
            m = m.min(x);
            m
        })
        .collect();
    out.reverse();
    out
}

// ---- input ----

/// Point an exclusive singleton relation at the block (or figure block) `ent`, or clear it.
fn point(w: &World, rel: Entity, ent: Option<u64>) {
    match ent {
        None => {
            w.remove((rel, flecs::Wildcard::ID));
        }
        Some(id) => {
            let e = w.entity_from_id(id);
            if w.target(rel, Some(0)).id() != e.id() {
                w.add((rel, e));
            }
        }
    }
}

fn block_ent(w: &World, idx: i32) -> Option<u64> {
    let i = usize::try_from(idx).ok()?;
    w.get::<&Doc>(|d| d.block_ent.get(i).copied())
}

fn fig_ent(w: &World, idx: i32) -> Option<u64> {
    let i = usize::try_from(idx).ok()?;
    w.get::<&Doc>(|d| d.figs.get(i).map(|g| g.ent)).filter(|&e| e != 0)
}

/// Edit a figure clock (immediate, outside the pipeline) and mirror it for the packer. False when the figure is unknown or static.
fn edit_clock(w: &World, idx: i32, f: impl FnOnce(&Figure, FigureTime) -> FigureTime) -> bool {
    let Some(id) = fig_ent(w, idx) else { return false };
    let e = w.entity_from_id(id);
    let (Some(fig), Some(c)) = (e.try_cloned::<&Figure>(), e.try_cloned::<&FigureTime>()) else { return false };
    let n = f(&fig, c);
    e.set(n);
    w.get::<&mut Doc>(|d| {
        if let Some(g) = d.figs.get_mut(idx as usize) {
            g.t = n.t;
        }
        d.dirty |= D_FIG;
    });
    true
}

fn is_static(w: &World, idx: i32) -> bool {
    fig_ent(w, idx).and_then(|id| w.entity_from_id(id).try_cloned::<&Figure>()).map_or(true, |f| f.mode == MODE_STATIC)
}

pub fn input(kind: u32, a: f32, b: f32) {
    let ai = if a.is_finite() { a as i32 } else { -1 };
    with_world(|w| {
        match kind {
            IN_HOVER => {
                point(w, w.component_id::<Hover>(), block_ent(w, ai));
                w.get::<&mut Doc>(|d| {
                    d.hover = if ai >= 0 && d.block_ent.len() > ai as usize { ai } else { -1 };
                    d.dirty |= D_HOVER;
                });
            }
            IN_FOCUS => {
                point(w, w.component_id::<Focus>(), block_ent(w, ai));
                w.get::<&mut Doc>(|d| {
                    d.focus = if ai >= 0 && d.block_ent.len() > ai as usize { ai } else { -1 };
                    d.dirty |= D_HOVER;
                });
            }
            IN_OPEN => {
                point(w, w.component_id::<Open>(), block_ent(w, ai));
                w.get::<&mut Doc>(|d| {
                    d.open = if ai >= 0 && d.block_ent.len() > ai as usize { ai } else { -1 };
                    d.dirty |= D_HOVER;
                });
            }
            IN_SCRUB_BEGIN => {
                if !is_static(w, ai) && edit_clock(w, ai, |_, c| FigureTime { vel: 0.0, hold: USER_HOLD_S, ..c }) {
                    point(w, w.component_id::<Scrubbing>(), fig_ent(w, ai));
                    w.get::<&mut Doc>(|d| {
                        d.scrub = ai;
                        d.dirty |= D_HOVER;
                    });
                }
            }
            IN_SCRUB_TO => {
                if !is_static(w, ai) {
                    edit_clock(w, ai, |f, c| FigureTime { t: b.clamp(0.0, f.duration.max(0.0)), vel: 0.0, hold: USER_HOLD_S, ..c });
                }
            }
            IN_SCRUB_END => {
                let reduced = w.has(Reduced::id());
                if !is_static(w, ai) {
                    edit_clock(w, ai, |_, c| FigureTime { vel: if reduced { 0.0 } else { b }, hold: USER_HOLD_S, ..c });
                }
                point(w, w.component_id::<Scrubbing>(), None);
                w.get::<&mut Doc>(|d| {
                    d.scrub = -1;
                    d.dirty |= D_HOVER;
                });
            }
            IN_FIG_STEP => {
                if !is_static(w, ai) {
                    edit_clock(w, ai, |f, c| FigureTime { t: (c.t + b).clamp(0.0, f.duration.max(0.0)), vel: 0.0, hold: USER_HOLD_S, ..c });
                }
            }
            IN_FIG_PLAY => {
                if !is_static(w, ai) {
                    edit_clock(w, ai, |f, c| {
                        let play = match b as i32 {
                            0 => false,
                            2 => !c.play,
                            _ => true,
                        };
                        // playing a finished figure starts it over
                        let t = if play && f.mode != MODE_LOOP && c.t >= f.duration { 0.0 } else { c.t };
                        FigureTime { t, play, hold: 0.0, ..c }
                    });
                }
            }
            IN_FIG_HOME => {
                edit_clock(w, ai, |f, c| FigureTime { t: f.poster, vel: 0.0, hold: USER_HOLD_S, ..c });
            }
            IN_FOLD_SET => set_fold(w, a > 0.5, b > 0.5),
            IN_REDUCED => set_reduced(w, a > 0.5),
            _ => {}
        }
        pack(w);
    });
}

fn set_fold(w: &World, expand: bool, instant: bool) {
    let target = if expand { 1.0 } else { 0.0 };
    let f = w.try_cloned::<&Fold>().unwrap_or_default();
    if f.target != target {
        w.get::<&mut Fold>(|f| f.target = target);
        if expand {
            w.add(Expanded::id());
        } else {
            w.remove(Expanded::id());
        }
        w.remove(Settled::id());
        mark(w, D_SPRING | D_LAYOUT);
    }
    if instant || w.has(Reduced::id()) {
        w.get::<&mut Fold>(|f| {
            f.t = target;
            f.vel = 0.0;
        });
        w.add(Settled::id());
        mark(w, D_LAYOUT);
        refresh(w);
    }
}

fn set_reduced(w: &World, on: bool) {
    if on {
        w.add(Reduced::id());
    } else {
        w.remove(Reduced::id());
    }
    w.get::<&mut Doc>(|d| d.reduced = on);
    if on {
        // figures pin their poster; the fold lands where it is going
        let n = w.get::<&Doc>(|d| d.figs.len());
        for i in 0..n {
            edit_clock(w, i as i32, |f, c| FigureTime { t: f.poster, vel: 0.0, hold: 0.0, ..c });
        }
        let f = w.try_cloned::<&Fold>().unwrap_or_default();
        if f.t != f.target || f.vel != 0.0 {
            set_fold(w, f.target > 0.5, true);
        }
    }
}

#[cfg(test)]
mod scroll_tests {
    use super::*;

    fn state(i: usize) -> f32 {
        RD.with(|s| s.borrow()[i])
    }

    /// The exports end to end in a Flecs world: an empty article of 100 em, a 800 px viewport at 16 px/em (max 50 em = 800 px).
    #[test]
    fn engine_owns_the_scroll() {
        assert_eq!(init(), 0);
        let p = buf(LOAD_HEADER as u32);
        // SAFETY: `buf` returned at least LOAD_HEADER words and nothing else touches the buffer in this test.
        let b = unsafe { std::slice::from_raw_parts_mut(p, LOAD_HEADER) };
        b.fill(0);
        b[5] = 100.0f32.to_bits();
        assert_eq!(load(), 0);
        set_viewport(800.0, 800.0, 1.0, 16.0, 2);
        tick(16.0);
        assert_eq!(state(RD_SCROLL_MAX_PX), (100.0 - 50.0) * 16.0);

        // Space animates a page minus 40 px; the state vector follows frame by frame
        assert_eq!(key(scroll::KEY_SPACE, false), 1);
        assert_eq!(key(99, false), 0);
        tick(16.0);
        assert_eq!(state(RD_SCROLL_MODE), scroll::MODE_ANIMATE as f32);
        assert!(state(RD_VELOCITY) > 0.0);
        for _ in 0..60 {
            tick(16.0);
        }
        assert_eq!(state(RD_SCROLL_MODE), scroll::MODE_IDLE as f32);
        assert!((state(RD_SCROLL_Y_PX) - 760.0).abs() < 0.01, "{}", state(RD_SCROLL_Y_PX));
        assert!((state(RD_SCROLL) * 16.0 - 760.0).abs() < 0.01, "Scroll.y in em stays in step");

        // the page is 800 px max: End clamps; a pinch wheel does nothing; reading_set_scroll cancels motion
        assert_eq!(wheel(0.0, 100.0, 0, true), 0);
        scroll_to(10_000.0, false);
        assert_eq!(state(RD_SCROLL_Y_PX), 800.0);
        assert_eq!(wheel(0.0, -7.0, 0, false), 1);
        tick(16.0);
        assert_eq!(state(RD_SCROLL_Y_PX), 793.0);
        set_scroll(100.0);
        tick(16.0);
        assert_eq!(state(RD_SCROLL_Y_PX), 100.0);
        assert_eq!(state(RD_SCROLL_MODE), 0.0);
        // a touch drag past the top: the band opens and closes
        let id = 1 << 16;
        set_scroll(0.0);
        pointer(scroll::PTR_DOWN, id, 0.0, 100.0, 0.0);
        pointer(scroll::PTR_MOVE, id, 0.0, 400.0, 10.0);
        pointer(scroll::PTR_MOVE, id, 0.0, 400.0, 300.0);
        tick(16.0);
        assert!(state(RD_SCROLL_Y_PX) < -50.0 && state(RD_SCROLL_Y_PX) > -800.0);
        assert_eq!(state(RD_SCROLL_MODE), scroll::MODE_DRAG as f32);
        pointer(scroll::PTR_UP, id, 0.0, 400.0, 400.0);
        for _ in 0..120 {
            tick(16.0);
        }
        assert_eq!(state(RD_SCROLL_Y_PX), 0.0);
        assert_eq!(state(RD_SCROLL_MODE), 0.0);
    }
}
