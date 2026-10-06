//! The room's reader glue: which book is open, the book choreography's state buffer (`RS`) and the host event queue.
//! The page itself (blocks, scroll, fold, figures) is `reading.rs`; this file only runs the pipeline once per frame
//! (`tick` progresses the whole world, so the reading systems and the book systems advance together) and opens and closes books.
//! See docs/WORLD.md "Reader" and docs/BOOK.md.
use crate::Output;
use flecs_ecs::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

pub const STATE_LEN: usize = 64;
const EV_CLOSED: u32 = 2;

struct Rs {
    world: World,
    articles: Vec<u64>,
    events: VecDeque<u32>,
}

thread_local! {
    static RS: RefCell<Option<Rs>> = const { RefCell::new(None) };
    static STATE: RefCell<[f32; STATE_LEN]> = const { RefCell::new([0.0; STATE_LEN]) };
    // read by the glue between ticks (never borrow RS inside a system: the glue holds it around progress)
    static ACTIVE: Cell<i32> = const { Cell::new(-1) };
}

/// Keep the world alive and register the systems.
pub fn store(world: World, articles: Vec<u64>, out: &Output) {
    ACTIVE.with(|a| a.set(-1));
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        *s = [0.0; STATE_LEN];
        s[4] = -1.0;
        s[5] = -1.0;
    });

    crate::reading::setup(&world);
    crate::book::setup(&world, &articles, out);

    RS.with(|r| *r.borrow_mut() = Some(Rs { world, articles, events: VecDeque::new() }));
}

fn with<T>(f: impl FnOnce(&mut Rs) -> T) -> Option<T> {
    RS.with(|r| r.borrow_mut().as_mut().map(f))
}

fn active() -> i32 {
    ACTIVE.with(|a| a.get())
}

/// True once `world_build` has made the room (as opposed to the bare reading world of `reading_init`).
pub fn is_full() -> bool {
    RS.with(|r| r.borrow().is_some())
}

/// Open article `index` (input order): the book takes it off the shelf, or snaps to the open state for a cold deep link. 0 on success.
pub fn article_open(index: u32, snap: bool) -> u32 {
    with(|rs| {
        if index as usize >= rs.articles.len() {
            return 1;
        }
        let cur = active();
        if cur >= 0 && cur as u32 != index {
            finish_close(rs);
        }
        let other = (0..rs.articles.len()).find(|&i| i as u32 != index && !crate::book::is_home(&rs.world, rs.articles[i]));
        if let Some(i) = other {
            crate::book::reset(&rs.world, rs.articles[i]);
        }
        ACTIVE.with(|a| a.set(index as i32));
        // the book: a click may already have started the lift (book::begin); a cold deep link snaps to the end state
        if snap {
            crate::book::snap_open(&rs.world, rs.articles[index as usize]);
        } else {
            crate::book::want(&rs.world, rs.articles[index as usize], true);
        }
        crate::book::spawn_parts(&rs.world, rs.articles[index as usize]);
        0
    })
    .unwrap_or(1)
}

fn finish_close(rs: &mut Rs) {
    let cur = active();
    if cur < 0 {
        return;
    }
    crate::book::reset(&rs.world, rs.articles[cur as usize]);
    ACTIVE.with(|a| a.set(-1));
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        for i in [0, 1, 6, 7, 40, 41, 42, 43, 44, 45, 47] {
            s[i] = 0.0;
        }
        s[4] = -1.0;
        s[5] = -1.0;
    });
    rs.events.push_back(EV_CLOSED << 24);
}

pub fn article_close(snap: bool) {
    with(|rs| {
        let cur = active();
        if cur < 0 {
            for &id in &rs.articles {
                crate::book::want(&rs.world, id, false);
            }
            return;
        }
        if snap {
            finish_close(rs);
        } else {
            crate::book::want(&rs.world, rs.articles[cur as usize], false);
        }
    });
}

pub fn set_reading_pose(cx: f32, cy: f32, cz: f32, hw: f32, hh: f32) {
    with(|rs| crate::book::set_pose(&rs.world, cx, cy, cz, hw, hh));
}

/// One frame: the whole pipeline (book and reading systems) advances by `dt_ms` once.
pub fn tick(dt_ms: f32) {
    let dt = (dt_ms / 1000.0).clamp(0.0, 0.1);
    let Some(world) = with(|rs| rs.world.clone()) else { return };
    world.progress_time(dt);
    with(|rs| {
        let cur = active();
        if cur < 0 {
            // a click that was cancelled while its article was still loading: the lift reverses on its own, then the book is put away
            for &id in &rs.articles {
                crate::book::settle_idle(&rs.world, id);
            }
            return;
        }
        if crate::book::is_home(&rs.world, rs.articles[cur as usize]) {
            finish_close(rs);
        }
    });
}

pub fn event_poll() -> u32 {
    if let Some(b) = with(|rs| crate::book::poll(&rs.world)).flatten() {
        return b;
    }
    with(|rs| rs.events.pop_front()).flatten().unwrap_or(0)
}

pub fn state_ptr() -> *const f32 {
    STATE.with(|s| s.as_ptr() as *const f32)
}

pub fn entity_count() -> u32 {
    with(|rs| rs.world.count(flecs::Wildcard::ID).max(0) as u32).unwrap_or(0)
}

/// Run `f` on the renderer's state buffer (the book's systems write their slots through this).
pub fn with_state<T>(f: impl FnOnce(&mut [f32; STATE_LEN]) -> T) -> T {
    STATE.with(|s| f(&mut s.borrow_mut()))
}

/// A click: the book starts lifting at once, before the article bytes arrive.
pub fn book_begin(index: u32) {
    with(|rs| {
        if let Some(&id) = rs.articles.get(index as usize) {
            crate::book::begin(&rs.world, id);
        }
    });
}
