//! The Graph family: nodes keyed by a hash of their inputs (an action graph with a cache, a Merkle DAG of definitions). Sources
//! (leaves) are edited by clicking them; every derived node's hash is FNV-1a over its tag, its `Content` text and the hashes of its
//! inputs in node order, so an edit changes exactly the nodes downstream of it. A step settles the next derived node in dependency
//! order: its hash already in the store is a hit (reused), a new one is stored (built). The store keeps every hash ever settled, so
//! editing a file back is all hits. Names (`Label`, `LabelAlt`) are not part of any hash: a rename changes no hash.
use super::{draw::*, input::{Hit, Target, Ui}, kind_common::*, kind_tape::Why, model::*};
use flecs_ecs::prelude::*;

pub const MAX_NODES: usize = 24;

const NODE_R: f32 = 0.95;
const PAD: f32 = 0.85;
const KEY_W: f32 = 1.55;
const KEY_GAP: f32 = 2.05;
const ENTRY_STEP: f32 = 0.42;
/// seconds between consecutive dependency levels of the edit wave, and its total length
const LEVEL_STEP: f32 = 0.38;
const EDIT_SPAN: f32 = 2.2;
const SETTLE_SPAN: f32 = 0.4;

fn ease(t: f32) -> f32 {
    1.0 - (1.0 - t.clamp(0.0, 1.0)).powi(3)
}

/// A dependency edge: leaves the source's right side, runs level to the gap before the target, then one smooth cubic S into the target's left side.
fn route(from: (f32, f32), gap_x: f32, to: (f32, f32)) -> Vec<(f32, f32)> {
    let xe = to.0 - 0.45;
    let xs = gap_x.clamp(from.0, xe - 0.5);
    let mut v = vec![from];
    if xs > from.0 + 0.01 {
        v.push((xs, from.1));
    }
    let d = xe - xs;
    const N: usize = 14;
    for k in 1..=N {
        let t = k as f32 / N as f32;
        let m = 1.0 - t;
        let x = m * m * m * xs + 3.0 * m * m * t * (xs + d / 2.0) + 3.0 * m * t * t * (xe - d / 2.0) + t * t * t * xe;
        let y = (m * m * m + 3.0 * m * m * t) * from.1 + (3.0 * m * t * t + t * t * t) * to.1;
        v.push((x, y));
    }
    v.push((to.0 + 0.05, to.1));
    v
}

/// The first `frac` of a polyline's length as round-capped segments; the full path ends in an arrowhead.
fn polyline(dl: &mut DrawList, pts: &[(f32, f32)], frac: f32, tone: f32) {
    const STROKE: f32 = 0.05;
    let len = |a: (f32, f32), b: (f32, f32)| ((b.0 - a.0).powi(2) + (b.1 - a.1).powi(2)).sqrt();
    let total: f32 = pts.windows(2).map(|w| len(w[0], w[1])).sum();
    let mut left = total * frac.clamp(0.0, 1.0);
    let last = pts.len() - 2;
    for (k, w) in pts.windows(2).enumerate() {
        let l = len(w[0], w[1]);
        if l <= 1e-4 {
            continue;
        }
        let take = left.min(l);
        if take <= 0.0 {
            break;
        }
        let f = take / l;
        let (dx, dy) = ((w[1].0 - w[0].0) * f, (w[1].1 - w[0].1) * f);
        if k == last && frac >= 1.0 {
            dl.arrow(w[0].0, w[0].1, dx, dy, STROKE, tone);
        } else {
            dl.line(w[0].0, w[0].1, dx, dy, STROKE, tone);
        }
        left -= take;
    }
}

#[derive(Clone, Debug)]
pub struct GNode {
    pub id: String,
    pub label: String,
    /// the name after a rename (empty: not renamable)
    pub alt: String,
    /// 0 source, 1 action, 2 tree
    pub tag: u8,
    pub body: String,
    pub place: [f32; 4],
    /// input nodes, ascending
    pub ins: Vec<usize>,
}

#[derive(Clone, Debug)]
pub struct GPreset {
    pub id: String,
    pub title: String,
    pub nodes: Vec<GNode>,
    /// every node, inputs before consumers (ties by declaration order)
    pub topo: Vec<usize>,
    /// the derived nodes of `topo`: the scheduling order of a step
    pub order: Vec<usize>,
    pub hit: String,
    pub built: String,
}

pub fn fnv(mut h: u32, bytes: &[u8]) -> u32 {
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// The four hex digits shown for a hash.
pub fn short(h: u32) -> String {
    format!("{:04x}", (h ^ (h >> 16)) & 0xffff)
}

fn node_hash(n: &GNode, ver: bool, cur: &[u32]) -> u32 {
    let mut h = fnv(0x811c_9dc5, &[n.tag]);
    h = fnv(h, n.body.as_bytes());
    h = fnv(h, &[0xff]);
    if n.tag == 0 {
        h = fnv(h, &[ver as u8]);
    }
    for &i in &n.ins {
        h = fnv(h, &cur[i].to_le_bytes());
    }
    h
}

pub fn read(w: &World, voc: &Voc, scope: EntityView, frame: [f32; 2]) -> Result<Vec<GPreset>, String> {
    let find = |n: &str| w.try_lookup(n).map(|e| e.id()).ok_or_else(|| format!("prefab `{n}` is missing"));
    let (source, action, tree) = (find("Source")?, find("Action")?, find("Tree")?);
    let root = children(scope).into_iter().find(|c| is_a(*c, voc.graph_machine)).ok_or("no GraphMachine")?;
    let hit = root.try_cloned::<&OnHit>().map(|t| t.text).filter(|t| !t.is_empty()).unwrap_or_else(|| "hit".into());
    let built = root.try_cloned::<&OnBuilt>().map(|t| t.text).filter(|t| !t.is_empty()).unwrap_or_else(|| "built".into());
    let mut presets = Vec::new();
    for pe in children(scope) {
        if !is_a(pe, voc.preset) {
            continue;
        }
        let at = |what: &str, c: EntityView| format!("{}: {what}", path(c));
        let mut ids = Vec::new();
        let mut nodes = Vec::new();
        let mut ents = Vec::new();
        for c in children(pe) {
            let tag = if is_a(c, source) {
                0
            } else if is_a(c, action) {
                1
            } else if is_a(c, tree) {
                2
            } else {
                continue;
            };
            let place = c.try_cloned::<&Place>().ok_or_else(|| at("a node needs a Place", c))?;
            let p = [place.x, place.y, place.w, place.h];
            if !(p[2] > 0.0 && p[3] > 0.0 && p[0] >= 0.0 && p[1] >= 0.0 && p[0] + p[2] <= frame[0] && p[1] + p[3] <= frame[1]) {
                return Err(at("the node's Place is not inside the Extent", c));
            }
            ids.push(c.id());
            ents.push(c);
            nodes.push(GNode {
                id: c.name(),
                label: c.try_cloned::<&Label>().map(|t| t.text).filter(|t| !t.is_empty()).unwrap_or_else(|| c.name()),
                alt: c.try_cloned::<&LabelAlt>().map(|t| t.text).unwrap_or_default(),
                tag,
                body: c.try_cloned::<&Content>().map(|t| t.text).unwrap_or_default(),
                place: p,
                ins: Vec::new(),
            });
        }
        // Entity ids are not declaration order once a scope has been destroyed and rebuilt (ids are recycled), so the node order is
        // canonical: top to bottom, left to right, then by name. Hashes and the step order depend on it only through this order.
        let mut order: Vec<usize> = (0..nodes.len()).collect();
        order.sort_by(|&a, &b| {
            let (p, q) = (&nodes[a], &nodes[b]);
            p.place[1].total_cmp(&q.place[1]).then(p.place[0].total_cmp(&q.place[0])).then(p.id.cmp(&q.id))
        });
        nodes = order.iter().map(|&i| nodes[i].clone()).collect();
        ents = order.iter().map(|&i| ents[i]).collect();
        ids = order.iter().map(|&i| ids[i]).collect();
        if nodes.is_empty() || nodes.len() > MAX_NODES {
            return Err(at(&format!("a preset needs 1 to {MAX_NODES} nodes"), pe));
        }
        for (k, c) in ents.iter().enumerate() {
            let mut i = 0;
            while let Some(t) = c.target(voc.reads, i) {
                let from = ids.iter().position(|&x| x == t.id()).ok_or_else(|| at(&format!("(Reads, {}) is not a node of this preset", path(t)), *c))?;
                if from == k {
                    return Err(at("a node reads itself", *c));
                }
                nodes[k].ins.push(from);
                i += 1;
            }
            if nodes[k].tag == 0 && !nodes[k].ins.is_empty() {
                return Err(at("a Source has no inputs", *c));
            }
            if nodes[k].tag != 0 && nodes[k].ins.is_empty() {
                return Err(at("an Action or Tree reads at least one node", *c));
            }
            nodes[k].ins.sort_unstable();
            nodes[k].ins.dedup();
        }
        let mut topo: Vec<usize> = Vec::new();
        while topo.len() < nodes.len() {
            let next = (0..nodes.len()).find(|&i| !topo.contains(&i) && nodes[i].ins.iter().all(|d| topo.contains(d)));
            match next {
                Some(i) => topo.push(i),
                None => return Err(at("the nodes form a cycle", pe)),
            }
        }
        let order = topo.iter().copied().filter(|&i| nodes[i].tag != 0).collect();
        presets.push(GPreset { id: pe.name(), title: pe.try_cloned::<&Title>().map(|t| t.text).unwrap_or_default(), nodes, topo, order, hit: hit.clone(), built: built.clone() });
    }
    Ok(presets)
}

pub struct Graph {
    preset: usize,
    ver: Vec<bool>,
    ren: Vec<bool>,
    cur: Vec<u32>,
    shown: Vec<u32>,
    /// every hash ever settled, sorted
    store: Vec<u32>,
    /// 0 idle, 1 hit, 2 built
    st: Vec<u8>,
    cursor: usize,
    /// a click renames instead of editing
    rename: bool,
    /// the keys at load (what "changed" is measured against)
    orig: Vec<u32>,
    /// the key a node showed before its last step
    from: Vec<u32>,
    /// seconds since each node last settled, and since the last edit (animation only: never saved, never hashed)
    age: Vec<f32>,
    edit_age: f32,
}

impl Graph {
    pub fn new(def: &ExDef) -> Graph {
        let mut g = Graph { preset: 0, ver: Vec::new(), ren: Vec::new(), cur: Vec::new(), shown: Vec::new(), store: Vec::new(), st: Vec::new(), cursor: 0, rename: false, orig: Vec::new(), from: Vec::new(), age: Vec::new(), edit_age: 9.0 };
        g.load(def, 0);
        g
    }

    fn p<'a>(&self, def: &'a ExDef) -> Option<&'a GPreset> {
        match &def.data {
            Data::Graph(v) => v.get(self.preset),
            _ => None,
        }
    }

    fn recompute(&mut self, p: &GPreset) {
        self.cur.resize(p.nodes.len(), 0);
        for &i in &p.topo {
            self.cur[i] = node_hash(&p.nodes[i], self.ver[i], &self.cur);
        }
    }

    fn store_add(&mut self, h: u32) -> bool {
        match self.store.binary_search(&h) {
            Ok(_) => false,
            Err(i) => {
                self.store.insert(i, h);
                true
            }
        }
    }

    fn new_round(&mut self) {
        self.st.iter_mut().for_each(|s| *s = 0);
        self.cursor = 0;
    }

    /// No animation in flight (load, restore).
    fn settled(&mut self) {
        self.from = self.cur.clone();
        self.age = vec![9.0; self.cur.len()];
        self.edit_age = 9.0;
    }

    fn stale(&self, i: usize) -> bool {
        self.cur[i] != self.shown[i]
    }
}

impl Core for Graph {
    fn tag(&self) -> &'static str {
        "gr1"
    }

    fn load(&mut self, def: &ExDef, i: usize) {
        self.preset = i;
        let Some(p) = self.p(def) else { return };
        let n = p.nodes.len();
        let p = p.clone();
        self.ver = vec![false; n];
        self.ren = vec![false; n];
        self.st = vec![0; n];
        self.store.clear();
        self.cursor = 0;
        self.rename = false;
        self.recompute(&p);
        self.shown = self.cur.clone();
        self.orig = self.cur.clone();
        self.settled();
        let cur = self.cur.clone();
        for h in cur {
            self.store_add(h);
        }
    }

    fn step(&mut self, def: &ExDef, _preset: usize) -> Out {
        let Some(p) = self.p(def) else { return Out { moved: false, halt: Some(Why::NoRule) } };
        let Some(&n) = p.order.get(self.cursor) else { return Out { moved: false, halt: Some(Why::Accept) } };
        let len = p.order.len();
        let k = self.cur[n];
        self.st[n] = if self.store_add(k) { 2 } else { 1 };
        self.from[n] = self.shown[n];
        self.age[n] = 0.0;
        self.shown[n] = k;
        self.cursor += 1;
        Out { moved: true, halt: (self.cursor == len).then_some(Why::Accept) }
    }

    fn toggle(&mut self, _def: &ExDef, _preset: usize) -> Act {
        self.rename = !self.rename;
        Act::None
    }

    fn toggled(&self) -> bool {
        self.rename
    }

    fn activate(&mut self, def: &ExDef, _preset: usize, t: Target, _can_step: bool) -> Act {
        let Target::Item(n, 0) = t else { return Act::None };
        let Some(p) = self.p(def) else { return Act::None };
        let Some(node) = p.nodes.get(n) else { return Act::None };
        if self.rename {
            if node.alt.is_empty() {
                return Act::None;
            }
            self.ren[n] = !self.ren[n];
            return Act::Changed;
        }
        if node.tag != 0 {
            return Act::None;
        }
        let p = p.clone();
        self.ver[n] = !self.ver[n];
        self.recompute(&p);
        self.shown[n] = self.cur[n];
        let h = self.cur[n];
        self.store_add(h);
        self.new_round();
        self.edit_age = 0.0;
        Act::Edit
    }

    fn hits(&self, def: &ExDef, out: &mut Vec<Hit>) {
        let Some(p) = self.p(def) else { return };
        let layer = def.part(PartKind::View).map_or(1, |v| v.layer);
        for (i, n) in p.nodes.iter().enumerate() {
            let ok = if self.rename { !n.alt.is_empty() } else { n.tag == 0 };
            if ok {
                out.push(Hit { rect: n.place, layer, target: Target::Item(i, 0) });
            }
        }
    }

    fn anim(&mut self, dt: f32) {
        self.edit_age = (self.edit_age + dt).min(9.0);
        for a in self.age.iter_mut() {
            *a = (*a + dt).min(9.0);
        }
    }

    fn animating(&self) -> bool {
        self.edit_age < EDIT_SPAN || self.age.iter().any(|&a| a < SETTLE_SPAN)
    }

    fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList) {
        let Some(p) = self.p(def) else { return };
        let n = p.nodes.len();
        let mut level = vec![0usize; n];
        for &i in &p.topo {
            level[i] = p.nodes[i].ins.iter().map(|&f| level[f] + 1).max().unwrap_or(0);
        }
        let changed: Vec<bool> = (0..n).map(|i| self.cur[i] != self.orig[i]).collect();
        // every edge as a routed polyline; entry points on the target's left side are spread by the source's height
        let mut routes: Vec<(usize, usize, Vec<(f32, f32)>)> = Vec::new();
        for (i, node) in p.nodes.iter().enumerate() {
            let mut ins = node.ins.clone();
            ins.sort_by(|&a, &b| p.nodes[a].place[1].total_cmp(&p.nodes[b].place[1]).then(a.cmp(&b)));
            let xs = p.nodes.iter().enumerate().filter(|&(k, m)| k != i && m.place[0] + m.place[2] <= node.place[0] + 0.01).map(|(_, m)| m.place[0] + m.place[2]).fold(0.0, f32::max);
            for (rank, &f) in ins.iter().enumerate() {
                let a = p.nodes[f].place;
                let spread = (rank as f32 - (ins.len() as f32 - 1.0) / 2.0) * ENTRY_STEP;
                routes.push((f, i, route((a[0] + a[2], a[1] + a[3] / 2.0), xs, (node.place[0], node.place[1] + node.place[3] / 2.0 + spread))));
            }
        }
        for (_, _, pts) in &routes {
            polyline(dl, pts, 1.0, EDGE);
        }
        for (f, i, pts) in &routes {
            if changed[*f] && changed[*i] {
                let t = ((self.edit_age - LEVEL_STEP * level[*f] as f32 - 0.05) / 0.3).clamp(0.0, 1.0);
                if t > 0.0 {
                    polyline(dl, pts, ease(t), ACCENT);
                }
            }
        }
        let next = p.order.get(self.cursor).copied();
        for (i, node) in p.nodes.iter().enumerate() {
            let [x, y, w, _] = node.place;
            let t = Target::Item(i, 0);
            let hover = ui.hover == Some(t) || ui.pressed == Some(t);
            let src = node.tag == 0;
            let stale = !src && self.stale(i);
            dl.rrect(node.place, NODE_R, if hover { NODE_HI } else { NODE }, 0);
            // fill animation: rebuilt nodes fill amber after their step; an edited source tints
            let settle = ease((self.age[i] / SETTLE_SPAN).min(1.0));
            let built = self.st[i] == 2;
            let edit_t = ease(((self.edit_age - if level[i] == 0 { 0.0 } else { LEVEL_STEP * level[i] as f32 }) / 0.35).clamp(0.0, 1.0));
            let fill = if built { settle } else { 0.0 };
            if built {
                dl.rrect_a(node.place, NODE_R, ACCENT, fill);
            } else if src && changed[i] {
                dl.rrect_a(node.place, NODE_R, ACCENT_TINT, edit_t);
            }
            let ink_amber = built && fill > 0.5;
            let name = if self.ren[i] && !node.alt.is_empty() { &node.alt } else { &node.label };
            let (kx, ky) = (x + PAD, y + 1.5);
            dl.label(x + PAD, y + 0.84, 0.7, w - 2.0 * PAD, name, if ink_amber { ACCENT_INK } else { INK }, 0);
            let key_ink = if ink_amber { ACCENT_INK } else { INK2 };
            let cur = short(self.cur[i]);
            let moving = !stale && self.age[i] < SETTLE_SPAN && self.from[i] != self.cur[i];
            if moving {
                // a settled node: the new key slides in over the struck old one
                let e = ease((self.age[i] / SETTLE_SPAN).min(1.0));
                dl.label(kx + (1.0 - e) * KEY_GAP, ky, 0.62, 0.0, &cur, key_ink, F_MONO);
            } else if stale || (src && changed[i]) {
                let old = if stale { self.shown[i] } else { self.orig[i] };
                let e = if stale { ease(((self.edit_age - LEVEL_STEP * level[i] as f32) / 0.35).clamp(0.0, 1.0)) } else { edit_t };
                dl.label(kx, ky, 0.62, 0.0, &short(old), if e > 0.0 { INK3 } else { INK2 }, F_MONO);
                dl.line_a(kx - 0.05, ky - 0.2, KEY_W * e + 0.1, 0.0, 0.05, INK3, e);
                dl.label_a(kx + KEY_GAP, ky, 0.62, 0.0, &cur, ACCENT, F_MONO, e);
            } else {
                dl.label(kx, ky, 0.62, 0.0, &cur, key_ink, F_MONO);
            }
            if self.st[i] == 1 {
                let a = ease((self.age[i] / SETTLE_SPAN).min(1.0));
                let (cx, cy) = (x + w - 1.35, y + 1.18);
                dl.line_a(cx - 0.3, cy + 0.02, 0.22, 0.24, 0.07, INK2, a);
                dl.line_a(cx - 0.08, cy + 0.26, 0.4, -0.5, 0.07, INK2, a);
            }
            if next == Some(i) && !built && self.st[i] == 0 && stale {
                dl.dot(x + w - 1.0, y + 1.0, 0.3, ACCENT);
            }
        }
    }

    fn status(&self, def: &ExDef, run: &Run) -> String {
        let Some(p) = self.p(def) else { return String::new() };
        let built = self.st.iter().filter(|&&s| s == 2).count();
        let hit = self.st.iter().filter(|&&s| s == 1).count();
        match run.halted {
            Some(_) => format!("done   {built} {}, {hit} {}", p.built, p.hit),
            None => {
                let stale = (0..p.nodes.len()).filter(|&i| p.nodes[i].tag != 0 && self.stale(i)).count();
                let next = p.order.get(self.cursor).map_or("", |&i| p.nodes[i].label.as_str());
                format!("step {} of {}   {stale} stale   next: {next}{}", run.steps, p.order.len(), if run.running { "   running" } else { "" })
            }
        }
    }

    fn save(&self) -> String {
        let bits = |v: &[bool]| v.iter().map(|&b| if b { '1' } else { '0' }).collect::<String>();
        let hexes = |v: &[u32]| v.iter().map(|h| format!("{h:08x}")).collect::<Vec<_>>().join(",");
        let st: String = self.st.iter().map(|&s| char::from(b'0' + s)).collect();
        format!("{};{};{};{};{};{};{}", bits(&self.ver), bits(&self.ren), self.cursor, self.rename as u8, st, hexes(&self.shown), hexes(&self.store))
    }

    fn restore(&mut self, def: &ExDef, preset: usize, s: &str, _steps: u32) -> bool {
        let Data::Graph(v) = &def.data else { return false };
        let Some(p) = v.get(preset) else { return false };
        let n = p.nodes.len();
        let f: Vec<&str> = s.split(';').collect();
        if f.len() != 7 {
            return false;
        }
        let bits = |t: &str| -> Option<Vec<bool>> {
            (t.len() == n && t.chars().all(|c| c == '0' || c == '1')).then(|| t.chars().map(|c| c == '1').collect())
        };
        let hexes = |t: &str, max: usize| -> Option<Vec<u32>> {
            if t.is_empty() {
                return Some(Vec::new());
            }
            let v: Option<Vec<u32>> = t.split(',').map(|h| (h.len() == 8).then(|| u32::from_str_radix(h, 16).ok()).flatten()).collect();
            v.filter(|v| v.len() <= max)
        };
        let (Some(ver), Some(ren), Some(cursor), Some(rename), Some(shown), Some(mut store)) = (bits(f[0]), bits(f[1]), f[2].parse::<usize>().ok(), match f[3] { "0" => Some(false), "1" => Some(true), _ => None }, hexes(f[5], n), hexes(f[6], 1024)) else { return false };
        let st: Option<Vec<u8>> = (f[4].len() == n).then(|| f[4].chars().map(|c| match c { '0' => Some(0), '1' => Some(1), '2' => Some(2), _ => None }).collect::<Option<Vec<u8>>>()).flatten();
        let Some(st) = st else { return false };
        if shown.len() != n || cursor > p.order.len() {
            return false;
        }
        store.sort_unstable();
        store.dedup();
        let p = p.clone();
        self.preset = preset;
        self.ver = ver;
        self.ren = ren;
        self.rename = rename;
        self.cursor = cursor;
        self.st = st;
        self.shown = shown;
        self.store = store;
        self.recompute(&p);
        let ver = std::mem::replace(&mut self.ver, vec![false; n]);
        self.recompute(&p);
        self.orig = self.cur.clone();
        self.ver = ver;
        self.recompute(&p);
        self.settled();
        true
    }
}
