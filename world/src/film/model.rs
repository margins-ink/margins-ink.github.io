//! The film vocabulary: reflected components, the script vocabulary lookup and the reader that turns a film scope into a `FilmDef`.
//! Everything here is data. The runtime (`timeline.rs`) is a pure function of the definition and the time; nothing integrates `dt`.
//! Contract: docs/NARRATED.md sections 2, 13, 15 and "Built contract" at its end.
use crate::museum::model::{children, path, Order, Title};
use flecs_ecs::prelude::*;

macro_rules! text_component {
    ($($name:ident),*) => {$(
        #[derive(Component, Clone, Default, Debug)]
        #[flecs(meta)]
        pub struct $name { pub text: String }
    )*};
}
// `Title` and `Order` are the museum's (registered by the museum module); the film reuses them.
text_component!(Heading, Covers, Text, Spoken, Status, Cite, Words);

#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Voice {
    pub id: String,
    pub rev: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Dur {
    pub s: f32,
}
/// Scene poster time (s from the scene start): the frame for the scrubber tooltip and the shelf.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Still {
    pub t: f32,
}
/// Silence after the last line of a scene.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Tail {
    pub s: f32,
}
/// Silence before the first line of a scene.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Lead {
    pub s: f32,
}
/// Authored silence before a line (a breath, a play hold).
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Gap {
    pub s: f32,
}
/// Stage position (centre of a box, disc and spot; the start of a line and arrow; the baseline anchor of a label), stage units.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Pos {
    pub x: f32,
    pub y: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Size {
    pub w: f32,
    pub h: f32,
}
/// `box` (rounded rectangle), `disc`, `ring`, `line`, `arrow`, `hatch`, `label`.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Form {
    pub kind: String,
}
/// A palette tone name (the reader's THEME slots, never RGB): panel ink ink2 ink3 accent accent2 rule ground accentTint panelHi accentDim.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Ink {
    pub tone: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Alpha {
    pub a: f32,
}
/// Label size in stage units.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Em {
    pub n: f32,
}
/// `left`, `centre`, `right`.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Align {
    pub side: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Rad {
    pub r: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Stroke {
    pub w: f32,
}
/// The scene camera: stage point at the centre of the screen and zoom (1 shows 32 x 18 stage units).
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Cam {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
}
/// Initial typewriter reveal (0..1) and the highlighted line of a label.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Reveal {
    pub f: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Lit {
    pub line: f32,
}
/// Closed-form particles: `rate` per second while a Burst lasts, `life` s, `speed` and `gravity` in stage units per second, `spread` radians.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Emit {
    pub life: f32,
    pub speed: f32,
    pub spread: f32,
    pub gravity: f32,
    pub seed: u32,
}
/// An exhibit shown in the scene: its id (`models/turing` or `turing`).
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Mount {
    pub id: String,
}
/// Screen rectangle of a mount, stage units.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Dock {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
}
/// The layout slot a prop belongs to (`title`, `hero`, `code`, `output`, `note`): a stage region (layout.rs `SLOTS`); the lint fails a text or plate
/// that leaves its slot. A prop without a slot is only checked against the stage and the other items.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Slot {
    pub name: String,
}
/// A character range `[from, to)` of the label a prop `Marks`: the prop (a halo, ring or line) is placed on the laid-out glyph rect of that range.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Chars {
    pub from: u32,
    pub to: u32,
}
/// What resume does with the viewer's changes: `snap` (default), `continue`, `rewind`.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Resume {
    pub mode: String,
}
// ---- beats ----
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct At {
    pub s: f32,
}
/// A word anchor: word `n` of the Say the beat is pinned to (negative: the end of the line), shifted by `lead` seconds.
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Word {
    pub n: i32,
    pub lead: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Delay {
    pub s: f32,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Tween {
    pub path: String,
    pub to: f32,
    pub dur: f32,
    pub ease: String,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Fade {
    pub dur: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Type {
    pub dur: f32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Burst {
    pub n: u32,
}
#[derive(Component, Clone, Copy, Default, Debug)]
#[flecs(meta)]
pub struct Ring {
    pub dur: f32,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Do {
    pub verb: String,
    pub n: u32,
}
/// The film clock holds at this beat until the viewer acts: `resume` (Space), `steps` (n presses on the mount), `idle` (n seconds after the
/// first touch). `hold` seconds of the timeline belong to the hold (silence in the voice file); opening the gate jumps to its end.
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Await {
    pub until: String,
    pub n: u32,
    pub hold: f32,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Fly {
    pub x: f32,
    pub y: f32,
    pub zoom: f32,
    pub dur: f32,
    pub ease: String,
}
#[derive(Component, Clone, Default, Debug)]
#[flecs(meta)]
pub struct Sound {
    pub name: String,
    pub vel: f32,
    pub pan: f32,
}

/// Register every component (names are the Rust names: a script entity must never share one).
pub fn register(w: &World) {
    w.component_named::<Heading>("Heading");
    w.component_named::<Covers>("Covers");
    w.component_named::<Text>("Text");
    w.component_named::<Spoken>("Spoken");
    w.component_named::<Status>("Status");
    w.component_named::<Cite>("Cite");
    w.component_named::<Words>("Words");
    w.component_named::<Voice>("Voice");
    w.component_named::<Dur>("Dur");
    w.component_named::<Still>("Still");
    w.component_named::<Tail>("Tail");
    w.component_named::<Lead>("Lead");
    w.component_named::<Gap>("Gap");
    w.component_named::<Pos>("Pos");
    w.component_named::<Size>("Size");
    w.component_named::<Form>("Form");
    w.component_named::<Ink>("Ink");
    w.component_named::<Alpha>("Alpha");
    w.component_named::<Em>("Em");
    w.component_named::<Align>("Align");
    w.component_named::<Rad>("Rad");
    w.component_named::<Stroke>("Stroke");
    w.component_named::<Cam>("Cam");
    w.component_named::<Reveal>("Reveal");
    w.component_named::<Lit>("Lit");
    w.component_named::<Emit>("Emit");
    w.component_named::<Mount>("Mount");
    w.component_named::<Dock>("Dock");
    w.component_named::<Resume>("Resume");
    w.component_named::<Slot>("Slot");
    w.component_named::<Chars>("Chars");
    w.component_named::<At>("At");
    w.component_named::<Word>("Word");
    w.component_named::<Delay>("Delay");
    w.component_named::<Tween>("Tween");
    w.component_named::<Fade>("Fade");
    w.component_named::<Type>("Type");
    w.component_named::<Burst>("Burst");
    w.component_named::<Ring>("Ring");
    w.component_named::<Do>("Do");
    w.component_named::<Await>("Await");
    w.component_named::<Fly>("Fly");
    w.component_named::<Sound>("Sound");
}

/// The script vocabulary entities (declared by world/scene/film/vocab.flecs), looked up once per load.
pub struct Voc {
    pub film: Entity,
    pub scene: Entity,
    pub show: Entity,
    pub hide: Entity,
    pub placeholder: Entity,
    pub grabbable: Entity,
    pub mono: Entity,
    pub pin: Entity,
    pub on: Entity,
    pub after: Entity,
    pub marks: Entity,
    pub overlay: Entity,
    pub transition: Entity,
}

impl Voc {
    pub fn lookup(w: &World) -> Result<Voc, String> {
        let get = |n: &str| w.try_lookup(n).map(|e| e.id()).ok_or_else(|| format!("film vocabulary entity `{n}` is missing (world/scene/film/vocab.flecs did not run)"));
        Ok(Voc {
            film: get("Film")?,
            scene: get("Scene")?,
            show: get("Show")?,
            hide: get("Hide")?,
            placeholder: get("Placeholder")?,
            grabbable: get("Grabbable")?,
            mono: get("Mono")?,
            pin: get("Pin")?,
            on: get("On")?,
            after: get("After")?,
            marks: get("Marks")?,
            overlay: get("Overlay")?,
            transition: get("Transition")?,
        })
    }
}

// ---- definition ----

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FormKind {
    Box,
    Disc,
    Ring,
    Line,
    Arrow,
    Hatch,
    Label,
}

#[derive(Clone, Debug)]
pub struct PropDef {
    pub name: String,
    pub path: String,
    pub form: FormKind,
    pub pos: [f32; 2],
    pub size: [f32; 2],
    pub tone: u32,
    pub alpha: f32,
    pub em: f32,
    pub align: u32,
    pub mono: bool,
    pub rad: f32,
    pub stroke: f32,
    pub layer: u32,
    pub text: String,
    pub reveal: f32,
    pub lit: f32,
    pub emit: Option<Emit>,
    pub mount: Option<MountDef>,
    pub placeholder: bool,
    /// layout slot (layout.rs `SLOTS` index)
    pub slot: Option<usize>,
    /// declared to draw over a mount, on its own plate (`Overlay` tag)
    pub overlay: bool,
    /// (label prop index, first char, last char + 1): this prop sits on that glyph range (relation `(Marks, label)` with `Chars`)
    pub marks: Option<(usize, u32, u32)>,
}

#[derive(Clone, Debug)]
pub struct MountDef {
    pub id: String,
    pub dock: [f32; 4],
    pub grabbable: bool,
    pub resume: String,
}

#[derive(Clone, Debug)]
pub struct SayDef {
    pub name: String,
    pub text: String,
    pub spoken: String,
    pub status: String,
    pub placeholder: bool,
    pub gap: Option<f32>,
    pub cite: String,
}

#[derive(Clone, Debug)]
pub enum Action {
    /// A numeric path moves to `to` over `dur`: `Alpha.a Pos.x Pos.y Size.w Size.h Em.n Rad.r Stroke.w Reveal.f Lit.line Cam.x Cam.y Cam.zoom`.
    Tween { path: String, to: f32, dur: f32, ease: Ease },
    Burst { n: u32 },
    Ring { dur: f32 },
    Do { verb: String, n: u32 },
    Await { until: String, n: u32, hold: f32 },
    Sound { name: String, vel: f32, pan: f32 },
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Ease {
    Linear,
    In,
    Out,
    InOut,
}

impl Ease {
    pub fn parse(s: &str) -> Option<Ease> {
        Some(match s {
            "" | "linear" => Ease::Linear,
            "in" => Ease::In,
            "out" => Ease::Out,
            "inout" => Ease::InOut,
            _ => return None,
        })
    }
    pub fn at(self, u: f32) -> f32 {
        let u = u.clamp(0.0, 1.0);
        match self {
            Ease::Linear => u,
            Ease::In => u * u * u,
            Ease::Out => 1.0 - (1.0 - u).powi(3),
            Ease::InOut => u * u * (3.0 - 2.0 * u),
        }
    }
}

#[derive(Clone, Debug)]
pub struct BeatDef {
    pub name: String,
    pub path: String,
    pub order: u32,
    /// id (declaration) order, the tie-break after `order`
    pub seq: usize,
    pub at: Option<f32>,
    /// (say index, word, lead)
    pub pin: Option<(usize, i32, f32)>,
    /// (beat index, delay)
    pub after: Option<(usize, f32)>,
    pub target: Option<usize>,
    pub action: Action,
}

#[derive(Clone, Debug)]
pub struct SceneDef {
    pub name: String,
    pub heading: String,
    pub covers: String,
    pub still: f32,
    pub tail: f32,
    pub lead: f32,
    pub dur: Option<f32>,
    /// seconds of fade from the ground at the scene start (a `Transition` child's Dur)
    pub fade_in: f32,
    pub cam: [f32; 3],
    pub props: Vec<PropDef>,
    pub says: Vec<SayDef>,
    pub beats: Vec<BeatDef>,
}

#[derive(Clone, Debug)]
pub struct FilmDef {
    pub name: String,
    pub title: String,
    pub voice: (String, String),
    pub scenes: Vec<SceneDef>,
}

pub const TONES: [&str; 11] = ["panel", "ink", "ink2", "ink3", "accent", "accent2", "rule", "ground", "accentTint", "panelHi", "accentDim"];

pub fn tone_of(s: &str) -> Option<u32> {
    if s.is_empty() {
        return Some(1);
    }
    TONES.iter().position(|t| *t == s).map(|i| i as u32)
}

/// Numeric paths a Tween may move: validated at load (fail closed with the beat's path).
pub const PATHS: [&str; 14] =
    ["Alpha.a", "Pos.x", "Pos.y", "Size.w", "Size.h", "Em.n", "Rad.r", "Stroke.w", "Reveal.f", "Lit.line", "Cam.x", "Cam.y", "Cam.zoom", "Time.s"];

macro_rules! txt {
    ($e:expr, $t:ident) => {
        $e.try_cloned::<&$t>().map(|t| t.text).unwrap_or_default()
    };
}

/// What a caption shows: emphasis stars and `[pause]` marks are for the voice only.
pub fn display_text(raw: &str) -> String {
    raw.replace("[pause]", " ").replace('*', "").split_whitespace().collect::<Vec<_>>().join(" ")
}

fn at(what: &str, c: EntityView) -> String {
    format!("{}: {what}", path(c))
}

fn read_prop(c: EntityView, voc: &Voc) -> Result<Option<PropDef>, String> {
    let form_c = c.try_cloned::<&Form>();
    let emit = c.try_cloned::<&Emit>();
    let mount_c = c.try_cloned::<&Mount>();
    let words = c.try_cloned::<&Words>();
    if form_c.is_none() && emit.is_none() && mount_c.is_none() && words.is_none() {
        return Ok(None);
    }
    let mut form = match form_c.as_ref().map(|f| f.kind.as_str()) {
        None | Some("") | Some("box") => FormKind::Box,
        Some("disc") => FormKind::Disc,
        Some("ring") => FormKind::Ring,
        Some("line") => FormKind::Line,
        Some("arrow") => FormKind::Arrow,
        Some("hatch") => FormKind::Hatch,
        Some("label") => FormKind::Label,
        Some(k) => return Err(at(&format!("Form {{\"{k}\"}} is not a form (box disc ring line arrow hatch label)"), c)),
    };
    if words.is_some() {
        form = FormKind::Label;
    }
    let ink = c.try_cloned::<&Ink>().map(|i| i.tone).unwrap_or_default();
    let tone = tone_of(&ink).ok_or_else(|| at(&format!("Ink {{\"{ink}\"}} is not a palette tone"), c))?;
    let pos = c.try_cloned::<&Pos>().unwrap_or_default();
    let size = c.try_cloned::<&Size>().unwrap_or(Size { w: 1.0, h: 1.0 });
    let align = match c.try_cloned::<&Align>().map(|a| a.side).as_deref() {
        None | Some("") | Some("left") => 0,
        Some("centre") | Some("center") => 1,
        Some("right") => 2,
        Some(s) => return Err(at(&format!("Align {{\"{s}\"}} is not left centre right"), c)),
    };
    let mount = match mount_c {
        Some(m) => {
            let d = c.try_cloned::<&Dock>().ok_or_else(|| at("a Mount needs a Dock", c))?;
            let mode = c.try_cloned::<&Resume>().map(|r| r.mode).filter(|m| !m.is_empty()).unwrap_or_else(|| "snap".into());
            if !["snap", "continue", "rewind"].contains(&mode.as_str()) {
                return Err(at(&format!("Resume {{\"{mode}\"}} is not snap continue rewind"), c));
            }
            Some(MountDef { id: m.id, dock: [d.x, d.y, d.w, d.h], grabbable: c.has(voc.grabbable), resume: mode })
        }
        None => None,
    };
    Ok(Some(PropDef {
        name: c.name(),
        path: path(c),
        form,
        pos: [pos.x, pos.y],
        size: [size.w, size.h],
        tone,
        alpha: c.try_cloned::<&Alpha>().map_or(1.0, |a| a.a),
        em: c.try_cloned::<&Em>().map_or(1.0, |e| e.n),
        align,
        mono: c.has(voc.mono),
        rad: c.try_cloned::<&Rad>().map_or(0.0, |r| r.r),
        stroke: c.try_cloned::<&Stroke>().map_or(0.08, |s| s.w),
        layer: c.try_cloned::<&crate::museum::model::Layer>().map_or(1, |l| l.n),
        text: words.map(|w| w.text).unwrap_or_default(),
        reveal: c.try_cloned::<&Reveal>().map_or(1.0, |r| r.f),
        lit: c.try_cloned::<&Lit>().map_or(-1.0, |l| l.line),
        emit,
        mount,
        placeholder: c.has(voc.placeholder),
        slot: match c.try_cloned::<&Slot>().map(|s| s.name) {
            None => None,
            Some(n) => Some(super::layout::slot_index(&n).ok_or_else(|| at(&format!("Slot {{\"{n}\"}} is not one of {}", super::layout::slot_names()), c))?),
        },
        overlay: c.has(voc.overlay),
        marks: None,
    }))
}

fn read_scene(w: &World, c: EntityView, voc: &Voc) -> Result<SceneDef, String> {
    let kids = children(c);
    let mut props: Vec<PropDef> = Vec::new();
    let mut prop_ids: Vec<Entity> = Vec::new();
    let mut says: Vec<SayDef> = Vec::new();
    let mut say_ids: Vec<Entity> = Vec::new();
    let mut empty_says: Vec<Entity> = Vec::new();
    let mut fade_in = 0.0f32;
    let mut cam = [16.0, 9.0, 1.0];
    for &k in &kids {
        if let Some(cm) = k.try_cloned::<&Cam>() {
            cam = [cm.x, cm.y, if cm.zoom > 0.0 { cm.zoom } else { 1.0 }];
        }
        if k.has((flecs::IsA::ID, voc.transition)) {
            fade_in = k.try_cloned::<&Dur>().map_or(0.5, |d| d.s);
            continue;
        }
        if k.try_cloned::<&Text>().is_some() {
            let raw = txt!(k, Text);
            if raw.trim().is_empty() {
                empty_says.push(k.id()); // an unused line slot of a template
                continue;
            }
            let spoken = txt!(k, Spoken);
            let status = k.try_cloned::<&Status>().map(|s| s.text).filter(|s| !s.is_empty()).unwrap_or_else(|| "draft".into());
            if !["draft", "approved", "voiced"].contains(&status.as_str()) {
                return Err(at(&format!("Status {{\"{status}\"}} is not draft approved voiced"), k));
            }
            say_ids.push(k.id());
            says.push(SayDef {
                name: k.name(),
                spoken: if spoken.is_empty() { raw.clone() } else { spoken },
                text: display_text(&raw),
                status,
                placeholder: k.has(voc.placeholder),
                gap: k.try_cloned::<&Gap>().map(|g| g.s),
                cite: txt!(k, Cite),
            });
        } else if let Some(p) = read_prop(k, voc)? {
            prop_ids.push(k.id());
            props.push(p);
        }
    }
    // `(Marks, label)` + `Chars`: resolved once every prop of the scene is known
    for (i, &id) in prop_ids.iter().enumerate() {
        let k = w.entity_from_id(id);
        if let Some(t) = k.target(voc.marks, 0) {
            let li = prop_ids.iter().position(|&q| q == t.id()).ok_or_else(|| at(&format!("(Marks, {}) is not a prop of this scene", path(t)), k))?;
            if props[li].form != FormKind::Label {
                return Err(at(&format!("(Marks, {}): the target is not a label (a prop with Words)", path(t)), k));
            }
            let ch = k.try_cloned::<&Chars>().ok_or_else(|| at("(Marks, label) needs Chars {from, to}", k))?;
            let n = props[li].text.chars().count() as u32;
            if ch.from >= ch.to || ch.to > n {
                return Err(at(&format!("Chars {{{}, {}}} is not a range inside the {n} characters of {}", ch.from, ch.to, path(t)), k));
            }
            props[i].marks = Some((li, ch.from, ch.to));
        }
    }
    // beats: every child with a time source (At, a Pin or an After) and an action
    let mut beat_kids: Vec<EntityView> = Vec::new();
    for &k in &kids {
        let has_action = k.try_cloned::<&Tween>().is_some()
            || k.try_cloned::<&Fade>().is_some()
            || k.try_cloned::<&Type>().is_some()
            || k.try_cloned::<&Burst>().is_some()
            || k.try_cloned::<&Ring>().is_some()
            || k.try_cloned::<&Do>().is_some()
            || k.try_cloned::<&Await>().is_some()
            || k.try_cloned::<&Fly>().is_some()
            || k.try_cloned::<&Sound>().is_some();
        if has_action {
            beat_kids.push(k);
        }
    }
    // a beat pinned to an unused line slot (or after a beat that is dropped for that) does not exist
    let mut dropped: Vec<Entity> = Vec::new();
    loop {
        let before = dropped.len();
        for &b in &beat_kids {
            if dropped.contains(&b.id()) {
                continue;
            }
            let pin_empty = b.target(voc.pin, 0).is_some_and(|t| empty_says.contains(&t.id()));
            let after_dropped = b.target(voc.after, 0).is_some_and(|t| dropped.contains(&t.id()));
            if pin_empty || after_dropped {
                dropped.push(b.id());
            }
        }
        if dropped.len() == before {
            break;
        }
    }
    beat_kids.retain(|b| !dropped.contains(&b.id()));
    let beat_ids: Vec<Entity> = beat_kids.iter().map(|b| b.id()).collect();
    let mut beats = Vec::new();
    for (seq, &b) in beat_kids.iter().enumerate() {
        let target = match b.target(voc.on, 0) {
            Some(t) => Some(prop_ids.iter().position(|&p| p == t.id()).ok_or_else(|| at(&format!("(On, {}) is not a prop of this scene", path(t)), b))?),
            None => None,
        };
        let pin = match b.target(voc.pin, 0) {
            Some(t) => {
                let si = say_ids.iter().position(|&p| p == t.id()).ok_or_else(|| at(&format!("(Pin, {}) is not a Say line of this scene", path(t)), b))?;
                let wd = b.try_cloned::<&Word>().unwrap_or_default();
                Some((si, wd.n, wd.lead))
            }
            None => None,
        };
        let after = match b.target(voc.after, 0) {
            Some(t) => {
                let bi = beat_ids.iter().position(|&p| p == t.id()).ok_or_else(|| at(&format!("(After, {}) is not a beat of this scene", path(t)), b))?;
                Some((bi, b.try_cloned::<&Delay>().map_or(0.0, |d| d.s)))
            }
            None => None,
        };
        let at_s = b.try_cloned::<&At>().map(|a| a.s);
        if at_s.is_none() && pin.is_none() && after.is_none() {
            return Err(at("a beat needs a time: At, (Pin, say) with Word, or (After, beat)", b));
        }
        let ease_of = |s: &str| Ease::parse(s).ok_or_else(|| at(&format!("ease \"{s}\" is not linear in out inout"), b));
        let action = if let Some(t) = b.try_cloned::<&Tween>() {
            if !PATHS.contains(&t.path.as_str()) {
                return Err(at(&format!("Tween path \"{}\" is not tweenable ({})", t.path, PATHS.join(" ")), b));
            }
            if !t.path.starts_with("Cam.") && !t.path.starts_with("Time.") && target.is_none() {
                return Err(at("a Tween of a prop path needs (On, prop)", b));
            }
            Action::Tween { path: t.path.clone(), to: t.to, dur: t.dur.max(0.0), ease: ease_of(&t.ease)? }
        } else if let Some(f) = b.try_cloned::<&Fade>() {
            let to = if b.has(voc.hide) { 0.0 } else { 1.0 };
            if target.is_none() {
                return Err(at("Fade needs (On, prop)", b));
            }
            Action::Tween { path: "Alpha.a".into(), to, dur: f.dur.max(0.0), ease: Ease::InOut }
        } else if let Some(t) = b.try_cloned::<&Type>() {
            if target.is_none() {
                return Err(at("Type needs (On, label prop)", b));
            }
            Action::Tween { path: "Reveal.f".into(), to: 1.0, dur: t.dur.max(0.0), ease: Ease::Linear }
        } else if let Some(f) = b.try_cloned::<&Fly>() {
            // a flight is three tweens at one time; it is expanded below
            let _ = &f;
            Action::Tween { path: "Cam.x".into(), to: f.x, dur: f.dur.max(0.0), ease: ease_of(&f.ease)? }
        } else if let Some(bu) = b.try_cloned::<&Burst>() {
            match target.and_then(|t| props[t].emit) {
                Some(_) => Action::Burst { n: bu.n.clamp(1, 120) },
                None => return Err(at("Burst needs (On, emitter)", b)),
            }
        } else if let Some(r) = b.try_cloned::<&Ring>() {
            Action::Ring { dur: r.dur.max(0.05) }
        } else if let Some(d) = b.try_cloned::<&Do>() {
            let t = target.ok_or_else(|| at("Do needs (On, mount)", b))?;
            if props[t].mount.is_none() {
                return Err(at("Do targets a prop that is not a Mount", b));
            }
            if !["load", "step", "run", "reset", "toggle"].contains(&d.verb.as_str()) {
                return Err(at(&format!("Do verb \"{}\" is not load step run reset toggle", d.verb), b));
            }
            Action::Do { verb: d.verb.clone(), n: d.n }
        } else if let Some(g) = b.try_cloned::<&Await>() {
            if !["resume", "steps", "idle"].contains(&g.until.as_str()) {
                return Err(at(&format!("Await \"{}\" is not resume steps idle", g.until), b));
            }
            Action::Await { until: g.until.clone(), n: g.n, hold: g.hold.max(0.0) }
        } else if let Some(s) = b.try_cloned::<&Sound>() {
            Action::Sound { name: s.name.clone(), vel: s.vel, pan: s.pan }
        } else {
            unreachable!()
        };
        let order = b.try_cloned::<&Order>().map_or(0, |o| o.n);
        let bd = BeatDef { name: b.name(), path: path(b), order, seq, at: at_s, pin, after, target, action };
        // a Fly also moves y and zoom: two more tweens with the same time source, appended after the others
        beats.push(bd);
    }
    // expand flights (Cam.y and Cam.zoom tweens next to the Cam.x one)
    let mut extra: Vec<BeatDef> = Vec::new();
    for (i, &b) in beat_kids.iter().enumerate() {
        if let Some(f) = b.try_cloned::<&Fly>() {
            let ease = Ease::parse(&f.ease).unwrap_or(Ease::InOut);
            for (p, v) in [("Cam.y", f.y), ("Cam.zoom", f.zoom)] {
                let mut c2 = beats[i].clone();
                c2.name = format!("{}.{}", c2.name, p);
                c2.action = Action::Tween { path: p.into(), to: v, dur: f.dur.max(0.0), ease };
                c2.seq = beats.len() + extra.len();
                extra.push(c2);
            }
        }
    }
    beats.extend(extra);
    let tail = c.try_cloned::<&Tail>().map_or(0.8, |t| t.s);
    let lead = c.try_cloned::<&Lead>().map_or(0.7, |t| t.s);
    let dur = c.try_cloned::<&Dur>().map(|d| d.s).filter(|d| *d > 0.0);
    if says.is_empty() && dur.is_none() {
        return Err(at("a scene with no Say line needs Dur", c));
    }
    Ok(SceneDef {
        name: c.name(),
        heading: { let h = txt!(c, Heading); if h.is_empty() { c.name() } else { h } },
        covers: txt!(c, Covers),
        still: c.try_cloned::<&Still>().map_or(0.0, |s| s.t),
        tail,
        lead,
        dur,
        fade_in,
        cam,
        props,
        says,
        beats,
    })
}

/// Read the film declared under `scope`: the one entity that is a `Film`, and its `Scene` children in `Order`, then declaration order.
pub fn read(w: &World, scope: EntityView) -> Result<FilmDef, String> {
    let voc = Voc::lookup(w)?;
    let mut film = None;
    for c in children(scope) {
        if c.has((flecs::IsA::ID, voc.film)) {
            if film.is_some() {
                return Err(at("a film file declares one Film", c));
            }
            film = Some(c);
        }
    }
    let film = film.ok_or_else(|| "the script declares no film (an entity `: Film`)".to_string())?;
    let mut scenes = Vec::new();
    for c in children(film) {
        if c.has((flecs::IsA::ID, voc.scene)) {
            scenes.push(read_scene(w, c, &voc)?);
        }
    }
    if scenes.is_empty() {
        return Err(at("a Film needs at least one Scene", film));
    }
    let v = film.try_cloned::<&Voice>().unwrap_or_default();
    Ok(FilmDef { name: film.name(), title: txt!(film, Title), voice: (v.id, v.rev), scenes })
}
