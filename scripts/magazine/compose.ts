// Composer: the layer between the grid planner (placements only) and emit.ts (RDR2). It turns
//   - a distill block + figures into the layer 0 spread (planDistilled): template areas filled by slot type;
//   - an article's blocks + figures into layer 1 spreads (planFullText): blocks shaped, measured for the planner, placed by
//     its plan, and written as glyphs, lines, rects, links, anchors and figure art in spread em.
// The planner never shapes text; this file never decides where a block goes. docs/MAGAZINE.md 1.4 and 1.5.
import { GlyphFlag, ItemType, LinkKind as LK, Material, NONE16, PAL2, RectKind } from '../../src/lib/magazine/format';
import type { Rect } from '../../src/lib/magazine/types';
import { F } from '../reader/fonts';
import type { Block, Parsed, Run } from '../reader/parse';
import { LINE_H, lintSolved, solveTemplate, GEOMETRY, type Area, type SheetClass, type Solved } from './grid';
import { ASCENT, firstBaseline } from './frames';
import { TEMPLATES, templateId as plannerTemplateId, type TemplateId } from './templates';
import { codeWidth, planWithCopyfit, validatePlan, type FitOpts, type FlowBlock, type Measurer, type Plan, type PlannedSpread } from './planner';
import { concatFragments, placeFigure, templateId, type Fragment, type FItem, type SpreadContent } from './emit';
import {
	TextSink, breakSegs, layoutBlocks, layoutCodeGrid, layoutPara, makeSegs, type Env, type BreakOpts, type Blk, type Ln, type TLine
} from './typeset';
import type { FigureArt } from './fig/emit';
import type { DistillBlock } from './parse-directives';

const LH = LINE_H;
const HALF = LH / 2;
const INDENT = 1.4; // first-line indent of a paragraph that follows a paragraph, em
const FIT_STEP = 0.25;

export interface Voice { hue: number; wdth: number; wght: number }

export interface DistilledInput {
	distill: DistillBlock;
	figures: Map<string, FigureArt>;
	palette: Uint32Array;
	voice: Voice;
	title: string;
	dek?: string;
	date?: string;
	slug: string;
}

const sheetOf = (cls: number): SheetClass => (cls === 0 ? 'wide' : 'narrow');
const scratch = (env: Env): Env => ({ ...env, text: new TextSink() });
const ceilLines = (h: number) => Math.max(1, Math.ceil(h / LH - 1e-6));

// ---- fragment writer ---------------------------------------------------------------------------------

class Writer {
	frag: Required<Pick<Fragment, 'items' | 'glyphs' | 'rects' | 'images' | 'lines' | 'links' | 'anchors' | 'shapes' | 'paths' | 'strokes' | 'segs' | 'groups' | 'numerals' | 'chans' | 'keys' | 'figures'>> = {
		items: [], glyphs: [], rects: [], images: [], lines: [], links: [], anchors: [], shapes: [], paths: [], strokes: [], segs: [], groups: [], numerals: [], chans: [], keys: [], figures: []
	};
	parts: Fragment[] = [];
	constructor(public env: Env) {}

	rect(r: Rect, colour: number, kind: number) {
		this.frag.rects.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, colour, kind, group: NONE16 });
		this.frag.items.push({ type: ItemType.rect, index: this.frag.rects.length - 1 });
	}

	/** One shaped line: its glyphs are placed with the line's left edge at `x`, baseline at `base`. */
	line(tl: TLine, x: number, base: number, frame: number, flags = 0) {
		const g0 = this.frag.glyphs.length;
		for (const g of tl.glyphs) {
			this.frag.glyphs.push({ x: x + g.x - tl.x0, y: base + g.y, glyphId: g.glyphId, size: g.size, colour: g.colour, flags: g.flags | flags, charOffset: g.off < 0 ? 0 : g.off, group: NONE16, frame });
			this.frag.items.push({ type: ItemType.glyph, index: this.frag.glyphs.length - 1 });
		}
		for (const r of tl.rects) this.rect({ x0: x + r.x0 - tl.x0, x1: x + r.x1 - tl.x0, y0: base + r.y0, y1: base + r.y1 }, r.colour, r.kind);
		for (const l of tl.links) this.link({ x0: x + l.x0 - tl.x0, x1: x + l.x1 - tl.x0, y0: base - ASCENT, y1: base + 0.4 }, l.href);
		if (tl.glyphs.length) {
			this.frag.lines.push({ yTop: base - ASCENT, yBot: base + 0.4, x0: x, x1: x + tl.width - tl.x0, firstGlyph: g0, glyphCount: tl.glyphs.length, charOffset: tl.off < 0 ? 0 : tl.off, frame });
		}
	}

	link(r: Rect, target: string) {
		const kind = target.startsWith('#ref-') || target.startsWith('#fn-') ? LK.ref : target.startsWith('#') ? LK.anchor : /^\/thoughts\//.test(target) ? LK.article : LK.url;
		this.frag.links.push({ x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1, kind, offset: this.env.strings.add(target) });
	}

	anchor(id: string, y: number) {
		this.frag.anchors.push({ idOffset: this.env.strings.add(id), y });
	}

	fragment(): Fragment { return concatFragments([...this.parts, this.frag]); }
}

// ---- text setting (display, deck, quote, folio) -------------------------------------------------------

interface SetOpts { font: number; colour: number; width: number; justify?: boolean; hyphenate?: boolean; flags?: number }

function breakOpts(env: Env, o: SetOpts): BreakOpts {
	return { ...(env.kp ?? { justify: false }), justify: !!o.justify, hyphenator: o.hyphenate ? env.kp?.hyphenator ?? null : null, indent: 0, looseness: 0 };
}

function shape(env: Env, text: string, o: SetOpts, size: number): TLine[] {
	const runs: Run[] = [{ text, font: o.font, size: 1, color: o.colour, flags: 0 }];
	return breakSegs(env, makeSegs(env, runs, size, `compose ${env.slug}`), o.width, breakOpts(env, o), size);
}

interface Fit { size: number; pitch: number; lines: TLine[] }

/**
 * Largest size in [min, max] (steps of FIT_STEP) whose lines fit `height` at the baseline pitch `pitch(size)` and none is overfull.
 * Trials run against a scratch Env (no plain text appended); the winning size is shaped once more against the real one.
 */
function fitText(env: Env, text: string, o: SetOpts, height: number, max: number, min: number, pitch: (size: number) => number): Fit {
	const sc = scratch(env);
	let size = max;
	for (; size > min + 1e-9; size -= FIT_STEP) {
		const lines = shape(sc, text, o, size);
		if (lines.length * pitch(size) <= height + 1e-6 && lines.every((l) => l.width - l.x0 <= o.width + 0.02)) break;
	}
	size = Math.max(size, min);
	return { size, pitch: pitch(size), lines: shape(env, text, o, size) };
}

const halfPitch = (lead: number) => (size: number) => Math.max(HALF, Math.round((size * lead) / HALF) * HALF);
const gridPitch = (lead: number) => (size: number) => Math.max(LH, Math.ceil((size * lead) / LH - 1e-9) * LH);

/** Glyph flags for display type. */
const DISPLAY = GlyphFlag.display;

// ---- figures ---------------------------------------------------------------------------------------

let figureSerial = 0;
/** Place a figure's art inside `rect` (contain, centred), numbering its figure record. */
function figureInto(w: Writer, art: FigureArt, rect: Rect, maxScale = 1.15) {
	const [fw, fh] = art.size;
	const s = Math.min((rect.x1 - rect.x0) / fw, (rect.y1 - rect.y0) / fh, maxScale);
	const dx = rect.x0 + ((rect.x1 - rect.x0) - fw * s) / 2, dy = rect.y0 + ((rect.y1 - rect.y0) - fh * s) / 2;
	const placed = placeFigure(art.fragment, dx, dy, s);
	placed.figures = (placed.figures ?? []).map((f) => ({ ...f, id: figureSerial++ }));
	return { placed, scale: s };
}

export const resetFigureSerial = () => { figureSerial = 0; };

// ---- distilled spread ---------------------------------------------------------------------------------

const pad = (r: Rect, d: number): Rect => ({ x0: r.x0 + d, y0: r.y0 + d, x1: r.x1 - d, y1: r.y1 - d });

function folioLine(w: Writer, text: string, a: Area, align: 'left' | 'right' | 'center', baseline: number, colour = PAL2.muted) {
	if (!text) return;
	const o: SetOpts = { font: F.sans, colour, width: 1e4 };
	const lines = shape(w.env, text, o, 0.72);
	if (!lines.length) return;
	const l = lines[0];
	const lw = l.width - l.x0;
	const x = align === 'left' ? a.rect.x0 : align === 'right' ? a.rect.x1 - lw : (a.rect.x0 + a.rect.x1) / 2 - lw / 2;
	w.line(l, x, baseline, NONE16);
}

const folioBase = (a: Area, top: boolean) => firstBaseline(a.rect.y0) + (top ? LH : LH);

/** The distilled copy as paragraphs of areas of the solved template. Returns the spread. */
export function planDistilled(env: Env, input: DistilledInput): SpreadContent {
	const cls = sheetOf(env.cls.id);
	const d = input.distill;
	const tid = d.template as TemplateId;
	const solved = solveTemplate(TEMPLATES[tid], cls);
	const errs = lintSolved(solved);
	if (errs.length) throw new Error(errs.join('; '));
	const w = new Writer(env);
	const display = env.fonts.display(input.voice.wdth, input.voice.wght);
	const letters = solved.order;
	const figAreas = letters.filter((l) => solved.areas[l].slot.type === 'figure');
	const capAreas = letters.filter((l) => solved.areas[l].slot.type === 'caption');
	const figIds = d.figures;

	// field and figure underlays first so text overprints them
	for (const l of letters) {
		const a = solved.areas[l];
		if (a.slot.type === 'field') w.rect(a.rect, PAL2.panel, RectKind.panel);
	}
	figAreas.forEach((l, i) => {
		const id = figIds[i];
		if (!id) return;
		const art = input.figures.get(id);
		if (!art) throw new Error(`${env.slug}: distill figure "${id}" is not in figures.ts`);
		const a = solved.areas[l];
		const inner = { x0: a.rect.x0 + (a.rect.x0 === 0 ? 2.5 : 0), x1: a.rect.x1 - (a.rect.x1 === solved.geom.w ? 2.5 : 0), y0: a.rect.y0 + 0.4, y1: a.rect.y1 - 0.4 };
		const { placed } = figureInto(w, art, inner);
		w.parts.push(placed);
	});

	for (const l of letters) {
		const a = solved.areas[l];
		const t = a.slot.type;
		const r = a.rect;
		const width = r.x1 - r.x0;
		const height = r.y1 - r.y0;
		if (t === 'head') {
			const o: SetOpts = { font: display, colour: PAL2.heading, width };
			const fit = fitText(env, d.headline, o, height, a.slot.size ?? 7.5, 2.4, halfPitch(0.92));
			// bottom aligned: the last baseline sits 0.3 pitch above the area's bottom edge
			const n = fit.lines.length;
			const last = r.y1 - fit.size * 0.22;
			fit.lines.forEach((tl, k) => w.line(tl, r.x0, last - (n - 1 - k) * fit.pitch, NONE16, DISPLAY));
			continue;
		}
		if (t === 'deck') {
			// the deck (large) then the definition (body); both ragged right, baselines on the grid
			const parts: { text: string; size: number; colour: number; font: number }[] = [];
			if (d.deck) parts.push({ text: d.deck, size: a.slot.size ?? 1.4, colour: PAL2.ink, font: F.body });
			if (d.definition) parts.push({ text: d.definition, size: 1, colour: PAL2.muted, font: F.body });
			let size = 1;
			const fitAll = (k: number) => {
				let used = 0;
				const sc = scratch(env);
				for (const p of parts) {
					const lines = shape(sc, p.text, { font: p.font, colour: p.colour, width, hyphenate: true }, p.size * k);
					used += lines.length * gridPitch(1.15)(p.size * k) + HALF;
				}
				return used <= height + 1e-6;
			};
			for (size = 1; size > 0.62 && !fitAll(size); size -= 0.04);
			let y = firstBaseline(r.y0);
			for (const p of parts) {
				const sz = p.size * size;
				const pitch = Math.max(LH, gridPitch(1.15)(sz));
				const lines = shape(env, p.text, { font: p.font, colour: p.colour, width, hyphenate: true }, sz);
				lines.forEach((tl, k) => w.line(tl, r.x0, y + k * pitch, NONE16));
				y += lines.length * pitch + HALF;
			}
			continue;
		}
		if (t === 'pullquote' && d.quote) {
			const o: SetOpts = { font: display, colour: PAL2.heading, width: width - 1.2 };
			const attrib = d.quote.from ? 2 * LH : 0;
			const fit = fitText(env, `“${d.quote.text}”`, o, height - attrib, a.slot.size ?? 2.4, 1.3, halfPitch(1.12));
			// accent bar left of the quote, full text height
			const top = r.y0 + 0.2;
			const base0 = firstBaseline(r.y0) + (fit.pitch - LH > 0 ? 0 : 0);
			w.rect({ x0: r.x0, x1: r.x0 + 0.18, y0: top, y1: top + fit.lines.length * fit.pitch + (attrib ? LH : 0) }, PAL2.accent, RectKind.quoteBar);
			fit.lines.forEach((tl, k) => w.line(tl, r.x0 + 1.2, base0 + k * fit.pitch, NONE16, DISPLAY));
			if (d.quote.from) {
				const lines = shape(env, `— ${d.quote.from}`, { font: F.sans, colour: PAL2.muted, width: width - 1.2 }, 0.78);
				if (lines[0]) w.line(lines[0], r.x0 + 1.2, base0 + fit.lines.length * fit.pitch + LH * 0.8, NONE16);
			}
			continue;
		}
		if (t === 'caption') {
			const idx = capAreas.indexOf(l);
			const cap = captionFor(d, idx, capAreas.length);
			if (!cap) continue;
			const sz = a.slot.size ?? 0.78;
			const o: SetOpts = { font: F.sans, colour: PAL2.muted, width, hyphenate: false };
			const lines = shape(env, cap, o, sz);
			const maxLines = Math.max(1, Math.floor(height / LH));
			lines.slice(0, maxLines).forEach((tl, k) => w.line(tl, r.x0, firstBaseline(r.y0) + k * LH, NONE16));
			if (lines.length > maxLines) throw new Error(`${env.slug}: caption ${l} needs ${lines.length} lines, area ${l} holds ${maxLines}`);
			continue;
		}
		if (t === 'folio') {
			const left = r.x0 < solved.geom.w / 2 - 1 && (r.x1 <= solved.geom.w / 2 + 1 || solved.geom.sheets === 1);
			if (l === 'f' || l === 'h') folioLine(w, left ? input.title : '', a, 'left', folioBase(a, false));
			else folioLine(w, input.date ?? '', a, 'right', folioBase(a, false));
			continue;
		}
		if (t === 'numeral') {
			const n = Number(l);
			if (!Number.isFinite(n)) continue;
			const lines = shape(env, String(n), { font: display, colour: PAL2.accent, width: 1e3 }, a.slot.size ?? 10);
			if (lines[0]) w.line(lines[0], r.x0, r.y1 - 0.8, NONE16, DISPLAY);
			continue;
		}
	}
	// figure channel budget is checked by emit
	return {
		meta: { layer: 0, template: templateId(tid), w: solved.geom.w, h: solved.geom.h, materialMask: Material.matte | Material.coated, accentIdx: PAL2.accent },
		frag: w.fragment()
	};
}

/** caption text for caption area `i` of `n`: the i-th caption in block order (two figures: the first caption of each figure when present). */
function captionFor(d: DistillBlock, i: number, n: number): string | undefined {
	if (d.figures.length >= 2 && n === d.figures.length) {
		const id = d.figures[i];
		return (d.captions ?? []).find((c) => c.fig === id)?.text;
	}
	return d.captions?.[i]?.text;
}

// ---- opener: the auto distill for an article without a distill block ---------------------------------------

/** Title, dek and the first paragraph as a two-sheet opener (no figures). Uses the `duo` template: H title, D dek, A and B hold the lede. */
export function planOpener(env: Env, input: Omit<DistilledInput, 'distill' | 'figures'> & { lede: Run[] | null }): SpreadContent {
	const cls = sheetOf(env.cls.id);
	const solved = solveTemplate(TEMPLATES.duo, cls);
	const w = new Writer(env);
	const display = env.fonts.display(input.voice.wdth, input.voice.wght);
	const H = solved.areas.H, D = solved.areas.D;
	const headO: SetOpts = { font: display, colour: PAL2.heading, width: H.rect.x1 - H.rect.x0 };
	const hf = fitText(env, input.title, headO, H.rect.y1 - H.rect.y0, H.slot.size ?? 7.5, 2.4, halfPitch(0.92));
	const n = hf.lines.length;
	hf.lines.forEach((tl, k) => w.line(tl, H.rect.x0, H.rect.y1 - hf.size * 0.22 - (n - 1 - k) * hf.pitch, NONE16, DISPLAY));
	if (input.dek) {
		const o: SetOpts = { font: F.body, colour: PAL2.ink, width: D.rect.x1 - D.rect.x0, hyphenate: true };
		const df = fitText(env, input.dek, o, D.rect.y1 - D.rect.y0, 1.8, 1, gridPitch(1.12));
		df.lines.forEach((tl, k) => w.line(tl, D.rect.x0, firstBaseline(D.rect.y0) + k * df.pitch, NONE16));
	}
	// the lede runs through A then B, justified, with the K-P breaker
	if (input.lede && input.lede.length) {
		const frames = [solved.areas.A, solved.areas.B].map((a) => ({ x0: a.cellRect.x0, x1: a.cellRect.x1, y0: a.cellRect.y0, y1: a.cellRect.y1 }));
		const wd = frames[0].x1 - frames[0].x0;
		const sz = 1.15;
		const kp = env.kp ?? { justify: true };
		const segs = makeSegs(env, input.lede, sz, `opener ${env.slug}`);
		const lines = breakSegs(env, segs, wd, { ...kp, justify: true, indent: 0 }, sz);
		let li = 0;
		for (const f of frames) {
			const rows = Math.floor((f.y1 - f.y0 - 0.4) / (LH * 1.05));
			const b0 = firstBaseline(f.y0);
			for (let k = 0; k < rows && li < lines.length; k++, li++) w.line(lines[li], f.x0, b0 + k * LH * 1.05 - 0 , NONE16);
		}
	}
	const fa = solved.areas.f, ga = solved.areas.g;
	folioLine(w, input.title, fa, 'left', folioBase(fa, false));
	folioLine(w, input.date ?? '', ga, 'right', folioBase(ga, false));
	return { meta: { layer: 0, template: templateId('duo'), w: solved.geom.w, h: solved.geom.h, materialMask: Material.matte, accentIdx: PAL2.accent }, frag: w.fragment() };
}

// ---- full text ---------------------------------------------------------------------------------------

export interface FullOpts { slug: string; title: string; dek?: string; date?: string; voice: Voice }

type Prep = { fb: FlowBlock; block: Block };

const plain = (rs: Run[]) => rs.map((r) => r.text ?? '').join('');
const FIG_PLACE = { inline: 'column', column: 'column', wide: 'wide', bleed: 'wide' } as const;

/** Top-level blocks as flow blocks, with the title and dek in front. */
function prepare(blocks: Block[], figures: Map<string, FigureArt>, env: Env, o: FullOpts): Prep[] {
	const head: Block[] = [
		{ t: 'heading', depth: 1, runs: [{ text: o.title, font: F.bold, size: 1, color: PAL2.heading, flags: 0 }] },
		...(o.dek ? [{ t: 'para' as const, runs: [{ text: o.dek, font: F.italic, size: 1, color: PAL2.muted, flags: 0 }] }] : [])
	];
	const all = [...head, ...blocks];
	const out: Prep[] = [];
	let prev: Block | undefined;
	all.forEach((b, i) => {
		const id = `b${i}`;
		const keep = (fb: FlowBlock) => out.push({ fb, block: b });
		switch (b.t) {
			case 'heading': keep({ id, kind: 'heading' }); break;
			case 'para': keep({ id, kind: 'para' }); break;
			case 'code': keep({ id, kind: 'code' }); break;
			case 'fig': {
				const art = figures.get(b.id);
				if (!art) throw new Error(`${env.slug}:${b.line}: ::fig id "${b.id}" is not in figures.ts`);
				keep({ id, kind: 'figure', place: FIG_PLACE[b.place], w: art.size[0], h: art.size[1], captionLines: 0 });
				break;
			}
			case 'image': {
				const info = env.images.bySrc.get(b.src);
				if (!info) throw new Error(`${env.slug}: image ${b.src} was not preloaded`);
				keep({ id, kind: 'figure', place: 'column', w: info.w, h: info.h, captionLines: 0 });
				break;
			}
			case 'pagebreak': break;
			default: keep({ id, kind: 'box' });
		}
		prev = b;
	});
	void prev;
	return out;
}

interface Laid { blk: Blk; indent: boolean }

export function planFullText(env0: Env, parsed: Pick<Parsed, 'blocks'>, figures: Map<string, FigureArt>, o: FullOpts): SpreadContent[] {
	const cls = sheetOf(env0.cls.id);
	const geom = GEOMETRY[cls];
	const preps = prepare(parsed.blocks, figures, env0, o);
	const flow = preps.map((p) => p.fb);
	const paraAfterPara = preps.map((p, i) => p.block.t === 'para' && preps[i - 1]?.block.t === 'para');

	// ---- measuring: scratch env, cache by block, width and looseness ----
	const cache = new Map<string, Blk>();
	const layout = (env: Env, i: number, width: number, looseness: number, panel: boolean): Blk => {
		const p = preps[i];
		const e: Env = { ...env, kp: { ...env.kp!, looseness } };
		switch (p.block.t) {
			case 'code': return layoutCodeGrid(e, p.block, width, panel);
			case 'para': return layoutPara(e, p.block.runs, { x0: 0, width, bs: 1, lh: LH, font: F.body, indent: paraAfterPara[i] ? INDENT : 0 }, `${env.slug} block ${i}`);
			default: return layoutBlocks(e, [p.block], { x0: 0, width }, `${env.slug} block ${i}`)[0];
		}
	};
	const measure: Measurer = (fb, width, fit: FitOpts) => {
		const i = flow.indexOf(fb);
		const key = `${i}|${width.toFixed(3)}|${fit.looseness}`;
		let b = cache.get(key);
		if (!b) { b = layout(scratch(env0), i, width, fit.looseness, false); cache.set(key, b); }
		return ceilLines(b.h);
	};

	const plan = planWithCopyfit(flow, { cls, measure });
	const errs = validatePlan(plan, flow);
	if (errs.length) throw new Error(`${env0.slug} [${cls}] plan: ${errs.join('; ')}`);
	const fit = plan.fit;

	// ---- writing ----
	const done = new Map<number, { blk: Blk; at: number }>(); // blocks laid out for real, with lines consumed so far
	const out: SpreadContent[] = [];
	for (const sp of plan.spreads) out.push(writeSpread(env0, sp, plan, preps, flow, layout, fit, done, o, geom.w, geom.h, figures));
	return out;
}

function writeSpread(
	env: Env, sp: PlannedSpread, plan: Plan, preps: Prep[], flow: FlowBlock[],
	layout: (env: Env, i: number, width: number, looseness: number, panel: boolean) => Blk, fit: FitOpts,
	done: Map<number, { blk: Blk; at: number }>, o: FullOpts, w: number, h: number, figures: Map<string, FigureArt>
): SpreadContent {
	const wr = new Writer(env);
	const solved = sp.solved;
	// panel field first (text-code): the underlay under the code frames
	for (const l of solved.order) {
		const a = solved.areas[l];
		if (a.slot.type === 'field') wr.rect(a.rect, PAL2.panel, RectKind.panel);
	}
	const placements = [...sp.placements].sort((a, b) => a.blockIndex - b.blockIndex || a.part - b.part);
	for (const pl of placements) {
		const frame = sp.frames.find((f) => f.id === pl.frame)!;
		const p = preps[pl.blockIndex];
		const top = frame.baseline(pl.startLine) - ASCENT; // y of the first line box of the piece
		const x0 = frame.rect.x0;
		if (pl.kind === 'figure') {
			const rect = pl.rect!;
			if (p.block.t === 'fig') {
				const art = figures.get(p.block.id)!;
				const { placed } = figureInto(wr, art, { x0: rect.x0, x1: rect.x1, y0: rect.y0 + 0.2, y1: rect.y1 }, 1);
				wr.parts.push(placed);
			} else if (p.block.t === 'image') {
				const info = env.images.bySrc.get(p.block.src)!;
				const bw = rect.x1 - rect.x0, bh = rect.y1 - rect.y0 - 0.4;
				const s = Math.min(bw / info.w, bh / info.h);
				const iw = info.w * s, ih = info.h * s;
				const ix = rect.x0 + (bw - iw) / 2;
				wr.frag.images.push({ x0: ix, y0: rect.y0 + 0.2, x1: ix + iw, y1: rect.y0 + 0.2 + ih, imageId: info.id, radius: 4, altOffset: env.strings.add(p.block.alt) });
				wr.frag.items.push({ type: ItemType.image, index: wr.frag.images.length - 1 });
			}
			continue;
		}
		const width = frame.width;
		let slot = done.get(pl.blockIndex);
		if (!slot) {
			const panel = pl.kind === 'code' && frame.thread === 1;
			slot = { blk: layout(env, pl.blockIndex, width, fit.looseness, panel), at: 0 };
			done.set(pl.blockIndex, slot);
		}
		const blk = slot.blk;
		const a = slot.at; // first line of the block this piece shows
		const n = pl.lineCount;
		slot.at += n;
		const whole = a === 0 && n >= ceilLines(blk.h);
		const y0 = a * LH, y1 = (a + n) * LH;
		const band = (y: number) => y >= y0 - 1e-6 && y < y1 - 1e-6;
		const dy = top - y0;
		for (const r of blk.rects) {
			if (!whole && (r.y1 <= y0 || r.y0 >= y1)) continue;
			const ry0 = whole ? r.y0 : Math.max(r.y0, y0), ry1 = whole ? r.y1 : Math.min(r.y1, y1);
			wr.rect({ x0: x0 + r.x0, x1: x0 + r.x1, y0: ry0 + dy, y1: ry1 + dy }, r.colour, r.kind);
		}
		for (const ln of blk.lines) {
			if (!whole && !band(ln.base - 0.5)) continue;
			writeLn(wr, ln, x0, dy, frame.id);
		}
		for (const l of blk.links) {
			if (!whole && !band((l.y0 + l.y1) / 2)) continue;
			wr.link({ x0: x0 + l.x0, x1: x0 + l.x1, y0: l.y0 + dy, y1: l.y1 + dy }, l.target);
		}
		for (const an of blk.anchors) if (a === 0 && pl.part === 0 || band(an.y)) wr.anchor(an.id, an.y + dy);
		for (const im of blk.images) {
			wr.frag.images.push({ x0: x0 + im.x0, y0: im.y0 + dy, x1: x0 + im.x1, y1: im.y1 + dy, imageId: im.imageId, radius: im.radius, altOffset: env.strings.add(im.alt) });
			wr.frag.items.push({ type: ItemType.image, index: wr.frag.images.length - 1 });
		}
	}
	// folios
	const pages = (side: number) => sp.index * 2 + side;
	for (const l of solved.order) {
		const a = solved.areas[l];
		if (a.slot.type !== 'folio') continue;
		const base = folioBase(a, l === 'h' || l === 'i');
		const single = solved.geom.sheets === 1;
		if (l === 'h') folioLine(wr, o.title, a, 'left', base);
		else if (l === 'i') folioLine(wr, 'Thoughts', a, 'right', base);
		else if (l === 'f') folioLine(wr, String(single ? sp.index : pages(0)), a, single ? 'center' : 'left', base);
		else if (l === 'g') folioLine(wr, String(pages(1)), a, 'right', base);
	}
	void plan; void flow;
	return {
		meta: { layer: 1, template: templateId(sp.template), w, h, materialMask: Material.matte, accentIdx: PAL2.accent },
		frag: wr.fragment()
	};
}

function writeLn(w: Writer, ln: Ln, x0: number, dy: number, frame: number) {
	if (!ln.glyphs.length) return;
	const g0 = w.frag.glyphs.length;
	const base = ln.base + dy;
	for (const g of ln.glyphs) {
		w.frag.glyphs.push({ x: x0 + g.x, y: g.y + dy, glyphId: g.glyphId, size: g.size, colour: g.colour, flags: g.flags, charOffset: g.off < 0 ? 0 : g.off, group: NONE16, frame });
		w.frag.items.push({ type: ItemType.glyph, index: w.frag.glyphs.length - 1 });
	}
	w.frag.lines.push({ yTop: base - ASCENT, yBot: base + 0.4, x0: x0 + ln.x0, x1: x0 + ln.x1, firstGlyph: g0, glyphCount: ln.glyphs.length, charOffset: ln.off < 0 ? 0 : ln.off, frame });
}

export { plannerTemplateId, codeWidth };
