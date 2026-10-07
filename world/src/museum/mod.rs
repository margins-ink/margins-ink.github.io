//! The museum: exhibits declared in Flecs script, stepped by small interpreters in Rust (docs/MUSEUM.md "Built contract").
//!
//! The script (`scene/60-museum.flecs` for the vocabulary, one file per exhibit for the content) declares data: parts, controls, presets,
//! rules. The runtime state of an exhibit (tape, clock, rule edits) is native Rust held by the registry below and mirrored to the
//! exhibit entity as tags (`Running`, `Halted`, `(Why, ..)`) and `Steps` for tests and tooling. One Flecs system (`ExhibitSim`, phase
//! Sim) advances every exhibit on a fixed 1/60 s clock, so the sequence of states depends on the step count only, never on frame time.
//!
//! Frame protocol: `reading::register` is called by the loader for every exhibit block; the host then calls `exhibit_load(ex, ..)` with
//! the script text. Everything an exhibit shows is read back through `pack` (a flat draw list) and the state rows (`XS` in abi.ts).
pub mod draw;
pub mod input;
pub mod kind_common;
pub mod kind_graph;
pub mod kind_grid;
pub mod kind_rewrite;
pub mod kind_tape;
pub mod kind_timeline;
pub mod model;
pub mod snapshot;

use crate::reading;
use draw::DrawList;
use flecs_ecs::prelude::*;
use input::{KeyResult, Ui};
use model::*;
use std::cell::RefCell;

pub const TICK: f32 = 1.0 / 60.0;
/// A frame of 1/60 s (as f32 milliseconds in JS) must count as one tick: 10 microseconds of slack, the debt carries.
const TICK_SLACK: f64 = 1e-5;
/// Interpreter steps per frame, per exhibit.
pub const MAX_STEPS: u32 = 64;
/// `XS.max` and `XS.stride` in abi.ts.
pub const MAX_EX: usize = 32;
pub const XS_STRIDE: usize = 8;
const SCRIPT: &str = include_str!("../../scene/60-museum.flecs");

/// What an exhibit knows about the page this tick.
#[derive(Clone, Copy, Default)]
pub struct Ctx {
    pub live: bool,
    pub idle: f32,
    pub reduced: bool,
}

pub enum Family {
    Timeline(kind_timeline::State),
    Tape(kind_tape::State),
    Machine(kind_common::Driver),
}

/// The load record of an exhibit block (`LOAD_EXHIBIT`), known before the script arrives.
#[derive(Clone, Copy, Default)]
#[allow(dead_code)]
pub struct Meta {
    pub id: u32,
    pub mode: u32,
    pub duration: f32,
    pub poster: f32,
    pub kind: u32,
    pub block: u64,
    pub article: u64,
}

pub struct Ex {
    pub index: usize,
    pub def: ExDef,
    pub scope: u64,
    pub src: String,
    pub hash: u32,
    pub ui: Ui,
    pub fam: Family,
    /// seconds not yet consumed by fixed ticks
    pub acc: f64,
    pub time: f32,
    /// needs a redraw
    pub dirty: bool,
    /// persisted state changed (event exhibitState)
    pub changed: bool,
    /// halted since the last flush (event exhibitHalted)
    pub halt_evt: bool,
    pub animating: bool,
    mirrored: (bool, Option<kind_tape::Why>, u32),
}

impl Ex {
    fn new(index: usize, def: ExDef, scope: u64, src: &str, meta: &Meta) -> Ex {
        let fam = match def.fam {
            Fam::Timeline => Family::Timeline(kind_timeline::State::from_def(&def, meta.mode, meta.duration, meta.poster)),
            Fam::Tape => Family::Tape(kind_tape::State::new(&def)),
            Fam::Rewrite | Fam::Graph | Fam::Grid => Family::Machine(kind_common::Driver::new(&def)),
        };
        Ex { index, def, scope, src: src.to_string(), hash: snapshot::fnv1a(src), ui: Ui::default(), fam, acc: 0.0, time: 0.0, dirty: true, changed: false, halt_evt: false, animating: false, mirrored: (false, None, 0) }
    }

    pub fn running(&self) -> bool {
        match &self.fam {
            Family::Tape(s) => s.running,
            Family::Machine(d) => d.running,
            Family::Timeline(t) => t.play,
        }
    }

    pub fn steps(&self) -> u32 {
        match &self.fam {
            Family::Tape(s) => s.steps,
            Family::Machine(d) => d.steps,
            Family::Timeline(_) => 0,
        }
    }

    /// Advance by `dt` seconds of page time: whole fixed ticks only.
    pub fn advance(&mut self, dt: f32, c: &Ctx) {
        self.acc = (self.acc + dt.clamp(0.0, 0.1) as f64).min(0.1);
        let was_halted = self.halted_why().is_some();
        let mut left = MAX_STEPS;
        while self.acc >= TICK as f64 - TICK_SLACK {
            self.acc -= TICK as f64;
            self.time += TICK;
            let moved = match &mut self.fam {
                Family::Timeline(t) => t.tick(c),
                Family::Tape(s) => s.tick(&self.def, c, &mut left),
                Family::Machine(d) => d.tick(&self.def, &mut left),
            };
            if moved {
                self.dirty = true;
            }
        }
        self.animating = match &self.fam {
            Family::Timeline(t) => t.animating(c),
            Family::Tape(s) => s.animating(&self.def),
            Family::Machine(d) => d.animating(),
        };
        if self.animating {
            self.dirty = true;
        }
        if !was_halted && self.halted_why().is_some() {
            self.halt_evt = true;
            self.changed = true;
        }
        if self.steps() != self.mirrored.2 && !matches!(self.fam, Family::Timeline(_)) {
            self.changed = true;
        }
    }

    pub fn reduced(&mut self) {
        if let Family::Timeline(t) = &mut self.fam {
            t.reduced();
        }
        self.touch_state();
    }

    /// Mirror the runtime state to the exhibit entity (tags and `Steps`) when it differs from what is there.
    fn mirror(&mut self, w: &World, voc: &Voc) {
        let now = (self.running(), self.halted_why(), self.steps());
        if now == self.mirrored {
            return;
        }
        let e = w.entity_from_id(self.def.root);
        if !e.is_alive() {
            return;
        }
        if now.0 != self.mirrored.0 {
            if now.0 {
                e.add(voc.running);
            } else {
                e.remove(voc.running);
            }
        }
        if now.1 != self.mirrored.1 {
            e.remove((voc.why, flecs::Wildcard::ID));
            match now.1 {
                Some(why) => {
                    e.add(voc.halted);
                    e.add((voc.why, match why {
                        kind_tape::Why::Accept => voc.accept,
                        kind_tape::Why::NoRule => voc.no_rule,
                        kind_tape::Why::Fuel => voc.out_of_fuel,
                    }));
                }
                None => {
                    e.remove(voc.halted);
                }
            }
        }
        if now.2 != self.mirrored.2 {
            e.set(Steps { n: now.2 });
        }
        self.mirrored = now;
    }
}

#[derive(Default)]
struct Reg {
    metas: Vec<Option<Meta>>,
    exs: Vec<Option<Ex>>,
    voc: Option<Voc>,
    setup_error: Option<String>,
    /// exhibit holding keyboard focus
    focus: i32,
    draw: DrawList,
    out: Vec<u8>,
    buf: Vec<u8>,
    state: Vec<f32>,
}

thread_local! {
    static REG: RefCell<Reg> = RefCell::new(Reg { focus: -1, state: vec![0.0; MAX_EX * XS_STRIDE], ..Reg::default() });
}

thread_local! {
    /// Dev: the vocabulary text read from disk by the page (`scene::override_source`), used instead of the baked copy.
    static VOCAB: RefCell<Option<String>> = const { RefCell::new(None) };
}

/// Dev: use `src` as the museum vocabulary (60-museum.flecs) for every later install.
pub fn override_vocabulary(src: &str) {
    VOCAB.with(|v| *v.borrow_mut() = Some(src.to_string()));
}

fn script_error(e: EntityView) -> Option<String> {
    e.get::<&flecs::Script>(|s| {
        // SAFETY: `error` is null or a NUL-terminated string owned by the EcsScript component, alive for this call.
        (!s.error.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(s.error) }.to_string_lossy().into_owned())
    })
}

/// Register the components and run the vocabulary script in `world`. Called by `reading::setup` (also for bare worlds and scratch worlds).
pub(crate) fn install(world: &World) -> Result<Voc, String> {
    model::register(world);
    let src = VOCAB.with(|v| v.borrow().clone()).unwrap_or_else(|| SCRIPT.to_string());
    let s = world.script_named("museum::prefabs").build_from_code(&src);
    if let Some(e) = script_error(*s) {
        return Err(format!("museum script 60-museum.flecs: {e}"));
    }
    Voc::lookup(world)
}

/// For the film module's scratch worlds: the museum vocabulary and components.
pub(crate) fn install_for_film(world: &World) -> Result<(), String> {
    install(world).map(|_| ())
}

pub fn setup(world: &World) {
    let r = install(world);
    REG.with(|g| {
        let mut g = g.borrow_mut();
        *g = Reg { focus: -1, state: vec![0.0; MAX_EX * XS_STRIDE], ..Reg::default() };
        match r {
            Ok(v) => g.voc = Some(v),
            Err(e) => g.setup_error = Some(e),
        }
    });
}

/// A new article is loading: its scopes die with it, so the rows go.
pub fn reset() {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        g.metas.clear();
        g.exs.clear();
        g.focus = -1;
        g.state.iter_mut().for_each(|x| *x = 0.0);
    });
}

/// The loader saw an exhibit block (`LOAD_EXHIBIT`).
pub fn register(index: usize, id: u32, mode: u32, duration: f32, poster: f32, kind: u32, block: u64, article: u64) {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        if g.metas.len() <= index {
            g.metas.resize(index + 1, None);
        }
        g.metas[index] = Some(Meta { id, mode, duration, poster, kind, block, article });
    });
}

/// `ExhibitSim`: advance every loaded exhibit. Called once per frame from the Sim phase.
pub fn tick(w: &World, dt: f32) {
    let (idle, reduced) = reading::page_idle(w);
    let mut dirty = false;
    REG.with(|g| {
        let mut g = g.borrow_mut();
        let Reg { exs, voc, .. } = &mut *g;
        for ex in exs.iter_mut().flatten() {
            let live = reading::exhibit_view(w, ex.index).is_some_and(|(_, live)| live);
            ex.advance(dt, &Ctx { live, idle, reduced });
            if let Some(v) = voc {
                ex.mirror(w, v);
            }
            dirty |= flush(w, ex);
        }
        sync(&mut g);
    });
    if dirty {
        reading::mark(w, reading::D_EX);
    }
}

/// Emit the pending events of `ex`; true when it needs a frame.
fn flush(w: &World, ex: &mut Ex) -> bool {
    if ex.changed {
        ex.changed = false;
        reading::emit(w, reading::EV_EX_STATE, ex.index as u32);
    }
    if ex.halt_evt {
        ex.halt_evt = false;
        reading::emit(w, reading::EV_EX_HALTED, ex.index as u32);
    }
    let d = ex.dirty;
    ex.dirty = false;
    d
}

/// The `XS` rows (`exhibit_state_ptr`).
fn sync(g: &mut Reg) {
    let focus = g.focus;
    for i in 0..MAX_EX {
        let row = &mut g.state[i * XS_STRIDE..(i + 1) * XS_STRIDE];
        match g.exs.get(i).and_then(|e| e.as_ref()) {
            Some(ex) => {
                row[0] = 1.0;
                row[1] = ex.running() as u32 as f32;
                row[2] = ex.halted_why().is_some() as u32 as f32;
                row[3] = ex.steps() as f32;
                row[4] = match &ex.fam {
                    Family::Timeline(t) => t.t,
                    Family::Tape(_) | Family::Machine(_) => ex.time,
                };
                row[5] = ex.animating as u32 as f32;
                row[6] = (focus == i as i32) as u32 as f32;
                row[7] = !matches!(ex.fam, Family::Timeline(_)) as u32 as f32;
            }
            None => row.fill(0.0),
        }
    }
}

/// Reduced motion was switched on: timelines pin their poster.
pub fn reduced(w: &World) {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        for ex in g.exs.iter_mut().flatten() {
            ex.reduced();
            flush(w, ex);
        }
        sync(&mut g);
    });
    reading::mark(w, reading::D_EX);
}

// ---- loading ----

fn world() -> Result<World, String> {
    reading::with_world(|w| w.clone()).ok_or_else(|| "no world".to_string())
}

/// Create scope `ex<N>` under the article, run the script in it and read the exhibit. On any error the scope is removed.
fn build(w: &World, article: u64, ex: usize, src: &str) -> Result<(ExDef, u64), String> {
    let art = w.entity_from_id(article);
    if !art.is_alive() {
        return Err(format!("exhibit {ex}: the article is gone"));
    }
    let prev = w.set_scope(art);
    let scope = w.entity_named(&format!("ex{ex}"));
    w.set_scope(scope);
    let s = w.script_named("script").build_from_code(src);
    w.set_scope(prev);
    let fail = |e: String| {
        scope.destruct();
        Err(format!("exhibit {ex}: {e}"))
    };
    if let Some(e) = script_error(*s) {
        return fail(e);
    }
    match model::read(w, scope) {
        Ok(def) => Ok((def, *scope.id())),
        Err(e) => fail(e),
    }
}

/// Run the script in a scratch world with only the museum vocabulary: the dry run of `reload` and the body of `inspect`.
fn scratch(src: &str) -> Result<ExDef, String> {
    let w = World::new();
    install(&w)?;
    let scope = w.entity_named("scratch");
    let prev = w.set_scope(scope);
    let s = w.script_named("script").build_from_code(src);
    w.set_scope(prev);
    if let Some(e) = script_error(*s) {
        return Err(e);
    }
    model::read(&w, scope)
}

/// Put an error text in the out buffer and return 1.
pub fn fail(e: &str) -> u32 {
    out_err(e);
    1
}

fn out_err(e: &str) {
    REG.with(|g| g.borrow_mut().out = e.as_bytes().to_vec());
}

/// `exhibit_load`: replaces a previous load of that index. 0 ok, else the error text is in the out buffer.
pub fn load(ex: usize, src: &str) -> u32 {
    match load_inner(ex, src, None) {
        Ok(()) => 0,
        Err(e) => {
            out_err(&e);
            1
        }
    }
}

fn load_inner(ex: usize, src: &str, keep: Option<(String, Ui)>) -> Result<(), String> {
    let w = world()?;
    let (meta, voc_ok, setup_err, old_scope) = REG.with(|g| {
        let g = g.borrow();
        (
            g.metas.get(ex).copied().flatten(),
            g.voc.is_some(),
            g.setup_error.clone(),
            g.exs.get(ex).and_then(|e| e.as_ref()).map(|e| e.scope),
        )
    });
    if let Some(e) = setup_err {
        return Err(e);
    }
    if !voc_ok {
        return Err("the museum is not installed".into());
    }
    let Some(meta) = meta else { return Err(format!("exhibit {ex} is not in the loaded article")) };
    if ex >= MAX_EX {
        return Err(format!("exhibit {ex}: at most {MAX_EX} exhibits per article"));
    }
    if let Some(s) = old_scope {
        let e = w.entity_from_id(s);
        if e.is_alive() {
            e.destruct();
        }
    }
    REG.with(|g| {
        let mut g = g.borrow_mut();
        if g.exs.len() <= ex {
            g.exs.resize_with(ex + 1, || None);
        }
        g.exs[ex] = None;
        sync(&mut g); // a failed load leaves the row unloaded (XS.loaded 0), never the stale one
    });
    let (def, scope) = build(&w, meta.article, ex, src)?;
    let mut e = Ex::new(ex, def, scope, src, &meta);
    if let Some((payload, ui)) = keep {
        e.restore_payload(&payload);
        e.ui = ui;
    }
    REG.with(|g| {
        let mut g = g.borrow_mut();
        if let Some(v) = &g.voc {
            e.mirror(&w, v);
        }
        g.exs[ex] = Some(e);
        sync(&mut g);
    });
    reading::mark(&w, reading::D_EX);
    Ok(())
}

/// `exhibit_reload`: dry run in a scratch world, then rebuild in place keeping the state (the old exhibit runs on after an error).
pub fn reload(ex: usize, src: &str) -> u32 {
    let r = (|| {
        scratch(src).map_err(|e| format!("exhibit {ex}: {e}"))?;
        let (old_src, keep) = REG.with(|g| {
            let g = g.borrow();
            g.exs.get(ex).and_then(|e| e.as_ref()).map(|e| {
                let payload = e.snapshot_text();
                let payload = payload.split_once(':').map_or(String::new(), |(_, p)| p.to_string());
                (e.src.clone(), (payload, Ui { hover: None, pressed: None, capture: None, focus: e.ui.focus, sel: e.ui.sel }))
            })
        }).ok_or_else(|| format!("exhibit {ex} is not loaded"))?;
        match load_inner(ex, src, Some(keep)) {
            Ok(()) => Ok(()),
            Err(e) => {
                let _ = load_inner(ex, &old_src, None);
                Err(e)
            }
        }
    })();
    match r {
        Ok(()) => 0,
        Err(e) => {
            out_err(&e);
            1
        }
    }
}

/// Names of every component, tag and relation on the entities under `scope` (the scope and all descendants), sorted, unique.
fn component_names(scope: EntityView) -> Vec<String> {
    fn walk(e: EntityView, out: &mut std::collections::BTreeSet<String>) {
        e.each_component(|id| {
            let ev = if id.is_pair() { id.first_id() } else { id.entity_view() };
            let n = ev.name();
            if !n.is_empty() {
                out.insert(n);
            }
        });
        let mut kids = Vec::new();
        e.each_child(|c| kids.push(c.id()));
        for k in kids {
            walk(EntityView::new_from(e.world(), k), out);
        }
    }
    let mut set = std::collections::BTreeSet::new();
    walk(scope, &mut set);
    set.into_iter().collect()
}

/// Draw items of one pack, counting the ones the list refused (so a script over the cap shows its real size).
fn item_count(ex: &Ex, dl: &mut DrawList) -> usize {
    ex.pack(dl);
    dl.count() + dl.dropped as usize
}

/// The most draw items over every preset, packed at step 0 and again after 200 steps (a timeline: once).
fn max_items(def: &ExDef, src: &str) -> usize {
    let meta = Meta::default();
    let mut ex = Ex::new(0, def.clone(), 0, src, &meta);
    let mut dl = DrawList::default();
    let mut most = item_count(&ex, &mut dl);
    if let Family::Tape(_) = ex.fam {
        for i in 0..def.presets.len() {
            if let Family::Tape(s) = &mut ex.fam {
                s.load(def, i);
            }
            most = most.max(item_count(&ex, &mut dl));
            if let Family::Tape(s) = &mut ex.fam {
                for _ in 0..200 {
                    if !s.step(def) {
                        break;
                    }
                }
            }
            most = most.max(item_count(&ex, &mut dl));
        }
    }
    if let Family::Machine(_) = ex.fam {
        for i in 0..def.preset_ids.len() {
            if let Family::Machine(d) = &mut ex.fam {
                d.load(def, i);
            }
            most = most.max(item_count(&ex, &mut dl));
            if let Family::Machine(d) = &mut ex.fam {
                for _ in 0..200 {
                    if !d.step_once(def) {
                        break;
                    }
                }
            }
            most = most.max(item_count(&ex, &mut dl));
        }
    }
    most
}

/// `exhibit_inspect`: describe a script as JSON (build lint, `Inspect` in scripts/magazine/exhibit.ts). 0 ok, else the error text is in the out buffer.
pub fn inspect(src: &str) -> u32 {
    let r = (|| {
        let w = World::new();
        install(&w)?;
        let scope = w.entity_named("scratch");
        let prev = w.set_scope(scope);
        let s = w.script_named("script").build_from_code(src);
        w.set_scope(prev);
        if let Some(e) = script_error(*s) {
            return Err(e);
        }
        let d = model::read(&w, scope)?;
        Ok((max_items(&d, src), component_names(scope), d))
    })();
    match r {
        Ok((items, components, d)) => {
            let nonempty = |s: &str| (!s.is_empty()).then(|| s.to_string());
            let parts: Vec<_> = d
                .parts
                .iter()
                .map(|p| serde_json::json!({"w": p.place[2], "h": p.place[3], "label": nonempty(&p.label), "name": p.name, "kind": format!("{:?}", p.kind), "place": p.place, "layer": p.layer}))
                .collect();
            let controls: Vec<_> = d
                .parts
                .iter()
                .filter_map(|p| p.verb.map(|v| serde_json::json!({"label": p.label, "does": format!("{v:?}")})))
                .collect();
            let presets: Vec<_> = match d.fam {
                Fam::Tape => d.presets.iter().map(|p| serde_json::json!({"id": p.id, "title": p.title, "symbols": p.symbols.len(), "states": p.states.len(), "rules": p.rules.len()})).collect(),
                _ => d.preset_ids.iter().map(|id| serde_json::json!({"id": id, "title": "", "symbols": 0, "states": 0, "rules": 0})).collect(),
            };
            let j = serde_json::json!({
                "kind": match d.fam { Fam::Tape => "tape", Fam::Timeline => "timeline", Fam::Rewrite => "rewrite", Fam::Graph => "graph", Fam::Grid => "grid" },
                "name": d.name, "title": d.title, "claim": d.claim, "describe": d.describe, "alt": d.alt, "caption": d.caption,
                "frame": {"w": d.frame[0], "h": d.frame[1]}, "items": items, "controls": controls, "parts": parts,
                // the museum has no Tone component: colours are the fixed palette of draw.rs, so a script cannot write one
                "tones": Vec::<String>::new(), "components": components,
                "presets": presets, "clip": d.clip.as_ref().map(|c| serde_json::json!({"duration": c.duration, "mode": c.mode, "poster": c.poster})),
            });
            REG.with(|g| g.borrow_mut().out = j.to_string().into_bytes());
            0
        }
        Err(e) => {
            out_err(&e);
            1
        }
    }
}

// ---- input, snapshot, pack ----

/// After an input: mirror the state of exhibit `ex` to its entity and refresh the state rows.
fn settle(g: &mut Reg, w: &World, ex: usize) {
    let Reg { exs, voc, .. } = &mut *g;
    if let (Some(v), Some(Some(e))) = (voc.as_ref(), exs.get_mut(ex)) {
        e.mirror(w, v);
    }
    sync(g);
}

/// `exhibit_drive`: the film plays an exhibit's controls. verb 0 load preset `n`, 1 press the Step button `n` times, 2 toggle Run, 3 Reset, 4 Toggle.
/// 0 ok, 1 no such exhibit, 2 the exhibit has no such control.
pub fn drive(ex: usize, verb: u32, n: u32) -> u32 {
    let Ok(w) = world() else { return 1 };
    let (r, dirty) = REG.with(|g| {
        let mut g = g.borrow_mut();
        let Some(e) = g.exs.get_mut(ex).and_then(|e| e.as_mut()) else { return (1, false) };
        let want = match verb {
            1 => Some(Verb::Step),
            2 => Some(Verb::Run),
            3 => Some(Verb::Reset),
            4 => Some(Verb::Toggle),
            _ => None,
        };
        let mut r = 0;
        if verb == 0 && e.def.presets.is_empty() {
            r = 2;
        } else if verb == 0 {
            match &mut e.fam {
                Family::Tape(s) => s.load(&e.def, n as usize),
                Family::Machine(d) => d.load(&e.def, n as usize),
                Family::Timeline(_) => r = 2,
            }
            e.touch_state();
        } else if let Some(v) = want {
            match e.def.parts.iter().position(|p| p.verb == Some(v)) {
                Some(i) => {
                    for _ in 0..(if verb == 1 { n.max(1) } else { 1 }) {
                        e.press(i);
                    }
                }
                None => r = 2,
            }
        } else {
            r = 2;
        }
        let d = flush(&w, e);
        settle(&mut g, &w, ex);
        (r, d)
    });
    if dirty {
        reading::mark(&w, reading::D_EX);
    }
    r
}

pub fn pointer(ex: usize, kind: u32, x: f32, y: f32) -> u32 {
    let Ok(w) = world() else { return 0 };
    let (r, dirty) = REG.with(|g| {
        let mut g = g.borrow_mut();
        let Some(e) = g.exs.get_mut(ex).and_then(|e| e.as_mut()) else { return (0, false) };
        let r = e.pointer(kind, x, y);
        let d = flush(&w, e);
        settle(&mut g, &w, ex);
        (r, d)
    });
    if dirty {
        reading::mark(&w, reading::D_EX);
    }
    r
}

pub fn key(code: u32, mods: u32) -> bool {
    let Ok(w) = world() else { return false };
    let (r, dirty) = REG.with(|g| {
        let mut g = g.borrow_mut();
        let ex = g.focus;
        let Some(e) = usize::try_from(ex).ok().and_then(|i| g.exs.get_mut(i)).and_then(|e| e.as_mut()) else { return (false, false) };
        let r = e.key(code, mods);
        let d = flush(&w, e);
        if r == KeyResult::Release {
            g.focus = -1;
        }
        settle(&mut g, &w, ex as usize);
        (r != KeyResult::Ignored, d)
    });
    if dirty {
        reading::mark(&w, reading::D_EX);
    }
    r
}

/// Give keyboard focus to exhibit `ex` (negative: none).
pub fn focus(ex: i32) {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        let old = g.focus;
        let new = if ex >= 0 && g.exs.get(ex as usize).is_some_and(|e| e.is_some()) { ex } else { -1 };
        if let Some(e) = usize::try_from(old).ok().and_then(|i| g.exs.get_mut(i)).and_then(|e| e.as_mut()) {
            e.ui.focus = false;
            e.dirty = true;
        }
        g.focus = new;
        if let Some(e) = usize::try_from(new).ok().and_then(|i| g.exs.get_mut(i)).and_then(|e| e.as_mut()) {
            e.ui.focus = true;
            e.dirty = true;
            if e.ui.sel.is_none() {
                e.ui.sel = e.def.parts.iter().position(|p| p.control());
            }
        }
        sync(&mut g);
    });
    if let Ok(w) = world() {
        reading::mark(&w, reading::D_EX);
    }
}

pub fn snapshot(ex: usize) -> u32 {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        let Some(t) = g.exs.get(ex).and_then(|e| e.as_ref()).map(|e| e.snapshot_text()) else { return 0 };
        g.out = t.into_bytes();
        g.out.len() as u32
    })
}

pub fn restore(ex: usize, text: &str) -> u32 {
    let Ok(w) = world() else { return 1 };
    let (ok, dirty) = REG.with(|g| {
        let mut g = g.borrow_mut();
        let Some(e) = g.exs.get_mut(ex).and_then(|e| e.as_mut()) else { return (false, false) };
        let ok = e.restore_text(text);
        let d = flush(&w, e);
        sync(&mut g);
        (ok, d)
    });
    if dirty {
        reading::mark(&w, reading::D_EX);
    }
    (!ok) as u32
}

pub fn pack(ex: usize) -> u32 {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        let Reg { exs, draw, .. } = &mut *g;
        match exs.get(ex).and_then(|e| e.as_ref()) {
            Some(e) => {
                e.pack(draw);
                draw.count() as u32
            }
            None => {
                draw.clear();
                0
            }
        }
    })
}

pub fn draw_ptr() -> *const f32 {
    REG.with(|g| g.borrow().draw.items.as_ptr())
}
pub fn str_ptr(i: u32) -> *const u8 {
    REG.with(|g| g.borrow().draw.strings.get(i as usize).map_or(std::ptr::null(), |s| s.as_ptr()))
}
pub fn str_len(i: u32) -> u32 {
    REG.with(|g| g.borrow().draw.strings.get(i as usize).map_or(0, |s| s.len() as u32))
}
pub fn state_ptr() -> *const f32 {
    REG.with(|g| g.borrow().state.as_ptr())
}
pub fn out_ptr() -> *const u8 {
    REG.with(|g| g.borrow().out.as_ptr())
}
pub fn out_len() -> u32 {
    REG.with(|g| g.borrow().out.len() as u32)
}
pub fn buf(len: u32) -> *mut u8 {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        if g.buf.len() < len as usize {
            g.buf.resize(len as usize, 0);
        }
        g.buf.as_mut_ptr()
    })
}
/// The staging buffer's first `len` bytes as text.
pub fn staged(len: u32) -> Result<String, String> {
    REG.with(|g| {
        let g = g.borrow();
        let n = (len as usize).min(g.buf.len());
        String::from_utf8(g.buf[..n].to_vec()).map_err(|_| "the staged text is not UTF-8".to_string())
    })
}

#[cfg(test)]
mod tests {}
