//! Generic input: pointer routing by descending Layer with capture, hover and pressed; keyboard focus over the Control parts.
use super::{draw::*, kind_tape::Why, model::*, snapshot, Ex, Family};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    Part(usize),
    Cell(i32),
    Head,
    RuleField(usize, u8),
    RuleDelete(usize),
    RuleAdd,
    /// a thing of a machine's view (family-defined index and kind)
    Item(usize, u8),
}

#[derive(Clone, Copy, Debug)]
pub struct Hit {
    pub rect: [f32; 4],
    pub layer: u32,
    pub target: Target,
}

#[derive(Default)]
pub struct Ui {
    pub hover: Option<Target>,
    pub pressed: Option<Target>,
    pub capture: Option<Target>,
    /// the exhibit holds keyboard focus
    pub focus: bool,
    /// the selected control part (keyboard)
    pub sel: Option<usize>,
}

pub const CONSUMED: u32 = 1;
pub const CAPTURE: u32 = 2;
pub const CURSOR_SHIFT: u32 = 2;
pub const CUR_POINTER: u32 = 1;
pub const CUR_GRAB: u32 = 2;
pub const CUR_GRABBING: u32 = 3;
pub const CUR_EW: u32 = 4;

pub const KEY_ENTER: u32 = 13;
pub const KEY_ESC: u32 = 27;
pub const KEY_TAB: u32 = 9;
pub const KEY_LEFT: u32 = 0x100;
pub const KEY_RIGHT: u32 = 0x101;
pub const KEY_UP: u32 = 0x102;
pub const KEY_DOWN: u32 = 0x103;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum KeyResult {
    Ignored,
    Consumed,
    /// Esc: the exhibit gives up keyboard focus
    Release,
}

fn inside(r: [f32; 4], x: f32, y: f32) -> bool {
    x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3]
}

impl Ex {
    pub fn hits(&self) -> Vec<Hit> {
        let mut v = Vec::new();
        if let Family::Timeline(t) = &self.fam {
            if !t.interactive() {
                return v;
            }
        }
        for (i, p) in self.def.parts.iter().enumerate() {
            if p.control() {
                v.push(Hit { rect: p.place, layer: p.layer, target: Target::Part(i) });
            }
        }
        match &self.fam {
            Family::Tape(s) => s.hits(&self.def, &mut v),
            Family::Machine(d) => d.core.hits(&self.def, &mut v),
            _ => {}
        }
        v
    }

    /// The topmost hit region at (x, y): highest layer, later declaration on a tie.
    pub fn hit_at(&self, x: f32, y: f32) -> Option<Hit> {
        self.hits().into_iter().filter(|h| inside(h.rect, x, y)).max_by_key(|h| h.layer)
    }

    fn draggable(&self, t: Target) -> bool {
        match t {
            Target::Head => true,
            Target::Part(i) => self.def.parts.get(i).is_some_and(|p| p.kind == PartKind::Slider),
            _ => false,
        }
    }

    fn cursor_of(&self, t: Target, captured: bool) -> u32 {
        match t {
            Target::Part(i) if self.def.parts.get(i).is_some_and(|p| p.kind == PartKind::Slider) => CUR_EW,
            Target::Head => {
                if captured {
                    CUR_GRABBING
                } else {
                    CUR_GRAB
                }
            }
            _ => CUR_POINTER,
        }
    }

    pub fn touch(&mut self) {
        self.dirty = true;
    }
    pub fn touch_state(&mut self) {
        self.dirty = true;
        self.changed = true;
    }

    /// Set a slider from a pointer x (exhibit-local em). True when the value moved.
    fn slide(&mut self, i: usize, x: f32) -> bool {
        let Some(p) = self.def.parts.get(i) else { return false };
        let f = if p.place[2] > 0.0 { ((x - p.place[0]) / p.place[2]).clamp(0.0, 1.0) } else { 0.0 };
        let (bind, range) = (p.bind, p.range);
        self.set_bound(bind, range, f)
    }

    fn set_bound(&mut self, bind: Bind, range: [f32; 2], f: f32) -> bool {
        match (&mut self.fam, bind) {
            (Family::Tape(s), Bind::RateHz) => {
                let v = range[0] + f * (range[1] - range[0]);
                let before = s.rate;
                s.set_rate(v);
                s.rate != before
            }
            (Family::Machine(d), Bind::RateHz) => {
                let v = range[0] + f * (range[1] - range[0]);
                let before = d.rate;
                d.set_rate(v);
                d.rate != before
            }
            (Family::Timeline(t), Bind::ClockT) => {
                let before = t.t;
                t.set_t(f * t.duration);
                t.t != before
            }
            _ => false,
        }
    }

    fn bound_frac(&self, p: &Part) -> f32 {
        match (&self.fam, p.bind) {
            (Family::Tape(s), Bind::RateHz) => ((s.rate - p.range[0]) / (p.range[1] - p.range[0]).max(1e-6)).clamp(0.0, 1.0),
            (Family::Machine(d), Bind::RateHz) => ((d.rate - p.range[0]) / (p.range[1] - p.range[0]).max(1e-6)).clamp(0.0, 1.0),
            (Family::Timeline(t), Bind::ClockT) => {
                if t.duration > 0.0 {
                    (t.t / t.duration).clamp(0.0, 1.0)
                } else {
                    0.0
                }
            }
            _ => 0.0,
        }
    }

    pub fn frac_of(&self, i: usize) -> f32 {
        self.def.parts.get(i).map_or(0.0, |p| self.bound_frac(p))
    }

    fn drag_to(&mut self, t: Target, x: f32, _y: f32) {
        let moved = match t {
            Target::Part(i) => self.slide(i, x),
            Target::Head => match &mut self.fam {
                Family::Tape(s) => s.drag_head(&self.def, x),
                _ => false,
            },
            _ => false,
        };
        if moved {
            self.touch_state();
        }
        self.touch();
    }

    /// Fire a button.
    pub fn press(&mut self, i: usize) {
        let Some(part) = self.def.parts.get(i).cloned() else { return };
        match &mut self.fam {
            Family::Tape(s) => s.verb(&self.def, &part),
            Family::Machine(d) => d.verb(&self.def, &part),
            Family::Timeline(t) => match part.verb {
                Some(Verb::Run) => t.toggle(),
                Some(Verb::Home) => t.home(),
                _ => {}
            },
        }
        self.touch_state();
    }

    fn activate(&mut self, t: Target) {
        match t {
            Target::Part(i) => {
                if self.def.parts.get(i).is_some_and(|p| p.kind == PartKind::Button) {
                    self.ui.sel = Some(i);
                    self.press(i);
                }
            }
            other => {
                let did = match &mut self.fam {
                    Family::Tape(s) => s.activate(&self.def, other),
                    Family::Machine(d) => d.activate(&self.def, other),
                    _ => false,
                };
                if did {
                    self.touch_state();
                }
            }
        }
    }

    /// `exhibit_pointer`: kind 0 move, 1 down, 2 up, 3 leave. Returns the XRESULT bits.
    pub fn pointer(&mut self, kind: u32, x: f32, y: f32) -> u32 {
        let result = |c: u32, consumed: bool, capture: bool| (consumed as u32 * CONSUMED) | (capture as u32 * CAPTURE) | (c << CURSOR_SHIFT);
        match kind {
            3 => {
                // leave and cancel (the router sends leave for a cancelled pointer): the press and any capture end without activating
                let was = self.ui.hover.take().is_some() | self.ui.pressed.take().is_some() | self.ui.capture.take().is_some();
                if was {
                    self.touch();
                }
                0
            }
            0 => {
                if let Some(c) = self.ui.capture {
                    self.drag_to(c, x, y);
                    return result(self.cursor_of(c, true), true, true);
                }
                let h = self.hit_at(x, y).map(|h| h.target);
                if h != self.ui.hover {
                    self.ui.hover = h;
                    self.touch();
                }
                h.map_or(0, |t| result(self.cursor_of(t, false), true, false))
            }
            1 => {
                let Some(h) = self.hit_at(x, y) else { return 0 };
                self.ui.pressed = Some(h.target);
                self.ui.hover = Some(h.target);
                if let Target::Part(i) = h.target {
                    if self.def.parts[i].control() {
                        self.ui.sel = Some(i);
                    }
                }
                self.touch();
                if self.draggable(h.target) {
                    self.ui.capture = Some(h.target);
                    self.drag_to(h.target, x, y);
                    return result(self.cursor_of(h.target, true), true, true);
                }
                result(self.cursor_of(h.target, false), true, false)
            }
            2 => {
                if let Some(c) = self.ui.capture.take() {
                    self.drag_to(c, x, y);
                    self.ui.pressed = None;
                    self.touch();
                    return result(self.cursor_of(c, false), true, false);
                }
                let Some(was) = self.ui.pressed.take() else { return 0 };
                self.touch();
                let under = self.hit_at(x, y).map(|h| h.target);
                if under == Some(was) {
                    self.activate(was);
                }
                result(under.map_or(0, |t| self.cursor_of(t, false)), true, false)
            }
            _ => 0,
        }
    }

    fn controls(&self) -> Vec<usize> {
        if let Family::Timeline(t) = &self.fam {
            if !t.interactive() {
                return Vec::new();
            }
        }
        (0..self.def.parts.len()).filter(|&i| self.def.parts[i].control()).collect()
    }

    /// `exhibit_key`. Only called while this exhibit has keyboard focus.
    pub fn key(&mut self, code: u32, mods: u32) -> KeyResult {
        if !self.ui.focus {
            return KeyResult::Ignored;
        }
        let ctl = self.controls();
        let cur = self.ui.sel.and_then(|s| ctl.iter().position(|&c| c == s));
        match code {
            KEY_ESC => {
                self.ui.focus = false;
                self.touch();
                KeyResult::Release
            }
            KEY_TAB => {
                let next = if mods & 1 != 0 { cur.and_then(|c| c.checked_sub(1)) } else { cur.map_or(Some(0), |c| (c + 1 < ctl.len()).then_some(c + 1)) };
                match next.and_then(|n| ctl.get(n)) {
                    Some(&i) => {
                        self.ui.sel = Some(i);
                        self.touch();
                        KeyResult::Consumed
                    }
                    None => KeyResult::Ignored,
                }
            }
            KEY_LEFT | KEY_RIGHT => {
                let dir = if code == KEY_RIGHT { 1.0 } else { -1.0 };
                match self.ui.sel.and_then(|i| self.def.parts.get(i).map(|p| (i, p.kind, p.bind, p.range))) {
                    Some((i, PartKind::Slider, bind, range)) => {
                        let f = (self.frac_of(i) + dir * 0.05).clamp(0.0, 1.0);
                        if self.set_bound(bind, range, f) {
                            self.touch_state();
                        }
                        KeyResult::Consumed
                    }
                    _ => self.move_sel(&ctl, cur, dir > 0.0),
                }
            }
            KEY_UP | KEY_DOWN => self.move_sel(&ctl, cur, code == KEY_DOWN),
            _ => {
                let lower = char::from_u32(code).map(|c| c.to_ascii_lowercase() as u32).unwrap_or(code);
                if let Some(&i) = ctl.iter().find(|&&i| self.def.parts[i].key != 0 && self.def.parts[i].key == lower) {
                    self.ui.sel = Some(i);
                    if self.def.parts[i].kind == PartKind::Button {
                        self.press(i);
                    }
                    return KeyResult::Consumed;
                }
                if code == KEY_ENTER || code == 32 {
                    if let Some(i) = self.ui.sel.filter(|&i| self.def.parts.get(i).is_some_and(|p| p.kind == PartKind::Button)) {
                        self.press(i);
                        return KeyResult::Consumed;
                    }
                }
                KeyResult::Ignored
            }
        }
    }

    fn move_sel(&mut self, ctl: &[usize], cur: Option<usize>, forward: bool) -> KeyResult {
        if ctl.is_empty() {
            return KeyResult::Ignored;
        }
        let n = match (cur, forward) {
            (None, _) => 0,
            (Some(c), true) => (c + 1) % ctl.len(),
            (Some(c), false) => (c + ctl.len() - 1) % ctl.len(),
        };
        self.ui.sel = Some(ctl[n]);
        self.touch();
        KeyResult::Consumed
    }

    // ---- drawing ----

    pub fn pack(&self, dl: &mut DrawList) {
        dl.clear();
        let (fw, fh) = (self.def.frame[0], self.def.frame[1]);
        let hov = |t: Target| if self.ui.hover == Some(t) { F_HOVER } else { 0 } | if self.ui.pressed == Some(t) { F_PRESSED } else { 0 };
        match &self.fam {
            Family::Tape(s) => {
                dl.rrect([0.0, 0.0, fw, fh], 0.8, PANEL, 0);
                s.draw(&self.def, &self.ui, dl);
                dl.label(1.0, fh - 0.5, 0.75, fw - 2.0, &self.def.caption, INK3, 0);
            }
            Family::Machine(d) => {
                dl.rrect([0.0, 0.0, fw, fh], 0.8, PANEL, 0);
                d.draw(&self.def, &self.ui, dl);
                dl.label(1.0, fh - 0.5, 0.75, fw - 2.0, &self.def.caption, INK3, 0);
            }
            Family::Timeline(t) => {
                if !t.interactive() {
                    return;
                }
            }
        }
        for (i, p) in self.def.parts.iter().enumerate() {
            let r = p.place;
            let t = Target::Part(i);
            match p.kind {
                PartKind::Button => {
                    let active = match (&self.fam, p.verb) {
                        (Family::Tape(s), Some(Verb::Run)) => s.running,
                        (Family::Timeline(tl), Some(Verb::Run)) => tl.play,
                        (Family::Tape(s), Some(Verb::Load)) => s.preset(&self.def).id == p.loads,
                        (Family::Machine(d), Some(Verb::Run)) => d.running,
                        (Family::Machine(d), Some(Verb::Load)) => self.def.preset_ids.get(d.preset).is_some_and(|id| *id == p.loads),
                        (Family::Machine(d), Some(Verb::Toggle)) => d.core.toggled(),
                        _ => false,
                    };
                    let flags = hov(t) | if active { F_SELECTED } else { 0 };
                    dl.rrect(r, 0.5, PANEL_HI, flags);
                    let text = if active && matches!(p.verb, Some(Verb::Run) | Some(Verb::Toggle)) && !p.label_alt.is_empty() { &p.label_alt } else { &p.label };
                    dl.label(r[0] + r[2] / 2.0, r[1] + r[3] / 2.0 + 0.3, 0.85, r[2] - 0.3, text, if active { ACCENT } else { INK }, ALIGN_CENTRE);
                }
                PartKind::Slider => {
                    let f = self.bound_frac(p);
                    let ty = if p.label.is_empty() { r[1] + r[3] / 2.0 } else { r[1] + r[3] - 0.5 };
                    if !p.label.is_empty() {
                        dl.label(r[0], r[1] + 0.6, 0.7, 0.0, &p.label, INK3, 0);
                        let rate = match &self.fam {
                            Family::Tape(s) => Some(s.rate),
                            Family::Machine(d) => Some(d.rate),
                            _ => None,
                        };
                        if let (Some(rate), Some(Bind::RateHz)) = (rate, Some(p.bind)) {
                            dl.label(r[0] + r[2], r[1] + 0.6, 0.7, 0.0, &format!("{rate:.1}/s"), INK2, ALIGN_RIGHT | F_MONO);
                        }
                    }
                    dl.rrect([r[0], ty - 0.12, r[2], 0.24], 0.12, RULE, 0);
                    dl.rrect([r[0], ty - 0.12, (r[2] * f).max(0.24), 0.24], 0.12, ACCENT, 0);
                    dl.dot(r[0] + r[2] * f, ty, if hov(t) != 0 { 0.9 } else { 0.7 }, ACCENT);
                }
                _ => {}
            }
        }
        if self.ui.focus {
            if let Some(p) = self.ui.sel.and_then(|i| self.def.parts.get(i)) {
                let r = p.place;
                dl.ring([r[0] - 0.15, r[1] - 0.15, r[2] + 0.3, r[3] + 0.3], 0.6, 0.12, ACCENT);
            }
        }
    }

    pub fn halted_why(&self) -> Option<Why> {
        match &self.fam {
            Family::Tape(s) => s.halted,
            Family::Machine(d) => d.halted,
            _ => None,
        }
    }

    pub fn snapshot_text(&self) -> String {
        let payload = match &self.fam {
            Family::Tape(s) => s.snapshot(&self.def),
            Family::Machine(d) => d.snapshot(&self.def),
            Family::Timeline(t) => t.snapshot(),
        };
        snapshot::wrap(self.hash, &payload)
    }

    /// Restore a payload (no hash check; `restore_text` checks it). False: stale or malformed, state untouched.
    pub fn restore_payload(&mut self, payload: &str) -> bool {
        let ok = match &mut self.fam {
            Family::Tape(s) => s.restore(&self.def, payload),
            Family::Machine(d) => d.restore(&self.def, payload),
            Family::Timeline(t) => t.restore(payload),
        };
        if ok {
            self.touch_state();
        }
        ok
    }

    pub fn restore_text(&mut self, text: &str) -> bool {
        match snapshot::unwrap(text) {
            Some((h, p)) if h == self.hash => self.restore_payload(p),
            _ => false,
        }
    }
}
