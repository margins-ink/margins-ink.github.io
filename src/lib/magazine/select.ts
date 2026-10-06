// Text selection on the GPU-drawn reader (docs/MAGAZINE.md 4.3). Pure and DOM-free: a TextModel built from the RDR2
// tables (lines, glyphs, plain text) answers "which character boundary is under this point", "which word or line is
// here", "which rects cover a range" and "what is the exact plain text of a range". Positions are UTF-8 byte offsets
// into the plain text section (the same numbers glyph.charOffset and line.charOffset carry), so a selection and a copy
// use the cluster boundaries the shaper produced: a ligature glyph that stands for several characters is addressed by
// its first character and ends where the next glyph starts.

export interface TLineRec { yTop: number; yBot: number; x0: number; x1: number; firstGlyph: number; glyphCount: number; charOffset: number; frame: number }
export interface TGlyphRec { x: number; charOffset: number }
export interface TSpreadRec { firstLine: number; lineCount: number }

/** One laid-out line with per-glyph x extents and character boundaries. */
export interface SelLine {
	yTop: number; yBot: number; x0: number; x1: number;
	/** glyph left edges (em, spread-local) and the character byte offset each glyph starts at (non-decreasing) */
	gx: Float32Array;
	go: Int32Array;
	/** first byte of the line's text and one past its last byte */
	start: number;
	end: number;
}

export interface TextModel {
	text: Uint8Array;
	/** lines of each spread index */
	spreads: SelLine[][];
}

const dec = new TextDecoder();

/** Byte length of the UTF-8 sequence that starts with lead byte `b`. */
const seqLen = (b: number) => (b < 0x80 ? 1 : b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1);
const isCont = (b: number) => (b & 0xc0) === 0x80;

export function buildTextModel(lines: readonly TLineRec[], glyphs: readonly TGlyphRec[], text: Uint8Array, spreads: readonly TSpreadRec[]): TextModel {
	const mk = (l: TLineRec): SelLine | null => {
		if (l.glyphCount <= 0) return null;
		const gx = new Float32Array(l.glyphCount);
		const go = new Int32Array(l.glyphCount);
		let prev = l.charOffset;
		for (let i = 0; i < l.glyphCount; i++) {
			const g = glyphs[l.firstGlyph + i];
			gx[i] = g.x;
			// a synthetic glyph (the hyphen inserted at a break) carries no usable offset: it stays at the previous boundary
			const o = g.charOffset >= prev && g.charOffset < text.length ? g.charOffset : prev;
			go[i] = o;
			prev = o;
		}
		const last = go[go.length - 1];
		const end = Math.min(text.length, last + (last < text.length ? seqLen(text[last]) : 0));
		return { yTop: l.yTop, yBot: l.yBot, x0: l.x0, x1: l.x1, gx, go, start: go[0], end };
	};
	return { text, spreads: spreads.map((s) => lines.slice(s.firstLine, s.firstLine + s.lineCount).map(mk).filter((x): x is SelLine => x !== null)) };
}

/** Distance from a point to a line box: the row (y) dominates, so a point level with a line picks it however far left or right it is. */
function dist(l: SelLine, x: number, y: number): number {
	const dy = y < l.yTop ? l.yTop - y : y > l.yBot ? y - l.yBot : 0;
	const dx = x < l.x0 ? l.x0 - x : x > l.x1 ? x - l.x1 : 0;
	return dy * 1000 + dx;
}

/** The line under or nearest to the point; `tol` (em) bounds how far away counts as "on text" (Infinity while dragging). */
export function lineNear(m: TextModel, spread: number, x: number, y: number, tol = 0.6): SelLine | null {
	let best: SelLine | null = null;
	let bd = Infinity;
	for (const l of m.spreads[spread] ?? []) {
		const d = dist(l, x, y);
		if (d < bd) { bd = d; best = l; }
	}
	return best && bd <= tol ? best : null;
}

/** True when the point is on a text line (the cursor becomes the text cursor). */
export const onText = (m: TextModel, spread: number, x: number, y: number) => lineNear(m, spread, x, y, 0.05) !== null;

/** End boundary of glyph i of a line (the next glyph's start, or the line end). */
const glyphEnd = (l: SelLine, i: number) => (i + 1 < l.go.length ? l.go[i + 1] : l.end);
const gxEnd = (l: SelLine, i: number) => (i + 1 < l.gx.length ? l.gx[i + 1] : l.x1);

/**
 * Character boundary (byte offset) nearest to the point on its line. While dragging, `tol` is Infinity so the nearest
 * line wins; x left of the line gives its start and right of it its end.
 */
export function caretAt(m: TextModel, spread: number, x: number, y: number, tol = Infinity): { offset: number; line: SelLine } | null {
	const l = lineNear(m, spread, x, y, tol);
	if (!l) return null;
	if (x <= l.gx[0]) return { offset: l.start, line: l };
	for (let i = 0; i < l.gx.length; i++) {
		const e = gxEnd(l, i);
		if (x < e || i === l.gx.length - 1) {
			const mid = (l.gx[i] + e) / 2;
			return { offset: x < mid ? l.go[i] : glyphEnd(l, i), line: l };
		}
	}
	return { offset: l.end, line: l };
}

const wordCh = (cp: number) => /[\p{L}\p{N}_]/u.test(String.fromCodePoint(cp));

/** Code point starting at byte i, and the start of the previous code point before byte i. */
function cpAt(t: Uint8Array, i: number): number {
	const n = seqLen(t[i]);
	return dec.decode(t.subarray(i, i + n)).codePointAt(0) ?? 0;
}
function prevStart(t: Uint8Array, i: number): number {
	let j = i - 1;
	while (j > 0 && isCont(t[j])) j--;
	return j;
}

/** Word around a boundary: letters, digits and underscore; a run of other non-space characters if the point sits on punctuation. */
export function wordRange(m: TextModel, at: number, lo = 0, hi = m.text.length): [number, number] {
	const t = m.text;
	if (at >= hi && at > lo) at = prevStart(t, at);
	if (at < lo) at = lo;
	if (at >= hi) return [at, at];
	const space = (cp: number) => cp === 0x20 || cp === 0xa0 || cp === 0x0a || cp === 0x09;
	const cls = (cp: number) => (space(cp) ? 0 : wordCh(cp) ? 1 : 2);
	const c0 = cls(cpAt(t, at));
	let a = at;
	while (a > lo) {
		const p = prevStart(t, a);
		if (cls(cpAt(t, p)) !== c0) break;
		a = p;
	}
	let b = at;
	while (b < hi && cls(cpAt(t, b)) === c0) b += seqLen(t[b]);
	return [a, Math.min(b, hi)];
}

/** The visual line's text range. */
export const lineRange = (l: SelLine): [number, number] => [l.start, l.end];

export interface Sel { spread: number; lo: number; hi: number }

/**
 * Highlight rects (spread em: x0, y0, x1, y1) for the range [lo, hi): one per line, from the first selected glyph to the
 * end of the last one; a line the selection continues past is filled to its right edge (it covers the gap to the next line).
 */
export function selectionRects(m: TextModel, s: Sel): number[] {
	const out: number[] = [];
	if (s.hi <= s.lo) return out;
	for (const l of m.spreads[s.spread] ?? []) {
		if (s.hi <= l.start || s.lo >= l.end) continue;
		let a = 0;
		while (a < l.go.length && glyphEnd(l, a) <= s.lo) a++;
		let b = l.go.length - 1;
		while (b > a && l.go[b] >= s.hi) b--;
		if (a >= l.go.length) continue;
		const x0 = s.lo <= l.start ? l.x0 : l.gx[a];
		const x1 = s.hi >= l.end ? (s.hi > l.end ? l.x1 : gxEnd(l, l.go.length - 1)) : gxEnd(l, b);
		if (x1 > x0) out.push(x0, l.yTop, x1, l.yBot);
	}
	return out;
}

/** Exact plain text of a range, straight from the text section (no hyphen glyphs, no layout). */
export function textOf(m: TextModel, lo: number, hi: number): string {
	return dec.decode(m.text.subarray(Math.max(0, lo), Math.min(m.text.length, hi)));
}

/** Gesture state of a selection in progress: the anchor is a range so word and line drags extend by whole units. */
export interface SelDrag { spread: number; unit: 'char' | 'word' | 'line'; a0: number; a1: number }

/** Selection for the pointer at boundary `off` given the drag's anchor range: whole words or lines extend on both sides. */
export function extend(m: TextModel, d: SelDrag, off: number, line: SelLine | null): Sel {
	let f0 = off, f1 = off;
	if (d.unit === 'word') [f0, f1] = wordRange(m, off);
	else if (d.unit === 'line' && line) [f0, f1] = lineRange(line);
	return f0 < d.a0 ? { spread: d.spread, lo: f0, hi: d.a1 } : { spread: d.spread, lo: d.a0, hi: Math.max(d.a1, f1) };
}
