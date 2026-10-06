// Knuth-Plass optimal line breaking (Knuth and Plass 1981, "Breaking Paragraphs into Lines"),
// own implementation. Pure: no font code. Widths are in em; the caller measures text through a
// `Measure` (the harfbuzz path in scripts/reader/fonts.ts: sum of LoadedFont.shape advances).
// Line width is a function of the line index (the frame function of MAGAZINE.md 1.4), so a
// wrapped quote or any exclusion needs no special case. Optical margin hanging is built into the
// line-width computation (Box.hl / Box.hr, Penalty.hang).
import { HYPHEN_HANG, leftHang, rightHang } from './microtype';
import type { Hyphenator } from './hyph';

export const INF = 10000; // penalty value meaning "never" / "always"
const BIG_STRETCH = 1e6; // stands in for infinite stretch (finishing glue)

export type Box = { t: 'box'; w: number; text?: string; hl?: number; hr?: number };
export type Glue = { t: 'glue'; w: number; stretch: number; shrink: number; text?: string };
/** `w` is added to the line when the break is taken (a hyphen glyph); `hang` is how much of it hangs. */
export type Penalty = { t: 'pen'; w: number; p: number; flagged?: boolean; hang?: number };
export type Item = Box | Glue | Penalty;

export interface Interval { x0: number; x1: number }

export interface BreakOptions {
	/** target width of line `i` (0-based): a number (x0 = 0) or the interval the frame leaves free */
	lineWidth: (line: number) => number | Interval;
	tolerance?: number; // first pass adjustment-ratio limit (default 2)
	tolerance2?: number; // second pass (default 3)
	linePenalty?: number; // default 10
	hyphenDemerits?: number; // extra demerits for a flagged break (default 0; the penalty value already costs)
	doubleHyphenDemerits?: number; // two flagged breaks in a row (default 3000)
	fitnessDemerits?: number; // jump of more than one fitness class (default 3000)
	/** extra stretch allowance per line, em: ragged-right (set justified glue stretch to 0 and this > 0) */
	raggedStretch?: number;
	/** TeX \looseness: aim for this many more (+) or fewer (-) lines than the optimum */
	looseness?: number;
	/** hard cap on consecutive hyphenated lines (default 2; ignored in the emergency pass) */
	maxConsecutiveHyphens?: number;
}

export interface BrokenLine {
	index: number;
	/** item range of the line: items[start..end) are set; items[end] is the break (glue or penalty) */
	start: number;
	end: number;
	/** adjustment ratio: <0 shrunk, >0 stretched (0 for forced / last lines) */
	ratio: number;
	/** the break is a flagged penalty with a hyphen glyph shown */
	hyphen: boolean;
	x0: number; // left edge of the frame interval
	width: number; // target width of the line
	/** hanging amount on the left (set the first glyph at x0 - hangLeft) */
	hangLeft: number;
	hangRight: number;
	natural: number; // natural width of the content, hanging excluded
}

interface Node {
	pos: number; // break item index, -1 for the start
	start: number; // first item of the next line (after discarded glue/penalties)
	line: number; // lines completed
	fit: number;
	demerits: number;
	flagged: boolean;
	run: number; // consecutive flagged breaks ending here
	prev: Node | null;
	ratio: number;
	W: number; Y: number; Z: number; // sums at `start`
}

function fitClass(r: number): number {
	if (r < -0.5) return 0; // tight
	if (r <= 0.5) return 1; // normal
	if (r <= 1) return 2; // loose
	return 3; // very loose
}

function span(f: BreakOptions['lineWidth'], line: number): Interval {
	const v = f(line);
	return typeof v === 'number' ? { x0: 0, x1: v } : v;
}

function run(items: Item[], o: BreakOptions, tol: number, emergency: boolean): Node | null {
	const n = items.length;
	const W = new Float64Array(n + 1), Y = new Float64Array(n + 1), Z = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) {
		const it = items[i];
		W[i + 1] = W[i]; Y[i + 1] = Y[i]; Z[i + 1] = Z[i];
		if (it.t === 'box') W[i + 1] += it.w;
		else if (it.t === 'glue') { W[i + 1] += it.w; Y[i + 1] += it.stretch; Z[i + 1] += it.shrink; }
	}
	const lp = o.linePenalty ?? 10;
	const dh = o.doubleHyphenDemerits ?? 3000;
	const df = o.fitnessDemerits ?? 3000;
	const hd = o.hyphenDemerits ?? 0;
	const rs = o.raggedStretch ?? 0;
	const maxRun = emergency ? Infinity : o.maxConsecutiveHyphens ?? 2;
	// start-of-line index: skip glue and non-forced penalties after a break
	const after = (b: number) => {
		let s = b + 1;
		while (s < n) {
			const it = items[s];
			if (it.t === 'box' || (it.t === 'pen' && it.p <= -INF)) break;
			s++;
		}
		return s;
	};
	const root: Node = { pos: -1, start: 0, line: 0, fit: 1, demerits: 0, flagged: false, run: 0, prev: null, ratio: 0, W: 0, Y: 0, Z: 0 };
	let active: Node[] = [root];
	let finals: Node[] = [];

	for (let b = 0; b < n; b++) {
		const it = items[b];
		let legal = false;
		if (it.t === 'glue') legal = b > 0 && items[b - 1].t === 'box';
		else if (it.t === 'pen') legal = it.p < INF;
		if (!legal) continue;
		const pen = it.t === 'pen' ? it : null;
		const forced = pen !== null && pen.p <= -INF;
		const last = forced && b === n - 1;
		const cands = new Map<number, Node>();
		const survivors: Node[] = [];

		for (const a of active) {
			const sp = span(o.lineWidth, a.line);
			const s = a.start;
			const first = items[s];
			const hl = first && first.t === 'box' ? first.hl ?? 0 : 0;
			let hr = 0;
			if (pen && pen.w > 0) hr = pen.hang ?? 0;
			else {
				const pv = items[b - 1];
				if (pv && pv.t === 'box') hr = pv.hr ?? 0;
			}
			const nat = W[b] - W[s] + (pen ? pen.w : 0) - hl - hr;
			const width = sp.x1 - sp.x0;
			const slack = width - nat;
			let r: number;
			if (slack > 1e-9) {
				const st = Y[b] - Y[s] + rs;
				r = st > 0 ? slack / st : Infinity;
			} else if (slack < -1e-9) {
				const sh = Z[b] - Z[s];
				r = sh > 0 ? slack / sh : -Infinity;
			} else r = 0;

			let over = false;
			if (r < -1) {
				if (emergency) over = true;
				else if (!forced) continue; // deactivate
				else continue;
			} else if (!forced) survivors.push(a);
			if (r > tol && !forced) continue; // not feasible here, stays active
			if (forced && r > tol) r = 0; // forced break ends the line with fill (never penalised)

			let bad: number;
			if (over) bad = 100 + 1e4 * (-Math.max(r, -1e3) - 1) + 1e4;
			else bad = 100 * Math.pow(Math.abs(Math.min(r, tol)), 3);
			if (forced && r > 0) bad = 0;
			const flagged = !!pen?.flagged && pen.w > 0;
			const run = flagged ? (a.flagged ? a.run + 1 : 1) : 0;
			if (run > maxRun) continue;
			let d = (lp + bad) ** 2;
			if (pen) { if (pen.p >= 0) d += pen.p * pen.p; else if (pen.p > -INF) d -= pen.p * pen.p; }
			if (flagged) { d += hd; if (a.flagged) d += dh; }
			const fit = fitClass(over ? -1 : r);
			if (Math.abs(fit - a.fit) > 1) d += df;
			const total = a.demerits + d;
			const key = ((a.line + 1) * 4 + fit) * 8 + run;
			const cur = cands.get(key);
			if (!cur || total < cur.demerits) {
				cands.set(key, {
					pos: b, start: after(b), line: a.line + 1, fit, demerits: total, flagged, run, prev: a,
					ratio: forced && r > 0 ? 0 : over ? -1 : r, W: 0, Y: 0, Z: 0
				});
			}
		}
		if (forced) active = [];
		else active = survivors;
		for (const c of cands.values()) {
			c.W = W[c.start]; c.Y = Y[c.start]; c.Z = Z[c.start];
			if (last) finals.push(c); else active.push(c);
		}
		if (!last && active.length === 0) return null;
		if (last) break;
	}
	if (!finals.length) return null;
	finals.sort((a, c) => a.demerits - c.demerits);
	let best = finals[0];
	const loose = o.looseness ?? 0;
	if (loose !== 0) {
		const want = best.line + loose;
		let bd = Infinity;
		for (const f of finals) {
			const dist = Math.abs(f.line - want);
			if (dist < bd || (dist === bd && f.demerits < best.demerits)) { bd = dist; best = f; }
		}
	}
	return best;
}

/**
 * Break `items` into lines. `items` must end with a finishing glue and a forced penalty
 * (use `finishParagraph`). Tries tolerance 2, then 3, then an emergency pass that allows overfull lines.
 */
export function breakLines(items: Item[], o: BreakOptions): BrokenLine[] {
	const t1 = o.tolerance ?? 2, t2 = o.tolerance2 ?? 3;
	const end = run(items, o, t1, false) ?? run(items, o, t2, false) ?? run(items, o, Infinity, true);
	if (!end) throw new Error('kp: no breaks found (empty paragraph or no legal breakpoint)');
	const chain: Node[] = [];
	for (let nd: Node | null = end; nd && nd.prev; nd = nd.prev) chain.push(nd);
	chain.reverse();
	const lines: BrokenLine[] = [];
	for (const nd of chain) {
		const a = nd.prev!;
		const sp = span(o.lineWidth, a.line);
		const pen = items[nd.pos].t === 'pen' ? (items[nd.pos] as Penalty) : null;
		const first = items[a.start];
		const hl = first && first.t === 'box' ? first.hl ?? 0 : 0;
		let hr = 0;
		if (pen && pen.w > 0) hr = pen.hang ?? 0;
		else {
			const pv = items[nd.pos - 1];
			if (pv && pv.t === 'box') hr = pv.hr ?? 0;
		}
		let nat = 0;
		for (let i = a.start; i < nd.pos; i++) { const it = items[i]; if (it.t !== 'pen') nat += it.w; }
		nat += pen ? pen.w : 0;
		lines.push({
			index: a.line, start: a.start, end: nd.pos, ratio: nd.ratio,
			hyphen: !!pen && pen.w > 0 && !!pen.flagged, x0: sp.x0, width: sp.x1 - sp.x0,
			hangLeft: hl, hangRight: hr, natural: nat - hl - hr
		});
	}
	return lines;
}

/** Append the finishing glue (infinite stretch) and the forced final break. */
export function finishParagraph(items: Item[]): Item[] {
	items.push({ t: 'pen', w: 0, p: INF }); // glue after a box must not break before the fill
	items.push({ t: 'glue', w: 0, stretch: BIG_STRETCH, shrink: 0 });
	items.push({ t: 'pen', w: 0, p: -INF });
	return items;
}

/** Text of a broken line: boxes and glue as written, a trailing `-` when a hyphen is shown. */
export function lineText(items: Item[], l: BrokenLine): string {
	let s = '';
	for (let i = l.start; i < l.end; i++) {
		const it = items[i];
		if (it.t === 'box') s += it.text ?? '';
		else if (it.t === 'glue') s += it.text ?? (it.w > 0 ? ' ' : '');
	}
	if (l.hyphen) s += '-';
	return s;
}

// ---------------------------------------------------------------------------------------------
// Items from text

/** Width in em of a string in the paragraph's font (sum of shaped advances). */
export type Measure = (s: string) => number;

/** Convenience: a Measure over anything shaped like LoadedFont (`shape(text) -> {xAdvance}[]`). */
export function shapedMeasure(font: { shape(t: string): { xAdvance: number }[] }): Measure {
	const cache = new Map<string, number>();
	return (s) => {
		let w = cache.get(s);
		if (w === undefined) {
			w = 0;
			for (const g of font.shape(s)) w += g.xAdvance;
			cache.set(s, w);
		}
		return w;
	};
}

export interface TextOptions {
	align?: 'justify' | 'ragged';
	space?: number; // em, default 0.25
	stretch?: number; // default 0.12 (justify), 0 (ragged)
	shrink?: number; // default 0.08
	hyphenator?: Hyphenator | null;
	hyphenPenalty?: number; // default 50
	explicitHyphenPenalty?: number; // break after a typed `-`, default 50
	microtype?: boolean; // hanging punctuation, default true
	/** first-line indent in em (a leading empty box), default 0 */
	indent?: number;
}

/**
 * Turn a paragraph (plain text, whitespace collapsed; U+00A0 is fixed non-breaking glue) into
 * K-P items: one box per syllable, discretionary hyphen penalties from Liang patterns,
 * break opportunities after a typed hyphen or dash. Piece widths are differences of prefix
 * measurements of the whole word, so kerning is exact across syllable seams. Includes the finish.
 */
export function itemsFromText(text: string, measure: Measure, o: TextOptions = {}): Item[] {
	const justify = (o.align ?? 'justify') === 'justify';
	const space = o.space ?? 0.25;
	const stretch = o.stretch ?? (justify ? 0.12 : 0);
	const shrink = o.shrink ?? (justify ? 0.08 : 0);
	const hp = o.hyphenPenalty ?? 50;
	const ep = o.explicitHyphenPenalty ?? 50;
	const mt = o.microtype ?? true;
	const hyphW = measure('-');
	const items: Item[] = [];
	if (o.indent) items.push({ t: 'box', w: o.indent, text: '' });
	const parts = text.split(/([ \t\r\n]+| )/).filter((p) => p !== '');
	let prevWasWord = false;
	for (const part of parts) {
		if (part === ' ') {
			items.push({ t: 'pen', w: 0, p: INF });
			items.push({ t: 'glue', w: space, stretch: 0, shrink: 0, text: ' ' });
			prevWasWord = false;
			continue;
		}
		if (/^[ \t\r\n]+$/.test(part)) {
			if (prevWasWord) items.push({ t: 'glue', w: space, stretch, shrink, text: ' ' });
			prevWasWord = false;
			continue;
		}
		pushWord(items, part, measure, o.hyphenator ?? null, { hp, ep, hyphW, mt });
		prevWasWord = true;
	}
	while (items.length && items[items.length - 1].t === 'glue') items.pop();
	return finishParagraph(items);
}

function pushWord(items: Item[], word: string, measure: Measure, hy: Hyphenator | null, c: { hp: number; ep: number; hyphW: number; mt: boolean }) {
	// cut points: [index, kind]; kind 'h' = discretionary hyphen, 'e' = after a typed hyphen/dash
	const cuts: { at: number; kind: 'h' | 'e' }[] = [];
	// segments split after typed hyphens and em/en dashes (inside a word, not trailing)
	const segBounds: number[] = [0];
	for (let i = 0; i < word.length - 1; i++) {
		const ch = word[i];
		if ((ch === '-' || ch === '–' || ch === '—' || ch === '‐') && i > 0 && /[\p{L}\p{N}]/u.test(word[i - 1]) && /[\p{L}\p{N}]/u.test(word[i + 1])) {
			segBounds.push(i + 1);
			cuts.push({ at: i + 1, kind: 'e' });
		}
	}
	segBounds.push(word.length);
	if (hy) {
		for (let s = 0; s + 1 < segBounds.length; s++) {
			const a = segBounds[s], b = segBounds[s + 1];
			// strip surrounding punctuation so patterns see letters only
			const seg = word.slice(a, b);
			const m = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/.exec(seg);
			if (!m) continue;
			const off = a + m[1].length;
			for (const k of hy.hyphenate(m[2])) cuts.push({ at: off + k, kind: 'h' });
		}
	}
	cuts.sort((x, y) => x.at - y.at);
	let from = 0;
	let wPrev = 0;
	const bounds = [...cuts.map((x) => x.at), word.length];
	for (let i = 0; i < bounds.length; i++) {
		const to = bounds[i];
		if (to === from) continue;
		const w = measure(word.slice(0, to));
		const piece = word.slice(from, to);
		const box: Box = { t: 'box', w: w - wPrev, text: piece };
		if (c.mt) {
			const f = piece[0], l = piece[piece.length - 1];
			const hl = leftHang(f), hr = rightHang(l);
			if (hl) box.hl = hl * measure(f);
			if (hr) box.hr = hr * measure(l);
		}
		items.push(box);
		wPrev = w;
		from = to;
		if (i < cuts.length) {
			if (cuts[i].kind === 'h') items.push({ t: 'pen', w: c.hyphW, p: c.hp, flagged: true, hang: c.mt ? HYPHEN_HANG * c.hyphW : 0 });
			else items.push({ t: 'pen', w: 0, p: c.ep, flagged: true });
		}
	}
}
