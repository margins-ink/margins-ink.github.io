//! The room's scene as a Flecs world, compiled to wasm.
//!
//! `world_build` reads a JSON article list, loads the `.flecs` scene scripts, spawns one floor per
//! year (plus an Archive basement), then flattens the world into the packed float buffers that
//! `src/lib/gpu/room/room.ts` uploads unchanged. See docs/WORLD.md.

mod book;
mod components;
mod elevator;
mod export;
mod reader;
mod reading;
mod scene;

use std::cell::RefCell;

/// Everything the host reads back after `world_build`.
#[derive(Default)]
pub struct Output {
    /// 28 floats per object (the shader's `Obj` struct).
    pub objs: Vec<f32>,
    /// 16 floats per level: up to four sky-light pane centres (xyz + pad).
    pub panes: Vec<f32>,
    /// 20 floats per level: [start, count, pane_count, 0, lamp xyz, lamp radius, lamp colour rgb, 0,
    /// accent centre xyz (front face z), accent half width, accent colour rgb, accent half height].
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

/// Advance the whole pipeline (the book and the reading module) by `dt_ms` (clamped to 0..100). One call per frame in the room.
#[no_mangle]
pub extern "C" fn world_tick(dt_ms: f32) {
    reader::tick(dt_ms);
}

/// Open article `index` (input order): the book lifts off the shelf, or snaps open for a cold deep link. 0 on success.
#[no_mangle]
pub extern "C" fn article_open(index: u32, snap: u32) -> u32 {
    reader::article_open(index, snap != 0)
}

#[no_mangle]
pub extern "C" fn article_close(snap: u32) {
    reader::article_close(snap != 0);
}

#[no_mangle]
pub extern "C" fn set_reading_pose(cx: f32, cy: f32, cz: f32, half_w: f32, half_h: f32) {
    reader::set_reading_pose(cx, cy, cz, half_w, half_h);
}

/// 0 none; kind << 24 | arg. 1 Opened(article), 2 Closed, 11 Sound, 12 Phase (the book; the page has `reading_event_poll`).
#[no_mangle]
pub extern "C" fn event_poll() -> u32 {
    reader::event_poll()
}

/// 64 f32 of book state (layout in docs/WORLD.md and `RS` in world.ts).
#[no_mangle]
pub extern "C" fn reader_state_ptr() -> *const f32 {
    reader::state_ptr()
}

#[no_mangle]
pub extern "C" fn world_entity_count() -> u32 {
    reader::entity_count()
}

// ---- reading (src/lib/reading/abi.ts, src/lib/ecs/reading.ts) ----

/// A bare world with only the reading module (reader-only mode). 0 ok, 1 when the room is already built.
#[no_mangle]
pub extern "C" fn reading_init() -> u32 {
    if reader::is_full() {
        return 1;
    }
    reading::init()
}

/// Pointer to the load buffer of at least `words` u32 (it grows, so re-derive views after the call).
#[no_mangle]
pub extern "C" fn reading_buf(words: u32) -> *mut u32 {
    reading::buf(words)
}

/// Parse the load buffer into entities, replacing the previous article. 0 ok.
#[no_mangle]
pub extern "C" fn reading_load() -> u32 {
    reading::load()
}

#[no_mangle]
pub extern "C" fn reading_set_viewport(w_px: f32, h_px: f32, dpr: f32, em_px: f32, width_class: u32) {
    reading::set_viewport(w_px, h_px, dpr, em_px, width_class);
}

#[no_mangle]
pub extern "C" fn reading_set_scroll(y_px: f32) {
    reading::set_scroll(y_px);
}

/// One gesture or command (`INPUT` in abi.ts): `a` and `b` are block or figure indices or floats as the kind says.
#[no_mangle]
pub extern "C" fn reading_input(kind: u32, a: f32, b: f32) {
    reading::input(kind, a, b);
}

/// Advance by `dt_ms`. In the room this is the same single pipeline run as `world_tick`; call one of them per frame, not both.
#[no_mangle]
pub extern "C" fn reading_tick(dt_ms: f32) {
    if reader::is_full() {
        reader::tick(dt_ms);
    } else {
        reading::tick(dt_ms);
    }
}

/// 64 f32 (`RD` in abi.ts).
#[no_mangle]
pub extern "C" fn reading_state_ptr() -> *const f32 {
    reading::state_ptr()
}

#[no_mangle]
pub extern "C" fn reading_ack_dirty() {
    reading::ack_dirty();
}

/// 0 none; kind << 24 | arg, kind a 1-based index into READING_EVENTS.
#[no_mangle]
pub extern "C" fn reading_event_poll() -> u32 {
    reading::poll()
}

#[no_mangle]
pub extern "C" fn reading_entity_count() -> u32 {
    reading::entity_count()
}

/// First block with y1 > `y_em` (document em), -1 when there are no blocks.
#[no_mangle]
pub extern "C" fn reading_block_at(y_em: f32) -> i32 {
    reading::block_at(y_em)
}

/// A click on a book: it starts lifting off the shelf at once, before the article bytes arrive.
#[no_mangle]
pub extern "C" fn book_begin(index: u32) {
    reader::book_begin(index);
}
