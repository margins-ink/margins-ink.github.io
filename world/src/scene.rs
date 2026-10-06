//! Build the world: load the scene scripts, spawn floors and article entities.
use crate::components::*;
use crate::export;
use crate::Output;
use flecs_ecs::prelude::*;
use serde::Deserialize;

const SCRIPTS: &[(&str, &str)] = &[
    ("building", include_str!("../scene/00-building.flecs")),
    ("prefabs", include_str!("../scene/10-prefabs.flecs")),
    ("elevator", include_str!("../scene/11-elevator.flecs")),
    ("decor", include_str!("../scene/12-decor.flecs")),
    ("palettes", include_str!("../scene/20-palettes.flecs")),
    ("rooms", include_str!("../scene/30-rooms.flecs")),
];

#[derive(Deserialize)]
struct Item {
    slug: String,
    date: String,
    archived: bool,
    tex: [f32; 4],
}

#[derive(Deserialize)]
struct Input {
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

pub fn build(json: &[u8]) -> Result<(Output, World, Vec<u64>), String> {
    let input: Input = serde_json::from_slice(json).map_err(|e| format!("input json: {e}"))?;
    let world = World::new();
    register(&world);
    for (name, src) in SCRIPTS {
        if !world.run_code(name, src) {
            return Err(format!("scene script {name} failed"));
        }
    }

    // Articles: one entity per Thought, in input order.
    let articles: Vec<_> = input
        .items
        .iter()
        .enumerate()
        .map(|(i, t)| {
            world
                .entity_named(&format!("articles::{}", t.slug))
                .set(Article { index: i as u32 })
        })
        .collect();

    // Floors: one per year in first-seen order, then the Archive in the basement.
    let mut years: Vec<&str> = Vec::new();
    for t in input.items.iter().filter(|t| !t.archived) {
        let y = &t.date[..4];
        if !years.contains(&y) {
            years.push(y);
        }
    }
    struct Spec {
        info: FloorInfo,
        basement: bool,
        mags: Vec<usize>,
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
        let floor = world
            .entity_named(&format!("floor{k}"))
            .is_a(world.lookup(proto))
            .set(Floor { index: k as u32, basement: spec.basement });
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

    let cab = crate::elevator::spawn(&world, floors.len());
    let cabpack = export::pack_cab(&world, cab)?;
    let out = export::pack(&world, &input.signs, &input.map, &floors, &articles, specs.iter().map(|s| &s.info), &cabpack)?;
    let level_h = world.lookup("Building").try_cloned::<&Dims>().map_or(3.28, |d| d.level_h);
    crate::elevator::setup(&world, cab, cabpack.rows.clone(), floors.len(), level_h);
    let cl = floors.len() * 20;
    crate::elevator::cab_info(out.lvl[cl] as u32, out.lvl[cl + 1] as u32);
    let ids = articles.iter().map(|a| *a.id()).collect();
    Ok((out, world, ids))
}
