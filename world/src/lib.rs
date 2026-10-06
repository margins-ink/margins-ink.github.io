//! The room's scene as a Flecs world, compiled to wasm.
//!
//! `world_build` reads a JSON article list, loads the `.flecs` scene scripts, spawns one floor per
//! year (plus an Archive basement), then flattens the world into the packed float buffers that
//! `src/lib/gpu/room/room.ts` uploads unchanged. See docs/WORLD.md.

mod book;
mod components;
mod elevator;
mod export;
mod hover;
mod reader;
mod reading;
mod scene;
mod scroll;

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
    /// For each input article, the object index of the page block behind its magazine's cover (u32::MAX: none).
    pub pages: Vec<u32>,
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

thread_local! {
    static SCENE_BUF: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// Reserve `len` bytes for a scene script update, written as `name`, a newline, then the source. Returns their address.
#[no_mangle]
pub extern "C" fn scene_buf(len: u32) -> *mut u8 {
    SCENE_BUF.with(|b| {
        let mut b = b.borrow_mut();
        b.clear();
        b.resize(len as usize, 0);
        b.as_mut_ptr()
    })
}

fn scene_script() -> Result<(String, String), String> {
    SCENE_BUF.with(|b| {
        let text = std::str::from_utf8(&b.borrow()).map_err(|e| format!("scene source is not utf-8: {e}"))?.to_owned();
        let (name, src) = text.split_once('\n').ok_or("scene_buf: expected `name\\nsource`")?;
        Ok((name.to_owned(), src.to_owned()))
    })
}

/// Dev: before `world_build`, use the script in the scene buffer instead of the baked copy. 0 ok, 1 error (`world_buf(5)`).
#[no_mangle]
pub extern "C" fn scene_override() -> u32 {
    match scene_script().and_then(|(n, s)| scene::override_source(&n, &s)) {
        Ok(()) => 0,
        Err(e) => {
            OUTPUT.with(|o| o.borrow_mut().error = e.into_bytes());
            1
        }
    }
}

/// Dev hot reload: update the named script from the scene buffer in place and re-pack (docs/WORLD.md "Hot reload").
/// 0 ok (read the buffers again); 1 error: the message is `world_buf(5)` and the previous scene is intact.
#[no_mangle]
pub extern "C" fn scene_reload() -> u32 {
    let result = scene_script().and_then(|(name, src)| {
        let world = reader::world().ok_or("the room is not built")?;
        INPUT.with(|i| scene::reload(&world, &i.borrow(), &name, &src))
    });
    OUTPUT.with(|o| match result {
        Ok(out) => {
            *o.borrow_mut() = out;
            0
        }
        Err(e) => {
            o.borrow_mut().error = e.into_bytes();
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

/// A wheel event (`deltaMode` 0 px, 1 lines, 2 pages; ctrl = pinch, ignored). Returns 1 when it scrolls. The engine owns the scroll (docs/READING_GPU.md).
#[no_mangle]
pub extern "C" fn reading_wheel(dx: f32, dy: f32, delta_mode: u32, ctrl: u32) -> u32 {
    reading::wheel(dx, dy, delta_mode, ctrl != 0)
}

/// Touch or pen drag: kind 1 down, 2 move, 3 up, 4 cancel; `id` = pointerId | pointerType << 16 (0 mouse, 1 touch, 2 pen); `t_ms` as f64.
/// Returns 1 while this pointer drives the scroll (the host captures it).
#[no_mangle]
pub extern "C" fn reading_pointer(kind: u32, id: u32, x: f32, y: f32, t_ms: f64) -> u32 {
    reading::pointer(kind, id, x, y, t_ms)
}

/// A scroll key (1 Space, 2 PageDown, 3 PageUp, 4 Home, 5 End, 6 ArrowDown, 7 ArrowUp). Returns 1 when consumed.
#[no_mangle]
pub extern "C" fn reading_key(code: u32, shift: u32) -> u32 {
    reading::key(code, shift != 0)
}

/// Scroll to `y_px` (clamped); `smooth` 1 animates 250..700 ms (instant under reduced motion).
#[no_mangle]
pub extern "C" fn reading_scroll_to(y_px: f32, smooth: u32) {
    reading::scroll_to(y_px, smooth != 0);
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

/// The hovered shelf book (article index, negative none): pointer hit region or keyboard selection (world/src/hover.rs).
#[no_mangle]
pub extern "C" fn hover_set(index: i32) {
    hover::set(index);
}

/// Start the one-time invitation (a slow open and close of the cover) on article `index`, or cancel it (negative).
#[no_mangle]
pub extern "C" fn hover_nudge(index: i32) {
    hover::nudge(index);
}

/// `hover::HOVER_LEN` f32: [count, busy, 0, 0, entries of 60: cover obj, pages obj, mask, 0, cover row 28, pages row 28].
#[no_mangle]
pub extern "C" fn hover_state_ptr() -> *const f32 {
    hover::state_ptr()
}

/// A click on a book: it starts lifting off the shelf at once, before the article bytes arrive.
#[no_mangle]
pub extern "C" fn book_begin(index: u32) {
    reader::book_begin(index);
}

thread_local! { static SPIKE: RefCell<String> = const { RefCell::new(String::new()) }; }
#[no_mangle]
pub extern "C" fn museum_spike() -> u32 { let s = museum::spike::run(); SPIKE.with(|x| *x.borrow_mut() = s); SPIKE.with(|x| x.borrow().len() as u32) }
#[no_mangle]
pub extern "C" fn museum_spike_ptr() -> *const u8 { SPIKE.with(|x| x.borrow().as_ptr()) }
