//! The film module: a narrated film is a Flecs script (`film.flecs`, scenes made of templates from `world/scene/film/`), read into a plain
//! definition and played by a pure function: the state of the stage at film time `t` depends on the definition, the voice alignment and `t`
//! only (docs/NARRATED.md, "Built contract"). Nothing integrates `dt`, so seek equals play by construction.
//!
//! The host (src/lib/film) owns the clock (it slaves it to the audio element when there is one), gates (holds for the viewer), the exhibit
//! mounts and the captions; this module owns layout (where every line and word falls in film time) and the stage draw list.
pub mod layout;
pub mod model;
pub mod pack;
pub mod timeline;

use crate::museum::draw::DrawList;
use crate::reading;
use flecs_ecs::prelude::*;
use model::*;
use std::cell::RefCell;
use timeline::*;

/// The library in install order: the vocabulary, the prefab family, then one file per template (world/scene/film/lib/templates/).
const LIB: [(&str, &str); 10] = [
    ("vocab", include_str!("../../scene/film/vocab.flecs")),
    ("prefabs", include_str!("../../scene/film/lib/prefabs.flecs")),
    ("coldopen", include_str!("../../scene/film/lib/templates/coldopen.flecs")),
    ("misconceptiontest", include_str!("../../scene/film/lib/templates/misconceptiontest.flecs")),
    ("demopause", include_str!("../../scene/film/lib/templates/demopause.flecs")),
    ("reveal", include_str!("../../scene/film/lib/templates/reveal.flecs")),
    ("callback", include_str!("../../scene/film/lib/templates/callback.flecs")),
    ("outro", include_str!("../../scene/film/lib/templates/outro.flecs")),
    ("equivalence", include_str!("../../scene/film/lib/templates/equivalence.flecs")),
    ("edgecases", include_str!("../../scene/film/lib/templates/edgecases.flecs")),
];

#[derive(Default)]
struct Reg {
    ready: bool,
    setup_error: Option<String>,
    def: Option<FilmDef>,
    tl: Option<Timeline>,
    align: AlignMap,
    scope: u64,
    draw: DrawList,
    meta: Vec<f32>,
    out: Vec<u8>,
    buf: Vec<u8>,
}

thread_local! {
    static REG: RefCell<Reg> = RefCell::new(Reg::default());
    /// Dev: library sources read from disk by the page, used instead of the baked copies.
    static OVERRIDE: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
}

/// Dev: use `src` for the library script `name` (one of `LIB`) in every later install.
pub fn override_library(name: &str, src: &str) {
    OVERRIDE.with(|o| {
        let mut o = o.borrow_mut();
        o.retain(|(n, _)| n != name);
        o.push((name.to_string(), src.to_string()));
    });
}

/// `film_library`: 0 ok, 1 no such script.
pub fn override_library_at(i: usize, src: &str) -> bool {
    match LIB.get(i) {
        Some((n, _)) => {
            override_library(n, src);
            false
        }
        None => true,
    }
}

pub fn library_name(i: usize) -> u32 {
    match LIB.get(i) {
        Some((n, _)) => {
            out_text(n.to_string());
            n.len() as u32
        }
        None => 0,
    }
}

fn script_error(e: EntityView) -> Option<String> {
    e.get::<&flecs::Script>(|s| {
        // SAFETY: `error` is null or a NUL-terminated string owned by the EcsScript component, alive for this call.
        (!s.error.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(s.error) }.to_string_lossy().into_owned())
    })
}

/// Register the components and run the library in `world` (the museum must already be installed there).
fn install(world: &World) -> Result<(), String> {
    model::register(world);
    for (name, baked) in LIB {
        let src = OVERRIDE.with(|o| o.borrow().iter().find(|(n, _)| n == name).map(|(_, s)| s.clone())).unwrap_or_else(|| baked.to_string());
        let s = world.script_named(&format!("film::{name}")).build_from_code(&src);
        if let Some(e) = script_error(*s) {
            return Err(format!("film library {name}.flecs: {e}"));
        }
    }
    Voc::lookup(world).map(|_| ())
}

/// Called by `reading::setup` after the museum.
pub fn setup(world: &World) {
    let r = install(world);
    REG.with(|g| {
        let mut g = g.borrow_mut();
        *g = Reg::default();
        match r {
            Ok(()) => g.ready = true,
            Err(e) => g.setup_error = Some(e),
        }
    });
}

fn out_err(e: &str) {
    REG.with(|g| g.borrow_mut().out = e.as_bytes().to_vec());
}

pub fn fail(e: &str) -> u32 {
    out_err(e);
    1
}

fn out_text(t: String) {
    REG.with(|g| g.borrow_mut().out = t.into_bytes());
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

pub fn staged(len: u32) -> Result<String, String> {
    REG.with(|g| {
        let g = g.borrow();
        let n = (len as usize).min(g.buf.len());
        String::from_utf8(g.buf[..n].to_vec()).map_err(|_| "the staged text is not UTF-8".to_string())
    })
}

pub fn out_ptr() -> *const u8 {
    REG.with(|g| g.borrow().out.as_ptr())
}
pub fn out_len() -> u32 {
    REG.with(|g| g.borrow().out.len() as u32)
}
pub fn draw_ptr() -> *const f32 {
    REG.with(|g| g.borrow().draw.items.as_ptr())
}
pub fn meta_ptr() -> *const f32 {
    REG.with(|g| g.borrow().meta.as_ptr())
}
pub fn str_ptr(i: u32) -> *const u8 {
    REG.with(|g| g.borrow().draw.strings.get(i as usize).map_or(std::ptr::null(), |s| s.as_ptr()))
}
pub fn str_len(i: u32) -> u32 {
    REG.with(|g| g.borrow().draw.strings.get(i as usize).map_or(0, |s| s.len() as u32))
}

/// Run a film script in `scope` of `w` and read it.
fn run(w: &World, src: &str, scope: EntityView) -> Result<FilmDef, String> {
    let prev = w.set_scope(scope);
    let s = w.script_named("script").build_from_code(src);
    w.set_scope(prev);
    if let Some(e) = script_error(*s) {
        return Err(e);
    }
    read(w, scope)
}

fn world() -> Result<World, String> {
    reading::with_world(|w| w.clone()).ok_or_else(|| "no world".to_string())
}

/// Dry run in a scratch world with the museum and the library only.
fn scratch(src: &str) -> Result<FilmDef, String> {
    let w = World::new();
    crate::museum::install_for_film(&w)?;
    install(&w)?;
    let scope = w.entity_named("scratch");
    run(&w, src, scope)
}

fn check_ready() -> Result<(), String> {
    REG.with(|g| {
        let g = g.borrow();
        if let Some(e) = &g.setup_error {
            return Err(e.clone());
        }
        if !g.ready {
            return Err("the film module is not installed".into());
        }
        Ok(())
    })
}

/// `film_load`: replaces a previous film. 0 ok, else the error text is in the out buffer.
pub fn load(src: &str) -> u32 {
    let r = (|| {
        check_ready()?;
        let w = world()?;
        let old = REG.with(|g| g.borrow().scope);
        if old != 0 {
            let e = w.entity_from_id(old);
            if e.is_alive() {
                e.destruct();
            }
        }
        REG.with(|g| g.borrow_mut().scope = 0);
        let scope = w.entity_named("filmscope");
        let def = match run(&w, src, scope) {
            Ok(d) => d,
            Err(e) => {
                scope.destruct();
                return Err(format!("film: {e}"));
            }
        };
        let align = REG.with(|g| g.borrow().align.clone());
        let tl = build(&def, &align).map_err(|e| format!("film: {e}"))?;
        REG.with(|g| {
            let mut g = g.borrow_mut();
            g.scope = *scope.id();
            g.def = Some(def);
            g.tl = Some(tl);
        });
        Ok::<(), String>(())
    })();
    match r {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// `film_reload`: dry run in a scratch world, then rebuild; the old film plays on after an error.
pub fn reload(src: &str) -> u32 {
    if let Err(e) = scratch(src).and_then(|d| build(&d, &REG.with(|g| g.borrow().align.clone())).map(|_| ())) {
        return fail(&format!("film: {e}"));
    }
    load(src)
}

/// `film_align`: staged JSON of the voice file's timings (narrate.py `align.json`). 0 ok.
pub fn set_align(json: &str) -> u32 {
    let r = (|| {
        let v: serde_json::Value = serde_json::from_str(json).map_err(|e| format!("align.json: {e}"))?;
        let lines = v.get("lines").and_then(|l| l.as_object()).ok_or("align.json has no `lines`")?;
        let mut align = AlignMap::new();
        for (k, l) in lines {
            let start = l.get("start").and_then(|x| x.as_f64()).ok_or_else(|| format!("align.json: {k} has no start"))? as f32;
            let dur = l.get("dur").and_then(|x| x.as_f64()).ok_or_else(|| format!("align.json: {k} has no dur"))? as f32;
            let words = l
                .get("words")
                .and_then(|x| x.as_array())
                .map(|a| a.iter().filter_map(|w| Some((w.get(1)?.as_f64()? as f32, w.get(2)?.as_f64()? as f32))).collect())
                .unwrap_or_default();
            align.insert(k.clone(), Aligned { start, dur, words });
        }
        REG.with(|g| {
            let mut g = g.borrow_mut();
            if let Some(def) = &g.def {
                let tl = build(def, &align)?;
                g.tl = Some(tl);
            }
            g.align = align;
            Ok::<(), String>(())
        })
    })();
    match r {
        Ok(()) => 0,
        Err(e) => fail(&e),
    }
}

/// Forget the voice file: the film plays on the reading-speed estimate again.
pub fn clear_align() {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        g.align.clear();
        if let Some(def) = &g.def {
            g.tl = build(def, &AlignMap::new()).ok();
        }
    });
}

fn info_json(def: &FilmDef, tl: &Timeline, items: Option<usize>) -> serde_json::Value {
    use serde_json::json;
    let scenes: Vec<_> = def
        .scenes
        .iter()
        .enumerate()
        .map(|(si, sc)| {
            let st = &tl.scenes[si];
            let says: Vec<_> = sc
                .says
                .iter()
                .enumerate()
                .map(|(qi, sy)| {
                    let t = &st.says[qi];
                    let tw = text_words(&sy.text);
                    let sw = spoken_words(&sy.spoken);
                    // the displayed words ride the spoken ones one to one; when the counts differ they are spread proportionally
                    let cw: Vec<[f32; 2]> = (0..tw.len())
                        .map(|i| {
                            if tw.len() == t.words.len() {
                                [t.words[i].0, t.words[i].1]
                            } else if t.words.is_empty() {
                                [t.start, t.start + t.dur]
                            } else {
                                let j = (i * t.words.len() / tw.len().max(1)).min(t.words.len() - 1);
                                [t.words[j].0, t.words[j].1]
                            }
                        })
                        .collect();
                    json!({
                        "key": say_key(def, si, qi), "name": sy.name, "text": sy.text, "spoken": sy.spoken, "status": sy.status, "placeholder": sy.placeholder,
                        "cite": sy.cite, "gap": authored_gap(def, si, qi), "start": t.start, "dur": t.dur, "aligned": t.aligned, "words": sw.len(), "cw": cw,
                    })
                })
                .collect();
            let gates: Vec<_> = gates(def, tl, si).iter().map(|(t, hold, until, n, mount)| json!({"t": t, "hold": hold, "until": until, "n": n, "mount": mount})).collect();
            let cmds: Vec<_> = commands(def, tl, si).iter().map(|(mount, t, verb, n)| json!({"mount": mount, "t": t, "verb": verb, "n": n})).collect();
            let mounts: Vec<_> = sc
                .props
                .iter()
                .enumerate()
                .filter_map(|(i, p)| p.mount.as_ref().map(|m| json!({"prop": i, "id": m.id, "dock": m.dock, "grabbable": m.grabbable, "resume": m.resume})))
                .collect();
            let placeholders: Vec<_> = sc.props.iter().filter(|p| p.placeholder).map(|p| p.path.clone()).collect();
            json!({
                "name": sc.name, "heading": sc.heading, "covers": sc.covers, "start": st.start, "end": st.end, "still": sc.still,
                "says": says, "gates": gates, "cmds": cmds, "mounts": mounts, "placeholders": placeholders, "beats": sc.beats.len(), "props": sc.props.len(),
            })
        })
        .collect();
    json!({"name": def.name, "title": def.title, "voice": {"id": def.voice.0, "rev": def.voice.1}, "total": tl.total, "scenes": scenes, "items": items})
}

/// Most draw items of any frame sampled over the film (the cap is 400).
fn max_items(def: &FilmDef, tl: &Timeline) -> usize {
    let mut dl = DrawList::default();
    let mut meta = Vec::new();
    let mut most = 0;
    for st in &tl.scenes {
        for k in 0..=12 {
            let t = st.start + (st.end - st.start) * k as f32 / 12.0;
            pack::pack(def, tl, t.min(tl.total), &mut dl, &mut meta);
            most = most.max(dl.count() + dl.dropped as usize);
        }
    }
    most
}

/// `film_info`: the layout of the loaded film (scenes, lines, word times, gates, commands, mounts) as JSON in the out buffer. 0 ok.
pub fn info() -> u32 {
    let r = REG.with(|g| {
        let g = g.borrow();
        match (&g.def, &g.tl) {
            (Some(d), Some(t)) => Ok(info_json(d, t, None).to_string()),
            _ => Err("no film is loaded".to_string()),
        }
    });
    match r {
        Ok(t) => {
            out_text(t);
            0
        }
        Err(e) => fail(&e),
    }
}

/// `film_inspect`: lint and describe a film script without loading it (`scripts/film/say.ts`). 0 ok, else the error text.
pub fn inspect(src: &str) -> u32 {
    let r = (|| {
        let def = scratch(src)?;
        let tl = build(&def, &AlignMap::new())?;
        let items = max_items(&def, &tl);
        Ok::<_, String>(info_json(&def, &tl, Some(items)).to_string())
    })();
    match r {
        Ok(t) => {
            out_text(t);
            0
        }
        Err(e) => fail(&e),
    }
}

/// `film_pack`: fill the stage draw list at film time `t`; the item count. The meta rows (`pack::META_*`) describe the scene and the mounts.
pub fn pack_at(t: f32) -> u32 {
    REG.with(|g| {
        let mut g = g.borrow_mut();
        let Reg { def, tl, draw, meta, .. } = &mut *g;
        match (def.as_ref(), tl.as_ref()) {
            (Some(d), Some(l)) => {
                pack::pack(d, l, if t.is_finite() { t } else { 0.0 }, draw, meta);
                draw.count() as u32
            }
            _ => {
                draw.clear();
                0
            }
        }
    })
}

/// The scene that film time `t` falls in and the seconds into it (for tests and the host's seek).
pub fn scene_at(t: f32) -> Option<(usize, f32)> {
    REG.with(|g| {
        let g = g.borrow();
        let tl = g.tl.as_ref()?;
        let f = tl.scenes.iter().rposition(|s| s.start <= t).unwrap_or(0);
        Some((f, t - tl.scenes[f].start))
    })
}

#[cfg(test)]
mod tests {}

