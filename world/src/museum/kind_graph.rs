//! The Graph family: nodes keyed by a hash of their inputs (an action graph with a cache, a Merkle DAG of definitions). Sources
//! (leaves) are edited by clicking them; every derived node's hash is FNV-1a over its tag, its `Content` text and the hashes of its
//! inputs in node order, so an edit changes exactly the nodes downstream of it. A step settles the next derived node in dependency
//! order: its hash already in the store is a hit (reused), a new one is stored (built). The store keeps every hash ever settled, so
//! editing a file back is all hits. Names (`Label`, `LabelAlt`) are not part of any hash: a rename changes no hash.
use super::{draw::*, input::{Hit, Target, Ui}, kind_common::*, kind_tape::Why, model::*};
use flecs_ecs::prelude::*;

pub const MAX_NODES: usize = 24;

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
}

impl Graph {
    pub fn new(def: &ExDef) -> Graph {
        let mut g = Graph { preset: 0, ver: Vec::new(), ren: Vec::new(), cur: Vec::new(), shown: Vec::new(), store: Vec::new(), st: Vec::new(), cursor: 0, rename: false };
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

    fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList) {
        let Some(p) = self.p(def) else { return };
        let next = p.order.get(self.cursor).copied();
        for (i, n) in p.nodes.iter().enumerate() {
            let [x, y, _, h] = n.place;
            for &f in &n.ins {
                let a = p.nodes[f].place;
                let (x0, y0) = (a[0] + a[2], a[1] + a[3] / 2.0);
                let (x1, y1) = (x - 0.15, y + h / 2.0);
                dl.arrow(x0, y0, x1 - x0, y1 - y0, 0.09, if self.st[i] == 2 && self.st[f] != 1 { ACCENT_DIM } else { INK3 });
            }
        }
        for (i, n) in p.nodes.iter().enumerate() {
            let [x, y, w, h] = n.place;
            let t = Target::Item(i, 0);
            let hov = if ui.hover == Some(t) { F_HOVER } else { 0 } | if ui.pressed == Some(t) { F_PRESSED } else { 0 };
            let built = self.st[i] == 2;
            let hit = self.st[i] == 1;
            let stale = n.tag != 0 && self.stale(i);
            dl.rrect(n.place, 0.4, if built { ACCENT_TINT } else { PANEL_HI }, hov | if n.tag == 0 && self.ver[i] { F_SELECTED } else { 0 });
            if hit {
                dl.ring(n.place, 0.4, 0.1, ACCENT2);
            } else if built {
                dl.ring(n.place, 0.4, 0.1, ACCENT);
            } else if next == Some(i) {
                dl.ring(n.place, 0.4, 0.1, ACCENT);
            } else if stale {
                dl.ring(n.place, 0.4, 0.07, ACCENT_DIM);
            }
            let name = if self.ren[i] && !n.alt.is_empty() { &n.alt } else { &n.label };
            dl.label(x + 0.5, y + h * 0.42, 0.7, if stale { w - 3.4 } else { w - 1.0 }, name, INK, 0);
            let (word, tone) = if hit {
                (p.hit.as_str(), ACCENT2)
            } else if built {
                (p.built.as_str(), ACCENT)
            } else if stale {
                (if self.store.binary_search(&self.cur[i]).is_ok() { p.hit.as_str() } else { p.built.as_str() }, INK3)
            } else if n.tag == 0 && self.ver[i] {
                ("edited", ACCENT)
            } else {
                ("", INK3)
            };
            // a settled word (cache hit, rebuilt, edited) sits on the short hash row; the prediction of a stale node sits beside its name (its hash row is the long `old -> new` form)
            let word_y = if stale { y + h * 0.42 } else { y + h - 0.3 };
            dl.label(x + w - 0.4, word_y, 0.6, 3.0, word, tone, ALIGN_RIGHT);
            let hash = if stale { format!("{} → {}", short(self.shown[i]), short(self.cur[i])) } else { short(self.cur[i]) };
            dl.label(x + 0.5, y + h - 0.3, 0.75, w - 1.0, &hash, if stale { INK3 } else if built { ACCENT } else { INK2 }, F_MONO);
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
        true
    }
}
