// Full-text layer planner (docs/MAGAZINE.md 1.4 step 5 and 1.5): greedy fill of `text` and `text-code` spreads in
// reading order, with widow and orphan control, headings kept with their next lines, floating inline figures with a
// distance penalty, and a copyfit pass for a nearly empty last spread. Line counts come from a `Measurer` (the
// Knuth-Plass lane plugs in here); the planner itself never shapes text.
import type { Rect } from '../../src/lib/magazine/types';
import { LINE_H, lintSolved, solveTemplate, type SheetClass, type Solved } from './grid';
import { buildFrames, threads, type GridFrame } from './frames';
import { TEMPLATES, type TemplateId } from './templates';

export const MIN_LINES = 2; // widow and orphan
export const KEEP_NEXT = 2; // lines of the next block that must follow a heading in its frame

// ---- input ---------------------------------------------------------------------------------------

export type FlowBlock =
	| { id: string; kind: 'para' }
	| { id: string; kind: 'heading' }
	/** code: wrapped by the measurer at the frame width (code is set on the code thread when the template has one) */
	| { id: string; kind: 'code' }
	/** composite block (list, quote, note, table, math, rule, refs): a stack of lines laid out by the composer, splittable between lines */
	| { id: string; kind: 'box' }
	/** figure: natural size in em, caption lines, `ref` = index of the first block that mentions it */
	| { id: string; kind: 'figure'; place: 'column' | 'wide'; w: number; h: number; captionLines: number; ref?: number };

export interface FitOpts { tracking: number; looseness: number }
export const NEUTRAL: FitOpts = { tracking: 0, looseness: 0 };

/** Number of lines `block` (para, heading, code or box) takes at `widthEm`. */
export type Measurer = (block: FlowBlock, widthEm: number, opts: FitOpts) => number;

export interface PlanOpts {
	cls: SheetClass;
	measure: Measurer;
	fit?: FitOpts;
	/** index of the first full-text spread (1: spread 0 is the distilled layer) */
	firstSpread?: number;
	maxSpreads?: number;
}

// ---- output --------------------------------------------------------------------------------------

export interface Placement {
	block: string;
	blockIndex: number;
	kind: FlowBlock['kind'];
	frame: number; // GridFrame id within the spread
	thread: number;
	startLine: number;
	lineCount: number;
	part: number; // 0-based piece of a split block
	last: boolean; // final piece of the block
	/** figures: placed rectangle in spread em */
	rect?: Rect;
}

export interface PlannedSpread {
	index: number;
	template: TemplateId;
	solved: Solved;
	frames: GridFrame[];
	placements: Placement[];
	linesUsed: number;
	capacity: number;
}

export interface Plan {
	cls: SheetClass;
	spreads: PlannedSpread[];
	fit: FitOpts;
	/** last spread fill ratio below 0.2: underflow the author may fill with a quote or numeral */
	underflow: boolean;
	violations: string[];
}

// ---- helpers -------------------------------------------------------------------------------------

const GAP_BEFORE: Record<FlowBlock['kind'], number> = { para: 0, heading: 1, code: 1, figure: 1, box: 1 };
const GAP_AFTER: Record<FlowBlock['kind'], number> = { para: 0, heading: 0, code: 1, figure: 1, box: 1 };

interface ThreadState { frames: GridFrame[]; used: number[]; fi: number }

const mkThread = (frames: GridFrame[]): ThreadState => ({ frames, used: frames.map(() => 0), fi: 0 });
const remaining = (t: ThreadState) => (t.fi < t.frames.length ? t.frames[t.fi].lines - t.used[t.fi] : 0);

interface Work { index: number; block: FlowBlock; done: number; total: number | null; parts: number }

/** Figure height in lines for a frame width. */
function figureLines(b: Extract<FlowBlock, { kind: 'figure' }>, width: number, maxLines: number): number {
	const scale = width / b.w;
	const l = Math.ceil((b.h * scale) / LINE_H - 1e-9) + b.captionLines;
	return Math.max(1, Math.min(l, maxLines));
}

/** Width of the code thread of the `text-code` template (code is wrapped at this width wherever the block lands on a code frame). */
export function codeWidth(cls: SheetClass): number {
	const fr = threads(buildFrames(solveTemplate(TEMPLATES['text-code'], cls))).get(1);
	if (!fr?.length) throw new Error('planner: text-code has no code thread');
	return fr[0].width;
}

/** Pick the template for the next spread from the blocks that will probably land on it. */
function chooseTemplate(queue: Work[], cls: SheetClass, measure: Measurer, fit: FitOpts, pendingWide: boolean): TemplateId {
	if (pendingWide) return 'text';
	const text = solveTemplate(TEMPLATES.text, cls);
	const cap = buildFrames(text).reduce((n, f) => n + f.lines, 0);
	const w = buildFrames(text)[0].width;
	const cw = codeWidth(cls);
	let acc = 0;
	for (const q of queue) {
		if (q.block.kind === 'code' && measure(q.block, cw, fit) - q.done >= 4) return 'text-code';
		acc += q.block.kind === 'figure' ? 8 : measure(q.block, w, fit) + 1;
		if (acc > cap) break;
	}
	return 'text';
}

// ---- the planner ---------------------------------------------------------------------------------

export function planFullText(blocks: FlowBlock[], o: PlanOpts): Plan {
	const fit = o.fit ?? NEUTRAL;
	const first = o.firstSpread ?? 1;
	const maxSpreads = o.maxSpreads ?? 400;
	const cache = new Map<string, number>();
	const measure: Measurer = (b, w, f) => {
		const k = `${b.id}|${w.toFixed(3)}|${f.tracking}|${f.looseness}`;
		let v = cache.get(k);
		if (v === undefined) { v = Math.max(1, o.measure(b, w, f)); cache.set(k, v); }
		return v;
	};

	const queue: Work[] = blocks.map((block, index) => ({ index, block, done: 0, total: null, parts: 0 }));
	let pending: Work[] = []; // floating figures waiting for a frame
	const spreads: PlannedSpread[] = [];
	const spreadOfBlock = new Map<number, number>(); // first placement per block index
	const violations: string[] = [];

	while (queue.length || pending.length) {
		if (spreads.length >= maxSpreads) throw new Error('planner: spread limit reached (no progress?)');
		const index = first + spreads.length;
		const pendingWide = pending.some((p) => p.block.kind === 'figure' && p.block.place === 'wide');
		const head = queue.length ? queue : pending;
		const tid = chooseTemplate(head, o.cls, measure, fit, pendingWide && o.cls === 'wide');
		const solved = solveTemplate(TEMPLATES[tid], o.cls);
		const errs = lintSolved(solved);
		if (errs.length) throw new Error(errs.join('; '));
		const frames = buildFrames(solved);
		const th = threads(frames);
		const proseT = mkThread(th.get(0) ?? []);
		const codeT = th.has(1) ? mkThread(th.get(1)!) : null;
		const placements: Placement[] = [];
		const spread: PlannedSpread = { index, template: tid, solved, frames, placements, linesUsed: 0, capacity: frames.reduce((n, f) => n + f.lines, 0) };

		const record = (w: Work, t: ThreadState, fi: number, start: number, n: number, rect?: Rect) => {
			const part = w.parts++;
			placements.push({ block: w.block.id, blockIndex: w.index, kind: w.block.kind, frame: t.frames[fi].id, thread: t.frames[fi].thread, startLine: start, lineCount: n, part, last: false, rect });
			if (!spreadOfBlock.has(w.index)) spreadOfBlock.set(w.index, index);
			t.used[fi] = start + n;
		};
		const markLast = (w: Work) => {
			for (let i = placements.length - 1; i >= 0; i--) if (placements[i].blockIndex === w.index) { placements[i].last = true; break; }
		};

		let gapAfter = 0;
		const gapNeed = (t: ThreadState, kind: FlowBlock['kind']) => (t.used[t.fi] === 0 ? 0 : Math.max(GAP_BEFORE[kind], gapAfter));

		const advance = (t: ThreadState) => { t.fi++; gapAfter = 0; flushPending(t); };

		// place figures that floated; called at the top of every new frame
		const flushPending = (t: ThreadState) => {
			if (t.fi >= t.frames.length || t.used[t.fi] !== 0) return;
			for (let i = 0; i < pending.length; i++) {
				const w = pending[i];
				if (w.block.kind !== 'figure') continue;
				if (tryFigure(w, t, true)) { pending.splice(i, 1); i--; gapAfter = 1; }
			}
		};

		// try to put a figure at the cursor (floating = no look-ahead, only the current frame). true when placed.
		const tryFigure = (w: Work, t: ThreadState, atTop: boolean): boolean => {
			const b = w.block as Extract<FlowBlock, { kind: 'figure' }>;
			if (t.fi >= t.frames.length) return false;
			const f = t.frames[t.fi];
			const wide = b.place === 'wide' && o.cls === 'wide' && tid === 'text';
			if (wide) {
				const mate = t.frames[t.fi + 1];
				const sheetFirst = t.fi === 0 || t.frames[t.fi - 1].sheet !== f.sheet;
				if (!sheetFirst || t.used[t.fi] !== 0 || !mate || mate.sheet !== f.sheet || t.used[t.fi + 1] !== 0) return false;
				const width = mate.rect.x1 - f.rect.x0;
				const l = figureLines(b, width, f.lines - 4);
				const rect: Rect = { x0: f.rect.x0, x1: mate.rect.x1, y0: f.baseline(0) - 1.2, y1: f.baseline(l - 1) + 0.4 };
				f.exclude(rect); mate.exclude(rect);
				record(w, t, t.fi, 0, l, rect); markLast(w);
				t.used[t.fi + 1] = l;
				gapAfter = 1;
				return true;
			}
			const gap = atTop ? 0 : gapNeed(t, 'figure');
			const l = figureLines(b, f.width, Math.max(1, f.lines - 4));
			if (gap + l > remaining(t)) return false;
			const start = t.used[t.fi] + gap;
			const rect: Rect = { x0: f.rect.x0, x1: f.rect.x1, y0: f.baseline(start) - 1.2, y1: f.baseline(start + l - 1) + 0.4 };
			record(w, t, t.fi, start, l, rect); markLast(w);
			gapAfter = 1;
			return true;
		};

		// place as much of a splittable block (para, heading, code) as the thread allows. returns lines placed.
		const placeLines = (w: Work, t: ThreadState, total: number): number => {
			let placed = 0;
			const kind = w.block.kind;
			let guard = 0;
			while (placed < total && t.fi < t.frames.length) {
				if (++guard > 1000) throw new Error('planner: no progress placing ' + w.block.id);
				const f = t.frames[t.fi];
				const rem = total - placed;
				const gap = gapNeed(t, kind);
				const avail = f.lines - t.used[t.fi] - gap;
				const keep = kind === 'heading' ? KEEP_NEXT : 0;
				if (kind === 'heading') {
					if (avail >= rem + (queue.length > 1 ? keep : 0)) {
						record(w, t, t.fi, t.used[t.fi] + gap, rem, undefined); placed += rem; gapAfter = 0;
					} else advance(t);
					continue;
				}
				if (avail >= rem) {
					record(w, t, t.fi, t.used[t.fi] + gap, rem); placed += rem; gapAfter = GAP_AFTER[kind];
					continue;
				}
				const take = Math.min(avail, rem - MIN_LINES);
				if (take >= MIN_LINES) {
					record(w, t, t.fi, t.used[t.fi] + gap, take); placed += take; w.done += take;
					advance(t);
				} else advance(t);
			}
			return placed;
		};

		// ---- fill ----
		while (queue.length) {
			const w = queue[0];
			const b = w.block;
			let t: ThreadState = proseT;
			if (b.kind === 'code') {
				if (codeT) t = codeT;
				else if (measure(b, codeWidth(o.cls), fit) - w.done >= 4) break; // needs a text-code spread
			}
			if (t.fi >= t.frames.length) break;
			if (spread.placements.length === 0 && t.used[t.fi] === 0) flushPending(t);

			if (b.kind === 'figure') {
				if (tryFigure(w, t, false)) { queue.shift(); continue; }
				// float: the next blocks flow on, the figure waits for the top of a frame
				pending.push(w); queue.shift();
				continue;
			}
			const width = t.frames[t.fi].width;
			const total = measure(b, width, fit);
			if (w.total === null) w.total = total;
			const rest = w.total - w.done;
			const before = w.done;
			const n = placeLines(w, t, rest);
			if (before + n >= w.total) { markLast(w); queue.shift(); }
			else { w.done = before + n; break; }
		}
		// nothing left to flow: floating figures take the next frame tops
		while (!queue.length && pending.length && proseT.fi < proseT.frames.length) {
			if (tryFigure(pending[0], proseT, false)) pending.shift();
			else { proseT.fi++; gapAfter = 0; }
		}
		spread.linesUsed = [...proseT.used, ...(codeT ? codeT.used : [])].reduce((a, b) => a + b, 0);
		if (spread.placements.length === 0) {
			throw new Error(`planner: empty spread ${index} (template ${tid}, next block ${queue[0]?.block.id})`);
		}
		spreads.push(spread);
	}

	// figure distance penalty
	for (const s of spreads) for (const p of s.placements) {
		if (p.kind !== 'figure' || p.part !== 0) continue;
		const b = blocks[p.blockIndex] as Extract<FlowBlock, { kind: 'figure' }>;
		if (b.ref === undefined) continue;
		const rs = spreadOfBlock.get(b.ref);
		if (rs !== undefined && s.index - rs > 1) violations.push(`figure ${b.id} is ${s.index - rs} spreads after its first reference`);
	}
	const lastFill = spreads.length ? spreads[spreads.length - 1].linesUsed / spreads[spreads.length - 1].capacity : 1;
	return { cls: o.cls, spreads, fit, underflow: spreads.length > 1 && lastFill < 0.2, violations };
}

/**
 * Plan, then copyfit: when the last spread is almost empty try tighter tracking and looseness -1 within the
 * template's ranges (1.4 step 5) and keep the first setting that removes a spread.
 */
export function planWithCopyfit(blocks: FlowBlock[], o: PlanOpts): Plan {
	const base = planFullText(blocks, o);
	if (base.spreads.length < 2) return base;
	const last = base.spreads[base.spreads.length - 1];
	if (last.linesUsed / last.capacity > 0.25) return base;
	const [lo] = TEMPLATES[last.template].fit.tracking;
	const tries: FitOpts[] = [];
	for (const looseness of [0, -1]) for (const tr of [lo / 2, lo]) tries.push({ tracking: tr, looseness });
	for (const fit of tries) {
		const p = planFullText(blocks, { ...o, fit });
		if (p.spreads.length < base.spreads.length) return p;
	}
	return base;
}

// ---- validation (A1/A2 invariants on a plan; planted-bug controls live in the tests) -----------------

export function validatePlan(plan: Plan, blocks: FlowBlock[]): string[] {
	const errs: string[] = [...plan.violations];
	const kinds = new Map(blocks.map((b, i) => [i, b.kind]));
	for (const s of plan.spreads) {
		const byBlock = new Map<number, Placement[]>();
		for (const p of s.placements) {
			const l = byBlock.get(p.blockIndex);
			if (l) l.push(p); else byBlock.set(p.blockIndex, [p]);
			const f = s.frames.find((x) => x.id === p.frame)!;
			if (p.startLine + p.lineCount > f.lines) errs.push(`spread ${s.index}: ${p.block} overflows frame ${f.slot}`);
			if (p.kind === 'heading' && p.startLine + p.lineCount > f.lines - KEEP_NEXT && s.placements.some((q) => q.blockIndex > p.blockIndex)) errs.push(`spread ${s.index}: heading ${p.block} in the last ${KEEP_NEXT} lines of ${f.slot}`);
			const gridOff = Math.abs(f.baseline(p.startLine) / LINE_H - Math.round(f.baseline(p.startLine) / LINE_H));
			if (gridOff > 1e-6) errs.push(`spread ${s.index}: ${p.block} baseline off the grid`);
		}
		// overlap inside a frame
		for (const f of s.frames) {
			const ps = s.placements.filter((p) => p.frame === f.id).sort((a, b) => a.startLine - b.startLine);
			for (let i = 1; i < ps.length; i++) if (ps[i].startLine < ps[i - 1].startLine + ps[i - 1].lineCount) errs.push(`spread ${s.index}: ${ps[i].block} overlaps ${ps[i - 1].block} in ${f.slot}`);
		}
	}
	// widow and orphan across all spreads, in block order
	const all = plan.spreads.flatMap((s) => s.placements);
	const per = new Map<number, Placement[]>();
	for (const p of all) { const l = per.get(p.blockIndex); if (l) l.push(p); else per.set(p.blockIndex, [p]); }
	for (const [bi, ps] of per) {
		if (kinds.get(bi) === 'figure' || kinds.get(bi) === 'heading' || ps.length < 2) continue;
		if (ps[0].lineCount < MIN_LINES) errs.push(`orphan: ${ps[0].block} starts with ${ps[0].lineCount} line(s)`);
		if (ps[ps.length - 1].lineCount < MIN_LINES) errs.push(`widow: ${ps[0].block} ends with ${ps[ps.length - 1].lineCount} line(s)`);
	}
	for (let i = 0; i < blocks.length; i++) if (!per.has(i)) errs.push(`block ${blocks[i].id} was never placed`);
	return errs;
}
