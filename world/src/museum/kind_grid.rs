//! The Grid family: a step-through of Dijkstra and A* on a 4-connected grid with unit costs. A step pops the next open cell (lowest f,
//! then lowest h, then oldest) and expands it; the run halts when the goal is popped (Accept, the path is drawn) or the open set is
//! empty (NoRule). A click on a cell toggles a wall and restarts the search; the toggle control switches Dijkstra and A* (Manhattan).
use super::{draw::*, input::{Hit, Target, Ui}, kind_common::*, kind_tape::Why, model::*};
use flecs_ecs::prelude::*;
use std::cmp::Reverse;
use std::collections::BinaryHeap;

pub const MAX_COLS: usize = 20;
pub const MAX_ROWS: usize = 12;
const NONE: u32 = u32::MAX;

#[derive(Clone, Debug)]
pub struct GridPreset {
    pub id: String,
    pub title: String,
    pub cols: usize,
    pub rows: usize,
    pub walls: Vec<bool>,
    pub start: usize,
    pub goal: usize,
}

/// `Board` text: rows separated by `/`, `#` wall, `.` open, `S` start, `G` goal.
pub fn parse_board(t: &str) -> Result<(usize, usize, Vec<bool>, usize, usize), String> {
    let rows: Vec<&str> = t.split('/').map(|r| r.trim()).filter(|r| !r.is_empty()).collect();
    let cols = rows.first().map_or(0, |r| r.chars().count());
    if cols < 2 || cols > MAX_COLS || rows.len() < 2 || rows.len() > MAX_ROWS {
        return Err(format!("a Board is 2 to {MAX_COLS} columns by 2 to {MAX_ROWS} rows"));
    }
    let (mut walls, mut start, mut goal) = (Vec::new(), None, None);
    for (y, r) in rows.iter().enumerate() {
        if r.chars().count() != cols {
            return Err(format!("Board row {y} has {} cells, row 0 has {cols}", r.chars().count()));
        }
        for (x, c) in r.chars().enumerate() {
            let i = y * cols + x;
            match c {
                '#' => walls.push(true),
                '.' => walls.push(false),
                'S' if start.is_none() => {
                    start = Some(i);
                    walls.push(false)
                }
                'G' if goal.is_none() => {
                    goal = Some(i);
                    walls.push(false)
                }
                _ => return Err(format!("Board has `{c}` at row {y}, column {x}: use # . and one S and one G")),
            }
        }
    }
    match (start, goal) {
        (Some(s), Some(g)) => Ok((cols, rows.len(), walls, s, g)),
        _ => Err("a Board needs one S and one G".into()),
    }
}

pub fn read(w: &World, voc: &Voc, scope: EntityView) -> Result<Vec<GridPreset>, String> {
    let _ = w;
    let mut presets = Vec::new();
    for pe in children(scope) {
        if !is_a(pe, voc.preset) {
            continue;
        }
        let t = pe.try_cloned::<&Board>().map(|t| t.text).ok_or_else(|| format!("{}: a Preset needs a Board text", path(pe)))?;
        let (cols, rows, walls, start, goal) = parse_board(&t).map_err(|e| format!("{}: {e}", path(pe)))?;
        presets.push(GridPreset { id: pe.name(), title: pe.try_cloned::<&Title>().map(|t| t.text).unwrap_or_default(), cols, rows, walls, start, goal });
    }
    Ok(presets)
}

pub struct Grid {
    preset: usize,
    cols: usize,
    rows: usize,
    walls: Vec<bool>,
    start: usize,
    goal: usize,
    astar: bool,
    g: Vec<u32>,
    parent: Vec<u32>,
    closed: Vec<bool>,
    open: BinaryHeap<Reverse<(u32, u32, u32, u32, u32)>>,
    seq: u32,
    expanded: u32,
    path: Vec<usize>,
    found: bool,
}

impl Grid {
    pub fn new(def: &ExDef) -> Grid {
        let mut s = Grid { preset: 0, cols: 2, rows: 2, walls: vec![false; 4], start: 0, goal: 3, astar: false, g: Vec::new(), parent: Vec::new(), closed: Vec::new(), open: BinaryHeap::new(), seq: 0, expanded: 0, path: Vec::new(), found: false };
        s.load(def, 0);
        s
    }

    fn h(&self, i: usize) -> u32 {
        if !self.astar {
            return 0;
        }
        let (x, y, gx, gy) = ((i % self.cols) as i32, (i / self.cols) as i32, (self.goal % self.cols) as i32, (self.goal / self.cols) as i32);
        ((x - gx).abs() + (y - gy).abs()) as u32
    }

    fn restart(&mut self) {
        let n = self.cols * self.rows;
        self.g = vec![NONE; n];
        self.parent = vec![NONE; n];
        self.closed = vec![false; n];
        self.open.clear();
        self.seq = 0;
        self.expanded = 0;
        self.path.clear();
        self.found = false;
        self.g[self.start] = 0;
        let h = self.h(self.start);
        self.open.push(Reverse((h, h, 0, self.start as u32, 0)));
        self.seq = 1;
    }

    fn expand(&mut self) -> Out {
        loop {
            let Some(Reverse((_, _, _, idx, g))) = self.open.pop() else { return Out { moved: false, halt: Some(Why::NoRule) } };
            let i = idx as usize;
            if self.closed[i] || self.g[i] != g {
                continue;
            }
            self.closed[i] = true;
            self.expanded += 1;
            if i == self.goal {
                let mut p = vec![i];
                let mut c = i;
                while self.parent[c] != NONE {
                    c = self.parent[c] as usize;
                    p.push(c);
                }
                p.reverse();
                self.path = p;
                self.found = true;
                return Out { moved: true, halt: Some(Why::Accept) };
            }
            let (x, y) = (i % self.cols, i / self.cols);
            let mut nb = [None; 4];
            if y > 0 {
                nb[0] = Some(i - self.cols);
            }
            if x + 1 < self.cols {
                nb[1] = Some(i + 1);
            }
            if y + 1 < self.rows {
                nb[2] = Some(i + self.cols);
            }
            if x > 0 {
                nb[3] = Some(i - 1);
            }
            for n in nb.into_iter().flatten() {
                if self.walls[n] || self.closed[n] {
                    continue;
                }
                let ng = g + 1;
                if ng < self.g[n] {
                    self.g[n] = ng;
                    self.parent[n] = i as u32;
                    let h = self.h(n);
                    self.open.push(Reverse((ng + h, h, self.seq, n as u32, ng)));
                    self.seq += 1;
                }
            }
            return Out { moved: true, halt: None };
        }
    }

    /// Cell rectangle in exhibit em.
    fn cell(&self, def: &ExDef, i: usize) -> [f32; 4] {
        let v = view(def);
        let cs = (v[2] / self.cols as f32).min(v[3] / self.rows as f32).min(2.0);
        let x0 = v[0] + (v[2] - cs * self.cols as f32) / 2.0;
        [x0 + (i % self.cols) as f32 * cs, v[1] + (i / self.cols) as f32 * cs, cs, cs]
    }

    fn name(&self) -> &'static str {
        if self.astar {
            "A*"
        } else {
            "Dijkstra"
        }
    }
}

impl Core for Grid {
    fn tag(&self) -> &'static str {
        "gd1"
    }

    fn load(&mut self, def: &ExDef, i: usize) {
        let Data::Grid(v) = &def.data else { return };
        let Some(p) = v.get(i) else { return };
        self.preset = i;
        self.cols = p.cols;
        self.rows = p.rows;
        self.walls = p.walls.clone();
        self.start = p.start;
        self.goal = p.goal;
        self.restart();
    }

    fn step(&mut self, _def: &ExDef, _preset: usize) -> Out {
        if self.found {
            return Out { moved: false, halt: Some(Why::Accept) };
        }
        self.expand()
    }

    fn toggle(&mut self, _def: &ExDef, _preset: usize) -> Act {
        self.astar = !self.astar;
        self.restart();
        Act::Edit
    }

    fn toggled(&self) -> bool {
        self.astar
    }

    fn activate(&mut self, _def: &ExDef, _preset: usize, t: Target, _can_step: bool) -> Act {
        let Target::Item(i, 0) = t else { return Act::None };
        if i >= self.walls.len() || i == self.start || i == self.goal {
            return Act::None;
        }
        self.walls[i] = !self.walls[i];
        self.restart();
        Act::Edit
    }

    fn hits(&self, def: &ExDef, out: &mut Vec<Hit>) {
        let layer = def.part(PartKind::View).map_or(1, |v| v.layer);
        for i in 0..self.walls.len() {
            if i != self.start && i != self.goal {
                out.push(Hit { rect: self.cell(def, i), layer, target: Target::Item(i, 0) });
            }
        }
    }

    fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList) {
        const PAD: f32 = 0.07;
        let inset = |r: [f32; 4]| [r[0] + PAD, r[1] + PAD, r[2] - 2.0 * PAD, r[3] - 2.0 * PAD];
        let v = view(def);
        let cs = self.cell(def, 0)[2];
        let (w, h) = (cs * self.cols as f32, cs * self.rows as f32);
        dl.rrect([v[0] + (v[2] - w) / 2.0 - 0.15, v[1] - 0.15, w + 0.3, h + 0.3], 0.3, PANEL_HI, 0);
        for i in 0..self.walls.len() {
            let r = inset(self.cell(def, i));
            let on_path = self.found && self.path.contains(&i);
            if self.walls[i] {
                dl.rrect(r, 0.15, INK3, 0);
            } else if on_path {
                dl.rrect(r, 0.15, ACCENT, 0);
            } else if self.closed[i] {
                dl.rrect(r, 0.15, ACCENT_TINT, 0);
            } else if self.g[i] != NONE {
                dl.rrect(r, 0.15, ACCENT_DIM, 0);
            }
            if ui.hover == Some(Target::Item(i, 0)) && !self.walls[i] {
                dl.ring(r, 0.15, 0.08, INK2);
            }
            let r0 = self.cell(def, i);
            if i == self.start || i == self.goal {
                dl.label(r0[0] + r0[2] / 2.0, r0[1] + r0[3] / 2.0 + 0.3, 0.9, r0[2], if i == self.start { "S" } else { "G" }, INK, ALIGN_CENTRE | F_BOLD);
            }
        }
    }

    fn status(&self, _def: &ExDef, run: &Run) -> String {
        let frontier = (0..self.g.len()).filter(|&i| self.g[i] != NONE && !self.closed[i]).count();
        match run.halted {
            Some(Why::Accept) => format!("{}   expanded {}   path {}", self.name(), self.expanded, self.path.len().saturating_sub(1)),
            Some(Why::NoRule) => format!("{}   expanded {}   no path", self.name(), self.expanded),
            Some(Why::Fuel) => format!("{}   expanded {}   out of fuel", self.name(), self.expanded),
            None => format!("{}   expanded {}   frontier {}{}", self.name(), self.expanded, frontier, if run.running { "   running" } else { "" }),
        }
    }

    fn save(&self) -> String {
        let walls: String = self.walls.iter().map(|&b| if b { '1' } else { '0' }).collect();
        format!("{};{}", self.astar as u8, walls)
    }

    fn restore(&mut self, def: &ExDef, preset: usize, s: &str, steps: u32) -> bool {
        let Data::Grid(v) = &def.data else { return false };
        let Some(p) = v.get(preset) else { return false };
        let Some((a, w)) = s.split_once(';') else { return false };
        let astar = match a {
            "0" => false,
            "1" => true,
            _ => return false,
        };
        if w.chars().count() != p.walls.len() || !w.chars().all(|c| c == '0' || c == '1') {
            return false;
        }
        let walls: Vec<bool> = w.chars().map(|c| c == '1').collect();
        if walls[p.start] || walls[p.goal] || steps as usize > p.walls.len() {
            return false;
        }
        self.load(def, preset);
        self.walls = walls;
        self.astar = astar;
        self.restart();
        for _ in 0..steps {
            if self.step(def, preset).halt.is_some() {
                break;
            }
        }
        true
    }
}
