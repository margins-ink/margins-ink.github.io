// 12-column baseline-grid solver (docs/MAGAZINE.md 1.2 and 1.4 step 1). Pure: Template in, rectangles out.
// Units are em of the body size, y down, origin at the spread's top-left. No harfbuzz, no node imports.
import type { Rect, Slot, Template } from '../../src/lib/magazine/types';

export const LINE_H = 1.6;
export const HALF = LINE_H / 2;
export const SPINE_SAFE = 1.5; // no text within this of the spine
export const EDGE_SAFE = 2; // no text within this of the sheet edge
export const OVERLAP_TOL = 0.05;
const EPS = 1e-9;

export type SheetClass = 'wide' | 'narrow';

export interface Geometry {
	cls: SheetClass;
	w: number; // spread width (wide 80, narrow 28)
	h: number; // 56
	sheets: number;
	sheetW: number;
	cols: number; // grid columns over the whole spread (12 or 6)
	gutter: number;
	/** [left, right] live-area margin per sheet */
	margins: [number, number][];
	topMargin: number;
	bottomMargin: number;
	/** x of the spine, or null for the narrow class */
	spineX: number | null;
}

export const GEOMETRY: Record<SheetClass, Geometry> = {
	wide: { cls: 'wide', w: 80, h: 56, sheets: 2, sheetW: 40, cols: 12, gutter: 1.2, margins: [[4.5, 3.5], [3.5, 4.5]], topMargin: 3 * LINE_H, bottomMargin: 4 * LINE_H, spineX: 40 },
	narrow: { cls: 'narrow', w: 28, h: 56, sheets: 1, sheetW: 28, cols: 6, gutter: 1.2, margins: [[3.5, 3.5]], topMargin: 3 * LINE_H, bottomMargin: 4 * LINE_H, spineX: null }
};

const snap = (v: number, step: number) => Math.round(v / step) * step;
const clean = (v: number) => Math.round(v * 1e6) / 1e6;

// ---- tracks --------------------------------------------------------------------------------------

export type Track = { kind: 'fixed'; em: number } | { kind: 'fr'; n: number } | { kind: 'fit' };

/** '3b' is 3 baselines, '12em' fixed em (snapped to half baselines), 'fr' or '2fr' share the rest, 'fit' takes content. */
export function parseTrack(s: string): Track {
	let m = /^(\d+(?:\.\d+)?)b$/.exec(s);
	if (m) return { kind: 'fixed', em: clean(parseFloat(m[1]) * LINE_H) };
	m = /^(\d+(?:\.\d+)?)em$/.exec(s);
	if (m) return { kind: 'fixed', em: snap(parseFloat(m[1]), HALF) };
	m = /^(\d*(?:\.\d+)?)fr$/.exec(s);
	if (m) return { kind: 'fr', n: m[1] === '' ? 1 : parseFloat(m[1]) };
	if (s === 'fit') return { kind: 'fit' };
	throw new Error(`bad track size '${s}'`);
}

/** Heights in em. Fixed first, `fit` from `fitEm[i]`, `fr` shares the rest in half-baseline steps (last fr takes the remainder). */
export function solveRows(rows: string[], total: number, fitEm: readonly number[] = []): number[] {
	const tracks = rows.map(parseTrack);
	const out = new Array<number>(tracks.length).fill(0);
	let used = 0;
	let frSum = 0;
	let lastFr = -1;
	tracks.forEach((t, i) => {
		if (t.kind === 'fixed') out[i] = t.em;
		else if (t.kind === 'fit') out[i] = snap(fitEm[i] ?? 0, HALF);
		else { frSum += t.n; lastFr = i; }
		used += out[i];
	});
	const rest = total - used;
	if (rest < -EPS) throw new Error(`rows need ${clean(used)} em but only ${total} em available`);
	if (lastFr < 0) {
		if (Math.abs(rest) > 1e-6) throw new Error(`rows sum to ${clean(used)} em, spread is ${total} em (add an 'fr' row)`);
		return out.map(clean);
	}
	let given = 0;
	tracks.forEach((t, i) => {
		if (t.kind !== 'fr' || i === lastFr) return;
		out[i] = Math.floor((rest * t.n / frSum) / HALF + EPS) * HALF;
		given += out[i];
	});
	out[lastFr] = rest - given;
	return out.map(clean);
}

/** Column rectangles [x0, x1] for the whole spread; the spine falls between columns cols/2-1 and cols/2. */
export function colEdges(g: Geometry): [number, number][] {
	const per = g.cols / g.sheets;
	const edges: [number, number][] = [];
	for (let s = 0; s < g.sheets; s++) {
		const [ml, mr] = g.margins[s];
		const live = g.sheetW - ml - mr;
		const cw = (live - (per - 1) * g.gutter) / per;
		for (let i = 0; i < per; i++) {
			const x0 = s * g.sheetW + ml + i * (cw + g.gutter);
			edges.push([clean(x0), clean(x0 + cw)]);
		}
	}
	return edges;
}

// ---- areas ---------------------------------------------------------------------------------------

/** Parse the ASCII map: rows of whitespace separated cells, `|` spine marker, `//` comments, `.` empty. */
export function parseAreas(areas: string, cols: number, nrows: number): string[][] {
	const lines = areas.split('\n').map((l) => l.replace(/\/\/.*$/, '').trim()).filter(Boolean);
	if (lines.length !== nrows) throw new Error(`areas has ${lines.length} rows, rows[] has ${nrows}`);
	return lines.map((line, r) => {
		const cells: string[] = [];
		line.split(/\s+/).forEach((tok) => {
			if (tok === '|') {
				if (cells.length !== cols / 2) throw new Error(`areas row ${r}: spine marker after ${cells.length} cells, expected ${cols / 2}`);
			} else {
				if (tok.length !== 1) throw new Error(`areas row ${r}: cell '${tok}' must be one character`);
				cells.push(tok);
			}
		});
		if (cells.length !== cols) throw new Error(`areas row ${r}: ${cells.length} cells, expected ${cols}`);
		return cells;
	});
}

export interface Area {
	letter: string;
	slot: Slot;
	rect: Rect; // after bleed
	cellRect: Rect; // before bleed (bbox of the cells)
	cells: number; // number of grid cells carrying the letter
	/** figure or field whose cells are not a rectangle: sits under its neighbours (overprinted headline) */
	underlay: boolean;
	spansSpine: boolean;
	sheet: number; // sheet of the first column; -1 when it spans sheets
	col0: number;
	col1: number;
	row0: number;
	row1: number;
}

export interface Solved {
	template: Template;
	geom: Geometry;
	rowY: [number, number][]; // [y0, y1] per row
	colX: [number, number][];
	areas: Record<string, Area>;
	/** letters in map order (top to bottom, left to right) */
	order: string[];
}

const isUnderlayType = (t: Slot['type']) => t === 'figure' || t === 'field';
const rectsOverlap = (a: Rect, b: Rect, tol = OVERLAP_TOL) =>
	Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > tol && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > tol;

export function solveTemplate(t: Template, cls: SheetClass = 'wide', fitEm: readonly number[] = []): Solved {
	const g = GEOMETRY[cls];
	const def = cls === 'narrow' ? t.narrow : t;
	if (!def) throw new Error(`template ${t.name}: no narrow variant`);
	if (def.cols !== g.cols) throw new Error(`template ${t.name}: ${cls} needs ${g.cols} cols, has ${def.cols}`);
	const heights = solveRows(def.rows, g.h, fitEm);
	let y = 0;
	const rowY = heights.map((h) => { const r: [number, number] = [clean(y), clean(y + h)]; y += h; return r; });
	const colX = colEdges(g);
	const map = parseAreas(def.areas, def.cols, def.rows.length);
	const acc = new Map<string, { c0: number; c1: number; r0: number; r1: number; n: number }>();
	const order: string[] = [];
	map.forEach((row, r) => row.forEach((ch, c) => {
		if (ch === '.') return;
		const a = acc.get(ch);
		if (!a) { acc.set(ch, { c0: c, c1: c, r0: r, r1: r, n: 1 }); order.push(ch); return; }
		a.c0 = Math.min(a.c0, c); a.c1 = Math.max(a.c1, c); a.r0 = Math.min(a.r0, r); a.r1 = Math.max(a.r1, r); a.n++;
	}));
	const areas: Record<string, Area> = {};
	for (const letter of order) {
		const a = acc.get(letter)!;
		const slot = t.slots[letter];
		if (!slot) throw new Error(`template ${t.name}: area '${letter}' has no slot`);
		const full = (a.c1 - a.c0 + 1) * (a.r1 - a.r0 + 1);
		const underlay = isUnderlayType(slot.type) && full !== a.n;
		if (full !== a.n && !underlay) throw new Error(`template ${t.name}: area '${letter}' (${slot.type}) is not a rectangle`);
		const cellRect: Rect = { x0: colX[a.c0][0], y0: rowY[a.r0][0], x1: colX[a.c1][1], y1: rowY[a.r1][1] };
		const rect = { ...cellRect };
		for (const side of slot.bleed ?? []) {
			if (side === 'left') rect.x0 = 0;
			if (side === 'right') rect.x1 = g.w;
			if (side === 'top') rect.y0 = 0;
			if (side === 'bottom') rect.y1 = g.h;
		}
		const per = g.cols / g.sheets;
		const s0 = Math.floor(a.c0 / per), s1 = Math.floor(a.c1 / per);
		areas[letter] = { letter, slot, rect, cellRect, cells: a.n, underlay, spansSpine: s0 !== s1, sheet: s0 === s1 ? s0 : -1, col0: a.c0, col1: a.c1, row0: a.r0, row1: a.r1 };
	}
	return { template: t, geom: g, rowY, colX, areas, order };
}

const TEXT_TYPES = new Set<Slot['type']>(['body', 'deck', 'caption', 'code']);

/** Fail-closed lint of a solved template: overlaps, spine and edge safe zones, half-baseline alignment. Empty when clean. */
export function lintSolved(s: Solved): string[] {
	const errs: string[] = [];
	const name = s.template.name;
	const list = s.order.map((l) => s.areas[l]);
	for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
		const a = list[i], b = list[j];
		if (a.underlay || b.underlay || a.slot.type === 'field' || b.slot.type === 'field') continue;
		if (rectsOverlap(a.rect, b.rect)) errs.push(`${name}: areas '${a.letter}' and '${b.letter}' overlap`);
	}
	for (const a of list) {
		if (a.slot.type === 'head' || a.slot.type === 'figure' || a.slot.type === 'field' || a.slot.type === 'numeral' || a.slot.type === 'pullquote' || a.slot.type === 'rule') {
			// display items may cross the spine; edge safety does not apply to bleeds
		}
		if (TEXT_TYPES.has(a.slot.type) && a.spansSpine) errs.push(`${name}: ${a.slot.type} area '${a.letter}' crosses the spine`);
		if (TEXT_TYPES.has(a.slot.type) && !a.underlay) {
			if (s.geom.spineX !== null && a.rect.x0 < s.geom.spineX + SPINE_SAFE && a.rect.x1 > s.geom.spineX - SPINE_SAFE) errs.push(`${name}: '${a.letter}' within ${SPINE_SAFE} em of the spine`);
			if (a.rect.x0 < EDGE_SAFE - EPS || a.rect.x1 > s.geom.w - EDGE_SAFE + EPS) errs.push(`${name}: '${a.letter}' within ${EDGE_SAFE} em of the sheet edge`);
		}
		for (const v of [a.rect.y0, a.rect.y1]) {
			if (Math.abs(v / HALF - Math.round(v / HALF)) > 1e-6) errs.push(`${name}: '${a.letter}' edge y=${v} is off the half-baseline grid`);
		}
	}
	return errs;
}
