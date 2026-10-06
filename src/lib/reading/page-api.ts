// The page pass: one WebGPU render pass that draws the visible blocks of an RDR3 article (docs/READING.md section 7).
// It owns a canvas, a device and the article's GPU buffers; it knows nothing about scrolling physics, the DOM or Flecs.
// The reader hands it one PageFrame per animation frame and it draws that and only that.
import type { ReadingModel } from '../magazine/format';
import type { UiGlyph } from './ui/types';

/** A rounded rectangle in CSS pixels of the canvas, premultiplied on output. rgba are straight, 0..1; hdr multiplies rgb above 1 on an extended-range canvas. */
export interface Overlay { x: number; y: number; w: number; h: number; radius: number; r: number; g: number; b: number; a: number; hdr?: number }

export interface PageFrame {
	/** scroller scrollTop, CSS px */
	scrollPx: number;
	/** CSS px per em of the article (body size) */
	emPx: number;
	/** CSS px of document x = 0 (the left edge of the reading column) */
	originX: number;
	/** CSS px of document y = 0 at scrollPx = 0 */
	originY: number;
	viewW: number;
	viewH: number;
	dpr: number;
	/** visible block and note ranges (RD.visFirst ...) */
	visFirst: number; visCount: number; noteFirst: number; noteCount: number;
	/** folded content (blocks with BlockFlag.folded and notes below foldY) is clipped at this document y (em); the last foldFadeEm fade to the ground */
	foldClipEm: number;
	foldFadeEm: number;
	/** the channel table of the article (256 f32): channels of every live figure already evaluated at its clock */
	chans: Float32Array;
	/** 0..1 opacity of the page ground; 1 in reader-only mode, springs between 0 and ~0.92 over the dimmed room in the world */
	groundA: number;
	/** px rect the ground covers (rounded corners radius px): the book's sheet during the hand-off, the whole viewport otherwise */
	ground: { x0: number; y0: number; x1: number; y1: number; radius: number };
	/** scissor in CSS px for the text and figures (the sheet rect during the hand-off); omit for none */
	clip?: { x0: number; y0: number; x1: number; y1: number };
	/** restrict drawing to blocks [onlyFirst, onlyFirst + onlyCount): the hero during the hand-off */
	only?: { first: number; count: number };
	/** 0..1 of each visible figure's enter animation is not handled here: figures draw at full opacity; per-block opacity multipliers by block index (sparse) for the enter rise */
	blockAlpha?: Map<number, number>;
	/** per-block vertical offset in px (the 12 px enter rise), sparse */
	blockDy?: Map<number, number>;
	/** per-block horizontal scroll in CSS px (positive = content moved left), sparse; only BlockKind.code blocks use it: their items are shifted by -dx and
	 *  scissored to the block box, except the panel background (the first RectKind.codeBg rect item of the block), which stays put */
	blockDx?: Map<number, number>;
	/** UI rectangles (progress rail, focus ring, hover frame, copy flash, selection plates), drawn over the page */
	overlays: Overlay[];
	/** UI text (chrome labels, find query ...), drawn after the overlays by a second instanced draw with the article's glyph atlas and coverage shader.
	 *  Glyph ids come from ui/text.ts (fonts.bin union ids); ids out of range are skipped. Capped at 4096 glyphs per frame. */
	uiText?: UiGlyph[];
	/** image lightbox: draws the image item of `block` fitted into the px rect `rect` (alpha 0..1), after the overlays and before uiText. `em` is the image's document box (em). */
	lightbox?: { block: number; em: { x0: number; y0: number; x1: number; y1: number }; rect: { x: number; y: number; w: number; h: number }; alpha: number };
	/** scissor in CSS px for uiText; omit for the whole viewport (the overlays and uiText are never clipped by `clip`) */
	uiClip?: { x0: number; y0: number; x1: number; y1: number };
	/** accent peak above 1.0 on extended-range canvases (hover underline, focus ring, rail head); 1 = SDR */
	hdrGain: number;
	/** seconds */
	time: number;
	/** false: draw nothing new (the reader decided nothing changed); the pass keeps the last frame */
	dirty: boolean;
}

export interface PagePass {
	readonly canvas: HTMLCanvasElement;
	/** upload fonts.bin (glyph tables) and the article; replaces a previous article. images are fetched by the pass from the urls in `imageUrls` (index = imageId). */
	load(fonts: Uint8Array, model: ReadingModel, imageUrls: string[]): Promise<void>;
	resize(cssW: number, cssH: number, dpr: number): void;
	draw(f: PageFrame): void;
	/** GPU buffer bytes currently allocated by the pass (the acceptance check reads it) */
	gpuBytes(): number;
	/** ms of GPU time of the last frames if timestamp queries are available, else NaN */
	lastGpuMs(): number;
	dispose(): void;
}

export interface PageOptions {
	/** reader-only: the pass requests its own adapter and device; in the world it may still do so (a second device is fine) */
	alpha: 'opaque' | 'premultiplied';
	/** show timing and expose counters on window.__page for the acceptance tests */
	debug?: boolean;
}
