// Shared declarations of lane U (GPU chrome): UI glyphs, UI fonts, text shaping and the scrollbar API.
// Lane U1 owns this file and the implementations (text.ts, tables.ts, scrollbar.ts); lane U2 (widgets, layout, hit) codes against it. Keep it stable.
import type { Overlay } from '../page-api';

// ---- text ----

/** The two UI font slots. `sans` is Instrument Sans (wdth 100, wght 500); `mono` is the code family (Berkeley Mono, Fira Code fallback). */
export type UiFont = 'sans' | 'mono';

/**
 * One glyph of UI text, drawn by the page pass. x, y in CSS px of the canvas, y is the BASELINE; size is px per em;
 * r g b a are straight sRGB 0..1 like Overlay (the pass decodes and premultiplies); hdr multiplies rgb above 1 on extended-range canvases.
 * glyphId is a fonts.bin union glyph id (what ui/text.ts returns).
 */
export interface UiGlyph { x: number; y: number; glyphId: number; font: UiFont; size: number; r: number; g: number; b: number; a: number; hdr?: number }

/** dx: pen x (px at the shaped size) of the glyph origin from the start of the string. Spaces and other glyphless characters add width but emit no glyph. */
export interface ShapedGlyph { dx: number; glyphId: number }
export interface Shaped { glyphs: ShapedGlyph[]; width: number }

/** glyphId value of a character that has an advance but no outline (space). Never emitted in Shaped.glyphs. */
export const NO_GLYPH = 0xffffffff;

/** Per-font table from fonts.bin: sorted code points with union glyph id and advance (em), optional kerning (em) keyed `(left << 16) | right` (code points below 0x10000). */
export interface UiFontTable {
	notdef: { glyphId: number; adv: number };
	cp: Uint32Array;
	gid: Uint32Array;
	adv: Float32Array;
	kern: Map<number, number>;
}
export type UiTables = Record<UiFont, UiFontTable>;

/*
 * ui/text.ts exports (implementation in text.ts):
 *   loadUiTables(fontsBin: Uint8Array): UiTables      decode the UI section of fonts.bin and register it for shapeUi
 *   setUiTables(t: UiTables): void                    register tables (tests)
 *   shapeUi(text, font, sizePx): Shaped               uses the registered tables
 *   measureUi(text, font, sizePx): number
 *   truncateUi(text, font, sizePx, maxW, ellipsis = '…'): string
 *   uiGlyphs(text, font, sizePx, x, baselineY, rgba: [r,g,b,a], hdr?): UiGlyph[]
 * ui/scrollbar.ts exports: see ScrollbarApi below.
 */

// ---- scrollbar ----

export interface ScrollbarInput {
	/** viewport CSS px and the document height in px (scrollY runs 0 .. docPx - viewH) */
	viewW: number; viewH: number; docPx: number;
	scrollY: number;
	/** pointer in CSS px, or null when outside the canvas (touch) */
	pointer: { x: number; y: number } | null;
	/** the thumb is being dragged (the caller sets it between scrollbarDragStart and the pointer up) */
	dragging: boolean;
	/** straight sRGB 0..1: thumb ink and the drag accent */
	ink: [number, number, number];
	accent: [number, number, number];
	/** px the track starts below the top (the top bar); default 0 */
	insetTop?: number;
	/** section starts in document px: small ticks drawn only while hovered */
	ticks?: number[];
}

export interface ScrollbarState {
	/** 0..1 */ opacity: number;
	/** visible width px (critically damped spring) and its velocity */ width: number; widthVel: number;
	/** ms since the last scroll, hover or drag */ idleMs: number;
	lastScrollY: number;
	hover: boolean;
}

export interface ScrollbarGeom {
	/** false when the document fits the viewport: nothing is drawn or hit */
	active: boolean;
	trackY0: number; trackH: number;
	thumbY: number; thumbH: number;
	/** x of the left edge of the 14 px hit area */
	hitX: number;
	maxY: number;
}

export interface ScrollbarFrame { state: ScrollbarState; overlays: Overlay[]; /** frames are needed now (fade or spring running) */ animating: boolean; /** ms until the next change when idle-waiting (Infinity if none) */ wakeInMs: number }

export type ScrollbarHit = 'thumb' | 'track' | null;

/*
 * ui/scrollbar.ts exports (implementation in scrollbar.ts):
 *   newScrollbar(): ScrollbarState
 *   scrollbarGeom(i: ScrollbarInput): ScrollbarGeom
 *   scrollbarHit(i: ScrollbarInput, x, y): ScrollbarHit               14 px hit area at the right edge
 *   scrollbarStep(s, dtMs, i): ScrollbarState                         pure
 *   scrollbarOverlays(s, dtMs, i): Overlay[]                          step then render (does not mutate s); use scrollbarFrame to keep the next state
 *   scrollbarFrame(s, dtMs, i): ScrollbarFrame
 *   scrollbarTrackClick(i, y): number                                 target scrollY: one page (viewH - 40) toward the click, clamped
 *   scrollbarDragStart(i, y): number                                  grab offset of the pointer inside the thumb
 *   scrollbarDragTo(i, grab, y): number                               scrollY for the pointer y (proportional, clamped)
 */
