//! The reader: Reading/Scroll state, Page entities and the systems that animate them.
//! Systems: ReadingTween (spring), ScrollIntegrate (fling, clamp), SheetCull (Visible tag),
//! PackObjs (state buffer for the renderer). See docs/WORLD.md "Reader".
use crate::components::*;
use crate::Output;
use flecs_ecs::prelude::*;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;

pub const STATE_LEN: usize = 40;
const OMEGA: f32 = 9.0;
const EV_OPENED: u32 = 1;
const EV_CLOSED: u32 = 2;
const EV_SCROLL_END: u32 = 3;
const EV_PAGE: u32 = 4;

/// Shelf pose of an article's magazine, taken from the packed objs row.
#[derive(Clone, Copy)]
struct Mag {
    obj: u32,
    row: [f32; 28],
    lean: f32,
}

struct Rs {
    world: World,
    articles: Vec<u64>,
    pages: Vec<u64>,
    events: VecDeque<u32>,
    opened_sent: bool,
    last_page: i32,
    last_scroll: f32,
    moving: bool,
    page_count: u32,
    sheet_h: f32,
    gap: f32,
}

thread_local! {
    static RS: RefCell<Option<Rs>> = const { RefCell::new(None) };
    static STATE: RefCell<[f32; STATE_LEN]> = const { RefCell::new([0.0; STATE_LEN]) };
    // read by the systems (never borrow RS inside a system: the glue holds it around progress)
    static DT: Cell<f32> = const { Cell::new(0.0) };
    static ACTIVE: Cell<i32> = const { Cell::new(-1) };
    static VIEW_H: Cell<f32> = const { Cell::new(56.0) };
    static SCROLL_Y: Cell<f32> = const { Cell::new(0.0) };
    static SHEET_STEP: Cell<f32> = const { Cell::new(56.6) };
    static VIS: Cell<(i32, i32)> = const { Cell::new((-1, 0)) };
    static POSE: Cell<[f32; 5]> = const { Cell::new([0.0, 0.0, 0.0, 0.31, 0.434]) };
    static MAGS: RefCell<Vec<Option<Mag>>> = const { RefCell::new(Vec::new()) };
}

fn smoothstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn smootherstep(a: f32, b: f32, x: f32) -> f32 {
    let t = ((x - a) / (b - a)).clamp(0.0, 1.0);
    t * t * t * (t * (t * 6.0 - 15.0) + 10.0)
}
fn lerp(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

/// Keep the world alive and register the systems.
pub fn store(world: World, articles: Vec<u64>, out: &Output) {
    let mags: Vec<Option<Mag>> = out
        .links
        .iter()
        .map(|&o| {
            if o == u32::MAX {
                return None;
            }
            let b = o as usize * 28;
            let mut row = [0.0; 28];
            row.copy_from_slice(&out.objs[b..b + 28]);
            // rot row 2 of lean(a) is [0, sin a, cos a]
            Some(Mag { obj: o, row, lean: row[17].atan2(row[18]) })
        })
        .collect();
    ACTIVE.with(|a| a.set(-1));
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        *s = [0.0; STATE_LEN];
        s[4] = -1.0;
        s[5] = -1.0;
        if let Some(Some(m)) = mags.first() {
            s[12..40].copy_from_slice(&m.row);
        }
    });
    MAGS.with(|m| *m.borrow_mut() = mags);

    world.system_named::<&mut Reading>("ReadingTween").each(|r| {
        let dt = DT.with(|d| d.get());
        let x = r.t - r.target;
        if x.abs() < 1e-3 && r.vel.abs() < 1e-2 {
            r.t = r.target;
            r.vel = 0.0;
            return;
        }
        // exact critically damped spring step: no overshoot for any dt
        let e = (-OMEGA * dt).exp();
        let k = r.vel + OMEGA * x;
        r.t = r.target + (x + k * dt) * e;
        r.vel = (r.vel - OMEGA * k * dt) * e;
        if (r.t - r.target).abs() < 1e-3 {
            r.t = r.target;
            r.vel = 0.0;
        }
    });

    world.system_named::<(&Article, &mut Scroll)>("ScrollIntegrate").each(|(a, s)| {
        let dt = DT.with(|d| d.get());
        s.vel *= 0.95f32.powf(dt * 60.0);
        if s.vel.abs() < 0.05 {
            s.vel = 0.0;
        }
        s.target_em = (s.target_em + s.vel * dt).clamp(0.0, s.max_em.max(0.0));
        s.y_em = s.target_em;
        if ACTIVE.with(|c| c.get()) == a.index as i32 {
            SCROLL_Y.with(|c| c.set(s.y_em));
        }
    });

    world.system_named::<&Page>("SheetCull").each_entity(|e, p| {
        let view_h = VIEW_H.with(|v| v.get());
        let y = SCROLL_Y.with(|v| v.get());
        let visible = p.y0_em - y < view_h && p.y0_em + p.h_em - y > 0.0;
        if visible {
            e.add(Visible::id());
            VIS.with(|v| {
                let (first, n) = v.get();
                let i = p.index as i32;
                let first = if first < 0 || i < first { i } else { first };
                v.set((first, (n + 1).min(3)));
            });
        } else {
            e.remove(Visible::id());
        }
    });

    world.system_named::<(&Article, &Reading, &Scroll)>("PackObjs").each(|(a, r, s)| {
        if ACTIVE.with(|c| c.get()) != a.index as i32 {
            return;
        }
        let Some(m) = MAGS.with(|m| m.borrow().get(a.index as usize).copied().flatten()) else {
            return;
        };
        let pose = POSE.with(|p| p.get());
        let t = r.t;
        let lift = smoothstep(0.0, 0.28, t);
        let fly = smootherstep(0.12, 1.0, t);
        let row = &m.row;
        let mut o = *row;
        o[0] = lerp(row[0], pose[0], fly);
        o[1] = lerp(row[1], pose[1], fly);
        o[2] = lerp(row[2], pose[2], fly) + 0.06 * lift * (1.0 - fly);
        o[4] = lerp(row[4], pose[3], fly);
        o[5] = lerp(row[5], pose[4], fly);
        o[6] = lerp(row[6], 0.006, fly);
        let (sn, cs) = (m.lean * (1.0 - lift)).sin_cos();
        o[8..12].copy_from_slice(&[1.0, 0.0, 0.0, 0.0]);
        o[12..16].copy_from_slice(&[0.0, cs, -sn, 0.0]);
        o[16..20].copy_from_slice(&[0.0, sn, cs, 0.0]);
        let (first, n) = VIS.with(|v| v.get());
        let step = SHEET_STEP.with(|c| c.get()).max(1e-3);
        let vh = VIEW_H.with(|v| v.get());
        let centre = (((s.y_em + vh * 0.5) / step).floor() as i32).max(0);
        STATE.with(|st| {
            let mut st = st.borrow_mut();
            st[0] = r.t;
            st[1] = r.target;
            st[2] = s.y_em;
            st[3] = s.max_em;
            st[4] = a.index as f32;
            st[5] = m.obj as f32;
            st[6] = lift;
            st[7] = smootherstep(0.15, 1.0, t);
            st[8] = first.max(0) as f32;
            st[9] = n as f32;
            st[10] = centre as f32;
            st[12..40].copy_from_slice(&o);
        });
    });

    RS.with(|r| {
        *r.borrow_mut() = Some(Rs {
            world,
            articles,
            pages: Vec::new(),
            events: VecDeque::new(),
            opened_sent: false,
            last_page: -1,
            last_scroll: 0.0,
            moving: false,
            page_count: 0,
            sheet_h: 56.0,
            gap: 0.6,
        })
    });
}

fn with<T>(f: impl FnOnce(&mut Rs) -> T) -> Option<T> {
    RS.with(|r| r.borrow_mut().as_mut().map(f))
}

fn active() -> i32 {
    ACTIVE.with(|a| a.get())
}

fn despawn_pages(rs: &mut Rs) {
    for id in rs.pages.drain(..) {
        let e = rs.world.entity_from_id(id);
        if e.is_alive() {
            e.destruct();
        }
    }
}

fn max_scroll(rs: &Rs, view_h: f32) -> f32 {
    let total = rs.page_count as f32 * rs.sheet_h + rs.page_count.saturating_sub(1) as f32 * rs.gap;
    (total - view_h).max(0.0)
}

pub fn article_open(index: u32, page_count: u32, _sheet_w: f32, sheet_h: f32, gap: f32, snap: bool) -> u32 {
    with(|rs| {
        if index as usize >= rs.articles.len() {
            return 1;
        }
        let cur = active();
        if cur >= 0 && cur as u32 != index {
            finish_close(rs);
        }
        let world = rs.world.clone();
        let art = world.entity_from_id(rs.articles[index as usize]);
        if cur != index as i32 || rs.pages.is_empty() {
            despawn_pages(rs);
            let sheet = world.lookup("Sheet");
            let step = sheet_h + gap;
            let mut prev: Option<EntityView> = None;
            for i in 0..page_count {
                let p = world
                    .entity()
                    .is_a(sheet)
                    .child_of(art)
                    .set(Page { index: i as f32, y0_em: i as f32 * step, h_em: sheet_h });
                art.add((HasPage::id(), p));
                if let Some(q) = prev {
                    q.add((Next::id(), p));
                    p.add((Prev::id(), q));
                }
                rs.pages.push(*p.id());
                prev = Some(p);
            }
        }
        rs.page_count = page_count;
        rs.sheet_h = sheet_h;
        rs.gap = gap;
        SHEET_STEP.with(|c| c.set(sheet_h + gap));
        ACTIVE.with(|a| a.set(index as i32));
        let r0 = art.try_cloned::<&Reading>().unwrap_or_default();
        art.set(Reading { t: if snap { 1.0 } else { r0.t }, vel: 0.0, target: 1.0 });
        let max = max_scroll(rs, VIEW_H.with(|v| v.get()));
        art.set(Scroll { y_em: 0.0, target_em: 0.0, vel: 0.0, max_em: max });
        SCROLL_Y.with(|c| c.set(0.0));
        rs.opened_sent = false;
        rs.last_page = -1;
        rs.last_scroll = 0.0;
        rs.moving = false;
        0
    })
    .unwrap_or(1)
}

fn finish_close(rs: &mut Rs) {
    let cur = active();
    if cur < 0 {
        return;
    }
    let art = rs.world.entity_from_id(rs.articles[cur as usize]);
    art.set(Reading { t: 0.0, vel: 0.0, target: 0.0 });
    art.set(Scroll::default());
    despawn_pages(rs);
    ACTIVE.with(|a| a.set(-1));
    SCROLL_Y.with(|c| c.set(0.0));
    VIS.with(|v| v.set((-1, 0)));
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        for i in [0, 1, 2, 8, 9] {
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
            return;
        }
        if snap {
            finish_close(rs);
        } else {
            let art = rs.world.entity_from_id(rs.articles[cur as usize]);
            if let Some(r) = art.try_cloned::<&Reading>() {
                art.set(Reading { target: 0.0, ..r });
            }
        }
    });
}

fn edit_scroll(f: impl FnOnce(Scroll) -> Scroll) {
    with(|rs| {
        let cur = active();
        if cur < 0 {
            return;
        }
        let art = rs.world.entity_from_id(rs.articles[cur as usize]);
        if let Some(s) = art.try_cloned::<&Scroll>() {
            art.set(f(s));
        }
    });
}

pub fn scroll_by(dy: f32) {
    edit_scroll(|s| Scroll { target_em: (s.target_em + dy).clamp(0.0, s.max_em), vel: 0.0, ..s });
}

pub fn scroll_to(y: f32) {
    edit_scroll(|s| Scroll { target_em: y.clamp(0.0, s.max_em), vel: 0.0, ..s });
}

/// Start a fling (em/s); ScrollIntegrate decays it.
pub fn scroll_fling(v: f32) {
    edit_scroll(|s| Scroll { vel: v, ..s });
}

pub fn set_viewport(h: f32) {
    let h = h.max(1.0);
    VIEW_H.with(|v| v.set(h));
    let max = with(|rs| max_scroll(rs, h)).unwrap_or(0.0);
    edit_scroll(|s| Scroll { max_em: max, target_em: s.target_em.min(max), y_em: s.y_em.min(max), ..s });
}

pub fn set_reading_pose(cx: f32, cy: f32, cz: f32, hw: f32, hh: f32) {
    POSE.with(|p| p.set([cx, cy, cz, hw, hh]));
}

pub fn tick(dt_ms: f32) {
    let dt = (dt_ms / 1000.0).clamp(0.0, 0.1);
    let Some(world) = with(|rs| rs.world.clone()) else { return };
    DT.with(|d| d.set(dt));
    VIS.with(|v| v.set((-1, 0)));
    world.progress_time(dt);
    with(|rs| {
        let cur = active();
        if cur < 0 {
            return;
        }
        let art = rs.world.entity_from_id(rs.articles[cur as usize]);
        let r = art.try_cloned::<&Reading>().unwrap_or_default();
        if r.target >= 1.0 && r.t >= 0.999 && !rs.opened_sent {
            rs.opened_sent = true;
            rs.events.push_back(EV_OPENED << 24 | cur as u32);
        }
        if r.target <= 0.0 && r.t <= 0.0 {
            finish_close(rs);
            return;
        }
        let (y, vel) = art.try_cloned::<&Scroll>().map_or((0.0, 0.0), |s| (s.y_em, s.vel));
        let moved = (y - rs.last_scroll).abs() > 1e-4;
        if rs.moving && !moved && vel == 0.0 {
            rs.events.push_back(EV_SCROLL_END << 24);
        }
        rs.moving = moved || vel != 0.0;
        rs.last_scroll = y;
        let page = (STATE.with(|s| s.borrow()[10]) as i32).clamp(0, rs.page_count as i32 - 1);
        if page != rs.last_page {
            rs.last_page = page;
            rs.events.push_back(EV_PAGE << 24 | page as u32);
        }
    });
}

pub fn event_poll() -> u32 {
    with(|rs| rs.events.pop_front()).flatten().unwrap_or(0)
}

pub fn state_ptr() -> *const f32 {
    STATE.with(|s| s.as_ptr() as *const f32)
}

pub fn entity_count() -> u32 {
    with(|rs| rs.world.count(flecs::Wildcard::ID).max(0) as u32).unwrap_or(0)
}
