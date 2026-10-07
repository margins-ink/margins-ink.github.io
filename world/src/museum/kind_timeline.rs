//! The Timeline family: a clock over compiled art (every figure). Autoplay while live, a play button and a scrub slider.
use super::{model::*, snapshot, Ctx};

pub const LOOP: u32 = 0;
pub const ONCE: u32 = 1;
pub const SCRUB: u32 = 2;
pub const STATIC: u32 = 3;
/// Autoplay waits this long (s) after the last touch.
const USER_HOLD_S: f32 = 1.5;
const IDLE_GATE_S: f32 = 0.2;
const TICK: f32 = super::TICK;

pub struct State {
    pub t: f32,
    pub play: bool,
    pub hold: f32,
    pub mode: u32,
    pub duration: f32,
    pub poster: f32,
}

pub fn mode_of(s: &str) -> Option<u32> {
    Some(match s {
        "loop" => LOOP,
        "once" => ONCE,
        "scrub" => SCRUB,
        "static" => STATIC,
        _ => return None,
    })
}

impl State {
    pub fn new(mode: u32, duration: f32, poster: f32) -> State {
        let duration = if duration.is_finite() { duration.max(0.0) } else { 0.0 };
        State { t: poster.clamp(0.0, duration), play: mode == LOOP || mode == ONCE, hold: 0.0, mode, duration, poster }
    }
    pub fn from_def(def: &ExDef, mode: u32, duration: f32, poster: f32) -> State {
        match &def.clip {
            Some(c) if c.duration > 0.0 => State::new(mode_of(&c.mode).unwrap_or(mode), c.duration, c.poster),
            _ => State::new(mode, duration, poster),
        }
    }
    pub fn interactive(&self) -> bool {
        self.mode != STATIC
    }
    /// One fixed tick. True when `t` moved.
    pub fn tick(&mut self, c: &Ctx) -> bool {
        self.hold = (self.hold - TICK).max(0.0);
        if !(self.play && c.live && c.idle >= IDLE_GATE_S && self.hold <= 0.0) || c.reduced || self.mode == STATIC {
            return false;
        }
        let before = self.t;
        if self.mode == LOOP {
            self.t += TICK;
            if self.duration > 0.0 && self.t >= self.duration {
                self.t -= self.duration;
            }
        } else {
            self.t = (self.t + TICK).min(self.duration);
            if self.t >= self.duration {
                self.play = false;
            }
        }
        self.t != before
    }
    pub fn set_t(&mut self, t: f32) {
        self.t = if t.is_finite() { t.clamp(0.0, self.duration) } else { self.t };
        self.hold = USER_HOLD_S;
    }
    pub fn toggle(&mut self) {
        self.play = !self.play;
        self.hold = 0.0;
        if self.play && self.mode != LOOP && self.t >= self.duration {
            self.t = 0.0;
        }
    }
    pub fn home(&mut self) {
        self.t = self.poster.clamp(0.0, self.duration);
        self.hold = USER_HOLD_S;
    }
    pub fn reduced(&mut self) {
        self.t = self.poster.clamp(0.0, self.duration);
        self.play = false;
        self.hold = 0.0;
    }
    pub fn animating(&self, c: &Ctx) -> bool {
        self.play && c.live && self.mode != STATIC && !c.reduced
    }
    pub fn snapshot(&self) -> String {
        format!("t1|{:08x}|{}", self.t.to_bits(), self.play as u8)
    }
    pub fn restore(&mut self, payload: &str) -> bool {
        let mut it = payload.split('|');
        let (Some("t1"), Some(t), Some(p), None) = (it.next(), it.next(), it.next(), it.next()) else { return false };
        let (Some(bits), Some(play)) = (snapshot::hex(t), snapshot::num::<u8>(p)) else { return false };
        let t = f32::from_bits(bits);
        if !t.is_finite() || t < 0.0 || t > self.duration + 1e-3 || play > 1 {
            return false;
        }
        self.t = t;
        self.play = play == 1 && self.mode != STATIC;
        self.hold = 0.0;
        true
    }
}
