// The contract between the JS reader, the Flecs ReadingModule (world/src/reading.rs) and the page pass.
// docs/READING.md sections 6 and 7; docs/READING_CONTRACT.md for the file ownership and the frame protocol.
//
// Units: the wasm side works in em of the article (document space of RDR3) except where a name ends in Px.
import type { ReadingModel } from '../magazine/format';
import type { FilmApi } from '../film/abi';

// ---- load: model -> wasm ------------------------------------------------------------------------------------

/** u32 words. Header: [0] nBlocks [1] nNotes [2] nExhibits [3] nAnchors [4] nLinks [5] docH (f32) [6] foldY (f32) [7] foldH (f32) [8] peekH (f32) [9] widthClass [10] colW (f32) [11..15] 0 */
export const LOAD_HEADER = 16;
export const LOAD_BLOCK = 8; // [y0 f32, y1 f32, x0 f32, x1 f32, kind | level << 8 | flags << 16, section, anchor string offset, ex (i32 exhibit index, -1 none)]
export const LOAD_NOTE = 6; // [y0 f32, y1 f32, x0 f32, x1 f32, anchorBlock, anchorLine]
export const LOAD_EXHIBIT = 6; // [id, mode, duration f32, poster f32, block, kind (ExhibitKind)]
export const LOAD_ANCHOR = 3; // [string offset, block, y f32]
export const LOAD_LINK = 5; // [block, kind (LinkKind), targetBlock (i32, -1 for none or external), refIndex (i32, -1 none), line]

/** Pack the model into the load buffer; the Rust side parses exactly this layout. */
export function packLoad(m: ReadingModel): Uint32Array {
	const n = LOAD_HEADER + m.blocks.length * LOAD_BLOCK + m.notes.length * LOAD_NOTE + m.exhibits.length * LOAD_EXHIBIT + m.anchors.length * LOAD_ANCHOR + m.links.length * LOAD_LINK;
	const out = new Uint32Array(n);
	const f = new Float32Array(out.buffer);
	const i32 = new Int32Array(out.buffer);
	out[0] = m.blocks.length; out[1] = m.notes.length; out[2] = m.exhibits.length; out[3] = m.anchors.length; out[4] = m.links.length;
	f[5] = m.docH; f[6] = m.foldY; f[7] = m.foldH; f[8] = m.peekH; out[9] = m.widthClass; f[10] = m.colW;
	let o = LOAD_HEADER;
	for (const b of m.blocks) {
		f[o] = b.y0; f[o + 1] = b.y1; f[o + 2] = b.x0; f[o + 3] = b.x1;
		out[o + 4] = b.kind | (b.level << 8) | (b.flags << 16); out[o + 5] = b.section; out[o + 6] = b.anchor; i32[o + 7] = b.ex;
		o += LOAD_BLOCK;
	}
	for (const nt of m.notes) {
		f[o] = nt.y0; f[o + 1] = nt.y1; f[o + 2] = nt.x0; f[o + 3] = nt.x1; out[o + 4] = nt.anchorBlock; out[o + 5] = nt.anchorLine;
		o += LOAD_NOTE;
	}
	for (const g of m.exhibits) {
		out[o] = g.id; out[o + 1] = g.mode; f[o + 2] = g.duration; f[o + 3] = g.poster; out[o + 4] = g.block; out[o + 5] = g.kind;
		o += LOAD_EXHIBIT;
	}
	for (const a of m.anchors) {
		out[o] = a.idOffset; out[o + 1] = a.block; f[o + 2] = a.y;
		o += LOAD_ANCHOR;
	}
	const anchorBlockByString = new Map(m.anchors.map((a) => [a.idOffset, a.block]));
	const lineBlock = (line: number) => m.lines[line]?.block ?? 0;
	for (const l of m.links) {
		out[o] = lineBlock(l.line); out[o + 1] = l.kind;
		i32[o + 2] = l.kind === 1 ? (anchorBlockByString.get(l.offset) ?? -1) : -1;
		i32[o + 3] = -1;
		out[o + 4] = l.line;
		o += LOAD_LINK;
	}
	return out;
}

// ---- state: wasm -> JS (a live Float32Array view, 64 floats; u32 fields are stored as exact integers in f32) ----

export const RD = {
	scrollEm: 0, // Scroll.y in em (set_scroll(px) / emPx)
	scrollMaxEm: 1, // Scroll.max: docHeightEm - viewport height em (>= 0)
	foldT: 2, // Fold.t 0 collapsed .. 1 expanded (spring)
	foldTarget: 3, // 0 | 1
	foldClipEm: 4, // document y (em) below which folded blocks are clipped: foldY + peekH + t * (foldH - peekH); = docH when there is no fold
	docHeightEm: 5, // current scrollable page height in em: foldClipEm + tail
	visFirst: 6, // first visible block index (text lookahead 0.25 viewport), blocks are sorted by y0
	visCount: 7,
	noteFirst: 8,
	noteCount: 9,
	section: 10, // Reading: section index of the current heading, -1 before the first h2
	readingBlock: 11, // block index of that heading, -1 none
	progress: 12, // 0..1 of scroll over scrollMax
	dirty: 13, // bit 0 scroll moved, 1 spring active, 2 timeline live, 3 hover/focus changed, 4 layout changed, 5 exhibit changed or animating; cleared by reading_ack_dirty
	hoverBlock: 14, // exclusive relation Hover (block index, -1 none)
	focusBlock: 15, // exclusive relation Focus
	// 16 was scrubFig (deleted with the figure ABI)
	openBlock: 17, // exclusive relation Open (popover / lightbox target block, -1 none)
	exVisFirst: 18, // exhibits within 1.5 viewports (data lookahead): contiguous range in exhibit order
	exVisCount: 19,
	foldSettled: 20, // 1 when the fold spring is at rest
	widthClass: 21,
	idle: 22, // seconds since the last scroll, for the timeline autoplay gate
	emPx: 23, // Typography.em_px as set
	viewportEm: 24, // viewport height in em
	scrollY: 25, // engine scroll position, CSS px (negative or above max while the rubber band is out)
	scrollMaxPx: 26,
	scrollMode: 27, // SCROLL_MODE
	velocity: 28 // px/s
} as const;
/** `RD.dirty` bit 5 (value 32): an exhibit changed or animates (the exhibit state rows XS say which). */
export const DIRTY_EXHIBIT = 32;

/** `state[RD.scrollMode]` */
export const SCROLL_MODE = { idle: 0, wheel: 1, drag: 2, fling: 3, animate: 4, rubber: 5 } as const;
/** `reading_key` codes (input.ts maps KeyboardEvent.code to these) */
export const SCROLL_KEY = { space: 1, pageDown: 2, pageUp: 3, home: 4, end: 5, arrowDown: 6, arrowUp: 7 } as const;
/** `reading_pointer` kinds. The id word is `pointerId | pointerType << 16` (0 mouse, 1 touch, 2 pen); only touch and pen drag the page. */
export const POINTER_KIND = { down: 1, move: 2, up: 3, cancel: 4 } as const;

/** Events from reading_event_poll(): kind in the top byte (1-based index into READING_EVENTS), arg in the low 24 bits. */
export const READING_EVENTS = ['section', 'foldSettled', 'foldExpand', 'exhibitVisible', 'exhibitHidden', 'open', 'focus', 'hover', 'layout', 'exhibitState', 'exhibitHalted'] as const;
export type ReadingEventKind = (typeof READING_EVENTS)[number];

/** set_input kinds (reading_input(kind, a, b)): a and b are block or figure indices or floats as noted. */
export const INPUT = {
	hoverBlock: 1, // a = block index or -1
	focusBlock: 2, // a = block index or -1
	open: 3, // a = block index or -1 (popover / lightbox)
	// 4..9 were the figure scrub/step/play/home inputs (deleted: exhibit parts do it, docs/MUSEUM.md)
	foldSet: 10, // a = 1 expand | 0 collapse, b = 1 instant
	reducedMotion: 11 // a = 1 | 0
} as const;

/** The wasm exports of the reading module (the existing exports of lib.rs stay, minus the spread, turn, corner, overview and bounce ones). */
export interface ReadingExports {
	memory: WebAssembly.Memory;
	reading_init(): number; // bare world with only the ReadingModule (reader-only mode); 0 ok
	reading_buf(words: number): number; // pointer to an input buffer of `words` u32 (grows as needed)
	reading_load(): number; // parse the load buffer into entities (replaces a previous article); 0 ok
	reading_set_viewport(wPx: number, hPx: number, dpr: number, emPx: number, widthClass: number): void;
	reading_set_scroll(yPx: number): void;
	reading_input(kind: number, a: number, b: number): void;
	reading_tick(dtMs: number): void;
	reading_state_ptr(): number;
	reading_ack_dirty(): void;
	reading_event_poll(): number;
	reading_entity_count(): number;
	/** y of block i in em after the document anchor for scroll restore: first block with y1 > yEm (binary search); -1 when empty */
	reading_block_at(yEm: number): number;
}

/** The typed wrapper over ReadingExports (src/lib/ecs/reading.ts: `createReading(exports)` and `loadReadingOnly()`), what the reader and the world host use. */
export interface Reading {
	load(m: ReadingModel): void;
	setViewport(wPx: number, hPx: number, dpr: number, emPx: number, widthClass: number): void;
	setScroll(yPx: number): void;
	input(kind: number, a: number, b?: number): void;
	tick(dtMs: number): void;
	/** 64 floats, re-derived on every call (a grown wasm memory detaches old views) */
	state(): Float32Array;
	ackDirty(): void;
	poll(): { kind: ReadingEventKind; arg: number } | null;
	blockAt(yEm: number): number;
	entityCount(): number;
	/** engine-owned scroll (wheel, touch, keys, smooth scroll-to) */
	scroll: ScrollApi;
	/** the museum: exhibit scripts, input, snapshots and draw lists (world/src/museum) */
	exhibit: ExhibitApi;
	/** the narrated film player (world/src/film, src/lib/film) */
	film: FilmApi;
}

// ---- scroll (docs/READING_GPU.md "Scroll (lane R)"): the engine owns the position, JS forwards events and reads state[RD.scrollY] ----

/** The scroll exports of world.wasm (world/src/lib.rs). */
export interface ScrollExports {
	reading_wheel(dx: number, dy: number, deltaMode: number, ctrl: number): number; // 1 when the event scrolls (preventDefault it)
	reading_pointer(kind: number, id: number, x: number, y: number, tMs: number): number; // 1 while this pointer drives the scroll
	reading_key(code: number, shift: number): number; // 1 when consumed
	reading_scroll_to(yPx: number, smooth: number): void;
}

export interface ScrollApi {
	/** `deltaMode` 0 px, 1 lines, 2 pages; ctrl (pinch) is ignored by the engine. True when the event scrolled. */
	wheel(dx: number, dy: number, deltaMode: number, ctrl: boolean): boolean;
	/** `id` = pointerId | pointerType << 16, `tMs` = event.timeStamp (a double: f32 loses the millisecond after 16 s). True while the pointer drives the scroll. */
	pointer(kind: number, id: number, x: number, y: number, tMs: number): boolean;
	/** a `SCROLL_KEY` code; true when consumed */
	key(code: number, shift: boolean): boolean;
	scrollTo(yPx: number, smooth: boolean): void;
}

export function createScrollApi(x: ScrollExports): ScrollApi {
	return {
		wheel: (dx, dy, mode, ctrl) => x.reading_wheel(dx, dy, mode, ctrl ? 1 : 0) !== 0,
		pointer: (kind, id, px, py, t) => x.reading_pointer(kind, id, px, py, t) !== 0,
		key: (code, shift) => x.reading_key(code, shift ? 1 : 0) !== 0,
		scrollTo: (y, smooth) => x.reading_scroll_to(y, smooth ? 1 : 0)
	};
}


// ---- exhibits (docs/MUSEUM.md "Built contract"): the museum module of world.wasm (world/src/museum) ----

/** Exhibit draw item: 8 f32 per item, exhibit-local em (origin top-left of the block, scaled by the exhibit record's `scale`). */
export const XD = {
	stride: 8,
	x: 0, y: 1, w: 2, h: 3, // line and arrow: (x, y) start, (w, h) delta; label: x, y = baseline anchor, h = size in em, w = max width (0 = none)
	shape: 4, tone: 5, flags: 6,
	/** rrect and ring: corner radius em (a ring is an outline inside its box, stroke 0.12 em); line/arrow: stroke width em; hatch: stripe pitch em (0 = 0.35); label: string index (exhibit_str); circle and dot: unused (the
	 *  box's inscribed circle) */
	aux: 7
} as const;
export const XSHAPE = { rrect: 0, circle: 1, line: 2, arrow: 3, ring: 4, dot: 5, label: 6, hatch: 7 } as const;
/** Tones resolve to THEME slots in the reader; scripts name them as strings (`"panel"`). Order is the numeric id. */
export const TONE_NAMES = ['panel', 'ink', 'ink2', 'ink3', 'accent', 'accent2', 'rule', 'ground', 'accentTint', 'panelHi', 'accentDim'] as const;
export type ToneName = (typeof TONE_NAMES)[number];
/** XD.flags bits; the label alignment is `(flags >> 8) & 3`: 0 left, 1 centre, 2 right. */
export const XFLAG = { hover: 1, pressed: 2, selected: 4, pending: 8, dim: 16, mono: 32, bold: 64 } as const;
/** `exhibit_pointer` kinds */
export const XPOINTER = { move: 0, down: 1, up: 2, leave: 3 } as const;
/** `exhibit_pointer` result bits: 1 consumed, 2 wants capture (the reader captures the pointer and keeps routing to this exhibit); `(r >> 2) & 15` is the cursor */
export const XRESULT = { consumed: 1, capture: 2, cursorShift: 2 } as const;
export const XCURSOR = ['default', 'pointer', 'grab', 'grabbing', 'ew-resize', 'crosshair', 'not-allowed', 'cell'] as const;
/** `exhibit_key` codes: a single character is its char code; these are the others. mods: 1 shift, 2 ctrl/meta, 4 alt. */
export const XKEY = { enter: 13, escape: 27, left: 0x100, right: 0x101, up: 0x102, down: 0x103, tab: 9, backspace: 8, delete: 127 } as const;
/** `exhibit_state_ptr` rows: XS.stride f32 per exhibit index (max XS.max). */
export const XS = { stride: 8, max: 32, loaded: 0, running: 1, halted: 2, steps: 3, clock: 4, animating: 5, focus: 6, kind: 7 } as const;

export interface ExhibitExports {
	memory: WebAssembly.Memory;
	/** staging buffer of `len` bytes (script text, snapshot text); pointer may change after every call */
	exhibit_buf(len: number): number;
	/** run the script text in the staging buffer as exhibit `ex`'s scope (replaces a previous load of that index); 0 ok, else the error text is in the out buffer */
	exhibit_load(ex: number, len: number): number;
	/** run a script text in the staging buffer in a scratch world and describe it as JSON in the out buffer (build lint, posters later); 0 ok, else error text in out */
	exhibit_inspect(len: number): number;
	exhibit_out_ptr(): number;
	exhibit_out_len(): number;
	exhibit_pointer(ex: number, kind: number, xEm: number, yEm: number, buttons: number, mods: number): number;
	exhibit_key(code: number, mods: number): number;
	/** the exhibit holding keyboard focus, -1 none */
	exhibit_focus(ex: number): void;
	/** snapshot text into the out buffer: returns its byte length (0 when the exhibit is not loaded) */
	exhibit_snapshot(ex: number): number;
	/** restore from the text in the staging buffer: 0 ok, 1 stale or malformed (the exhibit keeps its state) */
	exhibit_restore(ex: number, len: number): number;
	/** fill the draw list of exhibit `ex`: item count (<= 400); items at exhibit_draw_ptr() (stride XD.stride f32), strings via exhibit_str */
	exhibit_pack(ex: number): number;
	exhibit_draw_ptr(): number;
	exhibit_str_ptr(i: number): number;
	exhibit_str_len(i: number): number;
	exhibit_state_ptr(): number;
	/** dev hot reload: script text in the staging buffer; dry run in a scratch world, then update in place keeping state; 0 ok, else error text in out and the old exhibit runs on */
	exhibit_reload(ex: number, len: number): number;
}

/** The typed wrapper over ExhibitExports (src/lib/ecs/reading.ts). Text goes through the staging buffer; views are re-derived per call. */
export interface ExhibitApi {
	/** null when loaded, else the engine's error text */
	load(ex: number, src: string): string | null;
	/** dev hot reload: null when applied (state kept), else the error text (the old exhibit runs on) */
	reload(ex: number, src: string): string | null;
	/** scratch-world description (JSON text) of a script, or the error text with ok false */
	inspect(src: string): { ok: boolean; text: string };
	/** bit set per XRESULT */
	pointer(ex: number, kind: number, xEm: number, yEm: number, buttons: number, mods: number): number;
	key(code: number, mods: number): boolean;
	focus(ex: number): void;
	snapshot(ex: number): string | null;
	/** false: stale or malformed (the exhibit keeps its state) */
	restore(ex: number, text: string): boolean;
	/** the draw list: `count` items of XD.stride f32 (a live view: read it before the next wasm call) */
	pack(ex: number): { count: number; items: Float32Array };
	str(i: number): string;
	/** XS.max rows of XS.stride f32 */
	state(): Float32Array;
}
