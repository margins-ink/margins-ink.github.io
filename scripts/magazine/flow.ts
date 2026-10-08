// Flow layout (docs/READING.md section 4): one article at one width class -> the RDR4 tables of a page in document em.
// No pages, no spreads: a single column (34em, 21em on narrow) of blocks stacked on a 0.81em unit, ragged-right Knuth-Plass
// setting, citation sidenotes in the right margin on the wide class (inline note blocks otherwise), wide figures at 52em,
// plain h2 headings (no rules, no labels), an optional "In brief" section and fold built from the distill block.
// Coordinates: x 0 = left edge of the column, y 0 = top of the page, y down; glyph y is the baseline.
import {
	BlockFlag, BlockKind, ExhibitKind, GlyphFlag, ItemType, LinkKind, NONE16, NOTE_BIT, PAL2, RectKind, UNIT, LINE_H as LH,
	type BlockRec, type NoteRec
} from '../../src/lib/magazine/format';
import { LineFont } from '../../src/lib/magazine/format';
import { F } from '../reader/fonts';
import type { Block, Parsed, RefEntry, Run } from '../reader/parse';
import type { FigureArt } from './fig/emit';
import type { ScriptExhibit } from './exhibit';
import { PAL_EXT } from './palette';
import { appendFragment, newStore, placeFigure, type Box, type EmitContext, type FItem, type PageParts, type Store } from './emit';
import {
	TextSink, emptyBlk, layoutBlocks, layoutCode, layoutPara, makeSegs, shift, stack, withMarker, type Blk, type Env
} from './typeset';

const U = UNIT;
export const SP = { s1: 0.4, s2: U, s3: 1.5 * U, s4: 2 * U, s5: 3 * U, s6: 4 * U, s7: 6 * U, s8: 8 * U } as const;
const up = (h: number) => Math.ceil(h / U - 1e-6) * U;

export interface Cfg {
	cls: number; colW: number; docX0: number; docX1: number; figX: number; figW: number; noteX: number; noteW: number; margin: boolean;
	title: number; h2: number; pull: number; hyph: boolean; topPad: number;
}
export const CFG: Cfg[] = [
	{ cls: 0, colW: 38, docX0: -11, docX1: 49, figX: -11, figW: 60, noteX: 37, noteW: 17, margin: true, title: 3.0, h2: 1.6, pull: 1.5, hyph: false, topPad: SP.s8 + SP.s5 },
	{ cls: 1, colW: 38, docX0: 0, docX1: 38, figX: 0, figW: 38, noteX: 0, noteW: 38, margin: false, title: 2.6, h2: 1.6, pull: 1.4, hyph: false, topPad: SP.s7 },
	{ cls: 2, colW: 21, docX0: 0, docX1: 21, figX: 0, figW: 21, noteX: 0, noteW: 21, margin: false, title: 2.3, h2: 1.5, pull: 1.3, hyph: true, topPad: SP.s6 }
];

export interface Neighbour { slug: string; title: string }
export interface FlowInput {
	p: Parsed;
	env: Env;
	cfg: Cfg;
	/** compiled timeline art of exhibits/art.ts, by id */
	figures: Map<string, FigureArt>;
	/** script exhibits (exhibits/<id>.flecs), by id; ids are disjoint from `figures` (build.ts checks) */
	scripts: Map<string, ScriptExhibit>;
	display: number; // font index of the article's display voice
	neighbours: { prev?: Neighbour; next?: Neighbour };
	ctx: Omit<EmitContext, 'text'>;
}
export interface FlowOut { store: Store; parts: PageParts; words: number; /** trim line ranges against the final text bytes, set join flags and link ranges; call once the sink is closed */ finish: (text: Uint8Array) => void }

const plain = (rs: Run[]) => rs.map((r) => r.text ?? '').join('');
export const wordsOf = (blocks: Block[]): number => {
	let n = 0;
	const walk = (b: Block) => {
		switch (b.t) {
			case 'heading': case 'para': n += (plain(b.runs).match(/\S+/g) ?? []).length; break;
			case 'code': n += 0; break;
			case 'list': b.items.forEach((i) => i.forEach(walk)); break;
			case 'quote': case 'note': b.children.forEach(walk); break;
			case 'table': b.rows.forEach((r) => r.forEach((c) => (n += (plain(c).match(/\S+/g) ?? []).length))); break;
			case 'footnotes': b.items.forEach((i) => i.children.forEach(walk)); break;
			default: break;
		}
	};
	blocks.forEach(walk);
	return n;
};

/** Backtick spans set in the code face; the backticks are not part of the text. */
function spanRuns(text: string, font: number, colour: number, flags = 0): Run[] {
	const parts = text.split('`');
	if (parts.length < 3 || parts.length % 2 === 0) return [{ text: text.replace(/`/g, ''), font, size: 1, color: colour, flags }];
	return parts.flatMap((t, i): Run[] => !t ? [] : i % 2
		? [{ text: t, font: F.code, size: 0.85, color: colour, flags: GlyphFlag.code, inlineCode: true }]
		: [{ text: t, font, size: 1, color: colour, flags }]);
}

const ABBREV = /(?:\be\.g|\bi\.e|\bvs|\betc|\bFig|\bNo|\bcf|\bapprox|\bDr|\bMr|\bMs|\bSt|\bv\d+)$/;

/** Split the first sentence off a paragraph's runs (the lead). Null when the paragraph is one sentence or the sentence is too long or short. */
export function splitLead(runs: Run[]): { lead: Run[]; rest: Run[] } | null {
	const text = plain(runs);
	const re = /[.!?](?=[)"'”’]*(?:\s|$))/g;
	let m: RegExpExecArray | null;
	let cut = -1;
	while ((m = re.exec(text))) {
		const end = m.index + 1;
		if (end < 24) continue;
		if (ABBREV.test(text.slice(0, end))) continue;
		cut = end;
		break;
	}
	if (cut < 0 || cut > 260) return null;
	// walk runs to the cut; absorb closing quotes
	while (cut < text.length && /[)"'”’]/.test(text[cut])) cut++;
	const lead: Run[] = [], rest: Run[] = [];
	let at = 0;
	for (const r of runs) {
		const t = r.text ?? '';
		const len = r.math ? 0 : t.length;
		const nextAt = at + len;
		if (r.brk || r.math || r.text === undefined) { (at < cut ? lead : rest).push(r); at = nextAt; continue; }
		if (nextAt <= cut) lead.push(r);
		else if (at >= cut) rest.push(r);
		else { lead.push({ ...r, text: t.slice(0, cut - at) }); rest.push({ ...r, text: t.slice(cut - at) }); }
		at = nextAt;
	}
	// a citation superscript right after the full stop belongs to the lead
	while (rest.length && rest[0].sup && !/^\s/.test(rest[0].text ?? ' ')) lead.push(rest.shift()!);
	if (rest.length && rest[0].text !== undefined) rest[0] = { ...rest[0], text: rest[0].text!.replace(/^\s+/, '') };
	const restText = plain(rest).trim();
	if (!restText) return null;
	return { lead, rest: rest.filter((r) => r.text !== '' || r.math || r.brk) };
}

interface PlaceOpts {
	kind: number;
	level?: number;
	flags?: number;
	x?: number; // left edge of the block box
	width?: number;
	before: number;
	after: number;
	size: number; // line size (em), the DOM text layer font size
	font: number; // LineFont
	anchor?: string;
	ex?: number;
	exactH?: number;
	section?: number;
	start?: number; // text sink length before the block was laid out
}

interface Pending { id: string; y: number; block: number; line: number; n: number }

class Page {
	s = newStore();
	blocks: BlockRec[] = [];
	notes: NoteRec[] = [];
	exhibitItems: ({ items: FItem[]; box: Box } | undefined)[] = [];
	y = 0;
	prevAfter = 0;
	started = false;
	section = 0;
	folded = false;
	brief = false;
	/** bytes of hung marker text that precede a line's `off` in the sink, per line (index = store line) */
	lineMarker: number[] = [];
	lineRawLen: number[] = [];
	lineOwner: number[] = [];
	figNo = 0;
	wideRanges: { y0: number; y1: number }[] = [];
	constructor(public env: Env, public cfg: Cfg) {}

	advance(before: number) {
		if (this.started) this.y += Math.max(this.prevAfter, before);
		this.started = true;
	}

	/** Write a laid-out Blk with its origin at (ox, oy) into the store; returns the item and line ranges. */
	write(blk: Blk, ox: number, oy: number, owner: number, o: { size: number; font: number; start: number; end: number }) {
		const s = this.s;
		const firstItem = s.items.length, firstLine = s.lines.length;
		for (const r of blk.rects) {
			s.rects.push({ x0: ox + r.x0, x1: ox + r.x1, y0: oy + r.y0, y1: oy + r.y1, colour: r.colour, kind: r.kind, radius: r.radius ?? 0, group: NONE16 });
			s.items.push({ type: ItemType.rect, index: s.rects.length - 1 });
		}
		for (const im of blk.images) {
			s.images.push({ x0: ox + im.x0, y0: oy + im.y0, x1: ox + im.x1, y1: oy + im.y1, imageId: im.imageId, radius: im.radius, altOffset: this.env.strings.add(im.alt) });
			s.items.push({ type: ItemType.image, index: s.images.length - 1 });
		}
		const lines = blk.lines.filter((l) => l.off >= 0 || l.glyphs.length);
		lines.forEach((ln, k) => {
			const g0 = s.glyphs.length;
			const nDeco = ln.glyphs.filter((g) => g.deco).length; // decorations lead the line's glyphs and sit outside its glyph range
			for (const g of ln.glyphs) {
				s.glyphs.push({ x: ox + g.x, y: oy + g.y, glyphId: g.glyphId, size: g.size, colour: g.colour, flags: g.flags, charOffset: g.off < 0 ? 0 : g.off, group: NONE16 });
				s.items.push({ type: ItemType.glyph, index: s.glyphs.length - 1 });
			}
			const off = ln.off < 0 ? (ln.glyphs[nDeco]?.off ?? 0) : ln.off;
			const next = lines[k + 1];
			const rawEnd = next ? (next.off < 0 ? next.glyphs[next.glyphs.findIndex((g) => !g.deco)]?.off ?? o.end : next.off) - (next.markerLen ?? 0) : o.end;
			s.lines.push({
				yTop: oy + ln.yTop, yBot: oy + ln.yBot, x0: ox + ln.x0, x1: ox + ln.x1, firstGlyph: g0 + nDeco, glyphCount: ln.glyphs.length - nDeco,
				textOff: off, textLen: 0, block: owner, size: o.size, font: o.font, flags: 0
			});
			this.lineMarker.push(ln.markerLen ?? 0);
			this.lineRawLen.push(Math.max(0, rawEnd - off));
			this.lineOwner.push(owner);
		});
		const lineCount = s.lines.length - firstLine;
		for (const l of blk.links) {
			const cy = oy + (l.y0 + l.y1) / 2;
			let li = -1;
			for (let i = firstLine; i < s.lines.length; i++) if (cy >= s.lines[i].yTop - 1e-4 && cy < s.lines[i].yBot) { li = i; break; }
			if (li < 0) {
				let best = Infinity;
				for (let i = firstLine; i < s.lines.length; i++) { const d = Math.abs((s.lines[i].yTop + s.lines[i].yBot) / 2 - cy); if (d < best) { best = d; li = i; } }
			}
			if (li < 0) continue;
			s.links.push({ x0: ox + l.x0, y0: oy + l.y0, x1: ox + l.x1, y1: oy + l.y1, kind: l.kind, offset: this.env.strings.add(l.target), line: li, t0: 0, t1: 0 });
		}
		for (const an of blk.anchors) s.anchors.push({ idOffset: this.env.strings.add(an.id), block: owner, y: oy + an.y });
		return { firstItem, itemCount: s.items.length - firstItem, firstLine, lineCount, textOff: o.start, textEnd: o.end };
	}

	/** Place a Blk as the next block of the page. Returns the block index. */
	place(blk: Blk, o: PlaceOpts): number {
		this.advance(o.before);
		const bi = this.blocks.length;
		const x = o.x ?? 0;
		const w = o.width ?? this.cfg.colW;
		const y0 = this.y;
		const end = this.env.text.len;
		const r = this.write(blk, x, y0, bi, { size: o.size, font: o.font, start: o.start ?? end, end });
		const h = o.exactH ?? up(blk.h);
		this.blocks.push({
			x0: x, y0, x1: x + w, y1: y0 + h, firstItem: r.firstItem, itemCount: r.itemCount, firstLine: r.firstLine, lineCount: r.lineCount,
			anchor: o.anchor ? this.env.strings.add(o.anchor) : 0, ex: o.ex ?? -1, kind: o.kind, level: o.level ?? 0,
			flags: (o.flags ?? 0) | (this.folded ? BlockFlag.folded : 0) | (this.brief ? BlockFlag.brief : 0),
			section: this.section, textOff: r.textOff, textLen: Math.max(0, end - r.textOff)
		});
		this.y = y0 + h;
		this.prevAfter = o.after;
		return bi;
	}
}

const sentinelText = (env: Env, t = '\n\n') => { env.text.append(t); };

export function flowArticle(inp: FlowInput): FlowOut {
	const { p, env, cfg, figures, scripts } = inp;
	const W = cfg.colW;
	const where = `${p.file} [${['wide', 'mid', 'narrow'][cfg.cls]}]`;
	env.kp = { justify: false, hyphenator: cfg.hyph ? env.kp?.hyphenator ?? null : null };
	const pg = new Page(env, cfg);
	const s = pg.s;
	const refIndex = new Map(p.refs.map((r, i) => [r.id, i]));
	const noted = new Set<string>();
	const hasBrief = !!p.distill;
	// h2: Inter 600 (opsz 28), tracking 0 (docs/READING.md 2.1); the condensed display voice stays on the hero
	const headRuns = (runs: Run[]): Run[] => runs.map((r) => (r.inlineCode ? r : { ...r, font: F.head, color: PAL2.heading }));

	// paragraph through the K-P breaker, ragged right; appends the paragraph text and a separator to the sink
	const para = (runs: Run[], width: number, bs: number, lh: number, font: number): Blk => {
		const b = layoutPara(env, runs, { x0: 0, width, bs, lh, font, align: 'left' }, where);
		sentinelText(env);
		return b;
	};
	const longestWord = (runs: Run[], bs: number): number => {
		const sc: Env = { ...env, text: new TextSink() };
		let w = 0;
		for (const sg of makeSegs(sc, runs, bs, where)) for (const wd of sg.words) w = Math.max(w, wd.w);
		return w;
	};

	// --- citations: a pending margin or inline note per first citation of a ref ---
	const noteFor = (blkIdx: number, blk: Blk, oy: number) => {
		const fresh: Pending[] = [];
		for (const l of blk.links) {
			if (l.kind !== LinkKind.ref || !l.target.startsWith('#ref-')) continue;
			const id = l.target.slice(5);
			if (noted.has(id) || !refIndex.has(id)) continue;
			noted.add(id);
			const y = oy + l.y0;
			fresh.push({ id, y, block: blkIdx, line: 0, n: refIndex.get(id)! + 1 });
		}
		return fresh;
	};
	const refBlk = (r: RefEntry, n: number, width: number): Blk => {
		let host = r.url;
		try { const u = new URL(r.url); host = (u.host + u.pathname).replace(/\/$/, ''); } catch { /* keep */ }
		if (host.length > 44) host = host.slice(0, 43) + '…';
		const runs: Run[] = [
			{ text: `[${n}] `, font: F.sans, size: 0.8, color: PAL2.accent, flags: 0 },
			{ text: r.title, font: F.sans, size: 0.82, color: PAL2.ink, flags: 0 },
			{ brk: true, font: F.sans, size: 1, color: PAL2.ink, flags: 0 },
			{ text: host, font: F.code, size: 0.68, color: PAL2.muted, flags: GlyphFlag.code | GlyphFlag.link, href: r.url }
		];
		const b = layoutPara(env, runs, { x0: 0, width, bs: 1, lh: 1.215, font: F.sans, align: 'left' }, where);
		sentinelText(env);
		return b;
	};

	// ---- hero: quiet date, large Inter title, regular-weight dek, reading time ----
	const mins = Math.max(1, Math.round(wordsOf(p.blocks) / 230));
	const when = fmtDate(p.meta.date);
	pg.y = cfg.topPad;
	{
		const runs: Run[] = [{ text: p.meta.title, font: F.title, color: PAL2.heading, size: 1, flags: GlyphFlag.display }];
		let size = cfg.title;
		while (size > 1.4 && longestWord(runs, size) > W - 0.05) size -= 0.1;
		const lh = up(size * 1.05);
		const start = env.text.len;
		const b = para(runs, W, size, lh, F.title);
		pg.place(b, { kind: BlockKind.hero, level: 1, before: 0, after: SP.s4, size, font: LineFont.display, start, anchor: 'top' });
		if (p.meta.dek) {
			const st = env.text.len;
			const d = para(spanRuns(String(p.meta.dek), F.body, PAL2.ink), W, 1.12, 1.9, F.body);
			pg.place(d, { kind: BlockKind.hero, level: 2, before: 0, after: SP.s3, size: 1.12, font: LineFont.body, start: st });
		}
		const st = env.text.len;
		const rt = para([{ text: [when, `${mins} min read`].filter(Boolean).join('  ·  '), font: F.sans, size: 1, color: PAL_EXT.ink3, flags: 0 }], W, 0.85, LH, F.sans);
		pg.place(rt, { kind: BlockKind.hero, level: 3, before: 0, after: SP.s6, size: 0.85, font: LineFont.sans, start: st });
	}

	// ---- exhibits ----
	const directiveIds = new Set<string>();
	/**
	 * Place one exhibit block. A script exhibit is the Extent scaled to the column (no items); a timeline exhibit is its compiled art with the
	 * control strip below (Extent h = art h + strip), the cell grid covering the art only. scale = min(width / frameW, 1.5).
	 */
	const placeExhibit_ = (id: string, place: 'inline' | 'column' | 'wide' | 'bleed', flags: number, caption?: { num: number; text: string }) => {
		const art = figures.get(id);
		const scr = scripts.get(id);
		if (!art && !scr) throw new Error(`${where}: exhibit "${id}" is neither exhibits/${id}.flecs nor an entry of exhibits/art.ts`);
		const wide = cfg.margin && (place === 'wide' || place === 'bleed');
		const width = wide ? cfg.figW : W;
		const [fw, fh] = art ? [art.size[0], art.size[1] + art.strip] : scr!.frame;
		const sc = Math.min(width / fw, 1.5);
		const num = ++pg.figNo;
		pg.advance(SP.s4);
		const y0 = pg.y;
		const bw = fw * sc, bh = fh * sc;
		const bx = (wide ? cfg.figX : 0) + (width - bw) / 2;
		const bi = pg.blocks.length;
		const first = s.exhibits.length;
		const box: Box = { x0: bx, y0, x1: bx + bw, y1: y0 + bh };
		if (art) {
			const { items } = appendFragment(s, placeFigure(art.fragment, bx, y0, sc));
			if (s.exhibits.length === first + 1) {
				const artBox: Box = { x0: bx, y0, x1: bx + bw, y1: y0 + art.size[1] * sc };
				s.exhibits[first] = { ...s.exhibits[first], id: first, block: bi, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, scale: sc };
				pg.exhibitItems[first] = { items, box: artBox };
			} else throw new Error(`${where}: figure ${art.id} has no exhibit record`);
		} else {
			const x = scr!;
			s.exhibits.push({
				id: first, kind: ExhibitKind.script, firstChan: 0, chanCount: 0, mode: 0, duration: 0, poster: 0,
				alt: env.strings.add(x.alt), describe: env.strings.add(x.describe), name: env.strings.add(x.id), src: env.strings.add(x.src),
				title: x.title ? env.strings.add(x.title) : 0, claim: env.strings.add(x.claim), caption: x.caption ? env.strings.add(x.caption) : 0,
				frameW: fw, frameH: fh, x0: box.x0, y0: box.y0, x1: box.x1, y1: box.y1, block: bi, firstCell: 0, gridCols: 0, gridRows: 0, scale: sc
			});
		}
		const h = up(bh);
		pg.blocks.push({
			x0: bx, y0, x1: bx + bw, y1: y0 + h, firstItem: 0, itemCount: 0, firstLine: s.lines.length, lineCount: 0, anchor: env.strings.add(`fig-${num}`),
			ex: first, kind: BlockKind.exhibit, level: 0, flags: flags | (wide ? BlockFlag.wide : 0) | (pg.folded ? BlockFlag.folded : 0) | (pg.brief ? BlockFlag.brief : 0),
			section: pg.section, textOff: 0, textLen: 0
		});
		s.anchors.push({ idOffset: env.strings.add(`fig-${num}`), block: bi, y: y0 });
		if (wide) pg.wideRanges.push({ y0, y1: y0 + h });
		pg.y = y0 + h;
		pg.prevAfter = SP.s4;
		// a quiet caption line under the figure (secondary text, no box, no label)
		{
			const isStatic = !!art && art.strip === 0; // a static figure has no control strip
			const firstSentence = (t: string) => (t.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? t).trim();
			const text = caption?.text ?? (scr ? (scr.caption || scr.claim) : isStatic ? firstSentence(art!.compiled.describe) : '');
			if (text) {
				const st = env.text.len;
				const q = para(spanRuns(text, F.body, PAL2.muted), W, 0.8, 1.4, F.body);
				pg.place(q, { kind: BlockKind.caption, before: SP.s2, after: SP.s5, size: 0.8, font: LineFont.body, start: st, flags });
			} else pg.prevAfter = SP.s5;
		}
		return num;
	};

	// ---- section heading: plain h2 with generous space above ----
	const sectionEntry = (heading: Run[], id: string | undefined, flags: number, headingSize = cfg.h2) => {
		const hs = env.text.len;
		const hb = para(headRuns(heading), W, headingSize, up(headingSize * 1.08), F.head);
		if (id) hb.anchors.push({ id, y: 0 });
		pg.place(hb, { kind: BlockKind.heading, level: 2, before: SP.s7, after: SP.s3, size: headingSize, font: LineFont.bold, start: hs, anchor: id, flags });
	};

	// ---- the In brief section and the fold ----
	let foldStart = -1;
	if (hasBrief) {
		const d = p.distill!;
		pg.brief = true;
		pg.section = 0;
		const lead = d.definition ?? d.deck ?? p.meta.dek;
		{
			const st = env.text.len;
			const b = para(spanRuns(String(lead), F.body, PAL2.ink), W, 1.12, 1.9, F.body);
			pg.place(b, { kind: BlockKind.para, before: 0, after: SP.s4, size: 1.12, font: LineFont.lead, start: st, flags: BlockFlag.lead });
		}
		const used = new Set<number>();
		d.figures.forEach((id, i) => {
			const ci = (d.captions ?? []).findIndex((c) => c.fig === id);
			if (ci >= 0) used.add(ci);
			const num = pg.figNo + 1;
			placeExhibit_(id, 'wide', 0, ci >= 0 ? { num, text: d.captions![ci].text } : undefined);
			void i;
		});
		const extra = (d.captions ?? []).filter((_, i) => !used.has(i));
		for (const c of extra) {
			const st = env.text.len;
			const rs: Run[] = [{ text: c.text.replace(/`/g, ''), font: F.head, size: 1, color: PAL2.heading, flags: 0 }];
			const b = para(rs, W, 1.4, up(1.4 * 1.25), F.head);
			pg.place(b, { kind: BlockKind.takeaway, before: SP.s4, after: SP.s4, size: 1.4, font: LineFont.bold, start: st });
		}
		if (d.quote) {
			const st = env.text.len;
			const size = cfg.pull;
			const rs: Run[] = [{ text: `“${d.quote.text}”`, font: F.head, size: 1, color: PAL2.heading, flags: 0 }];
			const q = para(rs, W, size, up(size * 1.25), F.head);
			const qh = q.h;
			if (d.quote.from) {
				const a = layoutPara(env, [{ text: d.quote.from, font: F.sans, size: 1, color: PAL2.muted, flags: 0 }], { x0: 0, width: W, bs: 0.85, lh: LH, font: F.sans, align: 'left' }, where);
				sentinelText(env);
				shift(a, 0, qh + SP.s2);
				q.lines.push(...a.lines);
				q.h = qh + SP.s2 + LH;
			}
			pg.place(q, { kind: BlockKind.pullquote, before: SP.s5, after: SP.s6, size, font: LineFont.bold, start: st });
		}
		pg.brief = false;
		// fold control
		{
			const st = env.text.len;
			const b = emptyBlk();
			const t = layoutPara(env, [{ text: `Read the full post  ·  ${mins} min`, font: F.sans, size: 1, color: PAL2.link, flags: 0 }], { x0: 0, width: W, bs: 1, lh: 4 * U, font: F.sans, align: 'left' }, where);
			sentinelText(env);
			b.lines.push(...t.lines);
			b.h = 4 * U;
			pg.place(b, { kind: BlockKind.fold, before: SP.s5, after: SP.s4, size: 1, font: LineFont.sans, start: st });
		}
		pg.folded = true;
		foldStart = pg.y + SP.s4; // the region starts one s4 below the control row
	}

	// ---- body ----
	let leadNext = true; // the first paragraph after the hero or an h2 opens with a lead sentence
	let sectionNo = 0;
	const layoutNote = (fresh: Pending[]) => {
	};
	const inlineNotes = (fresh: Pending[]) => {
		if (!fresh.length) return;
		const parts = fresh.map((f) => refBlk(p.refs[f.n - 1], f.n, W - 0.9));
		parts.forEach((b) => { b.before = 0; b.after = 0.3; });
		const st = env.text.len;
		const blk = stack(parts);
		blk.rects.push({ x0: 0, x1: 0.1, y0: 0.1, y1: Math.max(0.2, blk.h - 0.1), colour: PAL2.rule, kind: RectKind.quoteBar });
		pg.place(shiftText(blk, 0.9), { kind: BlockKind.note, before: SP.s2, after: SP.s3, size: 0.82, font: LineFont.sans, start: st });
	};

	const emitPara = (runs: Run[], lead: boolean) => {
		const bs = lead ? 1.2 : 1;
		const lh = lead ? 1.86 : LH;
		const st = env.text.len;
		const startY = pg.y;
		const b = para(runs, W, bs, lh, F.body);
		const y0 = (pg.started ? pg.y + Math.max(pg.prevAfter, 0) : pg.y);
		const bi = pg.place(b, { kind: BlockKind.para, before: 0, after: lead ? SP.s2 : SP.s2, size: bs, font: lead ? LineFont.lead : LineFont.body, start: st, flags: lead ? BlockFlag.lead : 0 });
		void startY; void y0;
		const top = pg.blocks[bi].y0;
		const fresh = noteFor(bi, b, top);
		layoutNote(fresh);
		inlineNotes(fresh);
	};

	const body = p.blocks.filter((b) => !(b.t === 'heading' && b.depth === 1 && plain(b.runs).trim() === p.meta.title) && b.t !== 'pagebreak');
	let foldEndY = -1;
	for (let bi = 0; bi < body.length; bi++) {
		const bl = body[bi];
		switch (bl.t) {
			case 'heading': {
				if (bl.depth <= 2) {
					sectionNo++;
					pg.section = sectionNo;
					sectionEntry(bl.runs, bl.id, 0);
					leadNext = false;
				} else {
					const bs = bl.depth === 3 ? 1.25 : 1.05;
					const st = env.text.len;
					const hb = para(bl.runs, W, bs, bl.depth === 3 ? LH : LH, F.bold);
					if (bl.id) hb.anchors.push({ id: bl.id, y: 0 });
					pg.place(hb, { kind: BlockKind.heading, level: bl.depth, before: SP.s4, after: SP.s2, size: bs, font: LineFont.bold, start: st, anchor: bl.id });
					leadNext = false;
				}
				break;
			}
			case 'para': {
				if (leadNext) {
					const sp = splitLead(bl.runs);
					if (sp) { emitPara(sp.lead, true); emitPara(sp.rest, false); }
					else emitPara(bl.runs, true);
					leadNext = false;
				} else emitPara(bl.runs, false);
				break;
			}
			case 'code': {
				const wide = cfg.margin && !!bl.wide;
				const width = wide ? cfg.figW : W;
				const st = env.text.len;
				const b = layoutCode(env, bl, { x0: 0, width });
				// exactly one codeBg rect, first
				pg.place(b, { kind: BlockKind.code, level: 0, before: SP.s3, after: SP.s3, size: 0.875, font: LineFont.code, start: st, x: wide ? cfg.figX : 0, width, anchor: bl.lang || undefined });
				leadNext = false;
				break;
			}
			case 'exhibit': {
				if (directiveIds.has(bl.id)) throw new Error(`${where}:${bl.line}: two ::exhibit directives for "${bl.id}" (one exhibit instance per post)`);
				directiveIds.add(bl.id);
				if (!figures.has(bl.id) && !scripts.has(bl.id)) throw new Error(`${where}:${bl.line}: ::exhibit id "${bl.id}" is neither exhibits/${bl.id}.flecs nor an entry of exhibits/art.ts`);
				placeExhibit_(bl.id, bl.place, 0);
				leadNext = false;
				break;
			}
			case 'image': {
				const wide = cfg.margin;
				const width = wide ? cfg.figW : W;
				const st = env.text.len;
				const b = layoutBlocks(env, [bl], { x0: 0, width }, where)[0];
				pg.place(b, { kind: BlockKind.image, before: SP.s4, after: SP.s4, size: 1, font: LineFont.body, start: st, x: wide ? cfg.figX : 0, width, flags: wide ? BlockFlag.wide : 0 });
				leadNext = false;
				break;
			}
			case 'refs': {
				const st = env.text.len;
				foldEndY = foldEndY < 0 ? -1 : foldEndY;
				const out = layoutBlocks(env, [bl], { x0: 0, width: W }, where);
				const head = out[0], items = out[1];
				head.anchors = head.anchors.length ? head.anchors : [{ id: 'references', y: 0 }];
				pg.place(head, { kind: BlockKind.heading, level: 2, before: SP.s7, after: SP.s3, size: 2, font: LineFont.bold, start: st, anchor: 'references' });
				pg.place(items, { kind: BlockKind.refs, before: 0, after: SP.s4, size: 0.92, font: LineFont.body, start: st });
				leadNext = false;
				break;
			}
			case 'footnotes': {
				const st = env.text.len;
				const out = layoutBlocks(env, [bl], { x0: 0, width: W }, where);
				pg.place(out[0], { kind: BlockKind.rule, before: SP.s4, after: SP.s3, size: 1, font: LineFont.body, start: st });
				pg.place(out[1], { kind: BlockKind.footnotes, before: 0, after: SP.s3, size: 0.9, font: LineFont.body, start: st });
				break;
			}
			default: {
				const st = env.text.len;
				const out = layoutBlocks(env, [bl], { x0: 0, width: W }, where);
				const kind = bl.t === 'list' ? BlockKind.list : bl.t === 'quote' ? BlockKind.quote : bl.t === 'note' ? BlockKind.note : bl.t === 'rule' ? BlockKind.rule
					: bl.t === 'math' ? BlockKind.math : bl.t === 'table' ? BlockKind.table : BlockKind.para;
				const gap = bl.t === 'list' ? [0, SP.s2] : bl.t === 'math' ? [SP.s2, SP.s2] : bl.t === 'rule' ? [SP.s4, SP.s4] : [SP.s3, SP.s3];
				out.forEach((b, k) => pg.place(b, { kind, before: k ? 0 : gap[0], after: gap[1], size: bl.t === 'table' ? 0.95 : 1, font: LineFont.body, start: st }));
				if (bl.t === 'list' || bl.t === 'quote') {
					// citations inside lists and quotes get their note too (the note follows the block on mid and narrow)
					const top = pg.blocks[pg.blocks.length - 1].y0;
					const fresh = noteFor(pg.blocks.length - 1, out[0], top);
					layoutNote(fresh);
					inlineNotes(fresh);
				}
				leadNext = false;
			}
		}
	}
	const bodyEnd = pg.y;
	if (hasBrief) foldEndY = bodyEnd;
	pg.folded = false;

	// ---- footer: the next post (one large link) and the previous one (quiet) ----
	{
		const { prev, next } = inp.neighbours;
		if (prev || next) {
			const st = env.text.len;
			const b = emptyBlk();
			let y = 0;
			const lab = (text: string) => {
				const l = layoutPara(env, [{ text, font: F.sans, size: 1, color: PAL2.muted, flags: 0 }], { x0: 0, width: W, bs: 0.85, lh: LH, font: F.sans, align: 'left' }, where);
				sentinelText(env);
				return l;
			};
			const link = (nb: Neighbour, size: number, colour: number, yy: number) => {
				const t = layoutPara(env, [{ text: nb.title, font: F.head, size: 1, color: colour, flags: GlyphFlag.link, href: `/thoughts/${nb.slug}` }], { x0: 0, width: W, bs: size, lh: up(size * 1.2), font: F.head, align: 'left' }, where);
				sentinelText(env);
				shift(t, 0, yy);
				b.lines.push(...t.lines);
				b.links.push(...t.links);
				return t.h;
			};
			if (next) {
				const l = lab('Next');
				shift(l, 0, y);
				b.lines.push(...l.lines);
				y += LH + SP.s1;
				y += link(next, cfg.cls === 2 ? 1.5 : 1.9, PAL2.heading, y) + SP.s4;
			}
			if (prev) {
				const l = lab('Previous');
				shift(l, 0, y);
				b.lines.push(...l.lines);
				y += LH + SP.s1;
				y += link(prev, 1.1, PAL2.muted, y) + SP.s2;
			}
			b.h = y;
			pg.place(b, { kind: BlockKind.nextprev, before: SP.s8, after: 0, size: 1, font: LineFont.body, start: st });
		}
	}

	const docH = pg.y + SP.s7;
	let foldY = 0, foldH = 0, peekH = 0;
	if (hasBrief && foldStart >= 0) {
		foldY = foldStart;
		foldH = foldEndY - foldStart;
		peekH = 6 * LH;
		if (foldH < peekH + 4 * LH) { foldH = 0; peekH = 0; foldY = 0; for (const bk of pg.blocks) bk.flags &= ~BlockFlag.folded; }
	}
	const parts: PageParts = {
		widthClass: cfg.cls, colW: W, docX0: cfg.docX0, docX1: cfg.docX1, docH, foldY, foldH, peekH,
		blocks: pg.blocks, notes: pg.notes, exhibitItems: pg.exhibitItems
	};
	return { store: s, parts, words: wordsOf(p.blocks), finish: (text) => finalizeText(pg, text) };
}

function fmtDate(d: unknown): string {
	if (!d) return '';
	const t = d instanceof Date ? d : new Date(String(d));
	if (Number.isNaN(t.getTime())) return String(d);
	return t.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** Move every line, glyph and rect of a Blk right by dx em (used for hung text beside a bar). The bar rects are added before the shift by callers that want them fixed. */
function shiftText(b: Blk, dx: number): Blk {
	const bars = b.rects.filter((r) => r.kind === RectKind.quoteBar);
	const others = b.rects.filter((r) => r.kind !== RectKind.quoteBar);
	const keepY = b.h;
	b.rects = others;
	shift(b, dx, 0);
	b.rects.push(...bars);
	b.h = keepY;
	return b;
}

/** Text ranges (trailing whitespace trimmed against the final bytes), join flags, link ranges and block text ranges. */
export function finalizeText(pg: { s: Store; blocks: BlockRec[]; lineRawLen: number[]; lineOwner: number[] }, text: Uint8Array) {
	const s = pg.s;
	const ws = (b: number) => b === 0x20 || b === 0x0a || b === 0x09 || b === 0x0d;
	s.lines.forEach((l, i) => {
		let len = pg.lineRawLen[i];
		while (len > 0 && ws(text[l.textOff + len - 1])) len--;
		const raw = pg.lineRawLen[i];
		l.textLen = len;
		const nx = s.lines[i + 1];
		if (nx && pg.lineOwner[i + 1] === pg.lineOwner[i] && len === raw && raw > 0) l.flags |= 1;
	});
	for (const k of s.links) {
		const ln = s.lines[k.line];
		let lo = Infinity, hi = -1;
		const offs: number[] = [];
		for (let g = 0; g < ln.glyphCount; g++) {
			const gl = s.glyphs[ln.firstGlyph + g];
			offs.push(gl.charOffset);
			if (gl.x >= k.x0 - 0.02 && gl.x < k.x1 - 0.02) { lo = Math.min(lo, gl.charOffset); hi = Math.max(hi, gl.charOffset); }
		}
		const lineEnd = ln.textOff + ln.textLen;
		if (hi < 0) { k.t0 = ln.textOff; k.t1 = lineEnd; continue; }
		const after = offs.filter((o) => o > hi).sort((a, b) => a - b)[0];
		k.t0 = Math.max(lo, ln.textOff);
		k.t1 = Math.min(after ?? lineEnd, lineEnd);
		while (k.t1 > k.t0 && ws(text[k.t1 - 1])) k.t1--;
	}
	for (const b of pg.blocks) {
		let len = b.textLen;
		while (len > 0 && ws(text[b.textOff + len - 1])) len--;
		b.textLen = len;
	}
}
