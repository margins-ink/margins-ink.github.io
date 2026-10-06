// Text selection on the GPU-drawn reader (docs/READING_GPU.md "Selection, links, copy, find"). Pure, no DOM.
//
// A selection is two byte offsets into model.text (the plain article text the build wrote; glyph.charOffset maps every glyph back to it),
// so copy is a slice of the authored text: paragraph breaks are the blob's blank lines, code keeps its newlines, list markers are in
// the text before the first glyph of their line. Ligature glyphs are addressed by their first character.

import { BlockKind, NOTE_BIT, type ReadingModel } from '../magazine/format';
import {
	SPACE_EM, caretAt, foldClosed, isGap, layoutToDisplayY, lineContaining, lineHidden, prevCharStart, seqLen, textIndex,
	type Caret, type Domain, type ViewOpts
} from './hit';

export interface Sel { anchor: number; focus: number }
export const selLo = (s: Sel): number => Math.min(s.anchor, s.focus);
export const selHi = (s: Sel): number => Math.max(s.anchor, s.focus);
export const selEmpty = (s: Sel | null): boolean => !s || s.anchor === s.focus;

/** A highlight plate in displayed document em. */
export interface Rect { x0: number; y0: number; x1: number; y1: number; line: number; block: number }

const dec = new TextDecoder();

// ---- units ---------------------------------------------------------------------------------------------------------------

const cpAt = (t: Uint8Array, i: number): number => dec.decode(t.subarray(i, i + seqLen(t[i]))).codePointAt(0) ?? 0;
const WORD = /[\p{L}\p{N}_]/u;
/** 0 whitespace, 1 word character, 2 other (a run of punctuation is one unit). */
function cls(t: Uint8Array, i: number): number {
	const cp = cpAt(t, i);
	if (cp === 0x20 || cp === 0xa0 || cp === 0x0a || cp === 0x09) return 0;
	return WORD.test(String.fromCodePoint(cp)) ? 1 : 2;
}

/** The word around the character that starts at byte `off`: letters, digits and underscore; whitespace and punctuation runs are units too. */
export function wordAt(m: ReadingModel, off: number): [number, number] {
	const t = m.text;
	if (t.length === 0) return [0, 0];
	let at = Math.max(0, Math.min(off, t.length));
	if (at >= t.length) at = prevCharStart(t, at);
	const c0 = cls(t, at);
	let a = at;
	while (a > 0) {
		const p = prevCharStart(t, a);
		if (cls(t, p) !== c0) break;
		a = p;
	}
	let b = at;
	while (b < t.length && cls(t, b) === c0) b += seqLen(t[b]);
	return [a, Math.min(b, t.length)];
}

/** The visual line that holds byte `off` (marker included, soft-break space excluded). */
export function lineAt(m: ReadingModel, off: number): [number, number] {
	const li = lineContaining(m, off);
	if (li < 0) return [off, off];
	const ix = textIndex(m);
	return [ix.lineStart[li], ix.lineEnd[li]];
}

/** True when the line starts a new list or reference item (its first glyph is a marker before the line's own text). */
function startsItem(m: ReadingModel, li: number): boolean {
	const L = m.lines[li];
	return L.glyphCount > 0 && m.glyphs[L.firstGlyph].charOffset < L.textOff;
}

/** The paragraph (block) holding byte `off`; a list or reference item for those blocks; one visual line for code. */
export function paraAt(m: ReadingModel, off: number): [number, number] {
	const li = lineContaining(m, off);
	if (li < 0) return [off, off];
	const ix = textIndex(m);
	const L = m.lines[li];
	if (L.block >>> 0 >= NOTE_BIT) {
		const n = m.notes[L.block & ~NOTE_BIT];
		if (!n) return lineAt(m, off);
		return blockSpan(m, ix, n.firstLine, n.lineCount);
	}
	const b = m.blocks[L.block];
	if (!b || b.kind === BlockKind.code) return lineAt(m, off);
	if (b.kind === BlockKind.list || b.kind === BlockKind.refs || b.kind === BlockKind.footnotes) {
		let first = li;
		while (first > b.firstLine && !startsItem(m, first)) first--;
		let last = li;
		while (last + 1 < b.firstLine + b.lineCount && !startsItem(m, last + 1)) last++;
		return [ix.lineStart[first], ix.lineEnd[last]];
	}
	return blockSpan(m, ix, b.firstLine, b.lineCount);
}

function blockSpan(m: ReadingModel, ix: ReturnType<typeof textIndex>, first: number, count: number): [number, number] {
	let a = Infinity, z = 0;
	for (let i = first; i < first + count; i++) {
		if (m.lines[i].glyphCount <= 0) continue;
		a = Math.min(a, ix.lineStart[i]);
		z = Math.max(z, ix.lineEnd[i]);
	}
	return Number.isFinite(a) ? [a, z] : [0, 0];
}

/** Select all: the whole page text (sidenotes and fold buttons are not part of it). */
export function selectAll(m: ReadingModel): Sel {
	const ix = textIndex(m);
	return { anchor: ix.bodyStart, focus: ix.bodyEnd };
}

// ---- gestures --------------------------------------------------------------------------------------------------------------

export type Unit = 'char' | 'word' | 'para';

/** A selection in progress. The anchor is a range so word and paragraph drags extend by whole units. */
export interface Gesture { sel: Sel; unit: Unit; a0: number; a1: number; domain: Domain }

function unitRange(m: ReadingModel, unit: Unit, c: Caret): [number, number] {
	if (unit === 'word') return wordAt(m, c.glyphOff);
	if (unit === 'para') return paraAt(m, c.glyphOff);
	return [c.off, c.off];
}

/**
 * Pointer pressed on caret `c`. clicks 1: collapsed caret (shift: extend the previous selection from its anchor); 2: the word;
 * 3 or more: the paragraph (one line in code, one item in a list).
 */
export function press(m: ReadingModel, c: Caret, clicks: number, prev: Sel | null = null, shift = false): Gesture {
	if (shift && prev && !selEmpty(prev)) {
		// keep the end of the old selection that is farther from the new point fixed
		const anchor = Math.abs(c.off - prev.anchor) >= Math.abs(c.off - prev.focus) ? prev.anchor : prev.focus;
		return { sel: { anchor, focus: c.off }, unit: 'char', a0: anchor, a1: anchor, domain: c.domain };
	}
	if (shift && prev) return { sel: { anchor: prev.anchor, focus: c.off }, unit: 'char', a0: prev.anchor, a1: prev.anchor, domain: c.domain };
	const unit: Unit = clicks >= 3 ? 'para' : clicks === 2 ? 'word' : 'char';
	const [a0, a1] = unitRange(m, unit, c);
	return { sel: { anchor: a0, focus: a1 }, unit, a0, a1, domain: c.domain };
}

/** Pointer moved to caret `c` while pressed: the selection for the gesture. */
export function dragTo(m: ReadingModel, g: Gesture, c: Caret): Gesture {
	if (g.unit === 'char') return { ...g, sel: { anchor: g.a0, focus: c.off } };
	const [f0, f1] = unitRange(m, g.unit, c);
	const sel = f0 < g.a0 ? { anchor: g.a1, focus: f0 } : { anchor: g.a0, focus: Math.max(g.a1, f1) };
	return { ...g, sel };
}

/** Convenience for the caller: caret at a point in the gesture's domain. */
export const caretFor = (m: ReadingModel, g: Gesture, x: number, y: number, opts: ViewOpts = {}): Caret | null =>
	caretAt(m, x, y, { ...opts, domain: g.domain });

// ---- geometry --------------------------------------------------------------------------------------------------------------

/** x (layout em, glyph space) of byte boundary `off` on line `li`; a boundary inside a whitespace gap sits one estimated space per byte before the next glyph. */
export function xOfOffset(m: ReadingModel, li: number, off: number): number {
	const L = m.lines[li];
	const g = m.glyphs;
	const first = L.firstGlyph, last = first + L.glyphCount - 1;
	if (L.glyphCount <= 0) return L.x0;
	if (off <= g[first].charOffset) return Math.min(L.x0, g[first].x);
	let lo = first, hi = last, j = first;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (g[mid].charOffset <= off) { j = mid; lo = mid + 1; } else hi = mid - 1;
	}
	const o = g[j].charOffset;
	const clen = seqLen(m.text[o]);
	if (off < o + clen) return g[j].x;
	const nextOff = j < last ? g[j + 1].charOffset : textIndex(m).lineEnd[li];
	if (off >= nextOff) return j < last ? g[j + 1].x : Math.max(L.x1, g[j].x);
	if (!isGap(m.text, o + clen, nextOff)) return g[j].x; // inside a multi-character cluster: its start
	const end = j < last ? g[j + 1].x : Math.max(L.x1, g[j].x);
	const x = end - (nextOff - off) * SPACE_EM * L.size;
	return Math.max(g[j].x, Math.min(end, x));
}

export interface RectOpts extends ViewOpts {
	/** plate vertical padding in em added above and below the line box; default 0 */
	pad?: number;
}

/**
 * Plates (displayed document em) for the byte range [lo, hi): one per line, from the first selected glyph to the end of the last; a line
 * the range continues past is filled to its right edge. Lines clipped away by the closed fold are skipped; code plates move with the
 * block's horizontal scroll and are clipped to the block.
 */
export function rangeRects(m: ReadingModel, lo: number, hi: number, opts: RectOpts = {}): Rect[] {
	const out: Rect[] = [];
	if (hi <= lo) return out;
	const ix = textIndex(m);
	// first line in sorted order whose start is <= lo, one step back for safety
	let a = 0, b = ix.order.length - 1, k = 0;
	while (a <= b) {
		const mid = (a + b) >> 1;
		if (ix.lineStart[ix.order[mid]] <= lo) { k = mid; a = mid + 1; } else b = mid - 1;
	}
	const pad = opts.pad ?? 0;
	for (let i = Math.max(0, k - 1); i < ix.order.length; i++) {
		const li = ix.order[i];
		const s = ix.lineStart[li], e = ix.lineEnd[li];
		if (s >= hi) break;
		if (lo >= e || ix.isUi[li] || lineHidden(m, li, opts.clipEm)) continue;
		const L = m.lines[li];
		const isNote = ix.isNote[li] === 1;
		const bi = isNote ? -1 : L.block;
		const blk = bi >= 0 ? m.blocks[bi] : null;
		const dx = blk && blk.kind === BlockKind.code ? (opts.codeDx?.(bi) ?? 0) : 0;
		let x0 = lo <= s ? Math.min(L.x0, m.glyphs[L.firstGlyph].x) : xOfOffset(m, li, lo);
		let x1 = hi > e ? L.x1 : xOfOffset(m, li, hi);
		x0 -= dx; x1 -= dx;
		if (blk && blk.kind === BlockKind.code) { x0 = Math.max(x0, blk.x0); x1 = Math.min(x1, blk.x1); }
		if (x1 <= x0) continue;
		out.push({
			x0, x1, line: li, block: bi,
			y0: layoutToDisplayY(m, L.yTop, opts.clipEm) - pad, y1: layoutToDisplayY(m, L.yBot, opts.clipEm) + pad
		});
	}
	return out;
}

/** Highlight plates of a selection. */
export const selectionRects = (m: ReadingModel, s: Sel, opts: RectOpts = {}): Rect[] => rangeRects(m, selLo(s), selHi(s), opts);

// ---- copy ----------------------------------------------------------------------------------------------------------------------

/**
 * The exact authored text of a selection: a slice of the article text, so soft breaks are the single spaces the build wrote, a
 * hyphen cut joins without one, code lines keep their newlines, list and reference markers are present, blocks are separated by a
 * blank line. Fold buttons are never copied, and while the fold is closed (`clipEm` < foldY + foldH) neither is the folded text.
 */
export function copyText(m: ReadingModel, s: Sel, opts: { clipEm?: number } = {}): string {
	const ix = textIndex(m);
	const lo = Math.max(0, selLo(s)), hi = Math.min(m.text.length, selHi(s));
	if (hi <= lo) return '';
	const cuts: [number, number][] = [...ix.uiRanges];
	if (ix.foldedRange && foldClosed(m, opts.clipEm)) cuts.push(ix.foldedRange);
	cuts.sort((p, q) => p[0] - q[0]);
	const pieces: string[] = [];
	let cut = false;
	let start = lo;
	const push = (a: number, z: number) => {
		if (z > a) pieces.push(dec.decode(m.text.subarray(a, z)));
	};
	for (const [a, z] of cuts) {
		if (z <= start || a >= hi) continue;
		push(start, Math.min(a, hi));
		start = Math.max(start, z);
		cut = true;
	}
	push(start, hi);
	if (!cut || pieces.length <= 1) return pieces.join('');
	// pieces were separated by a removed range: rejoin them with one blank line
	return pieces.map((p, i) => (i > 0 ? p.replace(/^\n+/, '') : p)).map((p, i, all) => (i < all.length - 1 ? p.replace(/\n+$/, '') : p)).filter((p) => p.length).join('\n\n');
}
