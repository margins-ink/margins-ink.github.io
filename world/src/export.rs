//! Flatten the world into the packed buffers the renderer uploads.
use crate::components::*;
use crate::scene::FloorInfo;
use crate::Output;
use flecs_ecs::prelude::*;
use std::collections::HashMap;

type M3 = [[f32; 3]; 3];
const I3: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

fn lean(a: f64) -> M3 {
    let (s, c) = a.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c as f32, -s as f32], [0.0, s as f32, c as f32]]
}

fn flat(t: f64) -> M3 {
    let (s, c) = t.sin_cos();
    [[c as f32, 0.0, -s as f32], [-s as f32, 0.0, -c as f32], [0.0, 1.0, 0.0]]
}

/// Objects under `e` (an entity with `Kind`), in creation order.
fn collect(e: EntityView, out: &mut Vec<u64>) {
    e.each_child(|c| {
        if c.try_cloned::<&Kind>().is_some() {
            out.push(*c.id());
        }
        collect(c, out);
    });
}

/// Centre in floor space: the entity's own Center plus those of its Center-bearing ancestors.
fn floor_pos(e: EntityView) -> [f32; 3] {
    let mut p = e.try_cloned::<&Center>().map_or([0.0; 3], |c| [c.x, c.y, c.z]);
    let mut up = e.parent();
    while let Some(a) = up {
        if let Some(c) = a.try_cloned::<&Center>() {
            p[0] += c.x;
            p[1] += c.y;
            p[2] += c.z;
        }
        up = a.parent();
    }
    p
}

pub fn pack<'a>(
    world: &World,
    signs: &[[f32; 4]],
    map: &[f32; 4],
    floors: &[EntityView<'a>],
    articles: &[EntityView<'a>],
    infos: impl Iterator<Item = &'a FloorInfo>,
) -> Result<Output, String> {
    let dims = world.lookup("Building").try_cloned::<&Dims>().ok_or("Building has no Dims")?;
    let mut out = Output::default();
    let mut index_of: HashMap<u64, u32> = HashMap::new();

    for (k, floor) in floors.iter().enumerate() {
        let dy = -(k as f32) * dims.level_h;
        let palette = floor.target(Uses::id(), 0).ok_or("floor has no palette")?;
        let plaster = palette.try_cloned::<&Plaster>().ok_or("palette has no Plaster")?;
        let wainscot = palette.try_cloned::<&Wainscot>().ok_or("palette has no Wainscot")?;

        let mut ids = Vec::new();
        collect(*floor, &mut ids);
        ids.sort_unstable();
        let objs: Vec<_> = ids.iter().map(|&id| world.entity_from_id(id)).collect();

        let start = out.objs.len() / 28;
        let mut panes = Vec::new();
        let mut lamp = None;
        let mut accent = None;
        for e in &objs {
            let kind = e.try_cloned::<&Kind>().unwrap().id;
            let half = e.try_cloned::<&Half>().ok_or("object without Half")?;
            let mut c = floor_pos(*e);
            c[1] += dy;
            let rot = if let Some(l) = e.try_cloned::<&Lean>() {
                lean(l.angle as f64)
            } else if let Some(f) = e.try_cloned::<&Flat>() {
                flat(f.theta as f64 + f.per_floor as f64 * k as f64)
            } else {
                I3
            };
            let alb = e.try_cloned::<&Albedo>().unwrap_or_default();
            let tex = if e.has(TexSign::id()) {
                signs.get(k).copied().ok_or("no sign rect for floor")?
            } else if e.has(TexMap::id()) {
                *map
            } else {
                let t = e.try_cloned::<&Tex>().unwrap_or_default();
                [t.x, t.y, t.w, t.h]
            };
            let (alb, tex) = if kind == 4 {
                ([plaster.r, plaster.g, plaster.b, k as f32 * 2.0], [wainscot.r, wainscot.g, wainscot.b, 0.0])
            } else {
                ([alb.r, alb.g, alb.b, 0.0], tex)
            };
            match kind {
                // the shader samples panes in the z = 0 plane (the pane objects sit at z 0.08)
                1 => panes.extend([c[0], c[1], 0.0, 0.0]),
                9 => {
                    let col = e.try_cloned::<&LampColour>().unwrap_or_default();
                    lamp = Some(([c[0], c[1], c[2], half.x], [col.r, col.g, col.b, 0.0]));
                }
                // neon / accent: an emissive rectangle facing +z; its front face is the light
                3 => {
                    let col = e.try_cloned::<&LampColour>().unwrap_or_default();
                    accent = Some(([c[0], c[1], c[2] + half.z, half.x], [col.r, col.g, col.b, half.y]));
                }
                _ => {}
            }
            index_of.insert(*e.id(), (out.objs.len() / 28) as u32);
            out.objs.extend([c[0], c[1], c[2], kind as f32, half.x, half.y, half.z, 0.0]);
            let mat = e.try_cloned::<&Material>().unwrap_or_default();
            // the w of the rotation rows is free: roughness, metallic, spare
            for (r, row) in rot.iter().enumerate() {
                out.objs.extend([row[0], row[1], row[2], [mat.roughness, mat.metallic, 0.0][r]]);
            }
            out.objs.extend(alb);
            out.objs.extend(tex);
        }
        if panes.len() > 16 {
            return Err(format!("floor {k}: more than four panes"));
        }
        let pane_count = (panes.len() / 4) as f32;
        panes.resize(16, 0.0);
        out.panes.extend(panes);
        let (lp, lc) = lamp.ok_or("floor has no lamp")?;
        out.lvl.extend([start as f32, objs.len() as f32, pane_count, 0.0]);
        out.lvl.extend(lp);
        out.lvl.extend(lc);
        let (ap, ac) = accent.unwrap_or(([0.0; 4], [0.0; 4]));
        out.lvl.extend(ap);
        out.lvl.extend(ac);
    }

    for a in articles {
        let mag = a.target(Displayed::id(), 0);
        out.links.push(mag.and_then(|m| index_of.get(&*m.id()).copied()).unwrap_or(u32::MAX));
    }

    #[derive(serde::Serialize)]
    struct F<'a> {
        label: &'a str,
        title: &'a str,
        sub: &'a str,
    }
    #[derive(serde::Serialize)]
    struct Meta<'a> {
        #[serde(rename = "levelH")]
        level_h: f32,
        #[serde(rename = "roomH")]
        room_h: f32,
        #[serde(rename = "roomD")]
        room_d: f32,
        floors: Vec<F<'a>>,
    }
    let floors_meta: Vec<_> = infos.map(|i| F { label: &i.label, title: &i.title, sub: &i.sub }).collect();
    out.meta = serde_json::to_vec(&Meta {
        level_h: dims.level_h,
        room_h: dims.room_h,
        room_d: dims.room_d,
        floors: floors_meta,
    })
    .map_err(|e| e.to_string())?;
    Ok(out)
}
