//! Render quality policy: which tier the device gets and how far it degrades. The host (room.ts) only reports
//! frame gaps and reads the verdicts; every threshold lives here.
//!
//! Low tier (touch devices): no progressive path tracing at rest, a short lightmap and probe bake, half the pixel
//! budget to start. Auto degrade: a smoothed frame gap above `SLOW_MS` for `SLOW_FRAMES` frames steps the pixel
//! multiplier down in proportion to how slow it is (a 1 fps device reaches the floor in a few frames, a 25 fps one
//! loses 15%). It never steps back up within a session.

use std::cell::Cell;

const SLOW_MS: f32 = 34.0;
const SLOW_FRAMES: u32 = 6;
/// A gap longer than this is the page idling, not a slow frame.
const IDLE_MS: f32 = 3000.0;
const FLOOR: f32 = 0.25;

#[derive(Clone, Copy)]
struct Quality {
    low: bool,
    scale: f32,
    ema: f32,
    slow: u32,
}

impl Quality {
    const fn new(low: bool) -> Self {
        Self { low, scale: if low { 0.5 } else { 1.0 }, ema: 16.0, slow: 0 }
    }

    /// Feed the gap since the previous animated frame; true when `scale` changed.
    fn frame(&mut self, gap_ms: f32) -> bool {
        if !(gap_ms.is_finite() && gap_ms > 0.0) || gap_ms >= IDLE_MS {
            return false;
        }
        self.ema += (gap_ms - self.ema) * 0.3;
        self.slow = if self.ema > SLOW_MS { self.slow + 1 } else { 0 };
        if self.slow > SLOW_FRAMES && self.scale > FLOOR {
            self.scale = (self.scale * (30.0 / self.ema).clamp(0.5, 0.85)).max(FLOOR);
            self.slow = 0;
            self.ema = 16.0;
            return true;
        }
        false
    }
}

thread_local! {
    static Q: Cell<Quality> = const { Cell::new(Quality::new(false)) };
}

/// `low` is 1 for a touch device (or the dev `?low` switch).
#[no_mangle]
pub extern "C" fn quality_init(low: u32) {
    Q.with(|q| q.set(Quality::new(low != 0)));
}

#[no_mangle]
pub extern "C" fn quality_low() -> u32 {
    Q.with(|q| q.get().low as u32)
}

/// Pixel-budget multiplier, 0.25..1.
#[no_mangle]
pub extern "C" fn quality_scale() -> f32 {
    Q.with(|q| q.get().scale)
}

/// Lightmap samples per texel at convergence.
#[no_mangle]
pub extern "C" fn quality_lm_spp() -> u32 {
    if Q.with(|q| q.get().low) { 96 } else { 640 }
}

/// Reflection-probe samples per texel at convergence.
#[no_mangle]
pub extern "C" fn quality_probe_spp() -> u32 {
    if Q.with(|q| q.get().low) { 32 } else { 256 }
}

/// Report the gap in ms since the previous animated frame. Returns 1 when the pixel multiplier just changed.
#[no_mangle]
pub extern "C" fn quality_frame(gap_ms: f32) -> u32 {
    Q.with(|q| {
        let mut v = q.get();
        let changed = v.frame(gap_ms);
        q.set(v);
        changed as u32
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_fps_reaches_the_floor_fast() {
        let mut q = Quality::new(true);
        let mut steps = 0;
        for _ in 0..200 {
            if q.frame(1000.0) {
                steps += 1;
            }
        }
        assert_eq!(q.scale, FLOOR);
        assert!(steps <= 3);
    }

    #[test]
    fn sixty_fps_never_degrades_and_idle_gaps_are_ignored() {
        let mut q = Quality::new(false);
        for i in 0..1000 {
            assert!(!q.frame(if i % 100 == 0 { 5000.0 } else { 16.7 }));
        }
        assert_eq!(q.scale, 1.0);
    }
}
