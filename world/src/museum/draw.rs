//! The draw list: 8 f32 per item (`XD` in abi.ts), exhibit-local em, plus the interned strings of the last pack.
#![allow(dead_code)] // the full shape, tone and flag table of abi.ts, whether or not an exhibit uses each yet

pub const STRIDE: usize = 8;
pub const MAX_ITEMS: usize = 400;

pub const RRECT: f32 = 0.0;
pub const CIRCLE: f32 = 1.0;
pub const LINE: f32 = 2.0;
pub const ARROW: f32 = 3.0;
pub const RING: f32 = 4.0;
pub const DOT: f32 = 5.0;
pub const LABEL: f32 = 6.0;
pub const HATCH: f32 = 7.0;

pub const PANEL: f32 = 0.0;
pub const INK: f32 = 1.0;
pub const INK2: f32 = 2.0;
pub const INK3: f32 = 3.0;
pub const ACCENT: f32 = 4.0;
pub const ACCENT2: f32 = 5.0;
pub const RULE: f32 = 6.0;
pub const GROUND: f32 = 7.0;
pub const ACCENT_TINT: f32 = 8.0;
pub const PANEL_HI: f32 = 9.0;
pub const ACCENT_DIM: f32 = 10.0;

pub const F_HOVER: u32 = 1;
pub const F_PRESSED: u32 = 2;
pub const F_SELECTED: u32 = 4;
pub const F_PENDING: u32 = 8;
pub const F_DIM: u32 = 16;
pub const F_MONO: u32 = 32;
pub const F_BOLD: u32 = 64;
pub const ALIGN_CENTRE: u32 = 1 << 8;
pub const ALIGN_RIGHT: u32 = 2 << 8;

#[derive(Default)]
pub struct DrawList {
    pub items: Vec<f32>,
    pub strings: Vec<String>,
    /// items refused because the list was full
    pub dropped: u32,
}

impl DrawList {
    pub fn clear(&mut self) {
        self.items.clear();
        self.strings.clear();
        self.dropped = 0;
    }
    pub fn count(&self) -> usize {
        self.items.len() / STRIDE
    }
    pub fn push(&mut self, it: [f32; 8]) {
        if self.count() >= MAX_ITEMS {
            self.dropped += 1;
            return;
        }
        self.items.extend_from_slice(&it);
    }
    pub fn intern(&mut self, s: &str) -> u32 {
        if let Some(i) = self.strings.iter().position(|x| x == s) {
            return i as u32;
        }
        self.strings.push(s.to_string());
        (self.strings.len() - 1) as u32
    }
    pub fn rrect(&mut self, r: [f32; 4], radius: f32, tone: f32, flags: u32) {
        self.push([r[0], r[1], r[2], r[3], RRECT, tone, flags as f32, radius]);
    }
    pub fn ring(&mut self, r: [f32; 4], radius: f32, _stroke: f32, tone: f32) {
        self.push([r[0], r[1], r[2], r[3], RING, tone, 0.0, radius]);
    }
    pub fn arrow(&mut self, x: f32, y: f32, dx: f32, dy: f32, stroke: f32, tone: f32) {
        self.push([x, y, dx, dy, ARROW, tone, 0.0, stroke]);
    }
    pub fn line(&mut self, x: f32, y: f32, dx: f32, dy: f32, stroke: f32, tone: f32) {
        self.push([x, y, dx, dy, LINE, tone, 0.0, stroke]);
    }
    pub fn dot(&mut self, x: f32, y: f32, d: f32, tone: f32) {
        self.push([x - d / 2.0, y - d / 2.0, d, d, DOT, tone, 0.0, 0.0]);
    }
    /// A label with its baseline anchor at (x, y), `size` em, `max_w` em (0 none); align per ALIGN_*.
    pub fn label(&mut self, x: f32, y: f32, size: f32, max_w: f32, text: &str, tone: f32, flags: u32) {
        self.push_label(x, y, size, max_w, text, tone, flags);
    }
    pub fn push_label(&mut self, x: f32, y: f32, size: f32, max_w: f32, text: &str, tone: f32, flags: u32) {
        if text.is_empty() {
            return;
        }
        let i = self.intern(text);
        self.push([x, y, max_w, size, LABEL, tone, flags as f32, i as f32]);
    }
}
