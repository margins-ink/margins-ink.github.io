// Stage 2, step 4 and 6: shaping into words, line breaking, blocks, pagination and the article
// model. Everything is in em of the sheet (1 em = body font size), page-local, x right, y DOWN from
// the sheet's top-left. Glyph y is the baseline; glyph outlines are y UP (flip when drawing).
import { EXTRA_BIT, GlyphFlag, LinkKind, Pal, PALETTE_SIZE, RectKind, ItemType, type ArticleModel, type GlyphInst, type LineRec, type LinkRec, type RectInst, type ImageInst, type AnchorRec } from '../../src/lib/reader/format';
import { F, type FontSet, type GlyphTableBuilder } from './fonts';
import type { Block, Parsed, Run } from './parse';
import { mathObject, type MathObj } from './math';
import type { ImageStore } from './images';

export interface WidthClass { id: number; sheetW: number; sheetH: number; measure: number; marginX: number; marginY: number }
export const CLASSES: WidthClass[] = [
	{ id: 0, sheetW: 40, sheetH: 56, measure: 30, marginX: 5, marginY: 5 },
	{ id: 1, sheetW: 28, sheetH: 56, measure: 21, marginX: 3.5, marginY: 5 }
];
export const LINE_H = 1.6;
export const SHEET_GAP = 0.6;
export const CELL_W = 6;
export const CELL_H = 1.6;
const CODE_SIZE = 0.85;
const CODE_LH = 1.3; // em of the sheet per code line
const GRID_PAD = 0.25; // em; grid cell lists are dilated by this much

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
	shikiIdx: Map<string, number>;
	images: ImageStore;
	strings: StringSink;
	text: TextSink;
	slug: string;
	missing: Set<string>;
}

// ---- placed content ------------------------------------------------------------------------------

interface PG { x: number; y: number; glyphId: number; size: number; colour: number; flags: number; off: number }
interface Ln { yTop: number; yBot: number; x0: number; x1: number; base: number; glyphs: PG[]; off: number; canBreakBefore: boolean }
interface BRect { x0: number; y0: number; x1: number; y1: number; colour: number; kind: number }
interface BImage { x0: number; y0: number; x1: number; y1: number; imageId: number; radius: number; alt: string }
interface BLink { x0: number; y0: number; x1: number; y1: number; kind: number; target: string }
interface Blk {
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

const emptyBlk = (): Blk => ({ h: 0, lines: [], rects: [], images: [], links: [], anchors: [], before: 0, after: 0, keepNext: false });

interface Ctx { x0: number; width: number }

const colourOf = (env: Env, c: Run['color']) => (typeof c === 'number' ? c : env.shikiIdx.get(`${c.light}|${c.dark}`) ?? Pal.ink);

// ---- words ----------------------------------------------------------------------------------------

interface WItem { kind: 'g' | 'sp' | 'm'; x: number; adv: number; pg?: Omit<PG, 'x'>; math?: { obj: MathObj; scale: number; off: number; colour: number }; href?: string; code?: boolean }
interface Word { items: WItem[]; w: number }
interface Seg { words: Word[]; gaps: { items: WItem[]; w: number }[] }

function glyphIndex(env: Env, fontIdx: number, gid: number): number | null {
	const font = env.fonts.fonts[fontIdx];
	const cs = font.outline(gid);
	if (!cs.length) return null;
	return env.union.add(`${fontIdx}:${gid}`, cs, [fontIdx, gid]);
}

function utf8Prefix(s: string): Uint32Array {
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
function makeSegs(env: Env, runs: Run[], bs: number, where: string, textPrefix = ''): Seg[] {
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
		const shaped = font.shape(text);
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
				kind: 'g', x: x + xo, adv: gadv,
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

interface ParaOpts { x0: number; width: number; bs: number; lh: number; font: number; align?: 'left' }

function linkKind(href: string): number {
	if (href.startsWith('#ref-') || href.startsWith('#fn-')) return LinkKind.ref;
	if (href.startsWith('#')) return LinkKind.anchor;
	if (/^\/thoughts\//.test(href)) return LinkKind.article;
	return LinkKind.url;
}

function layoutPara(env: Env, runs: Run[], o: ParaOpts, where: string, textPrefix = ''): Blk {
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
				if (s.code) b.rects.push({ x0: s.x0 - 0.15, x1: s.x1 + 0.15, y0: base - 0.95 * o.bs, y1: base + 0.3 * o.bs, colour: Pal.codeBg, kind: RectKind.inlineCodeBg });
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

function shift(b: Blk, dx: number, dy: number) {
	for (const l of b.lines) {
		l.yTop += dy; l.yBot += dy; l.base += dy; l.x0 += dx; l.x1 += dx;
		for (const g of l.glyphs) { g.x += dx; g.y += dy; }
	}
	for (const r of b.rects) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
	for (const r of b.images) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
	for (const r of b.links) { r.x0 += dx; r.x1 += dx; r.y0 += dy; r.y1 += dy; }
	for (const a of b.anchors) a.y += dy;
}

function stack(children: Blk[], pad = 0): Blk {
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

const HEAD = [0, 2.0, 1.35, 1.12, 1.0, 1.0, 1.0];

function layoutBlocks(env: Env, blocks: Block[], ctx: Ctx, where: string): Blk[] {
	const out: Blk[] = [];
	for (const bl of blocks) {
		switch (bl.t) {
			case 'heading': {
				const bs = HEAD[bl.depth];
				const b = layoutPara(env, bl.runs, { x0: ctx.x0, width: ctx.width, bs, lh: 1.25 * bs, font: F.bold }, where);
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
function withMarker(env: Env, b: Blk, marker: string, mOff: number, x0: number, indent: number, anchors: { id: string; y: number }[] = []): Blk {
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
	if (!first) {
		first = { yTop: 0, yBot: LINE_H, x0, x1: x0, base: 1.1, glyphs: [], off: -1, canBreakBefore: false };
		b.lines.push(first);
		b.h = Math.max(b.h, LINE_H);
	}
	const x = x0 + indent - w - 0.55;
	first.glyphs = [...pgs.map((g) => ({ ...g, x: x + g.x, y: first.base })), ...first.glyphs];
	first.x0 = Math.min(first.x0, x);
	if (first.off < 0 && first.glyphs.length) first.off = first.glyphs[0].off;
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

function layoutCode(env: Env, bl: Extract<Block, { t: 'code' }>, ctx: Ctx): Blk {
	const b = emptyBlk();
	const padX = 0.8, padY = 0.8;
	const font = env.fonts.fonts[F.code];
	const base0 = env.text.append(bl.source + '\n\n');
	const pre = utf8Prefix(bl.source);
	let y = padY;
	let charBase = 0;
	bl.lines.forEach((runs, li) => {
		const text = runs.map((r) => r.text ?? '').join('');
		const cols: Run['color'][] = [];
		for (const r of runs) for (let k = 0; k < (r.text?.length ?? 0); k++) cols.push(r.color);
		const lh = CODE_LH;
		const base = y + (lh - (font.info.ascender - font.info.descender) * CODE_SIZE) / 2 + font.info.ascender * CODE_SIZE;
		const ln: Ln = { yTop: y, yBot: y + lh, x0: ctx.x0 + padX, x1: ctx.x0 + padX, base, glyphs: [], off: base0 + pre[charBase], canBreakBefore: false };
		let x = ctx.x0 + padX;
		if (text) {
			for (const g of font.shape(text)) {
				const ch = text[g.cluster];
				let adv = g.xAdvance * CODE_SIZE;
				let fidx: number = F.code, gid = g.gid;
				if (gid === 0 && ch !== ' ') {
					const cp = text.codePointAt(g.cluster)!;
					const fb = env.fonts.fallback(cp);
					if (fb) { fidx = fb.font; gid = fb.gid; adv = fb.adv * CODE_SIZE; }
					else env.missing.add(`Fira Code 400: U+${cp.toString(16).toUpperCase()} "${String.fromCodePoint(cp)}" (code block)`);
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
		void li;
	});
	b.h = y + padY;
	b.rects.push({ x0: ctx.x0, x1: ctx.x0 + ctx.width, y0: 0, y1: b.h, colour: Pal.codeBg, kind: RectKind.codeBg });
	const n = b.lines.length;
	b.lines.forEach((l, k) => (l.canBreakBefore = k >= 2 && n - k >= 2));
	b.before = 0.5; b.after = 1.2;
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

// ---- pagination -----------------------------------------------------------------------------------

interface PageAcc { lines: Ln[]; rects: BRect[]; images: BImage[]; links: BLink[]; anchors: { id: string; y: number }[] }

function minPiece(b: Blk): number {
	for (let k = 1; k < b.lines.length; k++) if (b.lines[k].canBreakBefore) return b.lines[k].yTop;
	return b.h;
}

function paginate(blks: Blk[], cls: WidthClass): PageAcc[] {
	const H = cls.sheetH - 2 * cls.marginY;
	const pages: PageAcc[] = [];
	let page: PageAcc = { lines: [], rects: [], images: [], links: [], anchors: [] };
	let used = 0;
	let prevAfter = 0;
	const fresh = () => ({ lines: [], rects: [], images: [], links: [], anchors: [] } as PageAcc);
	const newPage = () => { pages.push(page); page = fresh(); used = 0; prevAfter = 0; };

	const place = (b: Blk, from: number, to: number, dy: number, first: boolean, last: boolean) => {
		const sa = from === 0 ? 0 : b.lines[from].yTop;
		const sb = to >= b.lines.length ? b.h : b.lines[to].yTop;
		const ofs = dy - sa;
		for (let k = from; k < to; k++) {
			const l = b.lines[k];
			page.lines.push({ ...l, yTop: l.yTop + ofs, yBot: l.yBot + ofs, base: l.base + ofs, glyphs: l.glyphs.map((g) => ({ ...g, y: g.y + ofs })) });
		}
		const clip = <T extends { y0: number; y1: number }>(r: T): T | null => {
			const y0 = Math.max(r.y0, sa), y1 = Math.min(r.y1, sb);
			return y1 > y0 ? { ...r, y0: y0 + ofs, y1: y1 + ofs } : null;
		};
		for (const r of b.rects) { const c = clip(r); if (c) page.rects.push(c); }
		for (const r of b.images) { const mid = (r.y0 + r.y1) / 2; if (mid >= sa && mid < sb) page.images.push({ ...r, y0: r.y0 + ofs, y1: r.y1 + ofs }); }
		for (const r of b.links) { const mid = (r.y0 + r.y1) / 2; if (mid >= sa && mid < sb) page.links.push({ ...r, y0: r.y0 + ofs, y1: r.y1 + ofs }); }
		for (const a of b.anchors) if (a.y >= sa && a.y < sb) page.anchors.push({ id: a.id, y: a.y + ofs });
		void first; void last;
		return sb - sa;
	};

	for (let i = 0; i < blks.length; i++) {
		const b = blks[i];
		if (b.pageBreak) { if (page.lines.length || page.rects.length || page.images.length) newPage(); continue; }
		let from = 0;
		let first = true;
		for (;;) {
			const empty = used === 0;
			const gap = empty || !first ? 0 : Math.max(prevAfter, b.before);
			const remaining = H - used - gap;
			const n = b.lines.length;
			const sa = from === 0 ? 0 : b.lines[from].yTop;
			const total = b.h - sa;
			// keep-with-next: the heading chain needs room for the first piece of what follows
			let need = total;
			if (b.keepNext && from === 0) {
				let k = i, acc = total, gapN = b.after;
				while (blks[k].keepNext && k + 1 < blks.length && !blks[k + 1].pageBreak) {
					const nb = blks[k + 1];
					gapN = Math.max(gapN, nb.before);
					acc += gapN + (nb.keepNext ? nb.h : minPiece(nb));
					if (!nb.keepNext) break;
					k++;
					gapN = nb.after;
				}
				need = acc;
			}
			if (need <= remaining + 1e-6) {
				const h = place(b, from, n, used + gap, first, true);
				used += gap + h;
				prevAfter = b.after;
				break;
			}
			// split at the last allowed break that fits
			let to = -1;
			for (let k = n - 1; k > from; k--) {
				if (!b.lines[k].canBreakBefore) continue;
				if (b.lines[k].yTop - sa <= remaining + 1e-6) { to = k; break; }
			}
			if (to > from && !b.keepNext) {
				const h = place(b, from, to, used + gap, first, false);
				used += gap + h;
				newPage();
				from = to;
				first = false;
				continue;
			}
			if (!empty) { newPage(); continue; }
			// empty page and still too tall: force a split anywhere, or place oversize atomic content
			let k2 = -1;
			if (total > H + 1e-6) for (let k = n - 1; k > from; k--) if (b.lines[k].yTop - sa <= H + 1e-6) { k2 = k; break; }
			if (k2 > from) {
				const h = place(b, from, k2, 0, first, false);
				used += h;
				newPage();
				from = k2;
				first = false;
				continue;
			}
			const h = place(b, from, n, 0, first, true);
			used += h;
			prevAfter = b.after;
			break;
		}
	}
	if (page.lines.length || page.rects.length || page.images.length || page.anchors.length || !pages.length) pages.push(page);
	return pages;
}

// ---- article -------------------------------------------------------------------------------------

const hexRGB = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (h: string, a = 255) => { const [r, g, b] = hexRGB(h); return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0; };
export const PAPER_LIGHT = '#f1ede4';

export function makePalette(accent: { light: string; dark: string }, syntax: { light: string; dark: string }[]): Uint32Array {
	const pal = new Uint32Array(PALETTE_SIZE * 2);
	const L = [rgba('#1c1917'), rgba(accent.light), rgba('#78716c'), rgba('#1c1917'), rgba('#d6d3d1'), rgba('#3b82f6', 0x55), rgba('#e6e0d2'), rgba('#a8a29e')];
	const D = [rgba('#e7e5e4'), rgba(accent.dark), rgba('#a8a29e'), rgba('#fafaf9'), rgba('#44403c'), rgba('#60a5fa', 0x66), rgba('#24211e'), rgba('#78716c')];
	L.forEach((c, i) => (pal[i] = c));
	D.forEach((c, i) => (pal[PALETTE_SIZE + i] = c));
	for (let i = 8; i < PALETTE_SIZE; i++) {
		const s = syntax[i - 8];
		pal[i] = s ? rgba(s.light) : L[0];
		pal[PALETTE_SIZE + i] = s ? rgba(s.dark) : D[0];
	}
	return pal;
}

const rgb565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

export function frontMatterBlocks(p: Parsed): Block[] {
	const title: Run[] = p.meta.title.split(/(`[^`]+`)/g).filter(Boolean).map((s) =>
		s.startsWith('`') ? { text: s.slice(1, -1), font: F.code, size: 0.85, color: Pal.heading, flags: GlyphFlag.code, inlineCode: true } : { text: s, font: F.bold, size: 1, color: Pal.heading, flags: 0 }
	);
	const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const d = new Date(p.meta.date);
	const date = Number.isNaN(+d) ? '' : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
	const out: Block[] = [{ t: 'heading', depth: 1, runs: title }];
	if (p.meta.dek) out.push({ t: 'para', runs: [{ text: p.meta.dek, font: F.italic, size: 1.12, color: Pal.muted, flags: 0 }] });
	out.push({ t: 'para', runs: [{ text: `${date ? date + ' · ' : ''}Andrew Gazelka`, font: F.sans, size: 0.78, color: Pal.muted, flags: 0 }] });
	return out;
}

export interface Built {
	model: ArticleModel;
	plainText: string;
	pageCount: number;
}

export function layoutArticle(env: Env, p: Parsed, palette: Uint32Array): Built {
	const cls = env.cls;
	const ctx: Ctx = { x0: cls.marginX, width: cls.measure };
	const blocks = [...frontMatterBlocks(p), ...p.blocks];
	const blks = layoutBlocks(env, blocks, ctx, p.file);
	// the front matter byline sits closer to the body
	const pagesAcc = paginate(blks, cls);

	// ---- assemble the model ----
	const glyphs: GlyphInst[] = [];
	const rects: RectInst[] = [];
	const images: ImageInst[] = [];
	const lines: LineRec[] = [];
	const links: LinkRec[] = [];
	const anchors: AnchorRec[] = [];
	const items: number[] = [];
	const cells: { start: number; count: number }[] = [];
	const pages: ArticleModel['pages'] = [];
	const cols = Math.ceil(cls.sheetW / CELL_W), rows = Math.ceil(cls.sheetH / CELL_H);
	const boxOf = (gid: number) => (gid & EXTRA_BIT ? env.extra.boxes[(gid & ~EXTRA_BIT) >>> 0] : env.union.boxes[gid]);
	const areaOf = (gid: number) => (gid & EXTRA_BIT ? env.extra.areas[(gid & ~EXTRA_BIT) >>> 0] : env.union.areas[gid]);
	const [pr, pg, pb] = hexRGB(PAPER_LIGHT), [ir, ig, ib] = hexRGB('#1c1917');

	pagesAcc.forEach((pa, pi) => {
		const my = cls.marginY;
		const firstLine = lines.length;
		const pageItems: { type: number; idx: number; x0: number; y0: number; x1: number; y1: number }[] = [];
		let ink = 0;
		for (const l of pa.lines) {
			const fg = glyphs.length;
			for (const g of l.glyphs) {
				const idx = glyphs.length;
				const y = g.y + my;
				glyphs.push({ x: g.x, y, glyphId: g.glyphId, size: g.size, colour: g.colour, flags: g.flags, charOffset: g.off });
				const [bx0, by0, bx1, by1] = boxOf(g.glyphId);
				pageItems.push({ type: ItemType.glyph, idx, x0: g.x + bx0 * g.size, x1: g.x + bx1 * g.size, y0: y - by1 * g.size, y1: y - by0 * g.size });
				ink += areaOf(g.glyphId) * g.size * g.size;
			}
			lines.push({ yTop: l.yTop + my, yBot: l.yBot + my, x0: l.x0, x1: l.x1, firstGlyph: fg, glyphCount: l.glyphs.length, charOffset: l.off < 0 ? 0 : l.off });
		}
		for (const r of pa.rects) {
			const idx = rects.length;
			rects.push({ x0: r.x0, x1: r.x1, y0: r.y0 + my, y1: r.y1 + my, colour: r.colour, kind: r.kind });
			pageItems.push({ type: ItemType.rect, idx, x0: r.x0, x1: r.x1, y0: r.y0 + my, y1: r.y1 + my });
			if (r.kind === RectKind.rule || r.kind === RectKind.mathRule || r.kind === RectKind.tableLine) ink += (r.x1 - r.x0) * (r.y1 - r.y0);
		}
		for (const r of pa.images) {
			const idx = images.length;
			images.push({ x0: r.x0, x1: r.x1, y0: r.y0 + my, y1: r.y1 + my, imageId: r.imageId, radius: r.radius, altOffset: env.strings.add(r.alt) });
			pageItems.push({ type: ItemType.image, idx, x0: r.x0, x1: r.x1, y0: r.y0 + my, y1: r.y1 + my });
		}
		for (const r of pa.links) links.push({ x0: r.x0, x1: r.x1, y0: r.y0 + my, y1: r.y1 + my, kind: r.kind, offset: env.strings.add(r.kind === LinkKind.anchor ? r.target.slice(1) : r.kind === LinkKind.ref ? r.target.slice(1) : r.target), page: pi });
		for (const a of pa.anchors) anchors.push({ idOffset: env.strings.add(a.id), page: pi, y: a.y + my });

		// grid: per cell item lists, dilated by GRID_PAD
		const firstItem = items.length;
		for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
			const x0 = cx * CELL_W, x1 = x0 + CELL_W, y0 = cy * CELL_H, y1 = y0 + CELL_H;
			const start = items.length;
			for (const it of pageItems) {
				if (it.x1 + GRID_PAD < x0 || it.x0 - GRID_PAD > x1 || it.y1 + GRID_PAD < y0 || it.y0 - GRID_PAD > y1) continue;
				items.push(((it.type << 29) | it.idx) >>> 0);
			}
			cells.push({ start, count: items.length - start });
		}
		const coverage = ink / (cls.sheetW * cls.sheetH);
		const t = Math.min(1, coverage * 1.0);
		pages.push({
			y0: pi * (cls.sheetH + SHEET_GAP), h: cls.sheetH, firstLine, lineCount: lines.length - firstLine, firstItem, itemCount: items.length - firstItem,
			tone565: rgb565(Math.round(pr + (ir - pr) * t), Math.round(pg + (ig - pg) * t), Math.round(pb + (ib - pb) * t)), coverage, pageNo: pi + 1
		});
	});

	const text = env.text.bytes();
	const model: ArticleModel = {
		widthClass: cls.id, emPx0: 16, sheetW: cls.sheetW, sheetH: cls.sheetH, measure: cls.measure, marginX: cls.marginX, marginY: cls.marginY,
		cellW: CELL_W, cellH: CELL_H, gridCols: cols, gridRows: rows, plainTextBytes: text.length,
		pages, cells, items, glyphs, rects, images, lines, links, anchors,
		extra: env.extra.finish(), text, strings: env.strings.bytes(), palette
	};
	return { model, plainText: env.text.plain(), pageCount: pages.length };
}
