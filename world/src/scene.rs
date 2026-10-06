//! Build the world: load the scene scripts, spawn floors and article entities.
use crate::components::*;
use crate::export;
use crate::Output;
use flecs_ecs::prelude::*;
use serde::Deserialize;
use std::cell::RefCell;

const SCRIPTS: &[(&str, &str)] = &[
    ("building", include_str!("../scene/00-building.flecs")),
    ("prefabs", include_str!("../scene/10-prefabs.flecs")),
    ("elevator", include_str!("../scene/11-elevator.flecs")),
    ("decor", include_str!("../scene/12-decor.flecs")),
    ("palettes", include_str!("../scene/20-palettes.flecs")),
    ("rooms", include_str!("../scene/30-rooms.flecs")),
];

thread_local! {
    /// Current script sources in load order: the baked ones, replaced by `override_source` (dev) or `reload`.
    static SRC: RefCell<Vec<(String, String)>> =
        RefCell::new(SCRIPTS.iter().map(|(n, s)| (n.to_string(), s.to_string())).collect());
    /// The ids of the Rust-spawned instance entities; they keep their ids across a hot reload.
    static LIVE: RefCell<Option<Live>> = const { RefCell::new(None) };
}

#[derive(Deserialize)]
pub struct Item {
    slug: String,
    date: String,
    archived: bool,
    tex: [f32; 4],
}

#[derive(Deserialize)]
pub struct Input {
    items: Vec<Item>,
    /// Atlas rect of the title sign of floor k.
    signs: Vec<[f32; 4]>,
    /// Atlas rect of the world map.
    map: [f32; 4],
}

pub struct FloorInfo {
    pub label: String,
    pub title: String,
    pub sub: String,
}

/// Ids of everything Rust spawns from the scripts' templates. Floors and the cab are instances (`is_a` a prefab);
/// a hot reload keeps these entities (and everything the Rust systems store on them) and only re-instances them.
pub struct Live {
    pub floors: Vec<u64>,
    pub cab: u64,
    pub articles: Vec<u64>,
}

pub struct Built {
    pub out: Output,
    pub live: Live,
    pub cab_rows: Vec<f32>,
    pub level_h: f32,
}

struct Spec {
    info: FloorInfo,
    basement: bool,
    mags: Vec<usize>,
}

fn specs(input: &Input) -> Vec<Spec> {
    // Floors: one per year in first-seen order, then the Archive in the basement.
    let mut years: Vec<&str> = Vec::new();
    for t in input.items.iter().filter(|t| !t.archived) {
        let y = &t.date[..4];
        if !years.contains(&y) {
            years.push(y);
        }
    }
    let mut specs: Vec<Spec> = years
        .iter()
        .enumerate()
        .map(|(k, y)| Spec {
            info: FloorInfo {
                label: y.to_string(),
                title: if k == 0 { "Andrew Gazelka".into() } else { y.to_string() },
                sub: if k == 0 { format!("{y} \u{b7} latest") } else { String::new() },
            },
            basement: false,
            mags: (0..input.items.len())
                .filter(|&i| !input.items[i].archived && input.items[i].date.starts_with(y))
                .collect(),
        })
        .collect();
    let archived: Vec<usize> = (0..input.items.len()).filter(|&i| input.items[i].archived).collect();
    if !archived.is_empty() {
        specs.push(Spec {
            info: FloorInfo {
                label: "Archive".into(),
                title: "Archive".into(),
                sub: "Common knowledge now, or I think differently".into(),
            },
            basement: true,
            mags: archived,
        });
    }
    specs
}

fn script_error(e: EntityView) -> Option<String> {
    e.get::<&flecs::Script>(|s| {
        // SAFETY: `error` is null or a NUL-terminated string owned by the EcsScript component, alive for this call.
        (!s.error.is_null()).then(|| unsafe { std::ffi::CStr::from_ptr(s.error) }.to_string_lossy().into_owned())
    })
}

/// Load every script as a named script entity (`scene::<name>`), so `update_script` can re-run it in place later.
fn load_scripts(world: &World, srcs: &[(String, String)]) -> Result<(), String> {
    for (name, src) in srcs {
        let e = world.script_named(&format!("scene::{name}")).build_from_code(src);
        if let Some(err) = script_error(*e) {
            return Err(format!("scene script {name}: {err}"));
        }
    }
    Ok(())
}

/// `ecs_script_update`: the entities the script created are deleted, then the new source runs. Not transactional: an
/// evaluation error deletes them for good (flecs.c `ecs_script_update`), so `reload` dry-runs in a scratch world first.
fn update_script(world: &World, name: &str, src: &str) -> Result<(), String> {
    let e = world.lookup(&format!("scene::{name}"));
    let view = ScriptEntityView::new_from(world, e);
    if view.update(world, None::<Entity>, src) {
        Ok(())
    } else {
        Err(format!("scene script {name}: {}", script_error(*view).unwrap_or_else(|| "failed".into())))
    }
}

/// Spawn (or, after `detach`, re-spawn) the floors, the magazines on them and the cab, then pack the buffers.
fn instantiate(world: &World, input: &Input, prev: Option<&Live>) -> Result<Built, String> {
    let specs = specs(input);
    if let Some(p) = prev {
        if p.floors.len() != specs.len() || p.articles.len() != input.items.len() {
            return Err("the article list changed: reload the page".into());
        }
    }
    let articles: Vec<_> = match prev {
        Some(p) => p.articles.iter().map(|&id| world.entity_from_id(id)).collect(),
        // one entity per Thought, in input order
        None => input
            .items
            .iter()
            .enumerate()
            .map(|(i, t)| world.entity_named(&format!("articles::{}", t.slug)).set(Article { index: i as u32 }))
            .collect(),
    };

    let magazine = world.lookup("Magazine");
    let mag_half = magazine.try_cloned::<&Half>().ok_or("Magazine has no Half")?;
    let mag_lean = magazine.try_cloned::<&Lean>().ok_or("Magazine has no Lean")?;
    let mut floors = Vec::new();
    for (k, spec) in specs.iter().enumerate() {
        let proto = match (spec.basement, k) {
            (true, _) => "Basement",
            (false, 0) => "Lobby",
            (false, 1) => "Upper",
            _ => "Lower",
        };
        let floor = match prev {
            Some(p) => world.entity_from_id(p.floors[k]),
            None => world.entity_named(&format!("floor{k}")),
        };
        let floor = floor.is_a(world.lookup(proto)).set(Floor { index: k as u32, basement: spec.basement });
        floors.push(floor);

        let n = spec.mags.len();
        let a = mag_lean.angle as f64;
        for (m, &i) in spec.mags.iter().enumerate() {
            let x = if n == 1 {
                0.15
            } else if n > 3 {
                (m as f64 - (n as f64 - 1.0) / 2.0) * 0.62 - 0.2
            } else {
                -0.35 + m as f64 * 0.65
            };
            let hy = mag_half.y as f64;
            let t = input.items[i].tex;
            let mag = world
                .entity()
                .is_a(magazine)
                .child_of(floor)
                .set(Center { x: x as f32, y: (1.03 + hy * a.cos()) as f32, z: (0.34 - hy * a.sin()) as f32 })
                .set(Tex { x: t[0], y: t[1], w: t[2], h: t[3] });
            articles[i].add((Displayed::id(), mag));
        }
    }

    let cab = crate::elevator::spawn(world, floors.len(), prev.map(|p| p.cab));
    let cabpack = export::pack_cab(world, cab)?;
    let out = export::pack(world, &input.signs, &input.map, &floors, &articles, specs.iter().map(|s| &s.info), &cabpack)?;
    let level_h = world.lookup("Building").try_cloned::<&Dims>().map_or(3.28, |d| d.level_h);
    let live = Live {
        floors: floors.iter().map(|f| *f.id()).collect(),
        cab: *cab.id(),
        articles: articles.iter().map(|a| *a.id()).collect(),
    };
    Ok(Built { out, live, cab_rows: cabpack.rows, level_h })
}

fn parse(json: &[u8]) -> Result<Input, String> {
    serde_json::from_slice(json).map_err(|e| format!("input json: {e}"))
}

/// Dev: use `src` for script `name` in the next `build` (so the page starts from the files on disk, not the baked copy).
pub fn override_source(name: &str, src: &str) -> Result<(), String> {
    SRC.with(|s| match s.borrow_mut().iter_mut().find(|(n, _)| n == name) {
        Some(slot) => {
            slot.1 = src.to_string();
            Ok(())
        }
        None => Err(format!("no scene script named {name}")),
    })
}

pub fn build(json: &[u8]) -> Result<(Output, World, Vec<u64>), String> {
    let input = parse(json)?;
    let world = World::new();
    register(&world);
    let srcs = SRC.with(|s| s.borrow().clone());
    load_scripts(&world, &srcs)?;
    let built = instantiate(&world, &input, None)?;
    crate::elevator::setup(&world, world.entity_from_id(built.live.cab), built.cab_rows.clone(), built.live.floors.len(), built.level_h);
    let cl = built.live.floors.len() * 20;
    crate::elevator::cab_info(built.out.lvl[cl] as u32, built.out.lvl[cl + 1] as u32);
    let ids = built.live.articles.clone();
    LIVE.with(|l| *l.borrow_mut() = Some(built.live));
    Ok((built.out, world, ids))
}

/// Delete what the old templates produced (the children of every floor and of the cab, and the prefab links) so the
/// templates can be replaced. The floor and cab entities themselves, and the state on them, stay.
fn detach(world: &World, live: &Live) {
    for &id in live.floors.iter().chain([&live.cab]) {
        let e = world.entity_from_id(id);
        let mut kids = Vec::new();
        e.each_child(|c| kids.push(*c.id()));
        for k in kids {
            world.entity_from_id(k).destruct();
        }
        e.remove((flecs::IsA::ID, flecs::Wildcard::ID));
    }
}

/// Hot reload of script `name` (dev). Returns the new packed output; on error nothing has changed.
///
/// 1. Dry run: the whole scene with the candidate source in a scratch world (scripts, instances, pack). A parse or
///    evaluation error, or an exporter error (a floor without a lamp), is returned and the live world is untouched.
/// 2. Live: detach the instances, `ecs_script_update` the script and every script after it (they may use its prefabs),
///    re-instance the floors and cab on their old ids, re-pack. Singletons and the state on the cab and the books survive.
pub fn reload(world: &World, json: &[u8], name: &str, src: &str) -> Result<Output, String> {
    let input = parse(json)?;
    let mut cand = SRC.with(|s| s.borrow().clone());
    let idx = cand.iter().position(|(n, _)| n == name).ok_or_else(|| format!("no scene script named {name}"))?;
    cand[idx].1 = src.to_string();

    {
        let scratch = World::new();
        register(&scratch);
        load_scripts(&scratch, &cand)?;
        instantiate(&scratch, &input, None)?;
    }

    let live = LIVE.with(|l| l.borrow_mut().take()).ok_or("scene is not built")?;
    detach(world, &live);
    let built = cand[idx..]
        .iter()
        .try_for_each(|(n, s)| update_script(world, n, s))
        .and_then(|()| instantiate(world, &input, Some(&live)));
    let built = match built {
        Ok(b) => b,
        Err(e) => {
            // the dry run passed, so this is a bug: keep the ids so a later reload can try again
            LIVE.with(|l| *l.borrow_mut() = Some(live));
            return Err(format!("{e} (the live scene may be half updated: reload the page)"));
        }
    };
    SRC.with(|s| *s.borrow_mut() = cand);
    crate::elevator::reload(built.cab_rows.clone(), built.level_h);
    let cl = built.live.floors.len() * 20;
    crate::elevator::cab_info(built.out.lvl[cl] as u32, built.out.lvl[cl + 1] as u32);
    crate::book::relink(world, &built.live.articles, &built.out);
    LIVE.with(|l| *l.borrow_mut() = Some(built.live));
    Ok(built.out)
}
