// Hit testing and caret placement on the RDR3 model (docs/READING_GPU.md "Selection, links, copy, find"). Pure, no DOM.
//
// Coordinates: document em (the caller converts CSS px with emPx / originX / scroll). Input y is the DISPLAYED document y: while the fold
// is closed or opening the content after the fold is moved up, `ViewOpts.clipEm` is RD.foldClipEm and `displayToLayoutY` undoes that shift.
// Text positions are UTF-8 byte offsets into model.text (glyph.charOffset), the same numbers the selection, copy and find code use.
//
// Glyph cells: the RDR glyph records carry only the left edge x (spaces are not glyphs), so the cell of glyph i is [x_i, x_{i+1}) and
// the last glyph of a line runs to line.x1. A trailing space therefore belongs to the glyph before it.

import { BlockFlag, BlockKind, LinkKind, NOTE_BIT, type ReadingModel } from '../magazine/format';

export type HitKind = 'text' | 'link' | 'cite' | 'exhibit' | 'image' | 'code' | 'fold' | 'none';

export interface Hit {
	kind: HitKind;
	/** index into model.blocks, -1 when none (and for margin sidenotes, see `note`) */
	block: number;
	/** absolute line index, -1 when none */
	line: number;
	/** absolute glyph index, -1 when none */
	glyph: number;
	/** index into model.links, -1 when none */
	link: number;
	/** exhibit index, -1 when none */
	ex: number;
	/** index into model.notes for a wide-class margin sidenote, else -1 */
	note: number;
	/** byte offset of the first character of the glyph hit, -1 when no glyph */
	off: number;
}

export interface ViewOpts {
	/** RD.foldClipEm; default (or >= foldY + foldH) = fold fully open */
	clipEm?: number;
	/** horizontal scroll of a code block in em (x shift of its glyphs); default 0 */
	codeDx?: (block: number) => number;
}

export const NONE_HIT: Readonly<Hit> = Object.freeze({ kind: 'none', block: -1, line: -1, glyph: -1, link: -1, ex: -1, note: -1, off: -1 });

const EPS = 1e-4;
const dec = new TextDecoder();

// ---- UTF-8 -------------------------------------------------------------------------------------------------------

/** Byte length of the UTF-8 sequence starting with lead byte b. */
export const seqLen = (b: number): number => (b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1);
export const isContByte = (b: number): boolean => (b & 0xc0) === 0x80;
/** Start of the character that ends at (or contains byte) i - 1. */
export function prevCharStart(t: Uint8Array, i: number): number {
	let j = Math.min(i, t.length) - 1;
	while (j > 0 && isContByte(t[j])) j--;
	return Math.max(0, j);
}
export const isWhitespaceAt = (t: Uint8Array, i: number): boolean => {
	const b = t[i];
	return b === 0x20 || b === 0x0a || b === 0x09 || (b === 0xc2 && t[i + 1] === 0xa0);
};

// ---- fold geometry -------------------------------------------------------------------------------------------------

export const foldEndOf = (m: ReadingModel): number => m.foldY + m.foldH;
/** The fold is closed or still opening: folded blocks are clipped. */
export const foldClosed = (m: ReadingModel, clipEm?: number): boolean => m.foldH > 0 && clipEm !== undefined && clipEm < foldEndOf(m) - 1e-3;
const shiftOf = (m: ReadingModel, clipEm?: number): number => (foldClosed(m, clipEm) ? foldEndOf(m) - clipEm! : 0);

/** Displayed document y to layout y (the y of the model's blocks). */
export function displayToLayoutY(m: ReadingModel, y: number, clipEm?: number): number {
	return foldClosed(m, clipEm) && y >= clipEm! ? y + shiftOf(m, clipEm) : y;
}
/** Layout y to displayed document y; a y inside the clipped part of the fold maps to clipEm. */
export function layoutToDisplayY(m: ReadingModel, y: number, clipEm?: number): number {
	if (!foldClosed(m, clipEm)) return y;
	if (y >= foldEndOf(m) - 1e-6) return y - shiftOf(m, clipEm);
	return Math.min(y, clipEm!);
}

// ---- per-model index -------------------------------------------------------------------------------------------------

export interface TextIndex {
	/** selectable lines (glyphCount > 0) sorted by start offset */
	order: Int32Array;
	/** per line: first byte of the line's selectable text (marker glyphs included) and one past its last byte */
	lineStart: Int32Array;
	lineEnd: Int32Array;
	/** per line: 1 when the line is a margin sidenote line */
	isNote: Uint8Array;
	/** per line: 1 when the line belongs to a fold button (UI text, never selected or copied) */
	isUi: Uint8Array;
	/** body lines (not notes, not UI) sorted by yTop, and the same for note lines */
	bodyByY: Int32Array;
	noteByY: Int32Array;
	/** end of the last body line: select-all stops here (wide-class sidenote text sits after it in the blob) */
	bodyEnd: number;
	/** first byte of the first body line */
	bodyStart: number;
	/** byte range of the folded blocks' text, or null */
	foldedRange: [number, number] | null;
	/** byte ranges of UI text (fold buttons) */
	uiRanges: [number, number][];
	/** the fold button block, -1 when none */
	foldBlock: number;
	/** per block: horizontal extent of what is drawn and hittable (the block box widened to its lines, except code, which is clipped to the box) */
	blockX0: Float32Array;
	blockX1: Float32Array;
	/** CSR of links per line */
	linkStart: Int32Array;
	linkIdx: Int32Array;
}

const indexCache = new WeakMap<ReadingModel, TextIndex>();

const noteLineOf = (blockField: number): boolean => ((blockField & NOTE_BIT) !== 0);

export function textIndex(m: ReadingModel): TextIndex {
	let ix = indexCache.get(m);
	if (ix) return ix;
	const { lines, glyphs, blocks, notes, text } = m;
	const n = lines.length;
	const lineStart = new Int32Array(n), lineEnd = new Int32Array(n);
	const isNote = new Uint8Array(n), isUi = new Uint8Array(n);
	const sel: number[] = [];
	let foldBlock = -1;
	blocks.forEach((b, i) => { if (b.kind === BlockKind.fold && foldBlock < 0) foldBlock = i; });
	for (let i = 0; i < n; i++) {
		const L = lines[i];
		let s = L.textOff, e = L.textOff + L.textLen;
		if (L.glyphCount > 0) {
			const g0 = glyphs[L.firstGlyph], gl = glyphs[L.firstGlyph + L.glyphCount - 1];
			if (g0.charOffset < s) s = g0.charOffset;
			if (gl.charOffset >= e && gl.charOffset < text.length) e = gl.charOffset + seqLen(text[gl.charOffset]);
			sel.push(i);
		}
		lineStart[i] = s;
		lineEnd[i] = Math.min(e, text.length);
		if (noteLineOf(L.block)) isNote[i] = 1;
		else if (blocks[L.block]?.kind === BlockKind.fold) isUi[i] = 1;
	}
	const order = Int32Array.from(sel.sort((a, b) => lineStart[a] - lineStart[b] || a - b));
	const byY = (flag: (i: number) => boolean) =>
		Int32Array.from(sel.filter(flag).sort((a, b) => lines[a].yTop - lines[b].yTop || a - b));
	const bodyByY = byY((i) => !isNote[i] && !isUi[i]);
	const noteByY = byY((i) => !!isNote[i]);
	let bodyStart = Infinity, bodyEnd = 0;
	let fa = Infinity, fb = 0;
	let ua = Infinity, ub = 0;
	for (const i of bodyByY) {
		bodyStart = Math.min(bodyStart, lineStart[i]);
		bodyEnd = Math.max(bodyEnd, lineEnd[i]);
		if (blocks[lines[i].block]!.flags & BlockFlag.folded) { fa = Math.min(fa, lineStart[i]); fb = Math.max(fb, lineEnd[i]); }
	}
	for (let i = 0; i < n; i++) if (isUi[i] && lines[i].glyphCount > 0) { ua = Math.min(ua, lineStart[i]); ub = Math.max(ub, lineEnd[i]); }
	if (!Number.isFinite(bodyStart)) bodyStart = 0;
	// folded range also covers the folded blocks' own notes (narrow class: note blocks carry the folded flag)
	const foldedRange: [number, number] | null = m.foldH > 0 && fb > fa ? [fa, fb] : null;
	const uiRanges: [number, number][] = ub > ua ? [[ua, ub]] : [];
	// links per line (CSR)
	const linkStart = new Int32Array(n + 1);
	for (const l of m.links) if (l.line >= 0 && l.line < n) linkStart[l.line + 1]++;
	for (let i = 0; i < n; i++) linkStart[i + 1] += linkStart[i];
	const fill = linkStart.slice(0, n);
	const linkIdx = new Int32Array(m.links.length);
	m.links.forEach((l, k) => { if (l.line >= 0 && l.line < n) linkIdx[fill[l.line]++] = k; });
	void notes;
	const blockX0 = new Float32Array(blocks.length), blockX1 = new Float32Array(blocks.length);
	blocks.forEach((b, i) => {
		let a = b.x0, z = b.x1;
		if (b.kind !== BlockKind.code) {
			for (let k = 0; k < b.lineCount; k++) {
				const L = lines[b.firstLine + k];
				if (L.glyphCount <= 0) continue;
				a = Math.min(a, L.x0, glyphs[L.firstGlyph].x);
				z = Math.max(z, L.x1);
			}
		}
		blockX0[i] = a; blockX1[i] = z;
	});
	ix = { blockX0, blockX1, order, lineStart, lineEnd, isNote, isUi, bodyByY, noteByY, bodyEnd, bodyStart, foldedRange, uiRanges, foldBlock, linkStart, linkIdx };
	indexCache.set(m, ix);
	return ix;
}

/** True when the line is clipped away by the closed fold (or its note's anchor is). */
export function lineHidden(m: ReadingModel, line: number, clipEm?: number): boolean {
	if (!foldClosed(m, clipEm)) return false;
	const b = m.lines[line].block;
	if (noteLineOf(b)) {
		const n = m.notes[b & ~NOTE_BIT];
		return !!n && !!((m.blocks[n.anchorBlock]?.flags ?? 0) & BlockFlag.folded);
	}
	return !!((m.blocks[b]?.flags ?? 0) & BlockFlag.folded);
}

/** The line whose text range holds byte `off` (a gap byte after a line belongs to that line), -1 when none. */
export function lineContaining(m: ReadingModel, off: number): number {
	const ix = textIndex(m);
	let lo = 0, hi = ix.order.length - 1, k = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (ix.lineStart[ix.order[mid]] <= off) { k = mid; lo = mid + 1; } else hi = mid - 1;
	}
	if (k < 0) return -1;
	// several lines can start at the same offset only for degenerate input; the last one wins
	const li = ix.order[k];
	return off <= ix.lineEnd[li] ? li : -1;
}

// ---- glyph search ----------------------------------------------------------------------------------------------------

/** Absolute index of the glyph whose cell holds x on line `li` (x before the first glyph gives the first), -1 for a line without glyphs. */
export function glyphAtX(m: ReadingModel, li: number, x: number): number {
	const L = m.lines[li];
	if (L.glyphCount <= 0) return -1;
	const g = m.glyphs;
	let lo = L.firstGlyph, hi = L.firstGlyph + L.glyphCount - 1, r = L.firstGlyph;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (g[mid].x <= x) { r = mid; lo = mid + 1; } else hi = mid - 1;
	}
	return r;
}

/** Right edge of glyph j's cell on its line. */
export function glyphCellEnd(m: ReadingModel, li: number, j: number): number {
	const L = m.lines[li];
	return j + 1 < L.firstGlyph + L.glyphCount ? m.glyphs[j + 1].x : Math.max(L.x1, m.glyphs[j].x);
}

// ---- hit test ----------------------------------------------------------------------------------------------------------

function lastIdx(n: number, le: (i: number) => boolean): number {
	let lo = 0, hi = n - 1, r = -1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (le(mid)) { r = mid; lo = mid + 1; } else hi = mid - 1;
	}
	return r;
}

/** Nearest line (by y distance, then x) among the lines [first, first + count) of one block or note; their yTop ascends. */
function nearestInRange(m: ReadingModel, first: number, count: number, x: number, y: number): number {
	const { lines } = m;
	// a block's lines ascend in yTop except in multi-column blocks (previous / next), which are short: scan those
	let lo = 0, hi = count - 1;
	if (count > 24) {
		let k = lastIdx(count, (i) => lines[first + i].yTop <= y);
		if (k < 0) k = 0;
		lo = Math.max(0, k - 1); hi = Math.min(count - 1, k + 1);
	}
	let best = -1, bd = Infinity;
	for (let i = lo; i <= hi; i++) {
		const L = lines[first + i];
		if (L.glyphCount <= 0) continue;
		const dy = y < L.yTop ? L.yTop - y : y > L.yBot ? y - L.yBot : 0;
		const dx = x < L.x0 ? L.x0 - x : x > L.x1 ? x - L.x1 : 0;
		const d = dy * 1000 + dx;
		if (d < bd) { bd = d; best = first + i; }
	}
	return best;
}

function linkAt(m: ReadingModel, ix: TextIndex, li: number, x: number, y: number): number {
	for (let p = ix.linkStart[li]; p < ix.linkStart[li + 1]; p++) {
		const k = ix.linkIdx[p];
		const l = m.links[k];
		if (x >= l.x0 - EPS && x <= l.x1 + EPS && y >= l.y0 - EPS && y <= l.y1 + EPS) return k;
	}
	return -1;
}

function textHit(m: ReadingModel, ix: TextIndex, li: number, block: number, note: number, x: number, y: number): Hit | null {
	const L = m.lines[li];
	const g0 = m.glyphs[L.firstGlyph];
	const left = Math.min(L.x0, g0?.x ?? L.x0);
	const link = linkAt(m, ix, li, x, y);
	const inInk = x >= left - EPS && x <= L.x1 + EPS;
	if (!inInk && link < 0) return null;
	const j = glyphAtX(m, li, x);
	const lk = link >= 0 ? m.links[link] : null;
	const kind: HitKind = lk ? (lk.kind === LinkKind.ref ? 'cite' : 'link') : 'text';
	return { kind, block, line: li, glyph: j, link, ex: -1, note, off: j >= 0 ? m.glyphs[j].charOffset : -1 };
}

/**
 * What is at (x, y), document em, y as displayed. Notes first (they overlap the blocks in y), then a binary search over the blocks
 * (sorted by y0), then the nearest line of the block, then the glyph by x. While the fold is closed the peek band over the folded
 * region is the fold control.
 */
export function hitTest(m: ReadingModel, x: number, y: number, opts: ViewOpts = {}): Hit {
	const ix = textIndex(m);
	const ly = displayToLayoutY(m, y, opts.clipEm);
	const closed = foldClosed(m, opts.clipEm);
	if (closed && ly >= m.foldY - EPS && ly < opts.clipEm! && x >= m.docX0 && x <= m.docX1) {
		return { ...NONE_HIT, kind: 'fold', block: ix.foldBlock };
	}
	// margin notes
	const nn = m.notes;
	if (nn.length) {
		let k = lastIdx(nn.length, (i) => nn[i].y0 <= ly);
		for (let i = k; i >= Math.max(0, k - 2); i--) {
			const n = nn[i];
			if (ly > n.y1 + EPS || x < n.x0 - EPS || x > n.x1 + EPS) continue;
			if (closed && ((m.blocks[n.anchorBlock]?.flags ?? 0) & BlockFlag.folded)) continue;
			const li = nearestInRange(m, n.firstLine, n.lineCount, x, ly);
			if (li >= 0) {
				const h = textHit(m, ix, li, -1, i, x, ly);
				if (h) return h;
			}
			return NONE_HIT;
		}
	}
	const bl = m.blocks;
	const k = lastIdx(bl.length, (i) => bl[i].y0 <= ly);
	for (let i = k; i >= Math.max(0, k - 3); i--) {
		const b = bl[i];
		if (ly > b.y1 + EPS) continue;
		if (x < ix.blockX0[i] - EPS || x > ix.blockX1[i] + EPS) continue;
		if (closed && (b.flags & BlockFlag.folded)) continue;
		return hitInBlock(m, ix, i, x, ly, opts);
	}
	return NONE_HIT;
}

function hitInBlock(m: ReadingModel, ix: TextIndex, bi: number, x: number, y: number, opts: ViewOpts): Hit {
	const b = m.blocks[bi];
	if (b.kind === BlockKind.fold) return { ...NONE_HIT, kind: 'fold', block: bi };
	const dx = b.kind === BlockKind.code ? (opts.codeDx?.(bi) ?? 0) : 0;
	if (b.lineCount > 0) {
		const li = nearestInRange(m, b.firstLine, b.lineCount, x + dx, y);
		if (li >= 0) {
			const L = m.lines[li];
			// the nearest line only counts when the point is level with it (inside the line box, widened by half the gap to a neighbour)
			const dy = y < L.yTop ? L.yTop - y : y > L.yBot ? y - L.yBot : 0;
			if (dy <= 0.5 * (L.yBot - L.yTop) + EPS) {
				const h = textHit(m, ix, li, bi, -1, x + dx, y);
				if (h) return h;
			}
		}
	}
	if (b.kind === BlockKind.code) return { ...NONE_HIT, kind: 'code', block: bi };
	if (b.kind === BlockKind.exhibit) return { ...NONE_HIT, kind: 'exhibit', block: bi, ex: b.ex };
	if (b.kind === BlockKind.image) return { ...NONE_HIT, kind: 'image', block: bi };
	return { ...NONE_HIT, block: bi };
}

// ---- caret ---------------------------------------------------------------------------------------------------------------

export type Domain = 'body' | 'notes';

export interface Caret {
	/** the character boundary nearest to the point (byte offset) */
	off: number;
	/** byte offset of the glyph whose cell holds the point (for word and paragraph selection) */
	glyphOff: number;
	line: number;
	glyph: number;
	/** block of the line, -1 for a sidenote line */
	block: number;
	note: number;
	domain: Domain;
}

/** Which selection domain a press at (x, y) belongs to: the margin sidenotes select among themselves, the page among itself. */
export function domainAt(m: ReadingModel, x: number, y: number, opts: ViewOpts = {}): Domain {
	return hitTest(m, x, y, opts).note >= 0 ? 'notes' : 'body';
}

/** Estimated width of one space, em per em of glyph size (used only to place a boundary that sits in a gap between two glyphs). */
export const SPACE_EM = 0.27;

/** Whether the bytes [a, b) of the text are all whitespace (a gap between two glyph clusters, not a ligature). */
export function isGap(t: Uint8Array, a: number, b: number): boolean {
	if (b <= a) return false;
	for (let i = a; i < b; ) {
		if (!isWhitespaceAt(t, i)) return false;
		i += seqLen(t[i]);
	}
	return true;
}

/** Nearest selectable line to a point, whatever its distance (dragging keeps working above, below and beside the text). */
function nearestLine(m: ReadingModel, ix: TextIndex, domain: Domain, x: number, ly: number, opts: ViewOpts): number {
	const arr = domain === 'notes' ? ix.noteByY : ix.bodyByY;
	if (!arr.length) return -1;
	const { lines } = m;
	let k = lastIdx(arr.length, (i) => lines[arr[i]].yTop <= ly);
	if (k < 0) k = 0;
	let best = -1, bd = Infinity;
	const lim = 4;
	const consider = (i: number) => {
		const li = arr[i];
		if (lineHidden(m, li, opts.clipEm)) return;
		const L = lines[li];
		const dy = ly < L.yTop ? L.yTop - ly : ly > L.yBot ? ly - L.yBot : 0;
		const dx = x < L.x0 ? L.x0 - x : x > L.x1 ? x - L.x1 : 0;
		const d = dy * 1000 + dx;
		if (d < bd) { bd = d; best = li; }
	};
	for (let i = Math.max(0, k - lim); i <= Math.min(arr.length - 1, k + lim); i++) consider(i);
	return best;
}

/**
 * The caret (character boundary) nearest to the point, on the nearest line of `domain`; x left of a line gives its start (marker
 * included), right of it its end. Null only when the model has no selectable line.
 */
export function caretAt(m: ReadingModel, x: number, y: number, opts: ViewOpts & { domain?: Domain } = {}): Caret | null {
	const ix = textIndex(m);
	const domain = opts.domain ?? 'body';
	let ly = displayToLayoutY(m, y, opts.clipEm);
	if (foldClosed(m, opts.clipEm) && ly >= m.foldY && ly < opts.clipEm!) ly = m.foldY - 1e-3; // the peek band is the fold control
	// pick the line, trying the point's own x first, then without the code shift
	let li = nearestLine(m, ix, domain, x, ly, opts);
	if (li < 0) return null;
	const L = m.lines[li];
	const note = noteLineOf(L.block) ? L.block & ~NOTE_BIT : -1;
	const block = note >= 0 ? -1 : L.block;
	const dx = block >= 0 && m.blocks[block].kind === BlockKind.code ? (opts.codeDx?.(block) ?? 0) : 0;
	const xe = x + dx;
	const gs = m.glyphs;
	const first = L.firstGlyph, last = L.firstGlyph + L.glyphCount - 1;
	const lineS = ix.lineStart[li], lineE = ix.lineEnd[li];
	const j = glyphAtX(m, li, xe);
	const glyphOff = gs[j].charOffset;
	let off: number;
	if (xe <= gs[first].x) off = lineS;
	else if (xe >= L.x1 - EPS && j === last) off = lineE;
	else {
		const e = glyphCellEnd(m, li, j);
		const mid = (gs[j].x + e) / 2;
		off = xe < mid ? gs[j].charOffset : j < last ? gs[j + 1].charOffset : lineE;
	}
	return { off, glyphOff, line: li, glyph: j, block, note, domain: note >= 0 ? 'notes' : 'body' };
}
