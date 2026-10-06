// In-engine find (docs/READING_GPU.md "Selection, links, copy, find"). Pure, no DOM.
// Case and diacritics insensitive search over the FULL article text (folded blocks included); hits are byte ranges of model.text, so
// they use the same offsets as the selection and map to plates with rangeRects.

import { BlockFlag, NOTE_BIT, type ReadingModel } from '../magazine/format';
import { lineContaining, textIndex, type ViewOpts } from './hit';
import { rangeRects, type Rect } from './select';

export interface Range { lo: number; hi: number }

/** Per code point fold: lower case, NFD, combining marks dropped, no-break spaces and curly quotes to their plain forms. */
function foldCp(cp: string): string {
	switch (cp) {
		case ' ': case ' ': case ' ': case ' ': return ' ';
		case '‘': case '’': return "'";
		case '“': case '”': return '"';
	}
	return cp.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

/** The search normalisation of a string (what both the text and the query go through). */
export function normalizeForFind(s: string): string {
	let out = '';
	for (const cp of s) out += foldCp(cp);
	return out;
}

interface Normed {
	str: string;
	norm: string;
	/** per UTF-16 unit of norm: UTF-16 start and end of the source code point */
	from: Int32Array;
	to: Int32Array;
	/** per UTF-16 unit of str (plus one): byte offset in the UTF-8 form */
	bytes: Uint32Array | null;
}

function normalise(str: string, withBytes: boolean): Normed {
	let norm = '';
	const from: number[] = [], to: number[] = [];
	const bytes = withBytes ? new Uint32Array(str.length + 1) : null;
	let b = 0, i = 0;
	for (const cp of str) {
		const n = cp.length;
		const f = foldCp(cp);
		for (let k = 0; k < f.length; k++) { from.push(i); to.push(i + n); }
		norm += f;
		const cpv = cp.codePointAt(0)!;
		const bl = cpv < 0x80 ? 1 : cpv < 0x800 ? 2 : cpv < 0x10000 ? 3 : 4;
		if (bytes) for (let k = 0; k < n; k++) bytes[i + k] = b;
		b += bl;
		i += n;
	}
	if (bytes) bytes[i] = b;
	return { str, norm, from: Int32Array.from(from), to: Int32Array.from(to), bytes };
}

const blobCache = new WeakMap<Uint8Array, Normed>();

/**
 * Every non-overlapping occurrence of `query` in `text`, case and diacritics insensitive, in order. A string gives UTF-16 index ranges
 * of that string; a Uint8Array (UTF-8, the article text section) gives byte ranges. An empty query finds nothing.
 */
export function findAll(text: string | Uint8Array, query: string): Range[] {
	const q = normalizeForFind(query);
	if (!q) return [];
	let nm: Normed;
	if (typeof text === 'string') nm = normalise(text, false);
	else {
		let c = blobCache.get(text);
		if (!c) blobCache.set(text, (c = normalise(new TextDecoder().decode(text), true)));
		nm = c;
	}
	const out: Range[] = [];
	for (let at = nm.norm.indexOf(q); at >= 0; at = nm.norm.indexOf(q, at + q.length)) {
		const lo = nm.from[at], hi = nm.to[at + q.length - 1];
		out.push(nm.bytes ? { lo: nm.bytes[lo], hi: nm.bytes[hi] } : { lo, hi });
	}
	return out;
}

export interface FindHit extends Range {
	/** index into model.blocks, -1 for a margin note or when the hit is outside any line */
	block: number;
	/** index into model.notes for a wide-class margin note line, else -1 */
	note: number;
	/** absolute line index of the first character, -1 when none */
	line: number;
	/** the hit is inside the folded region: the caller expands the fold before scrolling to it */
	inFold: boolean;
	/** the hit is in a brief (collapsed view) block, whose text the folded region repeats */
	brief: boolean;
}

export interface FindOpts {
	/** drop hits inside brief blocks (their text is repeated in the folded region); default false = the literal full text */
	skipBrief?: boolean;
}

/**
 * Find over model.text. Hits inside fold buttons are dropped (interface text, not article text). Each hit is mapped to its block
 * (through the line that holds its first character) and flagged when that block is folded.
 */
export function findInModel(m: ReadingModel, query: string, opts: FindOpts = {}): FindHit[] {
	const ix = textIndex(m);
	const out: FindHit[] = [];
	for (const r of findAll(m.text, query)) {
		if (ix.uiRanges.some(([a, z]) => r.lo >= a && r.lo < z)) continue;
		const li = lineContaining(m, r.lo);
		let block = -1, note = -1, flags = 0;
		if (li >= 0) {
			const lb = m.lines[li].block;
			if (lb >>> 0 >= NOTE_BIT) {
				note = lb & ~NOTE_BIT;
				flags = m.blocks[m.notes[note]?.anchorBlock ?? -1]?.flags ?? 0;
			} else {
				block = lb;
				flags = m.blocks[lb]?.flags ?? 0;
			}
		}
		const brief = !!(flags & BlockFlag.brief);
		if (opts.skipBrief && brief) continue;
		out.push({ ...r, block, note, line: li, inFold: !!(flags & BlockFlag.folded) && m.foldH > 0, brief });
	}
	return out;
}

/** Next hit index after `cur` (wraps); -1 when there are no hits. cur = -1 gives the first. */
export const nextHit = (hits: readonly Range[], cur: number): number => (hits.length ? (cur + 1) % hits.length : -1);
/** Previous hit index before `cur` (wraps); -1 when there are no hits. cur = -1 gives the last. */
export const prevHit = (hits: readonly Range[], cur: number): number => (hits.length ? (cur <= 0 ? hits.length - 1 : cur - 1) : -1);
/** Index of the first hit at or after byte `off` (wraps to 0), -1 when there are no hits: keeps the current hit stable while typing. */
export function hitFrom(hits: readonly Range[], off: number): number {
	if (!hits.length) return -1;
	let lo = 0, hi = hits.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (hits[mid].hi <= off) lo = mid + 1; else hi = mid;
	}
	return lo < hits.length ? lo : 0;
}

export interface FindRect extends Rect {
	/** index into the ranges array */
	range: number;
}

/** Plates (displayed document em) of every range, one per line; ranges clipped away by the closed fold give none. */
export function rangesToRects(m: ReadingModel, ranges: readonly Range[], opts: ViewOpts & { pad?: number } = {}): FindRect[] {
	const out: FindRect[] = [];
	ranges.forEach((r, i) => { for (const p of rangeRects(m, r.lo, r.hi, opts)) out.push({ ...p, range: i }); });
	return out;
}
