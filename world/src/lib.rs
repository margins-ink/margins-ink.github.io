//! The room's scene as a Flecs world, compiled to wasm.
//!
//! `world_build` reads a JSON article list, loads the `.flecs` scene scripts, spawns one floor per
//! year (plus an Archive basement), then flattens the world into the packed float buffers that
//! `src/lib/gpu/room/room.ts` uploads unchanged. See docs/WORLD.md.

mod components;
mod export;
mod reader;
mod scene;

use std::cell::RefCell;

/// Everything the host reads back after `world_build`.
#[derive(Default)]
pub struct Output {
    /// 28 floats per object (the shader's `Obj` struct).
    pub objs: Vec<f32>,
    /// 16 floats per level: up to four sky-light pane centres (xyz + pad).
    pub panes: Vec<f32>,
    /// 12 floats per level: [start, count, pane_count, 0, lamp xyz, lamp radius, lamp colour rgb, 0].
    pub lvl: Vec<f32>,
    /// For each input article, the global object index of the magazine showing it (u32::MAX: none).
    pub links: Vec<u32>,
    /// JSON: `{levelH, roomH, roomD, floors: [{label, title, sub}]}`.
    pub meta: Vec<u8>,
    pub error: Vec<u8>,
}

thread_local! {
    static INPUT: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
    static OUTPUT: RefCell<Output> = RefCell::new(Output::default());
}

/// Reserve `len` bytes for the input JSON and return their address.
#[no_mangle]
pub extern "C" fn world_input(len: u32) -> *mut u8 {
    INPUT.with(|i| {
        let mut i = i.borrow_mut();
        i.clear();
        i.resize(len as usize, 0);
        i.as_mut_ptr()
    })
}

/// Build the scene from the input JSON. Returns 0 on success; on failure 1 and the message is
/// readable with `world_buf(5)`.
#[no_mangle]
pub extern "C" fn world_build() -> u32 {
    let result = INPUT.with(|i| scene::build(&i.borrow()));
    OUTPUT.with(|o| match result {
        Ok((out, world, ids)) => {
            reader::store(world, ids, &out);
            *o.borrow_mut() = out;
            0
        }
        Err(e) => {
            *o.borrow_mut() = Output { error: e.into_bytes(), ..Default::default() };
            1
        }
    })
}

/// Address of output buffer `id`: 0 objs, 1 panes, 2 lvl, 3 links, 4 meta JSON, 5 error text.
#[no_mangle]
pub extern "C" fn world_buf(id: u32) -> *const u8 {
    OUTPUT.with(|o| {
        let o = o.borrow();
        match id {
            0 => o.objs.as_ptr() as *const u8,
            1 => o.panes.as_ptr() as *const u8,
            2 => o.lvl.as_ptr() as *const u8,
            3 => o.links.as_ptr() as *const u8,
            4 => o.meta.as_ptr(),
            _ => o.error.as_ptr(),
        }
    })
}

/// Byte length of output buffer `id`.
#[no_mangle]
pub extern "C" fn world_buf_len(id: u32) -> u32 {
    OUTPUT.with(|o| {
        let o = o.borrow();
        (match id {
            0 => o.objs.len() * 4,
            1 => o.panes.len() * 4,
            2 => o.lvl.len() * 4,
            3 => o.links.len() * 4,
            4 => o.meta.len(),
            _ => o.error.len(),
        }) as u32
    })
}

/// Advance the reader's systems by `dt_ms` (clamped to 0..100).
#[no_mangle]
pub extern "C" fn world_tick(dt_ms: f32) {
    reader::tick(dt_ms);
}

/// Open article `index` (input order): creates its sheets and sets Reading.target to 1. 0 on success.
#[no_mangle]
pub extern "C" fn article_open(index: u32, page_count: u32, sheet_w: f32, sheet_h: f32, gap: f32, snap: u32) -> u32 {
    reader::article_open(index, page_count, sheet_w, sheet_h, gap, snap != 0)
}

#[no_mangle]
pub extern "C" fn article_close(snap: u32) {
    reader::article_close(snap != 0);
}

#[no_mangle]
pub extern "C" fn scroll_by(dy_em: f32) {
    reader::scroll_by(dy_em);
}

#[no_mangle]
pub extern "C" fn scroll_to(y_em: f32) {
    reader::scroll_to(y_em);
}

/// Extra (not in the base contract): start a fling in em/s.
#[no_mangle]
pub extern "C" fn scroll_fling(v_em_s: f32) {
    reader::scroll_fling(v_em_s);
}

#[no_mangle]
pub extern "C" fn set_viewport(view_h_em: f32) {
    reader::set_viewport(view_h_em);
}

#[no_mangle]
pub extern "C" fn set_reading_pose(cx: f32, cy: f32, cz: f32, half_w: f32, half_h: f32) {
    reader::set_reading_pose(cx, cy, cz, half_w, half_h);
}

/// 0 none; kind << 24 | arg. 1 Opened(article), 2 Closed, 3 ScrollEnd, 4 PageChanged(page).
#[no_mangle]
pub extern "C" fn event_poll() -> u32 {
    reader::event_poll()
}

/// 40 f32 of reader state (layout in docs/WORLD.md).
#[no_mangle]
pub extern "C" fn reader_state_ptr() -> *const f32 {
    reader::state_ptr()
}

#[no_mangle]
pub extern "C" fn world_entity_count() -> u32 {
    reader::entity_count()
}
