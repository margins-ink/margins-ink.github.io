//! The room's scene as a Flecs world, compiled to wasm.
//!
//! `world_build` reads a JSON article list, loads the `.flecs` scene scripts, spawns one floor per
//! year (plus an Archive basement), then flattens the world into the packed float buffers that
//! `src/lib/gpu/room/room.ts` uploads unchanged. See docs/WORLD.md.

mod components;
mod export;
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
        Ok(out) => {
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
