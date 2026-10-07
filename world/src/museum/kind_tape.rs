//! The Tape family: a head on a tape of symbols and an editable rule table. A step finds the first rule for (state, symbol under the
//! head), writes, moves and changes state (docs/MUSEUM.md 4.4). The tape is a `Vec`, not entities (spike: see "Spike results").
use super::{draw::*, input::{Hit, Target, Ui}, model::*, snapshot, Ctx, TICK};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Why {
    Accept,
    NoRule,
    Fuel,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct RuleRow {
    pub from: Option<usize>,
    pub read: Option<usize>,
    pub write: Option<usize>,
    pub mv: Dir,
    pub to: Option<usize>,
}

pub const COL_X: [f32; 5] = [0.0, 5.0, 8.5, 12.0, 16.0];
pub const COL_W: [f32; 5] = [4.8, 3.3, 3.3, 3.8, 4.8];

pub struct State {
    pub preset: usize,
    pub cells: Vec<u8>,
    /// tape coordinate of `cells[0]`
    pub lo: i32,
    pub head: i32,
    pub st: usize,
    pub steps: u32,
    pub budget: f32,
    pub running: bool,
    pub halted: Option<Why>,
    pub fuel: u32,
    pub rate: f32,
    pub rules: Vec<RuleRow>,
    pub pending: Option<usize>,
    pub conflict: Vec<bool>,
    /// tape coordinate of the left edge of the window (spring-followed)
    pub win: f32,
    pub vel: f32,
}

fn cycle(v: Option<usize>, n: usize) -> Option<usize> {
    if n == 0 {
        return None;
    }
    Some(v.map_or(0, |i| (i + 1) % n))
}

impl State {
    pub fn new(def: &ExDef) -> State {
        let preset = def.presets.iter().position(|p| p.id == def.runs).unwrap_or(0);
        let mut s = State {
            preset,
            cells: Vec::new(),
            lo: 0,
            head: 0,
            st: 0,
            steps: 0,
            budget: 0.0,
            running: false,
            halted: None,
            fuel: def.fuel,
            rate: def.rate,
            rules: Vec::new(),
            pending: None,
            conflict: Vec::new(),
            win: 0.0,
            vel: 0.0,
        };
        s.load(def, preset);
        s.win = s.target(def);
        s
    }

    pub fn preset<'a>(&self, def: &'a ExDef) -> &'a PresetDef {
        &def.presets[self.preset.min(def.presets.len() - 1)]
    }

    /// Replace everything but the speed with preset `i` (rules included).
    pub fn load(&mut self, def: &ExDef, i: usize) {
        self.preset = i.min(def.presets.len() - 1);
        let p = &def.presets[self.preset];
        self.rules = p.rules.iter().map(|r| RuleRow { from: Some(r.from), read: Some(r.read), write: Some(r.write), mv: r.mv, to: Some(r.to) }).collect();
        self.restart(def);
    }

    /// Back to the preset's tape, head and first state; rule edits stay.
    pub fn restart(&mut self, def: &ExDef) {
        let p = &def.presets[self.preset];
        let blank = blank_of(p);
        self.cells = p.tape.chars().map(|c| p.symbols.iter().position(|s| s.glyph.chars().next() == Some(c)).unwrap_or(blank) as u8).collect();
        if self.cells.is_empty() {
            self.cells.push(blank as u8);
        }
        self.lo = 0;
        self.head = p.head_at.clamp(-1_000_000, 1_000_000);
        self.touch(self.head, blank);
        self.st = 0;
        self.steps = 0;
        self.budget = 0.0;
        self.running = false;
        self.halted = None;
        self.fuel = def.fuel;
        self.vel = 0.0;
        self.rematch(def);
    }

    pub fn get(&self, i: i32, blank: usize) -> usize {
        let k = i as i64 - self.lo as i64;
        if k >= 0 && (k as usize) < self.cells.len() {
            self.cells[k as usize] as usize
        } else {
            blank
        }
    }

    /// Make cell `i` exist (grow both ways).
    fn touch(&mut self, i: i32, blank: usize) {
        if i < self.lo {
            let add = (self.lo - i) as usize;
            let mut v = vec![blank as u8; add];
            v.extend_from_slice(&self.cells);
            self.cells = v;
            self.lo = i;
        }
        let end = self.lo as i64 + self.cells.len() as i64;
        if (i as i64) >= end {
            self.cells.resize((i as i64 - self.lo as i64 + 1) as usize, blank as u8);
        }
    }

    pub fn set(&mut self, i: i32, sym: usize, blank: usize) {
        self.touch(i, blank);
        self.cells[(i - self.lo) as usize] = sym as u8;
    }

    /// The rule that fires next, and the extra rules that can never fire because an earlier one has the same (From, Reads).
    pub fn rematch(&mut self, def: &ExDef) {
        let p = self.preset(def);
        let sym = self.get(self.head, blank_of(p));
        self.pending = self.rules.iter().position(|r| r.from == Some(self.st) && r.read == Some(sym));
        self.conflict = (0..self.rules.len())
            .map(|i| {
                let r = self.rules[i];
                r.from.is_some() && r.read.is_some() && self.rules[..i].iter().any(|q| q.from == r.from && q.read == r.read)
            })
            .collect();
    }

    /// One transition. False when halted (and why is set) or nothing fired.
    pub fn step(&mut self, def: &ExDef) -> bool {
        if self.halted.is_some() {
            return false;
        }
        if self.fuel == 0 {
            self.halted = Some(Why::Fuel);
            self.running = false;
            return false;
        }
        let Some(ri) = self.pending else {
            self.halted = Some(Why::NoRule);
            self.running = false;
            return false;
        };
        let r = self.rules[ri];
        let (p, blank) = (self.preset(def), blank_of(self.preset(def)));
        if let Some(w) = r.write {
            self.set(self.head, w, blank);
        }
        self.head = self.head.saturating_add(match r.mv {
            Dir::Left => -1,
            Dir::Right => 1,
            Dir::Stay => 0,
        });
        self.touch(self.head, blank);
        if let Some(t) = r.to {
            self.st = t;
        }
        self.steps += 1;
        self.fuel -= 1;
        if p.states.get(self.st).is_some_and(|s| s.halting) {
            self.halted = Some(Why::Accept);
            self.running = false;
        }
        self.rematch(def);
        true
    }

    fn target(&self, def: &ExDef) -> f32 {
        let n = def.part(PartKind::TapeView).map_or(15, |p| p.cells.n.max(1)) as f32;
        self.head as f32 - (n - 1.0) / 2.0
    }

    /// One fixed tick: accrue the budget of a running machine, run whole steps (at most `left` this frame), follow the head with the window.
    /// True when anything changed.
    pub fn tick(&mut self, def: &ExDef, c: &Ctx, left: &mut u32) -> bool {
        let mut changed = false;
        if self.running {
            self.budget += self.rate * TICK;
        }
        while self.budget >= 1.0 - 1e-4 && *left > 0 {
            self.budget = (self.budget - 1.0).max(0.0);
            if self.halted.is_some() {
                self.budget = 0.0;
                break;
            }
            *left -= 1;
            changed |= self.step(def);
        }
        if self.halted.is_some() {
            self.budget = 0.0;
        }
        // critically damped follow
        let target = self.target(def);
        if c.reduced {
            changed |= self.win != target;
            self.win = target;
            self.vel = 0.0;
        } else if (self.win - target).abs() > 1e-3 || self.vel.abs() > 1e-3 {
            let w = def.omega.max(0.1);
            let a = -w * w * (self.win - target) - 2.0 * w * self.vel;
            self.vel += a * TICK;
            self.win += self.vel * TICK;
            if (self.win - target).abs() <= 1e-3 && self.vel.abs() <= 1e-2 {
                self.win = target;
                self.vel = 0.0;
            }
            changed = true;
        }
        changed
    }

    pub fn animating(&self, def: &ExDef) -> bool {
        self.running || self.budget >= 1.0 - 1e-4 || (self.win - self.target(def)).abs() > 1e-3 || self.vel.abs() > 1e-3
    }

    // ---- controls ----

    pub fn verb(&mut self, def: &ExDef, part: &Part) {
        match part.verb {
            Some(Verb::Step) => self.budget += 1.0,
            Some(Verb::Run) => {
                if self.halted.is_none() {
                    self.running = !self.running;
                } else {
                    self.running = false;
                }
            }
            Some(Verb::Reset) => self.restart(def),
            Some(Verb::Load) => {
                if let Some(i) = def.presets.iter().position(|p| p.id == part.loads) {
                    self.load(def, i);
                }
            }
            _ => {}
        }
    }

    pub fn set_rate(&mut self, v: f32) {
        if v.is_finite() {
            self.rate = v.clamp(0.05, 200.0);
        }
    }

    fn rule_cycle(&mut self, def: &ExDef, r: usize, f: u8) {
        let p = &def.presets[self.preset];
        let (ns, ny) = (p.states.len(), p.symbols.len());
        let Some(row) = self.rules.get_mut(r) else { return };
        match f {
            0 => row.from = cycle(row.from, ns),
            1 => row.read = cycle(row.read, ny),
            2 => row.write = cycle(row.write, ny),
            3 => {
                row.mv = match row.mv {
                    Dir::Left => Dir::Right,
                    Dir::Right => Dir::Stay,
                    Dir::Stay => Dir::Left,
                }
            }
            _ => row.to = cycle(row.to, ns),
        }
        self.rematch(def);
    }

    /// A click completed on `t`. True when the exhibit state changed.
    pub fn activate(&mut self, def: &ExDef, t: Target) -> bool {
        let (p, blank) = (self.preset(def), blank_of(self.preset(def)));
        let nsym = p.symbols.len();
        match t {
            Target::Cell(i) => {
                let cur = self.get(i, blank);
                self.set(i, (cur + 1) % nsym, blank);
                self.rematch(def);
                true
            }
            Target::RuleField(r, f) => {
                self.rule_cycle(def, r, f);
                true
            }
            Target::RuleDelete(r) => {
                if r < self.rules.len() {
                    self.rules.remove(r);
                    self.rematch(def);
                }
                true
            }
            Target::RuleAdd => {
                let max = def.part(PartKind::RuleTable).map_or(8, |p| p.rows.max) as usize;
                if self.rules.len() < max {
                    self.rules.push(RuleRow { from: None, read: None, write: None, mv: Dir::Right, to: None });
                    self.rematch(def);
                }
                true
            }
            _ => false,
        }
    }

    /// Head drag: snap the head to the cell under tape-local x (em). True when it moved.
    pub fn drag_head(&mut self, def: &ExDef, x: f32) -> bool {
        let Some(t) = def.part(PartKind::TapeView) else { return false };
        let pitch = t.cells.w + t.cells.gap;
        let i = (self.win + (x - t.place[0]) / pitch).floor();
        let i = i.clamp(-1.0e6, 1.0e6) as i32;
        if i == self.head {
            return false;
        }
        let blank = blank_of(self.preset(def));
        self.head = i;
        self.touch(i, blank);
        self.rematch(def);
        true
    }

    // ---- hit regions and drawing ----

    fn cell_rect(&self, t: &Part, i: i32) -> Option<[f32; 4]> {
        let [x, y, w, h] = t.place;
        let pitch = t.cells.w + t.cells.gap;
        let cx = x + (i as f32 - self.win) * pitch;
        let (x0, x1) = (cx.max(x), (cx + t.cells.w).min(x + w));
        (x1 - x0 >= 0.15).then_some([x0, y, x1 - x0, h])
    }

    fn head_rect(&self, def: &ExDef) -> Option<[f32; 4]> {
        let (t, hm) = (def.part(PartKind::TapeView)?, def.part(PartKind::HeadMark)?);
        let pitch = t.cells.w + t.cells.gap;
        let cx = t.place[0] + (self.head as f32 - self.win) * pitch + t.cells.w / 2.0;
        let w = hm.place[2];
        let x0 = (cx - w / 2.0).max(t.place[0]);
        let x1 = (cx + w / 2.0).min(t.place[0] + t.place[2]);
        (x1 > x0).then_some([x0, hm.place[1], x1 - x0, hm.place[3]])
    }

    fn visible_cells(&self, t: &Part) -> std::ops::RangeInclusive<i32> {
        (self.win.floor() as i32 - 1)..=(self.win.ceil() as i32 + t.cells.n as i32 + 1)
    }

    fn row_y(&self, tab: &Part, r: usize) -> f32 {
        tab.place[1] + 1.3 + r as f32 * tab.rows.h
    }

    pub fn hits(&self, def: &ExDef, out: &mut Vec<Hit>) {
        if let Some(t) = def.part(PartKind::TapeView) {
            for i in self.visible_cells(t) {
                if let Some(r) = self.cell_rect(t, i) {
                    out.push(Hit { rect: r, layer: t.layer, target: Target::Cell(i) });
                }
            }
        }
        if let (Some(r), Some(h)) = (self.head_rect(def), def.part(PartKind::HeadMark)) {
            out.push(Hit { rect: r, layer: h.layer, target: Target::Head });
        }
        if let Some(tab) = def.part(PartKind::RuleTable) {
            let (px, pw) = (tab.place[0], tab.place[2]);
            let n = self.rules.len().min(tab.rows.max as usize);
            for r in 0..n {
                let y = self.row_y(tab, r);
                for f in 0..5u8 {
                    out.push(Hit { rect: [px + COL_X[f as usize], y, COL_W[f as usize], tab.rows.h - 0.1], layer: tab.layer, target: Target::RuleField(r, f) });
                }
                out.push(Hit { rect: [px + pw - 1.8, y, 1.8, tab.rows.h - 0.1], layer: tab.layer, target: Target::RuleDelete(r) });
            }
            if self.rules.len() < tab.rows.max as usize {
                out.push(Hit { rect: [px, self.row_y(tab, self.rules.len()), 5.0, tab.rows.h - 0.1], layer: tab.layer, target: Target::RuleAdd });
            }
        }
    }

    pub fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList) {
        let p = self.preset(def);
        let blank = blank_of(p);
        let hov = |t: Target| if ui.hover == Some(t) { F_HOVER } else { 0 } | if ui.pressed == Some(t) { F_PRESSED } else { 0 };
        if let Some(t) = def.part(PartKind::TapeView) {
            for i in self.visible_cells(t) {
                let Some(r) = self.cell_rect(t, i) else { continue };
                let sym = self.get(i, blank);
                let head = i == self.head;
                dl.rrect(r, 0.35, if head { ACCENT_TINT } else { PANEL_HI }, hov(Target::Cell(i)));
                let cx = t.place[0] + (i as f32 - self.win) * (t.cells.w + t.cells.gap) + t.cells.w / 2.0;
                if cx >= t.place[0] && cx <= t.place[0] + t.place[2] {
                    let tone = if head { ACCENT } else if sym == blank { INK3 } else { INK };
                    dl.label(cx, t.place[1] + t.place[3] / 2.0 + 0.45, 1.3, 0.0, &p.symbols[sym].glyph, tone, ALIGN_CENTRE | F_MONO | F_BOLD);
                }
                if head {
                    dl.ring(r, 0.35, 0.12, ACCENT);
                }
            }
        }
        if let (Some(r), Some(_)) = (self.head_rect(def), def.part(PartKind::HeadMark)) {
            let cx = r[0] + r[2] / 2.0;
            dl.arrow(cx, r[1] + r[3], 0.0, -r[3], 0.14, ACCENT);
            dl.dot(cx, r[1] + r[3], 0.35, ACCENT);
        }
        if let Some(s) = def.part(PartKind::StatusLine) {
            let why = match self.halted {
                Some(Why::Accept) => "  halted: accept",
                Some(Why::NoRule) => "  halted: no rule",
                Some(Why::Fuel) => "  halted: out of fuel",
                None if self.running => "  running",
                None => "",
            };
            let sname = p.states.get(self.st).map_or("?", |s| s.name.as_str());
            dl.label(s.place[0], s.place[1] + 0.9, 0.9, s.place[2], &format!("step {}   state {sname}{why}", self.steps), INK2, F_MONO);
        }
        if let Some(tab) = def.part(PartKind::RuleTable) {
            let (px, pw) = (tab.place[0], tab.place[2]);
            for (f, name) in ["from", "reads", "writes", "moves", "to"].iter().enumerate() {
                dl.label(px + COL_X[f] + 0.2, tab.place[1] + 0.9, 0.75, 0.0, name, INK3, 0);
            }
            let n = self.rules.len().min(tab.rows.max as usize);
            for r in 0..n {
                let row = self.rules[r];
                let y = self.row_y(tab, r);
                let rh = tab.rows.h - 0.1;
                let pend = self.pending == Some(r);
                if pend {
                    dl.rrect([px - 0.3, y - 0.05, pw - 1.6, rh + 0.1], 0.3, ACCENT_TINT, F_PENDING);
                }
                let sname = |i: Option<usize>| i.and_then(|i| p.states.get(i)).map_or("?".to_string(), |s| s.name.clone());
                let yname = |i: Option<usize>| i.and_then(|i| p.symbols.get(i)).map_or("?".to_string(), |s| s.glyph.clone());
                let mvname = match row.mv {
                    Dir::Left => "left",
                    Dir::Right => "right",
                    Dir::Stay => "stay",
                };
                let texts = [sname(row.from), yname(row.read), yname(row.write), mvname.to_string(), sname(row.to)];
                for f in 0..5u8 {
                    let rect = [px + COL_X[f as usize], y, COL_W[f as usize], rh];
                    let t = Target::RuleField(r, f);
                    let unset = texts[f as usize] == "?";
                    dl.rrect(rect, 0.3, PANEL_HI, hov(t) | if pend { F_PENDING } else { 0 } | if self.conflict[r] { F_DIM } else { 0 });
                    let tone = if unset { INK3 } else if pend { ACCENT } else { INK };
                    dl.label(rect[0] + rect[2] / 2.0, y + rh / 2.0 + 0.3, 0.85, rect[2] - 0.2, &texts[f as usize], tone, ALIGN_CENTRE | F_MONO);
                }
                if self.conflict[r] {
                    dl.label(px + 20.8, y + rh / 2.0 + 0.3, 0.75, 0.0, "never fires", ACCENT2, 0);
                }
                let del = Target::RuleDelete(r);
                dl.rrect([px + pw - 1.8, y, 1.8, rh], 0.3, PANEL_HI, hov(del));
                dl.label(px + pw - 0.9, y + rh / 2.0 + 0.3, 0.9, 0.0, "×", INK2, ALIGN_CENTRE);
            }
            if self.rules.len() < tab.rows.max as usize {
                let y = self.row_y(tab, self.rules.len());
                let rect = [px, y, 5.0, tab.rows.h - 0.1];
                dl.rrect(rect, 0.3, PANEL_HI, hov(Target::RuleAdd));
                dl.label(rect[0] + 2.5, y + rect[3] / 2.0 + 0.3, 0.85, 4.8, "+ rule", INK2, ALIGN_CENTRE);
            }
        }
    }

    // ---- snapshot ----

    pub fn snapshot(&self, def: &ExDef) -> String {
        let p = self.preset(def);
        let cells: String = self.cells.iter().map(|&c| std::char::from_digit(c as u32, 36).unwrap_or('0')).collect();
        let opt = |v: Option<usize>| v.map_or("-".to_string(), |i| i.to_string());
        let rules: Vec<String> = self.rules.iter().map(|r| format!("{}.{}.{}.{}.{}", opt(r.from), opt(r.read), opt(r.write), r.mv as u8, opt(r.to))).collect();
        let halt = match self.halted {
            None => 0,
            Some(Why::Accept) => 1,
            Some(Why::NoRule) => 2,
            Some(Why::Fuel) => 3,
        };
        format!("t1|{}|{}|{}|{}|{}|{}|{}|{:08x}|{}|{}", p.id, self.lo, self.head, self.st, self.steps, halt, self.fuel, self.rate.to_bits(), cells, rules.join(";"))
    }

    /// Replace the state from a payload. False (state untouched) when malformed or inconsistent with the script.
    pub fn restore(&mut self, def: &ExDef, payload: &str) -> bool {
        self.try_restore(def, payload).is_some()
    }

    fn try_restore(&mut self, def: &ExDef, payload: &str) -> Option<()> {
        let f: Vec<&str> = payload.split('|').collect();
        if f.len() != 11 || f[0] != "t1" {
            return None;
        }
        let preset = def.presets.iter().position(|p| p.id == f[1])?;
        let p = &def.presets[preset];
        let lo: i32 = snapshot::num(f[2])?;
        let head: i32 = snapshot::num(f[3])?;
        let st: usize = snapshot::num(f[4])?;
        let steps: u32 = snapshot::num(f[5])?;
        let halt: u8 = snapshot::num(f[6])?;
        let fuel: u32 = snapshot::num(f[7])?;
        let rate = f32::from_bits(snapshot::hex(f[8])?);
        if lo.abs() > 1_000_000 || head.abs() > 1_000_000 || st >= p.states.len() || halt > 3 || !rate.is_finite() || fuel > def.fuel.max(1) * 4 {
            return None;
        }
        let mut cells = Vec::new();
        for c in f[9].chars() {
            let d = c.to_digit(36)? as usize;
            (d < p.symbols.len()).then_some(())?;
            cells.push(d as u8);
        }
        (cells.len() <= 100_000).then_some(())?;
        let opt = |s: &str, n: usize| -> Option<Option<usize>> {
            if s == "-" {
                return Some(None);
            }
            let v: usize = s.parse().ok()?;
            (v < n).then_some(Some(v))
        };
        let mut rules = Vec::new();
        if !f[10].is_empty() {
            for r in f[10].split(';') {
                let q: Vec<&str> = r.split('.').collect();
                (q.len() == 5).then_some(())?;
                let mv = match q[3] {
                    "0" => Dir::Left,
                    "1" => Dir::Right,
                    "2" => Dir::Stay,
                    _ => return None,
                };
                rules.push(RuleRow { from: opt(q[0], p.states.len())?, read: opt(q[1], p.symbols.len())?, write: opt(q[2], p.symbols.len())?, mv, to: opt(q[4], p.states.len())? });
            }
        }
        (rules.len() <= 64).then_some(())?;
        self.preset = preset;
        self.cells = cells;
        self.lo = lo;
        self.head = head;
        self.st = st;
        self.steps = steps;
        self.halted = match halt {
            1 => Some(Why::Accept),
            2 => Some(Why::NoRule),
            3 => Some(Why::Fuel),
            _ => None,
        };
        self.fuel = fuel;
        self.rate = rate;
        self.rules = rules;
        self.budget = 0.0;
        self.running = false;
        self.vel = 0.0;
        self.touch(self.head, blank_of(p));
        self.rematch(def);
        self.win = self.target(def);
        Some(())
    }
}

pub fn blank_of(p: &PresetDef) -> usize {
    p.symbols.iter().position(|s| s.blank).unwrap_or(0)
}
