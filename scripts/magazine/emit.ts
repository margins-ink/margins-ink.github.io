// emit: SpreadContent fragments (from the grid planner and the figure compiler) -> one RDR2 model.
//
// Lane contract. Every producer (planner for text, frames and the distilled spread; figure compiler for
// shapes, strokes, groups and channels) returns a `Fragment`: tables with indices LOCAL to the fragment
// and coordinates in the spread's em frame (origin top-left of the spread, x right, y down). `appendFragment`
// rebases every index (items, strokes -> segs, groups, channels, keys, figure channel ranges, line glyph
// ranges, dot -> stroke) so fragments compose. Glyph ids, string offsets and text offsets are ARTICLE-GLOBAL
// already (the producers share one GlyphTableBuilder pair, StringSink and TextSink through PlanEnv), so
// they are never rebased.
import {
	ItemType, MAX_CELL_ITEMS, NONE16, NO_CHAN, PAL2, PALETTE2_SIZE, SPREAD_H, SPREAD_W, CELL_W, CELL_H, ShapeKind, packItem, packMagazine,
	type MagazineModel, type SpreadRec, type GlyphInst, type RectInst, type ImageInst, type ShapeInst, type PathInst, type StrokeRec, type SegRec,
	type GroupRec, type NumeralInst, type LineRec, type LinkRec, type AnchorRec, type ChanRec, type KeyRec, type FigureRec
} from '../../src/lib/magazine/format';
import { EXTRA_BIT } from '../../src/lib/reader/format';
import type { GlyphTableBuilder } from '../reader/fonts';

export const GRID_PAD = 0.25; // em, cell lists are dilated by this much (MAGAZINE.md 1.6)
export const SPREAD_GAP = 2; // em between spreads on the table (x_em)

/** Template name -> id stored in `Spreads[].template`; index.json carries the same table for the runtime. */
export const TEMPLATE_IDS = ['duo', 'solo', 'compare', 'numerals', 'text', 'text-code'] as const;
export const templateId = (name: string): number => {
	const i = (TEMPLATE_IDS as readonly string[]).indexOf(name.replace(/-n$/, ''));
	if (i < 0) throw new Error(`emit: unknown template "${name}"`);
	return i;
};

export interface Box { x0: number; y0: number; x1: number; y1: number }

/** Records as producers write them: group / frame may be omitted (group defaults to "none"). */
type Loose<T, K extends string = never> = Omit<T, 'group' | 'frame' | K> & { group?: number; frame?: number };

/** One item in a spread's draw list. `bounds` is REQUIRED for animated items (swept bound over the timeline). */
export interface FItem { type: number; index: number; bounds?: Box }

export interface Fragment {
	items: FItem[];
	glyphs?: Loose<GlyphInst>[];
	rects?: Loose<RectInst>[];
	images?: Loose<ImageInst>[];
	shapes?: Loose<ShapeInst>[];
	paths?: Loose<PathInst>[];
	strokes?: Loose<StrokeRec>[];
	segs?: SegRec[];
	groups?: GroupRec[];
	numerals?: Loose<NumeralInst>[];
	lines?: Loose<LineRec>[];
	links?: Partial<LinkRec>[];
	anchors?: Partial<AnchorRec>[];
	chans?: ChanRec[];
	keys?: KeyRec[];
	figures?: Partial<FigureRec>[];
}

export interface SpreadMeta {
	/** 0 distilled, 1 full text */
	layer: 0 | 1;
	/** template id (index into the template table written to index.json) */
	template: number;
	w: number;
	h: number;
	materialMask: number;
	accentIdx: number;
	/** ink coverage 0..1 for the LOD tone; computed from glyph and rect areas when omitted */
	coverage?: number;
}

export interface SpreadContent { meta: SpreadMeta; frag: Fragment }

export interface EmitContext {
	widthClass: number;
	sheetW: number;
	marginOuter: number;
	marginSpine: number;
	gutter: number;
	extra: GlyphTableBuilder;
	/** union glyph builder: boxes and areas for grid bounds */
	union: GlyphTableBuilder;
	text: Uint8Array;
	strings: Uint8Array;
	palette: Uint32Array;
	digitSets: number[][];
	emPx0?: number;
}

const all = <T>(a: T[] | undefined): T[] => a ?? [];

const rebaseChan = (c: number | undefined, base: number) => (c === undefined || c === NO_CHAN ? NO_CHAN : c + base);
const rebaseGroup16 = (g: number | undefined, base: number) => (g === undefined || g === NONE16 ? NONE16 : g + base);

// ---- store: a Fragment-shaped accumulator with every table non-optional ---------------------------

export interface Store {
	items: FItem[];
	glyphs: GlyphInst[]; rects: RectInst[]; images: ImageInst[]; shapes: ShapeInst[]; paths: PathInst[]; strokes: StrokeRec[]; segs: SegRec[];
	groups: GroupRec[]; numerals: NumeralInst[]; lines: LineRec[]; links: LinkRec[]; anchors: AnchorRec[]; chans: ChanRec[]; keys: KeyRec[]; figures: FigureRec[];
}

export const newStore = (): Store => ({
	items: [], glyphs: [], rects: [], images: [], shapes: [], paths: [], strokes: [], segs: [], groups: [], numerals: [], lines: [], links: [], anchors: [], chans: [], keys: [], figures: []
});

const TABLE_OF: Record<number, keyof Store | undefined> = {
	[ItemType.glyph]: 'glyphs', [ItemType.rect]: 'rects', [ItemType.image]: 'images', [ItemType.shape]: 'shapes', [ItemType.path]: 'paths',
	[ItemType.stroke]: 'strokes', [ItemType.group]: 'groups', [ItemType.numeral]: 'numerals'
};

export interface Bases { glyph: number; rect: number; image: number; shape: number; path: number; stroke: number; seg: number; group: number; numeral: number; line: number; chan: number; key: number }

/** Rebase `f` into `s`. `spread` stamps links, anchors and figures. Returns the bases that were used. */
export function appendFragment(s: Store, f: Fragment, spread: number): Bases {
	const b: Bases = {
		glyph: s.glyphs.length, rect: s.rects.length, image: s.images.length, shape: s.shapes.length, path: s.paths.length, stroke: s.strokes.length,
		seg: s.segs.length, group: s.groups.length, numeral: s.numerals.length, line: s.lines.length, chan: s.chans.length, key: s.keys.length
	};
	const g = (v: number | undefined) => rebaseGroup16(v, b.group);
	const c = (v: number | undefined) => rebaseChan(v, b.chan);
	const f32 = <T extends object>(o: T) => o as T;
	for (const x of all(f.glyphs)) s.glyphs.push({ ...x, group: g(x.group), frame: x.frame ?? NONE16 } as GlyphInst);
	for (const x of all(f.rects)) s.rects.push({ ...x, group: g(x.group) } as RectInst);
	for (const x of all(f.images)) s.images.push(f32({ ...x }) as ImageInst);
	for (const x of all(f.shapes)) {
		s.shapes.push({
			...x, group: g(x.group), chan: c(x.chan), mixChan: c(x.mixChan),
			aux: x.kind === ShapeKind.dot || x.kind === ShapeKind.arrowHead ? x.aux + b.stroke : x.aux
		} as ShapeInst);
	}
	for (const x of all(f.paths)) s.paths.push({ ...x, group: g(x.group) } as PathInst);
	for (const x of all(f.strokes)) {
		s.strokes.push({
			...x, firstSeg: x.firstSeg + b.seg, group: g(x.group), phaseChan: c(x.phaseChan), trimT0Chan: c(x.trimT0Chan), trimT1Chan: c(x.trimT1Chan),
			widthChan: c(x.widthChan), mixChan: c(x.mixChan)
		} as StrokeRec);
	}
	for (const x of all(f.segs)) s.segs.push({ ...x });
	for (const x of all(f.groups)) {
		s.groups.push({
			...x, parent: x.parent < 0 ? -1 : x.parent + b.group, txChan: c(x.txChan), tyChan: c(x.tyChan), rotChan: c(x.rotChan),
			scaleChan: c(x.scaleChan), opacityChan: c(x.opacityChan)
		});
	}
	for (const x of all(f.numerals)) s.numerals.push({ ...x, chan: c(x.chan), group: g(x.group) } as NumeralInst);
	for (const x of all(f.lines)) s.lines.push({ ...x, firstGlyph: x.firstGlyph + b.glyph, frame: x.frame ?? 0 } as LineRec);
	for (const x of all(f.links)) s.links.push({ ...x, spread } as LinkRec);
	for (const x of all(f.anchors)) s.anchors.push({ ...x, spread } as AnchorRec);
	for (const x of all(f.chans)) s.chans.push({ ...x, firstKey: x.firstKey + b.key });
	for (const x of all(f.keys)) s.keys.push({ ...x });
	for (const x of all(f.figures)) s.figures.push({ ...x, firstChan: (x.firstChan ?? 0) + b.chan, spread } as FigureRec);
	for (const it of f.items) {
		const base = (b as unknown as Record<string, number>)[({ [ItemType.glyph]: 'glyph', [ItemType.rect]: 'rect', [ItemType.image]: 'image', [ItemType.shape]: 'shape', [ItemType.path]: 'path', [ItemType.stroke]: 'stroke', [ItemType.group]: 'group', [ItemType.numeral]: 'numeral' } as Record<number, string>)[it.type]];
		if (base === undefined) throw new Error(`emit: unknown item type ${it.type}`);
		s.items.push({ ...it, index: it.index + base });
	}
	return b;
}

/** Merge `src` into a new Fragment-shaped value with local indices (used to combine figure art with frames). */
export function concatFragments(parts: Fragment[]): Fragment {
	const s = newStore();
	for (const p of parts) appendFragment(s, p, 0);
	// links/anchors/figures got spread 0 stamped; the final emit re-stamps them
	return s as unknown as Fragment;
}

/**
 * Place figure-local art at (dx, dy) in the spread by wrapping it in one root group (translate only, no
 * coordinate rewrite): existing root groups are parented to it and ungrouped items join it. Bounds
 * overrides move with it. Returns a fresh Fragment; the input is not modified.
 */
export function placeFigure(art: Fragment, dx: number, dy: number, scale = 1): Fragment {
	const root: GroupRec = { parent: -1, txChan: NO_CHAN, tyChan: NO_CHAN, rotChan: NO_CHAN, scaleChan: NO_CHAN, opacityChan: NO_CHAN, tx: dx, ty: dy, rot: 0, scale, opacity: 1, pivotX: 0, pivotY: 0 };
	const shiftG = (v: number | undefined) => (v === undefined || v === NONE16 ? 0 : v + 1);
	const out: Fragment = {
		...art,
		groups: [root, ...all(art.groups).map((x) => ({ ...x, parent: x.parent < 0 ? 0 : x.parent + 1 }))],
		glyphs: all(art.glyphs).map((x) => ({ ...x, group: shiftG(x.group) })),
		rects: all(art.rects).map((x) => ({ ...x, group: shiftG(x.group) })),
		shapes: all(art.shapes).map((x) => ({ ...x, group: shiftG(x.group) })),
		paths: all(art.paths).map((x) => ({ ...x, group: shiftG(x.group) })),
		strokes: all(art.strokes).map((x) => ({ ...x, group: shiftG(x.group) })),
		numerals: all(art.numerals).map((x) => ({ ...x, group: shiftG(x.group) })),
		figures: all(art.figures).map((x) => ({ ...x, x0: (x.x0 ?? 0) * scale + dx, x1: (x.x1 ?? 0) * scale + dx, y0: (x.y0 ?? 0) * scale + dy, y1: (x.y1 ?? 0) * scale + dy })),
		items: art.items.map((it) => ({
			...it,
			// the new root group is group 0, so group items shift by one; they are listed only for completeness
			index: it.type === ItemType.group ? it.index + 1 : it.index,
			bounds: it.bounds ? { x0: it.bounds.x0 * scale + dx, x1: it.bounds.x1 * scale + dx, y0: it.bounds.y0 * scale + dy, y1: it.bounds.y1 * scale + dy } : undefined
		}))
	};
	return out;
}

// ---- bounds and grid ------------------------------------------------------------------------------

const rgb565 = (r: number, g: number, b: number) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);

function itemBounds(s: Store, it: FItem, ctx: EmitContext): { box: Box; animated: boolean } {
	const tableName = TABLE_OF[it.type];
	if (!tableName) throw new Error(`emit: item type ${it.type} has no table`);
	const table = s[tableName] as unknown as Record<string, number>[];
	const rec = table[it.index];
	if (!rec) throw new Error(`emit: item ${tableName}[${it.index}] does not exist`);
	const hasGroup = 'group' in rec && rec.group !== NONE16;
	if (it.bounds) return { box: it.bounds, animated: true };
	// a group chain with no channels and no rotation (the figure placement root) is a fixed affine map: the item is static
	// and its bound is the raw bound mapped through the chain. Anything else needs explicit swept bounds.
	const chain: GroupRec[] = [];
	if (hasGroup) {
		for (let g = rec.group; g >= 0 && g !== NONE16; g = s.groups[g].parent) {
			const gr = s.groups[g];
			const fixed = [gr.txChan, gr.tyChan, gr.rotChan, gr.scaleChan, gr.opacityChan].every((c) => c === NO_CHAN) && gr.rot === 0;
			if (!fixed) throw new Error(`emit: ${tableName}[${it.index}] is in an animated group and needs explicit swept bounds`);
			chain.push(gr);
		}
	}
	const raw = rawBounds(s, it, ctx, rec);
	let box = raw;
	for (const gr of chain) {
		const f = (x: number, y: number): [number, number] => [gr.pivotX + gr.scale * (x - gr.pivotX) + gr.tx, gr.pivotY + gr.scale * (y - gr.pivotY) + gr.ty];
		const [ax, ay] = f(box.x0, box.y0), [bx, by] = f(box.x1, box.y1);
		box = { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
	}
	return { box, animated: false };
}

function rawBounds(s: Store, it: FItem, ctx: EmitContext, rec: Record<string, number>): Box {
	switch (it.type) {
		case ItemType.glyph: {
			const gid = rec.glyphId;
			const [bx0, by0, bx1, by1] = gid & EXTRA_BIT ? ctx.extra.boxes[(gid & ~EXTRA_BIT) >>> 0] : ctx.union.boxes[gid];
			return ({ x0: rec.x + bx0 * rec.size, x1: rec.x + bx1 * rec.size, y0: rec.y - by1 * rec.size, y1: rec.y - by0 * rec.size });
		}
		case ItemType.rect:
		case ItemType.image:
		case ItemType.shape: return ({ x0: rec.x0, y0: rec.y0, x1: rec.x1, y1: rec.y1 });
		case ItemType.path: {
			const [bx0, by0, bx1, by1] = ctx.extra.boxes[rec.glyphIdx];
			return ({ x0: rec.x + bx0 * rec.scale, x1: rec.x + bx1 * rec.scale, y0: rec.y - by1 * rec.scale, y1: rec.y - by0 * rec.scale });
		}
		case ItemType.stroke: {
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			for (let i = 0; i < rec.segCount; i++) {
				const g = s.segs[rec.firstSeg + i];
				for (const [x, y] of [[g.x0, g.y0], [g.x1, g.y1], [g.x2, g.y2]]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
			}
			const h = rec.width / 2;
			return ({ x0: x0 - h, y0: y0 - h, x1: x1 + h, y1: y1 + h });
		}
		case ItemType.numeral: {
			const w = rec.cellW * rec.digits;
			return ({ x0: rec.x, x1: rec.x + w, y0: rec.y - rec.size, y1: rec.y + rec.size * 0.25 });
		}
		default: throw new Error(`emit: no bounds for item type ${it.type}`);
	}
}

export interface GridResult { cells: { start: number; count: number }[]; words: number[]; coverage: number }

/** Build the per-cell item lists for one spread's items (global store indices). */
export function buildGrid(s: Store, items: FItem[], w: number, h: number, ctx: EmitContext, where: string): { cols: number; rows: number; cells: { start: number; count: number }[]; list: number[]; ink: number } {
	const cols = Math.ceil(w / CELL_W), rows = Math.ceil(h / CELL_H);
	const boxes = items.filter((it) => it.type !== ItemType.group).map((it) => ({ it, ...itemBounds(s, it, ctx) }));
	const cells: { start: number; count: number }[] = [];
	const list: number[] = [];
	let ink = 0;
	for (const { it, box } of boxes) {
		if (it.type === ItemType.glyph) {
			const g = s.glyphs[it.index];
			const gid = g.glyphId;
			ink += (gid & EXTRA_BIT ? ctx.extra.areas[(gid & ~EXTRA_BIT) >>> 0] : ctx.union.areas[gid]) * g.size * g.size;
		}
	}
	for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
		const x0 = cx * CELL_W, x1 = x0 + CELL_W, y0 = cy * CELL_H, y1 = y0 + CELL_H;
		const start = list.length;
		let animatedHere = 0;
		for (const { it, box, animated } of boxes) {
			if (box.x1 + GRID_PAD < x0 || box.x0 - GRID_PAD > x1 || box.y1 + GRID_PAD < y0 || box.y0 - GRID_PAD > y1) continue;
			list.push(packItem(it.type, it.index));
			if (animated) animatedHere++;
		}
		if (animatedHere > MAX_CELL_ITEMS) {
			if (process.env.MAG_DEBUG) for (const { it, box, animated } of boxes) if (animated && !(box.x1 + GRID_PAD < x0 || box.x0 - GRID_PAD > x1 || box.y1 + GRID_PAD < y0 || box.y0 - GRID_PAD > y1)) console.error(it.type, it.index, JSON.stringify(box));
			throw new Error(`${where}: grid cell (${cx},${cy}) holds ${animatedHere} animated items (limit ${MAX_CELL_ITEMS}); split or reduce the figure`);
		}
		cells.push({ start, count: list.length - start });
	}
	return { cols, rows, cells, list, ink };
}

// ---- model ----------------------------------------------------------------------------------------

const hexOfPal = (p: number) => [p & 255, (p >> 8) & 255, (p >> 16) & 255];

export interface EmitResult { model: MagazineModel; spreadLayers: (0 | 1)[]; bytes: Uint8Array }

/** Validate and assemble every spread into one model, then pack it. */
export function emitMagazine(spreads: SpreadContent[], ctx: EmitContext, where: string): EmitResult {
	const s = newStore();
	const recs: (SpreadRec & { layer: number })[] = [];
	const cells: { start: number; count: number; pad?: number }[] = [];
	const cellItems: number[] = [];
	const paper = hexOfPal(ctx.palette[PAL2.paper]), ink = hexOfPal(ctx.palette[PAL2.ink]);
	let x = 0;
	spreads.forEach((sp, i) => {
		const w = `${where} spread ${i} (layer ${sp.meta.layer})`;
		const items0 = s.items.length, lines0 = s.lines.length;
		appendFragment(s, sp.frag, i);
		const mine = s.items.slice(items0);
		const g = buildGrid(s, mine, sp.meta.w, sp.meta.h, ctx, w);
		const firstCell = cells.length, firstItem = cellItems.length;
		for (const c of g.cells) cells.push({ start: c.start + firstItem, count: c.count });
		for (const word of g.list) cellItems.push(word);
		const coverage = sp.meta.coverage ?? Math.min(1, g.ink / (sp.meta.w * sp.meta.h));
		const t = Math.min(1, coverage);
		recs.push({
			x, w: sp.meta.w, h: sp.meta.h, template: sp.meta.template, gridCols: g.cols, gridRows: g.rows, firstItem, itemCount: g.list.length, firstCell,
			tone565: rgb565(Math.round(paper[0] + (ink[0] - paper[0]) * t), Math.round(paper[1] + (ink[1] - paper[1]) * t), Math.round(paper[2] + (ink[2] - paper[2]) * t)),
			materialMask: sp.meta.materialMask, accentIdx: sp.meta.accentIdx, firstLine: lines0, lineCount: s.lines.length - lines0, layer: sp.meta.layer
		});
		x += sp.meta.w + SPREAD_GAP;
	});
	// channel uniform is array<f32, 256> (format.ts CHAN_UNIFORM_FLOATS): no single figure set may exceed it
	for (const f of s.figures) if (f.chanCount > 256) throw new Error(`${where}: figure ${f.id} has ${f.chanCount} channels (limit 256)`);
	const model: MagazineModel = {
		widthClass: ctx.widthClass, emPx0: ctx.emPx0 ?? 16, spreadW: ctx.widthClass === 0 ? SPREAD_W : ctx.sheetW, spreadH: SPREAD_H, sheetW: ctx.sheetW,
		marginOuter: ctx.marginOuter, marginSpine: ctx.marginSpine, gutter: ctx.gutter, cellW: CELL_W, cellH: CELL_H, plainTextBytes: ctx.text.length,
		spreads: recs, cells, items: cellItems,
		glyphs: s.glyphs, rects: s.rects, images: s.images, shapes: s.shapes, paths: s.paths, strokes: s.strokes, segs: s.segs, groups: s.groups, numerals: s.numerals,
		digitSets: ctx.digitSets, chans: s.chans, keys: s.keys, figures: s.figures, lines: s.lines, links: s.links, anchors: s.anchors,
		extra: ctx.extra.finish(), text: ctx.text, strings: ctx.strings, palette: ctx.palette
	};
	if (model.palette.length !== PALETTE2_SIZE) throw new Error(`${where}: palette must have ${PALETTE2_SIZE} entries`);
	return { model, spreadLayers: recs.map((r) => r.layer as 0 | 1), bytes: packMagazine(model) };
}
