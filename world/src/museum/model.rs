//! The exhibit vocabulary: reflected components, the script vocabulary lookup and the reader that turns an exhibit scope into an `ExDef`.
//! Everything in here is data; the runtime state of a family lives in `kind_*.rs`.
use flecs_ecs::prelude::*;

macro_rules! text_component {
    ($($name:ident),*) => {$(
        #[derive(Component, Clone, Default, Debug)]
        #[flecs(meta)]
        pub struct $name { pub text: String }
    )*};
}
text_component!(Title, Claim, Describe, Alt, Caption, Label, LabelAlt, Glyph, Lambda, Content, Board, OnHit, OnBuilt);

#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Extent {
    pub w: f32,
    pub h: f32,
}
/// A part's rectangle, exhibit-local em. A negative x or y is measured from the far edge; a w or h of 0 or less leaves that margin.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Place {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Layer {
    pub n: u32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Order {
    pub n: u32,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Does {
    pub verb: String,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Key {
    pub ch: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Range {
    pub min: f32,
    pub max: f32,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Binds {
    pub path: String,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Loads {
    pub id: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Rate {
    pub hz: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Fuel {
    pub n: u32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Steps {
    pub n: u32,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Tape {
    pub cells: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct HeadAt {
    pub index: i32,
}
/// Timeline data when a script wants to override the load record: duration s, mode `loop | once | scrub | static`, poster time s.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Clip {
    pub duration: f32,
    pub mode: String,
    pub poster: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Spring {
    pub omega: f32,
}
/// Tape cell geometry: cell width, gap (em) and how many cells the window shows.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Cells {
    pub w: f32,
    pub gap: f32,
    pub n: u32,
}
/// Rule table geometry: row height (em) and the most rows shown.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Rows {
    pub h: f32,
    pub max: u32,
}

/// Register every field component. Names are the Rust names: a script entity must never share one (hot reload trap, flecs-scene skill).
pub fn register(w: &World) {
    w.component_named::<Title>("Title");
    w.component_named::<Claim>("Claim");
    w.component_named::<Describe>("Describe");
    w.component_named::<Alt>("Alt");
    w.component_named::<Caption>("Caption");
    w.component_named::<Label>("Label");
    w.component_named::<LabelAlt>("LabelAlt");
    w.component_named::<Glyph>("Glyph");
    w.component_named::<Lambda>("Lambda");
    w.component_named::<Content>("Content");
    w.component_named::<Board>("Board");
    w.component_named::<OnHit>("OnHit");
    w.component_named::<OnBuilt>("OnBuilt");
    w.component_named::<Extent>("Extent");
    w.component_named::<Place>("Place");
    w.component_named::<Layer>("Layer");
    w.component_named::<Order>("Order");
    w.component_named::<Does>("Does");
    w.component_named::<Key>("Key");
    w.component_named::<Range>("Range");
    w.component_named::<Binds>("Binds");
    w.component_named::<Loads>("Loads");
    w.component_named::<Rate>("Rate");
    w.component_named::<Fuel>("Fuel");
    w.component_named::<Steps>("Steps");
    w.component_named::<Tape>("Tape");
    w.component_named::<HeadAt>("HeadAt");
    w.component_named::<Clip>("Clip");
    w.component_named::<Spring>("Spring");
    w.component_named::<Cells>("Cells");
    w.component_named::<Rows>("Rows");
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PartKind {
    Button,
    Slider,
    TapeView,
    HeadMark,
    StatusLine,
    RuleTable,
    /// the region a stepper family (rewrite, graph, grid) draws its state in
    View,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Verb {
    Step,
    Run,
    Reset,
    Load,
    Scrub,
    Home,
    /// flip the family's mode (rewrite: evaluation order, grid: algorithm, graph: edit or rename)
    Toggle,
}

impl Verb {
    fn parse(s: &str) -> Option<Verb> {
        Some(match s {
            "step" => Verb::Step,
            "run" => Verb::Run,
            "reset" => Verb::Reset,
            "load" => Verb::Load,
            "scrub" => Verb::Scrub,
            "home" => Verb::Home,
            "toggle" => Verb::Toggle,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dir {
    Left,
    Right,
    Stay,
}

/// What a slider writes.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bind {
    None,
    RateHz,
    ClockT,
}

#[derive(Clone, Debug)]
pub struct Part {
    pub name: String,
    pub kind: PartKind,
    /// resolved against the frame: x, y, w, h in em, all non-negative
    pub place: [f32; 4],
    pub layer: u32,
    pub label: String,
    pub label_alt: String,
    pub verb: Option<Verb>,
    pub key: u32,
    pub loads: String,
    pub bind: Bind,
    pub range: [f32; 2],
    pub cells: Cells,
    pub rows: Rows,
}

impl Part {
    /// Buttons and sliders take part in keyboard focus.
    pub fn control(&self) -> bool {
        matches!(self.kind, PartKind::Button | PartKind::Slider)
    }
}

#[derive(Clone, Debug)]
#[allow(dead_code)]
pub struct SymDef {
    pub name: String,
    pub glyph: String,
    pub blank: bool,
}
#[derive(Clone, Debug)]
pub struct StateDef {
    pub name: String,
    pub halting: bool,
}
#[derive(Clone, Debug)]
pub struct RuleDef {
    pub from: usize,
    pub read: usize,
    pub write: usize,
    pub mv: Dir,
    pub to: usize,
}
#[derive(Clone, Debug)]
pub struct PresetDef {
    pub id: String,
    pub title: String,
    pub tape: String,
    pub head_at: i32,
    pub symbols: Vec<SymDef>,
    pub states: Vec<StateDef>,
    pub rules: Vec<RuleDef>,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Fam {
    Timeline,
    Tape,
    Rewrite,
    Graph,
    Grid,
}

/// Family data read from the script (steppers); `None` for Timeline and Tape.
#[derive(Clone, Debug)]
pub enum Data {
    None,
    Rewrite(Vec<super::kind_rewrite::RwPreset>),
    Graph(Vec<super::kind_graph::GPreset>),
    Grid(Vec<super::kind_grid::GridPreset>),
}

#[derive(Clone, Debug)]
pub struct ExDef {
    pub fam: Fam,
    pub root: u64,
    pub name: String,
    pub title: String,
    pub claim: String,
    pub describe: String,
    pub alt: String,
    pub caption: String,
    pub frame: [f32; 2],
    pub parts: Vec<Part>,
    pub rate: f32,
    pub fuel: u32,
    pub omega: f32,
    pub runs: String,
    pub presets: Vec<PresetDef>,
    pub data: Data,
    /// ids of the presets of any family, in declaration order
    pub preset_ids: Vec<String>,
    pub clip: Option<Clip>,
}

impl ExDef {
    pub fn part(&self, k: PartKind) -> Option<&Part> {
        self.parts.iter().find(|p| p.kind == k)
    }
}

/// The script vocabulary entities (declared by 60-museum.flecs), looked up once per load.
pub struct Voc {
    pub left: Entity,
    pub right: Entity,
    pub stay: Entity,
    pub from: Entity,
    pub reads: Entity,
    pub writes: Entity,
    pub moves: Entity,
    pub to: Entity,
    pub runs: Entity,
    pub blank: Entity,
    pub halting: Entity,
    pub running: Entity,
    pub halted: Entity,
    pub why: Entity,
    pub accept: Entity,
    pub no_rule: Entity,
    pub out_of_fuel: Entity,
    pub tape_machine: Entity,
    pub timeline: Entity,
    pub preset: Entity,
    pub rewrite_machine: Entity,
    pub graph_machine: Entity,
    pub grid_machine: Entity,
    parts: [(PartKind, Entity); 7],
}

impl Voc {
    pub fn lookup(w: &World) -> Result<Voc, String> {
        let get = |n: &str| w.try_lookup(n).map(|e| e.id()).ok_or_else(|| format!("museum vocabulary entity `{n}` is missing (60-museum.flecs did not run)"));
        Ok(Voc {
            left: get("Left")?,
            right: get("Right")?,
            stay: get("Stay")?,
            from: get("From")?,
            reads: get("Reads")?,
            writes: get("Writes")?,
            moves: get("Moves")?,
            to: get("To")?,
            runs: get("Runs")?,
            blank: get("Blank")?,
            halting: get("Halting")?,
            running: get("Running")?,
            halted: get("Halted")?,
            why: get("Why")?,
            accept: get("Accept")?,
            no_rule: get("NoRule")?,
            out_of_fuel: get("OutOfFuel")?,
            tape_machine: get("TapeMachine")?,
            timeline: get("Timeline")?,
            preset: get("Preset")?,
            rewrite_machine: get("RewriteMachine")?,
            graph_machine: get("GraphMachine")?,
            grid_machine: get("GridMachine")?,
            parts: [
                (PartKind::Button, get("Button")?),
                (PartKind::Slider, get("Slider")?),
                (PartKind::TapeView, get("TapeView")?),
                (PartKind::HeadMark, get("HeadMark")?),
                (PartKind::StatusLine, get("StatusLine")?),
                (PartKind::RuleTable, get("RuleTable")?),
                (PartKind::View, get("View")?),
            ],
        })
    }
}

pub fn is_a(e: EntityView, proto: Entity) -> bool {
    e.has((flecs::IsA::ID, proto))
}

pub fn path(e: EntityView) -> String {
    e.path().unwrap_or_else(|| format!("#{}", *e.id()))
}

macro_rules! txt {
    ($e:expr, $t:ident) => {
        $e.try_cloned::<&$t>().map(|t| t.text).unwrap_or_default()
    };
}

/// Children by `Order`, then by entity id. Ids are allocated as the script declares, so the id is the declaration order; the table order
/// `each_child` returns is not (children with different component sets sit in different tables: `b_reset` came before `b_run`).
pub fn children(e: EntityView) -> Vec<EntityView> {
    let mut v: Vec<(u64, u32, Entity)> = Vec::new();
    e.each_child(|c| {
        let o = c.try_cloned::<&Order>().map_or(0, |o| o.n);
        v.push((*c.id(), o, c.id()));
    });
    v.sort_by_key(|&(i, o, _)| (o, i));
    v.into_iter().map(|(_, _, id)| EntityView::new_from(e.world(), id)).collect()
}

fn resolve(p: Place, f: [f32; 2]) -> [f32; 4] {
    let x = if p.x < 0.0 { f[0] + p.x } else { p.x };
    let y = if p.y < 0.0 { f[1] + p.y } else { p.y };
    let w = if p.w <= 0.0 { f[0] - x + p.w } else { p.w };
    let h = if p.h <= 0.0 { f[1] - y + p.h } else { p.h };
    [x, y, w.max(0.0), h.max(0.0)]
}

fn read_preset(w: &World, voc: &Voc, e: EntityView) -> Result<PresetDef, String> {
    let id = e.name();
    let at = |what: &str, c: EntityView| format!("{}: {what}", path(c));
    let mut symbols = Vec::new();
    let mut states = Vec::new();
    let mut rules = Vec::new();
    let kids = children(e);
    let (sym_proto, state_proto, rule_proto) = (
        w.try_lookup("Symbol").ok_or("prefab `Symbol` is missing")?.id(),
        w.try_lookup("State").ok_or("prefab `State` is missing")?.id(),
        w.try_lookup("Rule").ok_or("prefab `Rule` is missing")?.id(),
    );
    let mut sym_ids = Vec::new();
    let mut state_ids = Vec::new();
    for &c in &kids {
        if is_a(c, sym_proto) {
            sym_ids.push(c.id());
            symbols.push(SymDef { name: c.name(), glyph: txt!(c, Glyph), blank: c.has(voc.blank) });
        } else if is_a(c, state_proto) {
            state_ids.push(c.id());
            states.push(StateDef { name: c.name(), halting: c.has(voc.halting) });
        }
    }
    if symbols.is_empty() || symbols.len() > 36 {
        return Err(at("a preset needs 1 to 36 Symbols", e));
    }
    if states.is_empty() {
        return Err(at("a preset needs at least one State", e));
    }
    if !symbols.iter().any(|s| s.blank) {
        symbols[0].blank = true;
    }
    for &c in &kids {
        if !is_a(c, rule_proto) {
            continue;
        }
        let pick = |rel: Entity, ids: &[Entity], what: &str| -> Result<usize, String> {
            let t = c.target(rel, 0).ok_or_else(|| at(&format!("rule has no ({what}, ...) pair"), c))?;
            ids.iter().position(|&i| i == t.id()).ok_or_else(|| at(&format!("({what}, {}) names something that is not in this preset", path(t)), c))
        };
        let mv = match c.target(voc.moves, 0).map(|t| t.id()) {
            Some(t) if t == voc.left => Dir::Left,
            Some(t) if t == voc.right => Dir::Right,
            Some(t) if t == voc.stay => Dir::Stay,
            _ => return Err(at("rule needs (Moves, Left | Right | Stay)", c)),
        };
        rules.push(RuleDef { from: pick(voc.from, &state_ids, "From")?, read: pick(voc.reads, &sym_ids, "Reads")?, write: pick(voc.writes, &sym_ids, "Writes")?, mv, to: pick(voc.to, &state_ids, "To")? });
    }
    Ok(PresetDef {
        id,
        title: txt!(e, Title),
        tape: e.try_cloned::<&Tape>().map(|t| t.cells).unwrap_or_default(),
        head_at: e.try_cloned::<&HeadAt>().map_or(0, |h| h.index),
        symbols,
        states,
        rules,
    })
}

fn read_part(c: EntityView, voc: &Voc, frame: [f32; 2], proto: PartKind) -> Result<Part, String> {
    let bad = |what: String| format!("{}: {what}", path(c));
    let place = c.try_cloned::<&Place>().ok_or_else(|| bad("part has no Place".into()))?;
    let verb = match c.try_cloned::<&Does>() {
        Some(d) => Some(Verb::parse(&d.verb).ok_or_else(|| bad(format!("Does {{\"{}\"}} is not a verb (step run reset load scrub home)", d.verb)))?),
        None => None,
    };
    if proto == PartKind::Button && verb.is_none() {
        return Err(bad("a Button needs Does".into()));
    }
    let bind = match c.try_cloned::<&Binds>().map(|b| b.path) {
        None => Bind::None,
        Some(p) if p == "Rate.hz" => Bind::RateHz,
        Some(p) if p == "Clock.t" => Bind::ClockT,
        Some(p) => return Err(bad(format!("Binds {{\"{p}\"}} is not bindable (Rate.hz, Clock.t)"))),
    };
    if proto == PartKind::Slider && bind == Bind::None {
        return Err(bad("a Slider needs Binds".into()));
    }
    let _ = voc;
    let range = c.try_cloned::<&Range>().unwrap_or(Range { min: 0.0, max: 1.0 });
    let key = c.try_cloned::<&Key>().and_then(|k| k.ch.chars().next()).map_or(0, |ch| ch as u32);
    Ok(Part {
        name: c.name(),
        kind: proto,
        place: resolve(place, frame),
        layer: c.try_cloned::<&Layer>().map_or(1, |l| l.n),
        label: txt!(c, Label),
        label_alt: txt!(c, LabelAlt),
        verb,
        key,
        loads: c.try_cloned::<&Loads>().map(|l| l.id).unwrap_or_default(),
        bind,
        range: [range.min, range.max],
        cells: c.try_cloned::<&Cells>().unwrap_or(Cells { w: 2.0, gap: 0.2, n: 15 }),
        rows: c.try_cloned::<&Rows>().unwrap_or(Rows { h: 1.1, max: 8 }),
    })
}

/// Read the exhibit declared under `scope` (the one entity that is a `TapeMachine` or `Timeline`). Fail closed: any problem is an error
/// naming the entity path, and the caller removes the scope.
pub fn read(w: &World, scope: EntityView) -> Result<ExDef, String> {
    let voc = Voc::lookup(w)?;
    let mut roots = Vec::new();
    for c in children(scope) {
        let fam = if is_a(c, voc.tape_machine) {
            Fam::Tape
        } else if is_a(c, voc.timeline) {
            Fam::Timeline
        } else if is_a(c, voc.rewrite_machine) {
            Fam::Rewrite
        } else if is_a(c, voc.graph_machine) {
            Fam::Graph
        } else if is_a(c, voc.grid_machine) {
            Fam::Grid
        } else {
            continue;
        };
        roots.push((fam, c));
    }
    let (fam, root) = match roots.as_slice() {
        [one] => *one,
        [] => return Err(format!("{}: the script declares no exhibit (an entity `: TapeMachine` or `: Timeline`)", path(scope))),
        [_, second, ..] => return Err(format!("{}: a second exhibit in one script", path(second.1))),
    };
    let bad = |what: &str| format!("{}: {what}", path(root));
    let frame = root.try_cloned::<&Extent>().ok_or_else(|| bad("no Extent"))?;
    if !(frame.w > 0.0 && frame.h > 0.0 && frame.w.is_finite() && frame.h.is_finite()) {
        return Err(bad("Extent must be positive"));
    }
    let frame = [frame.w, frame.h];
    let mut parts = Vec::new();
    let mut presets = Vec::new();
    for c in children(root) {
        if let Some(&(k, _)) = voc.parts.iter().find(|&&(_, p)| is_a(c, p)) {
            parts.push(read_part(c, &voc, frame, k)?);
        }
    }
    // Entity ids are not declaration order once a scope has been rebuilt (ids are recycled), so the part order, which is the Tab order,
    // is canonical: by layer, then reading order (top to bottom, left to right), then name.
    parts.sort_by(|a, b| a.layer.cmp(&b.layer).then(a.place[1].total_cmp(&b.place[1])).then(a.place[0].total_cmp(&b.place[0])).then(a.name.cmp(&b.name)));
    // presets are siblings of the exhibit
    if fam == Fam::Tape {
        for c in children(scope) {
            if is_a(c, voc.preset) {
                presets.push(read_preset(w, &voc, c)?);
            }
        }
    }
    let (data, preset_ids) = match fam {
        Fam::Rewrite => {
            let v = super::kind_rewrite::read(w, &voc, scope)?;
            let ids: Vec<String> = v.iter().map(|p| p.id.clone()).collect();
            (Data::Rewrite(v), ids)
        }
        Fam::Graph => {
            let v = super::kind_graph::read(w, &voc, scope, frame)?;
            let ids: Vec<String> = v.iter().map(|p| p.id.clone()).collect();
            (Data::Graph(v), ids)
        }
        Fam::Grid => {
            let v = super::kind_grid::read(w, &voc, scope)?;
            let ids: Vec<String> = v.iter().map(|p| p.id.clone()).collect();
            (Data::Grid(v), ids)
        }
        _ => (Data::None, presets.iter().map(|p| p.id.clone()).collect()),
    };
    let runs = root.target(voc.runs, 0).map(|t| t.name()).unwrap_or_default();
    match fam {
        Fam::Tape => {
            if presets.is_empty() {
                return Err(bad("a TapeMachine needs at least one Preset"));
            }
            for p in &parts {
                if p.verb == Some(Verb::Load) && !presets.iter().any(|x| x.id == p.loads) {
                    return Err(format!("{}: Loads {{\"{}\"}} names no preset", p.name, p.loads));
                }
                if p.kind == PartKind::Slider && p.bind != Bind::RateHz {
                    return Err(format!("{}: a TapeMachine slider must bind Rate.hz", p.name));
                }
            }
            if !runs.is_empty() && !presets.iter().any(|x| x.id == runs) {
                return Err(bad(&format!("(Runs, {runs}) names no preset")));
            }
        }
        Fam::Rewrite | Fam::Graph | Fam::Grid => {
            if preset_ids.is_empty() {
                return Err(bad("the exhibit needs at least one Preset"));
            }
            for p in &parts {
                if p.verb == Some(Verb::Load) && !preset_ids.contains(&p.loads) {
                    return Err(format!("{}: Loads {{\"{}\"}} names no preset", p.name, p.loads));
                }
                if p.kind == PartKind::Slider && p.bind != Bind::RateHz {
                    return Err(format!("{}: a slider of this family must bind Rate.hz", p.name));
                }
            }
            if !runs.is_empty() && !preset_ids.contains(&runs) {
                return Err(bad(&format!("(Runs, {runs}) names no preset")));
            }
        }
        Fam::Timeline => {
            for p in &parts {
                if !matches!(p.verb, Some(Verb::Run | Verb::Home | Verb::Scrub)) {
                    return Err(format!("{}: a Timeline control must be run, home or scrub", p.name));
                }
            }
        }
    }
    let rate = root.try_cloned::<&Rate>().map_or(4.0, |r| r.hz);
    Ok(ExDef {
        fam,
        root: *root.id(),
        name: root.name(),
        title: txt!(root, Title),
        claim: txt!(root, Claim),
        describe: txt!(root, Describe),
        alt: txt!(root, Alt),
        caption: txt!(root, Caption),
        frame,
        parts,
        rate,
        fuel: root.try_cloned::<&Fuel>().map_or(5000, |f| f.n),
        omega: root.try_cloned::<&Spring>().map_or(14.0, |s| s.omega),
        runs,
        presets,
        data,
        preset_ids,
        clip: root.try_cloned::<&Clip>(),
    })
}
