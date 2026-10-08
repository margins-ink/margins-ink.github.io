// Text machinery shared by the magazine composer (compose.ts): sinks, the build Env, shaping of runs into words
// (harfbuzz), the greedy block layouter used for composite blocks (lists, quotes, notes, tables, math, images),
// and the Knuth-Plass paragraph path (typesetPara) used for prose and headings. Everything is em of the sheet,
// y down, glyph y is the baseline. Moved from scripts/reader/layout.ts when the column reader was deleted.
import { EXTRA_BIT, GlyphFlag, LinkKind, Pal, RectKind } from '../../src/lib/reader/format';
import { PAL_EXT } from './palette';
import { UNIT } from '../../src/lib/magazine/format';
import { F, type FontSet, type GlyphTableBuilder } from '../reader/fonts';
import type { Block, Run } from '../reader/parse';
import { mathObject, type MathObj } from '../reader/math';
import type { ImageStore } from '../reader/images';
import { breakLines as kpBreak, INF, type Item } from './kp';
import { leftHang, rightHang, HYPHEN_HANG } from './microtype';
import type { Hyphenator } from './hyph';

export interface WidthClass { id: number; sheetW: number; sheetH: number; measure: number; marginX: number; marginY: number }
export const CLASSES: WidthClass[] = [
	{ id: 0, sheetW: 40, sheetH: 56, measure: 30, marginX: 5, marginY: 5 },
	{ id: 1, sheetW: 28, sheetH: 56, measure: 21, marginX: 3.5, marginY: 5 }
];
export const LINE_H = 1.62;
export const CODE_SIZE = 0.8;
/** Code line pitch: 1.6 x CODE_SIZE (docs/READING.md 2.1), in em of the sheet. */
export const CODE_LH = 1.6 * CODE_SIZE;
/** Code panel: corner radius, the label row above the first line, and the top right corner kept free for the copy button (em). */
export const CODE_PANEL = { radius: 0.6, padX: 1.3, padY: 1.0, labelRow: 2.2, labelSize: 0.72, copyW: 2.6, copyH: 1.9 } as const;

// ---- sinks ---------------------------------------------------------------------------------------

export class TextSink {
	private parts: Buffer[] = [];
	len = 0;
	append(s: string): number {
		const b = Buffer.from(s, 'utf8');
		const base = this.len;
		this.parts.push(b);
		this.len += b.length;
		return base;
	}
	bytes(): Uint8Array {
		return new Uint8Array(Buffer.concat(this.parts));
	}
	plain(): string {
		return Buffer.concat(this.parts).toString('utf8');
	}
}

export class StringSink {
	private parts: Buffer[] = [Buffer.from([0])];
	private len = 1;
	private seen = new Map<string, number>();
	add(s: string): number {
		if (!s) return 0;
		let o = this.seen.get(s);
		if (o === undefined) {
			const b = Buffer.from(s + '\0', 'utf8');
			o = this.len;
			this.parts.push(b);
			this.len += b.length;
			this.seen.set(s, o);
		}
		return o;
	}
	bytes(): Uint8Array {
		return new Uint8Array(Buffer.concat(this.parts));
	}
}

export interface Env {
	fonts: FontSet;
	union: GlyphTableBuilder;
	extra: GlyphTableBuilder;
	cls: WidthClass;
	digitSets: number[][];
	shikiIdx: Map<string, number>;
	images: ImageStore;
	strings: StringSink;
	text: TextSink;
	slug: string;
	missing: Set<string>;
	/** Knuth-Plass paragraph setting; when absent, layoutPara uses the greedy breaker */
	kp?: BreakOpts;
}

// ---- placed content ------------------------------------------------------------------------------

export interface PG { x: number; y: number; glyphId: number; size: number; colour: number; flags: number; off: number; /** drawn but not text: kept out of the line's glyph range (the code language label) */ deco?: boolean }
export interface Ln { yTop: number; yBot: number; x0: number; x1: number; base: number; glyphs: PG[]; off: number; canBreakBefore: boolean; /** bytes of hung marker text ('- ', '[3] ') that precede `off` in the text sink but are not part of the line's DOM text */ markerLen?: number }
export interface BRect { x0: number; y0: number; x1: number; y1: number; colour: number; kind: number; radius?: number }
export interface BImage { x0: number; y0: number; x1: number; y1: number; imageId: number; radius: number; alt: string }
export interface BLink { x0: number; y0: number; x1: number; y1: number; kind: number; target: string }
export interface Blk {
	h: number;
	lines: Ln[];
	rects: BRect[];
	images: BImage[];
	links: BLink[];
	anchors: { id: string; y: number }[];
	before: number;
	after: number;
	keepNext: boolean;
	pageBreak?: boolean;
}

export const emptyBlk = (): Blk => ({ h: 0, lines: [], rects: [], images: [], links: [], anchors: [], before: 0, after: 0, keepNext: false });

export interface Ctx { x0: number; width: number }

export const colourOf = (env: Env, c: Run['color']) => (typeof c === 'number' ? c : env.shikiIdx.get(c.dark) ?? Pal.ink);

// ---- words ----------------------------------------------------------------------------------------

export interface WItem { kind: 'g' | 'sp' | 'm'; ch?: string; font?: number; x: number; adv: number; pg?: Omit<PG, 'x'>; math?: { obj: MathObj; scale: number; off: number; colour: number }; href?: string; code?: boolean }
export interface Word { items: WItem[]; w: number }
export interface Seg { words: Word[]; gaps: { items: WItem[]; w: number }[] }

export function glyphIndex(env: Env, fontIdx: number, gid: number): number | null {
	const font = env.fonts.fonts[fontIdx];
	const cs = font.outline(gid);
	if (!cs.length) return null;
	return env.union.add(`${fontIdx}:${gid}`, cs, [fontIdx, gid]);
}

export function utf8Prefix(s: string): Uint32Array {
	const out = new Uint32Array(s.length + 1);
	let b = 0;
	for (let i = 0; i < s.length; i++) {
		out[i] = b;
		const c = s.charCodeAt(i);
		if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
			out[i + 1] = b; // low surrogate: same offset
			b += 4;
			i++;
			out[i + 1] = b;
			continue;
		}
		b += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
	}
	out[s.length] = b;
	return out;
}

/** Shape runs into segments of words. Appends the paragraph's plain text to env.text. */
export function makeSegs(env: Env, runs: Run[], bs: number, where: string, textPrefix = ''): Seg[] {
	// plain text of the paragraph, in run order; math is written as $tex$
	let ptext = textPrefix;
	const starts: number[] = [];
	for (const r of runs) {
		starts.push(ptext.length);
		if (r.math) ptext += `$${r.math.tex}$`;
		else if (r.brk) ptext += '\n';
		else if (r.text !== undefined) ptext += r.text;
	}
	const base = env.text.append(ptext);
	const pre = utf8Prefix(ptext);
	const byteAt = (i: number) => base + pre[Math.min(i, ptext.length)];

	const segs: Seg[] = [];
	let seg: Seg = { words: [], gaps: [] };
	let word: Word | null = null;
	let x = 0;
	let pendingGap: { items: WItem[]; w: number } = { items: [], w: 0 };
	const startWord = () => {
		if (!word) {
			word = { items: [], w: 0 };
			x = 0;
		}
	};
	// A finished word is pushed with the gap that preceded it (leading gaps are dropped).
	const closeWord = () => {
		if (word) {
			if (seg.words.length) seg.gaps.push(pendingGap);
			pendingGap = { items: [], w: 0 };
			seg.words.push(word);
			word = null;
		}
	};
	const endSegment = () => {
		closeWord();
		if (seg.words.length) segs.push(seg);
		seg = { words: [], gaps: [] };
		pendingGap = { items: [], w: 0 };
	};

	runs.forEach((r, ri) => {
		const size = r.size * bs;
		if (r.brk) { endSegment(); return; }
		if (r.imageInline) throw new Error(`${where}: inline image inside a paragraph is not split out`);
		if (r.math) {
			const obj = mathObject(r.math.tex, false);
			startWord();
			word!.items.push({ kind: 'm', x, adv: obj.width * size, math: { obj, scale: size, off: byteAt(starts[ri]), colour: colourOf(env, r.color) }, href: r.href });
			x += obj.width * size;
			word!.w = x;
			return;
		}
		const text = r.text ?? '';
		if (!text) return;
		const font = env.fonts.fonts[r.font];
		const shaped = font.shapeCode(text);
		// a cluster per UTF-16 unit: glyph i is character i, so the breaker may hyphenate and hang punctuation by character
		const oneToOne = shaped.length === text.length && shaped.every((g, i) => g.cluster === i);
		const colour = colourOf(env, r.color);
		for (const g of shaped) {
			const ch = text[g.cluster];
			const adv = g.xAdvance * size;
			if (ch === ' ') {
				closeWord();
				pendingGap.items.push({ kind: 'sp', x: 0, adv, href: r.href, code: r.inlineCode });
				pendingGap.w += adv;
				continue;
			}
			let fidx = r.font, gid = g.gid, gadv = adv, xo = g.xOffset * size, yo = g.yOffset * size;
			if (gid === 0) {
				const cp = text.codePointAt(g.cluster)!;
				const fb = env.fonts.fallback(cp);
				if (fb) { fidx = fb.font; gid = fb.gid; gadv = fb.adv * size; xo = 0; yo = 0; }
				else env.missing.add(`${font.spec.name}: U+${cp.toString(16).toUpperCase()} "${String.fromCodePoint(cp)}" (${where})`);
			}
			startWord();
			const gi = glyphIndex(env, fidx, gid);
			word!.items.push({
				kind: 'g', x: x + xo, adv: gadv, ch: oneToOne && fidx === r.font ? text[g.cluster] : undefined, font: fidx,
				pg: gi === null ? undefined : { y: -yo, glyphId: gi, size, colour, flags: r.flags | (r.href ? GlyphFlag.link : 0), off: byteAt(starts[ri] + g.cluster) },
				href: r.href, code: r.inlineCode
			});
			x += gadv;
			word!.w = x;
		}
	});
	endSegment();
	// leading gap items are dropped; trailing too (seg.gaps only holds inner gaps)
	return segs;
}

function splitLong(seg: Seg, W: number): Seg {
	const words: Word[] = [];
	const gaps: Seg['gaps'] = [];
	seg.words.forEach((w, i) => {
		let cur = w;
		while (cur.w > W + 1e-6 && cur.items.length > 1) {
			let k = 0;
			while (k < cur.items.length - 1 && cur.items[k + 1].x + cur.items[k + 1].adv - cur.items[0].x <= W) k++;
			if (k >= cur.items.length - 1) break; // float slack: it fits
			const cut = k + 1;
			const x0 = cur.items[0].x;
			const head = cur.items.slice(0, cut).map((it) => ({ ...it, x: it.x - x0 }));
			const tailX = cur.items[cut].x;
			const tail = cur.items.slice(cut).map((it) => ({ ...it, x: it.x - tailX }));
			words.push({ items: head, w: head[head.length - 1].x + head[head.length - 1].adv });
			gaps.push({ items: [], w: 0 });
			cur = { items: tail, w: tail[tail.length - 1].x + tail[tail.length - 1].adv };
		}
		words.push(cur);
		if (i < seg.gaps.length) gaps.push(seg.gaps[i]);
	});
	return { words, gaps };
}

/** Minimum-raggedness line breaking (sum of squared slack, last line free) over one segment. */
function breakLines(seg: Seg, W: number): number[][] {
	const n = seg.words.length;
	const INF = 1e30;
	const best = new Float64Array(n + 1).fill(INF);
	const prev = new Int32Array(n + 1).fill(-1);
	best[0] = 0;
	for (let i = 0; i < n; i++) {
		if (best[i] >= INF) continue;
		let w = 0;
		for (let j = i; j < n; j++) {
			w += (j > i ? seg.gaps[j - 1].w : 0) + seg.words[j].w;
			if (w > W + 1e-6 && j > i) break;
			const slack = Math.max(0, W - w);
			const cost = j === n - 1 ? 0 : slack * slack + (w > W + 1e-6 ? 1e6 : 0);
			if (best[i] + cost < best[j + 1]) { best[j + 1] = best[i] + cost; prev[j + 1] = i; }
		}
	}
	const lines: number[][] = [];
	for (let j = n; j > 0; j = prev[j]) lines.push([prev[j], j - 1]);
	return lines.reverse();
}

interface ParaOpts { x0: number; width: number; bs: number; lh: number; font: number; align?: 'left'; indent?: number }

export function linkKind(href: string): number {
	if (href.startsWith('#ref-') || href.startsWith('#fn-')) return LinkKind.ref;
	if (href.startsWith('#')) return LinkKind.anchor;
	if (/^\/thoughts\//.test(href)) return LinkKind.article;
	return LinkKind.url;
}

/** Paragraph through the Knuth-Plass breaker, lines on the baseline grid: line pitch `o.lh` (a multiple of LINE_H), baseline 0.4 em above the line bottom. */
function layoutParaKP(env: Env, runs: Run[], o: ParaOpts, where: string, textPrefix: string): Blk {
	const b = emptyBlk();
	const segs = makeSegs(env, runs, o.bs, where, textPrefix);
	const opts: BreakOpts = { ...env.kp!, justify: o.align === 'left' ? false : env.kp!.justify, indent: o.indent ?? 0 };
	let y = 0;
	for (const tl of breakSegs(env, segs, o.width, opts, o.bs)) {
		const fi = env.fonts.fonts[o.font].info;
		const base = y + (o.lh - (fi.ascender - fi.descender) * o.bs) / 2 + fi.ascender * o.bs;
		const x0 = o.x0 + tl.x0;
		const ln: Ln = { yTop: y, yBot: y + o.lh, x0, x1: o.x0 + tl.width, base, glyphs: tl.glyphs.map((g) => ({ ...g, x: o.x0 + g.x, y: base + g.y })), off: tl.off, canBreakBefore: false };
		for (const r of tl.rects) b.rects.push({ x0: o.x0 + r.x0, x1: o.x0 + r.x1, y0: base + r.y0, y1: base + r.y1, colour: r.colour, kind: r.kind });
		for (const l of tl.links) b.links.push({ x0: o.x0 + l.x0, x1: o.x0 + l.x1, y0: y, y1: y + o.lh, kind: linkKind(l.href), target: l.href });
		b.lines.push(ln);
		y += o.lh;
	}
	b.h = y;
	const n = b.lines.length;
	b.lines.forEach((l, k) => (l.canBreakBefore = k >= 2 && n - k >= 2));
	return b;
}

export function layoutPara(env: Env, runs: Run[], o: ParaOpts, where: string, textPrefix = ''): Blk {
	if (env.kp) return layoutParaKP(env, runs, o, where, textPrefix);
	const b = emptyBlk();
	const segs = makeSegs(env, runs, o.bs, where, textPrefix).map((s) => splitLong(s, o.width));
	const fi = env.fonts.fonts[o.font].info;
	let y = 0;
	for (const seg of segs) {
		const brk = breakLines(seg, o.width);
		for (const [i, j] of brk) {
			let mAsc = 0, mDesc = 0;
			for (let k = i; k <= j; k++) for (const it of seg.words[k].items) if (it.math) { mAsc = Math.max(mAsc, it.math.obj.ascent * it.math.scale); mDesc = Math.max(mDesc, it.math.obj.descent * it.math.scale); }
			let lh = o.lh;
			let baseOff = (lh - (fi.ascender - fi.descender) * o.bs) / 2 + fi.ascender * o.bs;
			if (mAsc > baseOff - 0.05) { const d = mAsc - baseOff + 0.05; lh += d; baseOff += d; }
			if (mDesc > lh - baseOff - 0.05) lh += mDesc - (lh - baseOff) + 0.05;
			const base = y + baseOff;
			const ln: Ln = { yTop: y, yBot: y + lh, x0: o.x0, x1: o.x0, base, glyphs: [], off: -1, canBreakBefore: false };
			let x = o.x0;
			const spans: { x0: number; x1: number; href?: string; code?: boolean }[] = [];
			const pushSpan = (x0: number, x1: number, href?: string, code?: boolean) => {
				if (!href && !code) return;
				const l = spans[spans.length - 1];
				if (l && l.x1 >= x0 - 1e-6 && l.href === href && l.code === code) l.x1 = x1;
				else spans.push({ x0, x1, href, code });
			};
			for (let k = i; k <= j; k++) {
				const wd = seg.words[k];
				for (const it of wd.items) {
					if (it.kind === 'g' && it.pg) ln.glyphs.push({ ...it.pg, x: x + it.x, y: base + it.pg.y });
					else if (it.kind === 'm') {
						const m = it.math!;
						for (const g of m.obj.glyphs) {
							const gi = env.extra.add(g.key, g.contours);
							ln.glyphs.push({ x: x + it.x + g.x * m.scale, y: base - g.y * m.scale, glyphId: (gi | EXTRA_BIT) >>> 0, size: m.scale, colour: m.colour, flags: GlyphFlag.math, off: m.off });
						}
						for (const r of m.obj.rects) b.rects.push({ x0: x + it.x + r.x0 * m.scale, x1: x + it.x + r.x1 * m.scale, y0: base - r.y1 * m.scale, y1: base - r.y0 * m.scale, colour: m.colour, kind: RectKind.mathRule });
					}
					pushSpan(x + it.x, x + it.x + it.adv, it.href, it.code);
				}
				x += wd.w;
				if (k < j) {
					const gp = seg.gaps[k];
					let gx = x;
					for (const gi of gp.items) { pushSpan(gx, gx + gi.adv, gi.href, gi.code); gx += gi.adv; }
					x += gp.w;
				}
			}
			ln.x1 = x;
			ln.off = ln.glyphs.length ? ln.glyphs[0].off : -1;
			for (const s of spans) {
				if (s.href && !s.code) b.rects.push({ x0: s.x0, x1: s.x1, y0: base + 0.16 * o.bs, y1: base + 0.16 * o.bs + 0.05, colour: PAL_EXT.ink3, kind: RectKind.rule });
				if (s.code) b.rects.push({ x0: s.x0 - 0.15, x1: s.x1 + 0.15, y0: base - 0.95 * o.bs, y1: base + 0.3 * o.bs, colour: Pal.codeBg, kind: RectKind.inlineCodeBg, radius: 0.28 });
				if (s.href) b.links.push({ x0: s.x0, x1: s.x1, y0: ln.yTop, y1: ln.yBot, kind: linkKind(s.href), target: s.href });
			}
			b.lines.push(ln);
			y += lh;
		}
	}
	b.h = y;
	const n = b.lines.length;
	b.lines.forEach((l, k) => (l.canBreakBefore = k >= 2 && n - k >= 2));
	return b;
}

// ---- stacking ------------------------------------------------------------------------------------

export function shift(b: Blk, dx: number, dy: number) {
	for (const l of b.lines) {
		l.yTop += dy; l.yBot += dy; l.base += dy; l.x0 += dx; l.x1 += dx;
		for (const g of l.glyphs) { g.x += dx; g.y += dy; }
	}
	for (const r of b.rects) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
	for (const r of b.images) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
	for (const r of b.links) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
	for (const a of b.anchors) a.y += dy;
}

export function stack(children: Blk[], pad = 0): Blk {
	const out = emptyBlk();
	let y = pad;
	children.forEach((c, i) => {
		const gap = i ? Math.max(children[i - 1].after, c.before) : 0;
		y += gap;
		shift(c, 0, y);
		if (c.lines.length) c.lines[0].canBreakBefore = i > 0 && !children[i - 1].keepNext;
		out.lines.push(...c.lines);
		out.rects.push(...c.rects);
		out.images.push(...c.images);
		out.links.push(...c.links);
		out.anchors.push(...c.anchors);
		y += c.h;
	});
	out.h = y + pad;
	if (children.length) { out.before = children[0].before; out.after = children[children.length - 1].after; out.keepNext = children[children.length - 1].keepNext; }
	return out;
}

// ---- blocks --------------------------------------------------------------------------------------

export const HEAD = [0, 2.0, 1.35, 1.12, 1.0, 1.0, 1.0];

export function layoutBlocks(env: Env, blocks: Block[], ctx: Ctx, where: string): Blk[] {
	const out: Blk[] = [];
	for (const bl of blocks) {
		switch (bl.t) {
			case 'heading': {
				const bs = HEAD[bl.depth];
				const b = layoutPara(env, bl.runs, { x0: ctx.x0, width: ctx.width, bs, lh: env.kp ? LINE_H * Math.ceil((1.15 * bs) / LINE_H - 1e-9) : 1.25 * bs, font: F.bold, align: 'left' }, where);
				b.before = bl.depth === 1 ? 2 : bl.depth === 2 ? 1.9 : 1.4;
				b.after = 0.55;
				b.keepNext = true;
				b.lines.forEach((l) => (l.canBreakBefore = false));
				if (bl.id) b.anchors.push({ id: bl.id, y: 0 });
				env.text.append('\n\n');
				out.push(b);
				break;
			}
			case 'para': {
				const b = layoutPara(env, bl.runs, { x0: ctx.x0, width: ctx.width, bs: 1, lh: LINE_H, font: F.body }, where);
				b.after = 0.9;
				env.text.append('\n\n');
				out.push(b);
				break;
			}
			case 'code': out.push(layoutCode(env, bl, ctx)); break;
			case 'list': out.push(layoutList(env, bl, ctx, where)); break;
			case 'quote': {
				const inner = stack(layoutBlocks(env, bl.children, { x0: ctx.x0 + 1.3, width: ctx.width - 1.3 }, where));
				inner.rects.push({ x0: ctx.x0 + 0.1, x1: ctx.x0 + 0.28, y0: 0, y1: inner.h, colour: Pal.quoteBar, kind: RectKind.quoteBar });
				inner.after = Math.max(inner.after, 0.9);
				out.push(inner);
				break;
			}
			case 'note': {
				const padX = 0.9, padY = 0.7;
				const inner = stack(layoutBlocks(env, bl.children, { x0: ctx.x0 + padX, width: ctx.width - 2 * padX }, where), padY);
				inner.rects.unshift({ x0: ctx.x0, x1: ctx.x0 + ctx.width, y0: 0, y1: inner.h, colour: Pal.codeBg, kind: RectKind.noteBox });
				inner.before = 0.5;
				inner.after = 1.2;
				out.push(inner);
				break;
			}
			case 'rule': {
				const b = emptyBlk();
				b.h = 1;
				b.rects.push({ x0: ctx.x0, x1: ctx.x0 + ctx.width, y0: 0.47, y1: 0.53, colour: Pal.rule, kind: RectKind.rule });
				b.before = 0.8; b.after = 0.8;
				out.push(b);
				break;
			}
			case 'image': out.push(layoutImage(env, bl, ctx, where)); break;
			case 'math': out.push(layoutDisplayMath(env, bl.tex, ctx)); break;
			case 'table': out.push(layoutTable(env, bl, ctx, where)); break;
			case 'pagebreak': { const b = emptyBlk(); b.pageBreak = true; out.push(b); break; }
			case 'refs': {
				const head = layoutBlocks(env, [{ t: 'heading', depth: 2, runs: [{ text: 'References', font: F.bold, size: 1, color: Pal.heading, flags: 0 }], id: 'references' }], ctx, where);
				const items: Blk[] = bl.items.map((r, i) => {
					const mOff = env.text.append(`[${i + 1}] `);
					const para = layoutBlocks(env, [{ t: 'para', runs: [
						{ text: r.title, font: F.body, size: 0.92, color: Pal.ink, flags: 0 },
						{ brk: true, font: F.body, size: 1, color: Pal.ink, flags: 0 },
						{ text: r.url, font: F.code, size: 0.7, color: Pal.link, flags: GlyphFlag.link | GlyphFlag.code, href: r.url }
					] }], { x0: ctx.x0 + 2.6, width: ctx.width - 2.6 }, where)[0];
					return withMarker(env, para, `[${i + 1}]`, mOff, ctx.x0, 2.6, [{ id: `ref-${r.id}`, y: 0 }]);
				});
				out.push(...head, stack(items));
				break;
			}
			case 'footnotes': {
				const rule = layoutBlocks(env, [{ t: 'rule' }], ctx, where);
				const items = bl.items.map((it) => {
					const mOff = env.text.append(`${it.n}. `);
					const inner = stack(layoutBlocks(env, it.children, { x0: ctx.x0 + 2, width: ctx.width - 2 }, where));
					return withMarker(env, inner, `${it.n}.`, mOff, ctx.x0, 2, [{ id: `fn-${it.n}`, y: 0 }]);
				});
				out.push(...rule, stack(items));
				break;
			}
		}
	}
	return out;
}

/** Hang a marker left of a block's first line. The caller appends `marker + ' '` to the text sink before laying out the block (mOff). */
export function withMarker(env: Env, b: Blk, marker: string, mOff: number, x0: number, indent: number, anchors: { id: string; y: number }[] = []): Blk {
	const font = env.fonts.fonts[F.sans];
	const size = 0.8;
	const pgs: PG[] = [];
	let w = 0;
	for (const g of font.shape(marker)) {
		const gi = glyphIndex(env, F.sans, g.gid);
		if (gi !== null) pgs.push({ x: w + g.xOffset * size, y: 0, glyphId: gi, size, colour: Pal.muted, flags: 0, off: mOff + g.cluster });
		w += g.xAdvance * size;
	}
	let first = b.lines[0];
	const hadText = !!first && first.off >= 0;
	if (!first) {
		first = { yTop: 0, yBot: LINE_H, x0, x1: x0, base: 1.1, glyphs: [], off: -1, canBreakBefore: false };
		b.lines.push(first);
		b.h = Math.max(b.h, LINE_H);
	}
	const x = x0 + indent - w - 0.55;
	first.glyphs = [...pgs.map((g) => ({ ...g, x: x + g.x, y: first.base })), ...first.glyphs];
	first.x0 = Math.min(first.x0, x);
	if (first.off < 0 && first.glyphs.length) first.off = first.glyphs[0].off;
	else if (hadText) first.markerLen = Buffer.byteLength(marker) + 1;
	for (const a of anchors) b.anchors.push(a);
	return b;
}

function layoutList(env: Env, bl: Extract<Block, { t: 'list' }>, ctx: Ctx, where: string): Blk {
	const indent = bl.ordered ? 2.0 : 1.6;
	const items: Blk[] = bl.items.map((children, i) => {
		const marker = bl.ordered ? `${bl.start + i}.` : '•';
		const mOff = env.text.append(marker + ' ');
		const inner = stack(layoutBlocks(env, children, { x0: ctx.x0 + indent, width: ctx.width - indent }, where));
		inner.after = 0.3;
		inner.before = 0;
		return withMarker(env, inner, marker, mOff, ctx.x0, indent);
	});
	const b = stack(items);
	b.after = 0.9;
	return b;
}

export function layoutCode(env: Env, bl: Extract<Block, { t: 'code' }>, ctx: Ctx): Blk {
	const b = emptyBlk();
	const { padX, padY } = CODE_PANEL;
	const font = env.fonts.fonts[F.code];
	// language label, top left of the panel (caption style, ink-3); its text precedes the source in the sink as a hung marker so copy and find never see it
	const label = bl.lang && bl.lang !== 'text' ? bl.lang : '';
	if (label) env.text.append(label + '\n');
	const base0 = env.text.append(bl.source + '\n\n');
	const pre = utf8Prefix(bl.source);
	let y = (label ? CODE_PANEL.labelRow : 0) + padY;
	let charBase = 0;
	bl.lines.forEach((runs) => {
		const text = runs.map((r) => r.text ?? '').join('');
		const cols: Run['color'][] = [];
		for (const r of runs) for (let k = 0; k < (r.text?.length ?? 0); k++) cols.push(r.color);
		const lh = CODE_LH;
		const base = y + (lh - (font.info.ascender - font.info.descender) * CODE_SIZE) / 2 + font.info.ascender * CODE_SIZE;
		const ln: Ln = { yTop: y, yBot: y + lh, x0: ctx.x0 + padX, x1: ctx.x0 + padX, base, glyphs: [], off: base0 + pre[charBase], canBreakBefore: false };
		let x = ctx.x0 + padX;
		if (text) {
			for (const g of font.shapeCode(text)) {
				const ch = text[g.cluster];
				let adv = g.xAdvance * CODE_SIZE;
				let fidx: number = F.code, gid = g.gid;
				if (gid === 0 && ch !== ' ') {
					const cp = text.codePointAt(g.cluster)!;
					const fb = env.fonts.fallback(cp);
					if (fb) { fidx = fb.font; gid = fb.gid; adv = fb.adv * CODE_SIZE; }
					else env.missing.add(`${font.spec.name}: U+${cp.toString(16).toUpperCase()} "${String.fromCodePoint(cp)}" (code block)`);
				}
				const gi = glyphIndex(env, fidx, gid);
				if (gi !== null) ln.glyphs.push({ x: x + g.xOffset * CODE_SIZE, y: base - g.yOffset * CODE_SIZE, glyphId: gi, size: CODE_SIZE, colour: colourOf(env, cols[g.cluster] ?? Pal.ink), flags: GlyphFlag.code, off: base0 + pre[charBase + g.cluster] });
				x += adv;
			}
		}
		ln.x1 = x;
		b.lines.push(ln);
		y += lh;
		charBase += text.length + 1;
	});
	if (label && b.lines.length) {
		const sans = env.fonts.fonts[F.code]; // the language label is set in the code face (a museum placard stamp), not the sans
		const size = CODE_PANEL.labelSize;
		const first = b.lines[0];
		const pgs: PG[] = [];
		let lx = ctx.x0 + padX;
		const labelBase = CODE_PANEL.labelRow / 2 + 0.2; // header row: label centred, hairline under it
		for (const g of sans.shape(label)) {
			const gi = glyphIndex(env, F.code, g.gid);
			// glyph offsets point at the first source character: a click on the label lands at the start of the code, never in the hung label bytes
			if (gi !== null) pgs.push({ x: lx + g.xOffset * size, y: labelBase, glyphId: gi, size, colour: PAL_EXT.ink3, flags: 0, off: first.off, deco: true });
			lx += g.xAdvance * size;
		}
		first.glyphs = [...pgs, ...first.glyphs];
		first.markerLen = Buffer.byteLength(label) + 1;
	}
	b.h = Math.ceil((y + padY) / UNIT - 1e-6) * UNIT; // the panel fills its block: block heights round up to a unit
	// exactly one codeBg rect, first: rounded panel; the page shader draws its 1px hairline (palette `rule`) on the same rect
	b.rects.push({ x0: ctx.x0, x1: ctx.x0 + ctx.width, y0: 0, y1: b.h, colour: Pal.codeBg, kind: RectKind.codeBg, radius: CODE_PANEL.radius });
	if (label) b.rects.push({ x0: ctx.x0, x1: ctx.x0 + ctx.width, y0: CODE_PANEL.labelRow, y1: CODE_PANEL.labelRow + 0.05, colour: Pal.rule, kind: RectKind.rule });
	const n = b.lines.length;
	b.lines.forEach((l, k) => (l.canBreakBefore = k >= 2 && n - k >= 2));
	b.before = 0.5; b.after = 1.2;
	return b;
}

/**
 * Code on the baseline grid: one row per LINE_H, source lines hard-wrapped at the column count the width holds (a continuation row
 * is indented two columns), shiki colours per character. `panel` = the code sits on a template field, so no background and no side padding.
 */
export function layoutCodeGrid(env: Env, bl: Extract<Block, { t: 'code' }>, width: number, panel: boolean): Blk {
	const b = emptyBlk();
	const padX = panel ? 0 : 0.8;
	const font = env.fonts.fonts[F.code];
	const adv = font.shape('0')[0].xAdvance * CODE_SIZE;
	const cols = Math.max(8, Math.floor((width - 2 * padX) / adv + 1e-6));
	const base0 = env.text.append(bl.source + '\n\n');
	const pre = utf8Prefix(bl.source);
	let y = panel ? 0 : LINE_H * 0.25;
	let charBase = 0;
	for (const runs of bl.lines) {
		const text = runs.map((r) => r.text ?? '').join('');
		const colours: Run['color'][] = [];
		for (const r of runs) for (let k = 0; k < (r.text?.length ?? 0); k++) colours.push(r.color);
		const rows: [number, number][] = [];
		let at = 0;
		do {
			const room = rows.length ? cols - 2 : cols;
			let end = Math.min(text.length, at + room);
			if (end < text.length) {
				const sp = text.lastIndexOf(' ', end);
				if (sp > at + room * 0.5) end = sp + 1;
			}
			rows.push([at, end]);
			at = end;
		} while (at < text.length);
		for (let ri = 0; ri < rows.length; ri++) {
			const [a, e] = rows[ri];
			const piece = text.slice(a, e);
			const x0 = padX + (ri ? 2 * adv : 0);
			const base = y + LINE_H - 0.4;
			const ln: Ln = { yTop: y, yBot: y + LINE_H, x0, x1: x0, base, glyphs: [], off: base0 + pre[charBase + a], canBreakBefore: false };
			let x = x0;
			if (piece.trim().length) {
				for (const g of font.shapeCode(piece)) {
					const ch = piece[g.cluster];
					let gadv = g.xAdvance * CODE_SIZE;
					let fidx: number = F.code, gid = g.gid;
					if (gid === 0 && ch !== ' ') {
						const cp = piece.codePointAt(g.cluster)!;
						const fb = env.fonts.fallback(cp);
						if (fb) { fidx = fb.font; gid = fb.gid; gadv = fb.adv * CODE_SIZE; }
						else env.missing.add(`${font.spec.name}: U+${cp.toString(16).toUpperCase()} "${String.fromCodePoint(cp)}" (code block)`);
					}
					const gi = glyphIndex(env, fidx, gid);
					if (gi !== null) ln.glyphs.push({ x: x + g.xOffset * CODE_SIZE, y: base - g.yOffset * CODE_SIZE, glyphId: gi, size: CODE_SIZE, colour: colourOf(env, colours[a + g.cluster] ?? Pal.ink), flags: GlyphFlag.code, off: base0 + pre[charBase + a + g.cluster] });
					x += gadv;
				}
			}
			ln.x1 = x;
			b.lines.push(ln);
			y += LINE_H;
		}
		charBase += text.length + 1;
	}
	b.h = y + (panel ? 0 : LINE_H * 0.25);
	if (!panel) b.rects.push({ x0: 0, x1: width, y0: 0, y1: b.h, colour: Pal.codeBg, kind: RectKind.codeBg, radius: CODE_PANEL.radius });
	return b;
}

function layoutImage(env: Env, bl: Extract<Block, { t: 'image' }>, ctx: Ctx, where: string): Blk {
	const info = env.images.bySrc.get(bl.src);
	if (!info) throw new Error(`${where}: image ${bl.src} was not preloaded`);
	const maxH = 24;
	let w = ctx.width;
	let h = (w * info.h) / info.w;
	if (h > maxH) { h = maxH; w = (h * info.w) / info.h; }
	const b = emptyBlk();
	const x0 = ctx.x0 + (ctx.width - w) / 2;
	b.images.push({ x0, x1: x0 + w, y0: 0, y1: h, imageId: info.id, radius: 4, alt: bl.alt });
	b.h = h;
	b.before = 1; b.after = 1.2;
	return b;
}

function layoutDisplayMath(env: Env, tex: string, ctx: Ctx): Blk {
	const s = 1.15;
	const obj = mathObject(tex, true);
	const b = emptyBlk();
	const padY = 0.5;
	const base = padY + obj.ascent * s;
	const w = obj.width * s;
	const x = ctx.x0 + Math.max(0, (ctx.width - w) / 2);
	const off = env.text.append(`$$${tex}$$\n\n`) + 2;
	const ln: Ln = { yTop: 0, yBot: 0, x0: x, x1: x + w, base, glyphs: [], off, canBreakBefore: false };
	for (const g of obj.glyphs) {
		const gi = env.extra.add(g.key, g.contours);
		ln.glyphs.push({ x: x + g.x * s, y: base - g.y * s, glyphId: (gi | EXTRA_BIT) >>> 0, size: s, colour: Pal.ink, flags: GlyphFlag.math, off });
	}
	for (const r of obj.rects) b.rects.push({ x0: x + r.x0 * s, x1: x + r.x1 * s, y0: base - r.y1 * s, y1: base - r.y0 * s, colour: Pal.ink, kind: RectKind.mathRule });
	b.h = (obj.ascent + obj.descent) * s + 2 * padY;
	ln.yBot = b.h;
	b.lines.push(ln);
	b.before = 0.8; b.after = 1.1;
	return b;
}

function layoutTable(env: Env, bl: Extract<Block, { t: 'table' }>, ctx: Ctx, where: string): Blk {
	const cols = Math.max(...bl.rows.map((r) => r.length));
	const gapX = 1.2;
	const nat: number[] = Array(cols).fill(0), mn: number[] = Array(cols).fill(0);
	// measure cells without emitting text: shape into a scratch sink
	const scratch: Env = { ...env, text: new TextSink() };
	for (const row of bl.rows) row.forEach((cell, c) => {
		const segs = makeSegs(scratch, cell, 1, where);
		for (const s of segs) {
			const w = s.words.reduce((a, x, i) => a + x.w + (i ? s.gaps[i - 1].w : 0), 0);
			nat[c] = Math.max(nat[c], w);
			mn[c] = Math.max(mn[c], ...s.words.map((x) => x.w));
		}
	});
	const avail = ctx.width - gapX * (cols - 1);
	let colW = nat.slice();
	const sum = nat.reduce((a, b) => a + b, 0);
	if (sum > avail) {
		const minSum = mn.reduce((a, b) => a + b, 0);
		const extra = Math.max(0, avail - minSum);
		const want = nat.map((n, i) => n - mn[i]);
		const wsum = want.reduce((a, b) => a + b, 0) || 1;
		colW = mn.map((m, i) => m + (extra * want[i]) / wsum);
	}
	const xs: number[] = [];
	let acc = ctx.x0;
	for (let c = 0; c < cols; c++) { xs.push(acc); acc += colW[c] + gapX; }
	const out = emptyBlk();
	let y = 0;
	bl.rows.forEach((row, r) => {
		let rowH = 0;
		const cells: Blk[] = [];
		row.forEach((cell, c) => {
			const cb = layoutPara(env, cell, { x0: xs[c], width: colW[c], bs: 1, lh: LINE_H, font: r === 0 ? F.bold : F.body }, where);
			env.text.append(c < row.length - 1 ? '\t' : '\n');
			cells.push(cb);
			rowH = Math.max(rowH, cb.h);
		});
		const first = out.lines.length;
		cells.forEach((cb) => {
			shift(cb, 0, y);
			cb.lines.forEach((l) => (l.canBreakBefore = false));
			out.lines.push(...cb.lines); out.rects.push(...cb.rects); out.links.push(...cb.links);
		});
		if (out.lines[first]) out.lines[first].canBreakBefore = r > 0;
		y += rowH + 0.35;
		out.rects.push({ x0: ctx.x0, x1: ctx.x0 + ctx.width, y0: y - 0.2, y1: y - 0.15, colour: Pal.rule, kind: RectKind.tableLine });
		y += 0.2;
	});
	out.h = y;
	out.before = 0.6; out.after = 1;
	return out;
}

// ---- Knuth-Plass paragraphs (docs/MAGAZINE.md 1.4 step 4) ----------------------------------------------
// A paragraph is shaped once (`shapeRuns`, appends its plain text in reading order), then broken as often as the
// planner asks (`breakSegs` is pure): once to count lines at a frame width, once to place them.

export interface TLine {
	/** glyph x relative to the line's left edge, y relative to the baseline (down positive) */
	glyphs: PG[];
	rects: { x0: number; x1: number; y0: number; y1: number; colour: number; kind: number }[];
	links: { x0: number; x1: number; href: string }[];
	/** left edge of the line (the paragraph indent on its first line) */
	x0: number;
	/** right edge of the content, hanging included */
	width: number;
	off: number;
}

export interface BreakOpts {
	hyphenator?: Hyphenator | null;
	justify: boolean;
	looseness?: number;
	/** ragged setting: extra stretch allowance per line, em */
	raggedStretch?: number;
	hyphenPenalty?: number;
	/** first-line indent, em */
	indent?: number;
}

type KBox = Item & { t: 'box'; ws: WItem[]; x0w: number };
type KGlue = Item & { t: 'glue'; gap: WItem[] };
type KPen = Item & { t: 'pen'; hy?: { w: number; glyphId: number; size: number; colour: number; off: number } };

function cutsOf(items: WItem[], hy: Hyphenator | null): { at: number; kind: 'h' | 'e' }[] {
	const cuts: { at: number; kind: 'h' | 'e' }[] = [];
	const chars = items.map((i) => i.ch);
	if (chars.some((c) => c === undefined)) return cuts;
	const word = chars.join('');
	const isDash = (ch: string) => ch === '-' || ch === '–' || ch === '—' || ch === '‐';
	const bounds = [0];
	for (let i = 1; i < word.length - 1 + 1; i++) {
		if (i < word.length && isDash(word[i - 1]) && i > 1 && /[\p{L}\p{N}]/u.test(word[i - 2]) && /[\p{L}\p{N}]/u.test(word[i])) { bounds.push(i); cuts.push({ at: i, kind: 'e' }); }
	}
	bounds.push(word.length);
	if (hy) {
		for (let s = 0; s + 1 < bounds.length; s++) {
			const a = bounds[s], b = bounds[s + 1];
			const m = /^([^A-Za-z]*)([A-Za-z]+)([^A-Za-z]*)$/.exec(word.slice(a, b));
			if (!m) continue;
			for (const k of hy.hyphenate(m[2])) cuts.push({ at: a + m[1].length + k, kind: 'h' });
		}
	}
	cuts.sort((x, y) => x.at - y.at);
	return cuts.filter((c, i) => c.at > 0 && c.at < word.length && (i === 0 || cuts[i - 1].at !== c.at));
}

function kpItems(env: Env, seg: Seg, o: BreakOpts): Item[] {
	const items: Item[] = [];
	const hp = o.hyphenPenalty ?? 50;
	seg.words.forEach((w, wi) => {
		if (wi > 0) {
			const g = seg.gaps[wi - 1];
			items.push({ t: 'glue', w: g.w, stretch: o.justify ? g.w * 0.48 : 0, shrink: o.justify ? g.w * 0.32 : 0, text: ' ', gap: g.items } as KGlue);
		}
		const cuts = cutsOf(w.items, o.hyphenator ?? null);
		const edges = [...cuts.map((c) => c.at), w.items.length];
		let from = 0;
		edges.forEach((to, ci) => {
			if (to <= from) return;
			const sl = w.items.slice(from, to);
			const last = sl[sl.length - 1], first = sl[0];
			const width = last.x + last.adv - first.x;
			const box: KBox = { t: 'box', w: width, ws: sl, x0w: first.x };
			const fh = first.pg && first.ch ? leftHang(first.ch) : 0;
			const lh = last.pg && last.ch ? rightHang(last.ch) : 0;
			if (fh) box.hl = fh * first.adv;
			if (lh) box.hr = lh * last.adv;
			items.push(box);
			if (ci < cuts.length) {
				const c = cuts[ci];
				if (c.kind === 'h' && last.pg && last.font !== undefined) {
					const font = env.fonts.fonts[last.font];
					const hg = font.shape('-')[0];
					const gi = hg ? glyphIndex(env, last.font, hg.gid) : null;
					if (gi !== null && hg) {
						const w1 = hg.xAdvance * last.pg.size;
						items.push({ t: 'pen', w: w1, p: hp, flagged: true, hang: HYPHEN_HANG * w1, hy: { w: w1, glyphId: gi, size: last.pg.size, colour: last.pg.colour, off: last.pg.off } } as KPen);
					}
				} else if (c.kind === 'e') items.push({ t: 'pen', w: 0, p: 50, flagged: true });
			}
			from = to;
		});
	});
	// finish: glue after the last box must not break before the fill
	items.push({ t: 'pen', w: 0, p: INF } as Item);
	items.push({ t: 'glue', w: 0, stretch: 1e6, shrink: 0 } as Item);
	items.push({ t: 'pen', w: 0, p: -INF } as Item);
	return items;
}

const spanPush = (spans: { x0: number; x1: number; href?: string; code?: boolean }[], x0: number, x1: number, href?: string, code?: boolean) => {
	if (!href && !code) return;
	const l = spans[spans.length - 1];
	if (l && l.x1 >= x0 - 1e-6 && l.href === href && l.code === code) l.x1 = x1;
	else spans.push({ x0, x1, href, code });
};

/** Break the shaped segments of one paragraph at `width` em. Pure and deterministic. */
export function breakSegs(env: Env, segs: Seg[], width: number, o: BreakOpts, bs = 1): TLine[] {
	const out: TLine[] = [];
	for (const seg0 of segs) {
		const seg = splitLong(seg0, width);
		if (!seg.words.length) continue;
		const items = kpItems(env, seg, o);
		const lines = kpBreak(items, { lineWidth: (i) => (i === 0 && o.indent ? { x0: o.indent, x1: width } : width), looseness: o.looseness ?? 0, raggedStretch: o.justify ? 0 : o.raggedStretch ?? 2 });
		for (const l of lines) {
			const tl: TLine = { glyphs: [], rects: [], links: [], x0: l.x0, width: 0, off: -1 };
			const spans: { x0: number; x1: number; href?: string; code?: boolean }[] = [];
			let x = l.x0 - l.hangLeft;
			for (let k = l.start; k < l.end; k++) {
				const it = items[k];
				if (it.t === 'box') {
					const b = it as KBox;
					for (const w of b.ws) {
						const wx = x + (w.x - b.x0w);
						if (w.kind === 'g' && w.pg) tl.glyphs.push({ ...w.pg, x: wx });
						else if (w.kind === 'm') {
							const m = w.math!;
							for (const g of m.obj.glyphs) {
								const gi = env.extra.add(g.key, g.contours);
								tl.glyphs.push({ x: wx + g.x * m.scale, y: -g.y * m.scale, glyphId: (gi | EXTRA_BIT) >>> 0, size: m.scale, colour: m.colour, flags: GlyphFlag.math, off: m.off });
							}
							for (const r of m.obj.rects) tl.rects.push({ x0: wx + r.x0 * m.scale, x1: wx + r.x1 * m.scale, y0: -r.y1 * m.scale, y1: -r.y0 * m.scale, colour: m.colour, kind: RectKind.mathRule });
						}
						spanPush(spans, wx, wx + w.adv, w.href, w.code);
					}
					x += b.w;
				} else if (it.t === 'glue') {
					const g = it as KGlue;
					const gw = g.w + (l.ratio > 0 ? l.ratio * g.stretch : l.ratio < 0 ? l.ratio * g.shrink : 0);
					if (g.gap) { let gx = x; for (const gi of g.gap) { spanPush(spans, gx, gx + gi.adv * (gw / Math.max(g.w, 1e-6)), gi.href, gi.code); gx += gi.adv * (gw / Math.max(g.w, 1e-6)); } }
					x += gw;
				}
			}
			if (l.hyphen) {
				const pen = items[l.end] as KPen;
				if (pen.hy) { tl.glyphs.push({ x, y: 0, glyphId: pen.hy.glyphId, size: pen.hy.size, colour: pen.hy.colour, flags: 0, off: pen.hy.off }); x += pen.hy.w; }
			}
			tl.width = x;
			tl.off = tl.glyphs.length ? tl.glyphs[0].off : -1;
			for (const s of spans) {
				if (s.href && !s.code) tl.rects.push({ x0: s.x0, x1: s.x1, y0: 0.16 * bs, y1: 0.16 * bs + 0.05, colour: PAL_EXT.ink3, kind: RectKind.rule });
				if (s.code) tl.rects.push({ x0: s.x0 - 0.15, x1: s.x1 + 0.15, y0: -0.95 * bs, y1: 0.3 * bs, colour: Pal.codeBg, kind: RectKind.inlineCodeBg, radius: 0.28 });
				if (s.href) tl.links.push({ x0: s.x0, x1: s.x1, href: s.href });
			}
			out.push(tl);
		}
	}
	return out;
}
