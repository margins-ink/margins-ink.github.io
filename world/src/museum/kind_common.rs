//! Shared driver of the stepper families (rewrite, graph, grid): the budget, Run and Step, the fuel, the speed, Reset and Load, the
//! snapshot envelope. A family implements `Core` (its state, one step, its edits, its picture); everything else is here.
use super::{draw::*, input::{Hit, Target, Ui}, kind_graph, kind_grid, kind_rewrite, kind_tape::Why, model::*, snapshot, TICK};

/// What one `Core::step` did.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Out {
    /// a transition happened (counts as a step)
    pub moved: bool,
    pub halt: Option<Why>,
}

/// What a click on a hit region did.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Act {
    None,
    /// something visible changed and the run goes on (a rename, a mode)
    Changed,
    /// the input changed: the run starts over (steps, halt and budget reset)
    Edit,
    /// the click was one step of the run
    Step(Option<Why>),
}

/// The driver's counters, for the status line.
#[derive(Clone, Copy, Debug)]
pub struct Run {
    pub steps: u32,
    pub halted: Option<Why>,
    pub running: bool,
    pub fuel: u32,
}

pub trait Core {
    /// Snapshot tag (first field of the payload).
    fn tag(&self) -> &'static str;
    /// Fresh state of preset `i`, edits discarded.
    fn load(&mut self, def: &ExDef, preset: usize);
    fn step(&mut self, def: &ExDef, preset: usize) -> Out;
    fn toggle(&mut self, _def: &ExDef, _preset: usize) -> Act {
        Act::None
    }
    fn toggled(&self) -> bool {
        false
    }
    fn activate(&mut self, def: &ExDef, preset: usize, t: Target, can_step: bool) -> Act;
    fn hits(&self, def: &ExDef, out: &mut Vec<Hit>);
    fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList);
    /// Advance a purely visual animation by one fixed tick (never part of the state or its hash).
    fn anim(&mut self, _dt: f32) {}
    fn animating(&self) -> bool {
        false
    }
    fn status(&self, def: &ExDef, run: &Run) -> String;
    /// Family payload (no `|` needed, but allowed: it is the tail of the envelope).
    fn save(&self) -> String;
    /// Replace the state from a payload; `steps` is the step count of the envelope. False (state untouched) when malformed.
    fn restore(&mut self, def: &ExDef, preset: usize, s: &str, steps: u32) -> bool;
}

pub struct Driver {
    pub core: Box<dyn Core>,
    pub preset: usize,
    pub steps: u32,
    pub budget: f32,
    pub running: bool,
    pub halted: Option<Why>,
    pub fuel: u32,
    pub rate: f32,
}

impl Driver {
    pub fn new(def: &ExDef) -> Driver {
        let preset = def.preset_ids.iter().position(|p| *p == def.runs).unwrap_or(0);
        let core: Box<dyn Core> = match def.fam {
            Fam::Rewrite => Box::new(kind_rewrite::Rw::new(def)),
            Fam::Graph => Box::new(kind_graph::Graph::new(def)),
            _ => Box::new(kind_grid::Grid::new(def)),
        };
        let mut d = Driver { core, preset, steps: 0, budget: 0.0, running: false, halted: None, fuel: def.fuel, rate: def.rate };
        d.load(def, preset);
        d
    }

    fn reset_counters(&mut self, def: &ExDef) {
        self.steps = 0;
        self.budget = 0.0;
        self.running = false;
        self.halted = None;
        self.fuel = def.fuel;
    }

    pub fn load(&mut self, def: &ExDef, i: usize) {
        self.preset = i.min(def.preset_ids.len().saturating_sub(1));
        self.core.load(def, self.preset);
        self.reset_counters(def);
    }

    fn run(&self) -> Run {
        Run { steps: self.steps, halted: self.halted, running: self.running, fuel: self.fuel }
    }

    /// One transition, honouring halt and fuel. True when anything changed.
    pub fn step_once(&mut self, def: &ExDef) -> bool {
        if self.halted.is_some() {
            return false;
        }
        if self.fuel == 0 {
            self.halted = Some(Why::Fuel);
            self.running = false;
            return true;
        }
        let out = self.core.step(def, self.preset);
        if out.moved {
            self.steps += 1;
            self.fuel -= 1;
        }
        if let Some(h) = out.halt {
            self.halted = Some(h);
            self.running = false;
        }
        out.moved || out.halt.is_some()
    }

    /// One fixed tick: accrue the budget of a running exhibit and run whole steps (at most `left` this frame). True when anything changed.
    pub fn tick(&mut self, def: &ExDef, left: &mut u32) -> bool {
        let mut changed = false;
        self.core.anim(TICK);
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
            changed |= self.step_once(def);
        }
        if self.halted.is_some() {
            self.budget = 0.0;
        }
        changed
    }

    pub fn animating(&self) -> bool {
        self.running || self.budget >= 1.0 - 1e-4 || self.core.animating()
    }

    pub fn verb(&mut self, def: &ExDef, part: &Part) {
        match part.verb {
            Some(Verb::Step) => self.budget += 1.0,
            Some(Verb::Run) => self.running = self.halted.is_none() && !self.running,
            Some(Verb::Reset) => self.load(def, self.preset),
            Some(Verb::Load) => {
                if let Some(i) = def.preset_ids.iter().position(|p| *p == part.loads) {
                    self.load(def, i);
                }
            }
            Some(Verb::Toggle) => {
                if self.core.toggle(def, self.preset) == Act::Edit {
                    self.reset_counters(def);
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

    /// A click completed on `t`. True when the state changed.
    pub fn activate(&mut self, def: &ExDef, t: Target) -> bool {
        let can = self.halted.is_none() && self.fuel > 0;
        match self.core.activate(def, self.preset, t, can) {
            Act::None => false,
            Act::Changed => true,
            Act::Edit => {
                self.reset_counters(def);
                true
            }
            Act::Step(h) => {
                self.steps += 1;
                self.fuel = self.fuel.saturating_sub(1);
                if let Some(h) = h {
                    self.halted = Some(h);
                    self.running = false;
                }
                true
            }
        }
    }

    pub fn draw(&self, def: &ExDef, ui: &Ui, dl: &mut DrawList) {
        if let Some(s) = def.part(PartKind::StatusLine) {
            dl.label(s.place[0], s.place[1] + 0.9, 0.72, s.place[2], &self.core.status(def, &self.run()), INK2, F_MONO);
        }
        self.core.draw(def, ui, dl);
    }

    pub fn snapshot(&self, def: &ExDef) -> String {
        let halt = match self.halted {
            None => 0,
            Some(Why::Accept) => 1,
            Some(Why::NoRule) => 2,
            Some(Why::Fuel) => 3,
        };
        let id = def.preset_ids.get(self.preset).map_or("", |s| s.as_str());
        format!("{}|{}|{}|{}|{}|{:08x}|{}", self.core.tag(), id, self.steps, halt, self.fuel, self.rate.to_bits(), self.core.save())
    }

    pub fn restore(&mut self, def: &ExDef, payload: &str) -> bool {
        let f: Vec<&str> = payload.splitn(7, '|').collect();
        if f.len() != 7 || f[0] != self.core.tag() {
            return false;
        }
        let Some(preset) = def.preset_ids.iter().position(|p| p == f[1]) else { return false };
        let (Some(steps), Some(halt), Some(fuel), Some(bits)) = (snapshot::num::<u32>(f[2]), snapshot::num::<u8>(f[3]), snapshot::num::<u32>(f[4]), snapshot::hex(f[5])) else { return false };
        let rate = f32::from_bits(bits);
        if halt > 3 || !rate.is_finite() || fuel > def.fuel.max(1) * 4 || steps > def.fuel.max(1) * 4 {
            return false;
        }
        if !self.core.restore(def, preset, f[6], steps) {
            return false;
        }
        self.preset = preset;
        self.steps = steps;
        self.halted = match halt {
            1 => Some(Why::Accept),
            2 => Some(Why::NoRule),
            3 => Some(Why::Fuel),
            _ => None,
        };
        self.fuel = fuel;
        self.rate = rate;
        self.budget = 0.0;
        self.running = false;
        true
    }
}

/// The part `View` of the exhibit, or the whole frame below the status line when the script declares none.
pub fn view(def: &ExDef) -> [f32; 4] {
    def.part(PartKind::View).map_or([1.0, 7.0, (def.frame[0] - 2.0).max(1.0), (def.frame[1] - 8.0).max(1.0)], |p| p.place)
}
