// Pure hit-testing and addressing for magazine spreads (docs/MAGAZINE.md 4.1, 4.3, 4.5). No DOM, no GPU.
// Coordinates are spread em, y down, origin at the spread's top-left. The room turns a pointer ray into
// such a point (shader lane's `pickSpread`); everything here works on that point.

export const SHEET_W = 40;
export const SHEET_H = 56;
export const SPINE_X = 40;
export const EDGE_FRAC = 0.12; // click on the outer 12% of a sheet turns
export const FOLIO_H = 6.4; // bottom 4 baselines: folio line

export interface Geom {
	/** em width of what is shown: 80 for a spread, 28 for a narrow single sheet */
	w: number;
	h: number;
	sheetW: number;
	narrow: boolean;
}
export const geom = (narrow: boolean): Geom => (narrow ? { w: 28, h: SHEET_H, sheetW: 28, narrow } : { w: 80, h: SHEET_H, sheetW: SHEET_W, narrow });

export interface Box { x0: number; y0: number; x1: number; y1: number }
export const inBox = (b: Box, x: number, y: number) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1;

export interface LinkRec extends Box { kind: number; target: string; spread: number }
/** mode: FigureMode (0 loop 1 once 2 scrub 3 static); duration in seconds. A figure scrubs unless it is static. */
export interface FigureRec extends Box { id: number; spread: number; mode: number; duration: number }
export const scrubbable = (f: FigureRec) => f.mode !== 3 && f.duration > 0;
export interface LineRec { yTop: number; yBot: number; x0: number; x1: number; firstGlyph: number; glyphCount: number; charOffset: number; frame: number }

export function linkAt(links: readonly LinkRec[], spread: number, x: number, y: number): LinkRec | null {
	for (const l of links) if (l.spread === spread && inBox(l, x, y)) return l;
	return null;
}

export function figureAt(figs: readonly FigureRec[], spread: number, x: number, y: number): FigureRec | null {
	let best: FigureRec | null = null;
	for (const f of figs) if (f.spread === spread && inBox(f, x, y) && (!best || area(f) < area(best))) best = f;
	return best;
}
const area = (b: Box) => (b.x1 - b.x0) * (b.y1 - b.y0);

/**
 * The "Full text" tab: a curled corner at the outer bottom corner of the right sheet. The hit box is
 * generous (touch); the visible curl is drawn by the shader inside it.
 */
export const TAB_W = 12;
export const TAB_H = 9;
export const tabBox = (g: Geom): Box => ({ x0: g.w - TAB_W, y0: g.h - TAB_H, x1: g.w, y1: g.h });
export const tabAt = (g: Geom, x: number, y: number) => inBox(tabBox(g), x, y);

/** Peel progress, 0..1 of the sheet width, from the corner's start point to the pointer (dragging left). */
export const peelFrac = (g: Geom, startX: number, x: number) => Math.min(1, Math.max(0, (startX - x) / g.sheetW));
export const PEEL_OPEN = 0.25;

/** The folio strip (click opens the overview), minus the tab. */
export function folioAt(g: Geom, x: number, y: number) {
	return y >= g.h - FOLIO_H && y <= g.h && !tabAt(g, x, y);
}

/** Outer-edge turn zones: -1 left edge (back), +1 right edge (forward), 0 none. Narrow single sheet has both edges. */
export function edgeAt(g: Geom, x: number, y: number): -1 | 0 | 1 {
	if (y < 0 || y > g.h) return 0;
	const e = g.sheetW * EDGE_FRAC;
	if (x >= 0 && x <= e) return -1;
	if (x <= g.w && x >= g.w - e) return 1;
	return 0;
}

/** Which margin a drag started in, for scrubbing the leaf: outer margin of the left or right sheet. */
export function marginSide(g: Geom, x: number): -1 | 0 | 1 {
	const m = 4.5; // outer margin, section 1.2
	if (x >= 0 && x <= m) return -1;
	if (x <= g.w && x >= g.w - m) return 1;
	return 0;
}

// ---- overview (lay-flat contact grid) ----------------------------------------------------------

export interface Cell { spread: number; x: number; y: number; w: number; h: number }

/** Contact grid of `count` spreads (index 0 = distilled) in a viewport of the given aspect, unit-less 0..1 coordinates. */
export function overviewLayout(count: number, aspect: number, spreadAspect = 80 / 56, pad = 0.03): Cell[] {
	if (count <= 0) return [];
	let best = { cols: 1, cw: 0 };
	for (let cols = 1; cols <= count; cols++) {
		const rows = Math.ceil(count / cols);
		// cell width in viewport-height-1 units; viewport is `aspect` wide, 1 tall
		const cw = Math.min((aspect - pad * (cols + 1)) / cols, ((1 - pad * (rows + 1)) / rows) * spreadAspect);
		if (cw > best.cw) best = { cols, cw };
	}
	const { cols, cw } = best;
	const ch = cw / spreadAspect;
	const rows = Math.ceil(count / cols);
	const gw = cols * cw + (cols - 1) * pad;
	const gh = rows * ch + (rows - 1) * pad;
	const ox = (aspect - gw) / 2;
	const oy = (1 - gh) / 2;
	const cells: Cell[] = [];
	for (let i = 0; i < count; i++) {
		const c = i % cols;
		const r = Math.floor(i / cols);
		// normalised to 0..1 of the viewport
		cells.push({ spread: i, x: (ox + c * (cw + pad)) / aspect, y: oy + r * (ch + pad), w: cw / aspect, h: ch });
	}
	return cells;
}

/** nx, ny in 0..1 of the viewport (y down). */
export function overviewAt(cells: readonly Cell[], nx: number, ny: number): number | null {
	for (const c of cells) if (nx >= c.x && nx <= c.x + c.w && ny >= c.y && ny <= c.y + c.h) return c.spread;
	return null;
}

// ---- selection reading order -------------------------------------------------------------------

/** Threads read in frame order, then top to bottom, then left to right (MAGAZINE.md 4.3). */
export function readingOrder<T extends Pick<LineRec, 'frame' | 'yTop' | 'x0'>>(lines: readonly T[]): T[] {
	return [...lines].sort((a, b) => a.frame - b.frame || a.yTop - b.yTop || a.x0 - b.x0);
}

/** Index of the glyph under (x, y) inside a spread's lines, via a caller-supplied per-glyph x lookup. */
export function lineAt(lines: readonly LineRec[], x: number, y: number): LineRec | null {
	for (const l of lines) if (y >= l.yTop && y < l.yBot && x >= l.x0 && x <= l.x1) return l;
	return null;
}

// ---- URL fragment ------------------------------------------------------------------------------

export interface Place { layer: 0 | 1; spread: number }

/** `#s3` -> full text spread 3; `#s0` -> distilled; `#full` -> first full spread; `#full/s3` -> full spread 3. */
export function parseHash(hash: string, spreadCount: number): Place | null {
	const h = hash.replace(/^#/, '');
	let m: RegExpExecArray | null;
	if (h === 'full') return { layer: 1, spread: 1 };
	if ((m = /^full\/s(\d+)$/.exec(h)) || (m = /^s(\d+)$/.exec(h))) {
		const n = Number(m[1]);
		if (n === 0 && !h.startsWith('full')) return { layer: 0, spread: 0 };
		if (n < 1 || n > spreadCount) return null;
		return { layer: 1, spread: n };
	}
	return null;
}

export function formatHash(p: Place): string {
	return p.layer === 0 ? '' : p.spread === 1 ? '#full' : `#full/s${p.spread}`;
}
