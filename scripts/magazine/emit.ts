// emit: the article's tables (text blocks written by flow.ts, figure fragments from the figure compiler) -> one RDR4 model.
//
// Lane contract. Every producer (planner for text, frames and the distilled spread; figure compiler for
// shapes, strokes, groups and channels) returns a `Fragment`: tables with indices LOCAL to the fragment
// and coordinates in the figure's em frame (origin top-left of the figure, x right, y down). `appendFragment`
// rebases every index (items, strokes -> segs, groups, channels, keys, exhibit channel ranges, line glyph
// ranges, dot -> stroke) so fragments compose. Glyph ids, string offsets and text offsets are ARTICLE-GLOBAL
// already (the producers share one GlyphTableBuilder pair, StringSink and TextSink through PlanEnv), so
// they are never rebased.
import {
	ItemType, MAX_CELL_ITEMS, NONE16, NO_CHAN, PAL2, PALETTE2_SIZE, CELL_W, CELL_H, ShapeKind, ExhibitKind, packItem, packReading,
	type ReadingModel, type BlockRec, type NoteRec, type GlyphInst, type RectInst, type ImageInst, type ShapeInst, type PathInst, type StrokeRec, type SegRec,
	type GroupRec, type NumeralInst, type LineRec, type LinkRec, type AnchorRec, type ChanRec, type KeyRec, type ExhibitRec
} from '../../src/lib/magazine/format';
import { EXTRA_BIT } from '../../src/lib/reader/format';
import type { GlyphTableBuilder } from '../reader/fonts';

export const GRID_PAD = 0.25; // em, cell lists are dilated by this much

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
	chans?: ChanRec[];
	keys?: KeyRec[];
	exhibits?: Partial<ExhibitRec>[];
}

export interface EmitContext {
	extra: GlyphTableBuilder;
	/** union glyph builder: boxes and areas for grid bounds */
	union: GlyphTableBuilder;
	text: Uint8Array;
	strings: Uint8Array;
	palette: Uint32Array;
	digitSets: number[][];
}

const all = <T>(a: T[] | undefined): T[] => a ?? [];

const rebaseChan = (c: number | undefined, base: number) => (c === undefined || c === NO_CHAN ? NO_CHAN : c + base);
const rebaseGroup16 = (g: number | undefined, base: number) => (g === undefined || g === NONE16 ? NONE16 : g + base);

// ---- store: a Fragment-shaped accumulator with every table non-optional ---------------------------

export interface Store {
	items: FItem[];
	glyphs: GlyphInst[]; rects: RectInst[]; images: ImageInst[]; shapes: ShapeInst[]; paths: PathInst[]; strokes: StrokeRec[]; segs: SegRec[];
	groups: GroupRec[]; numerals: NumeralInst[]; chans: ChanRec[]; keys: KeyRec[]; exhibits: ExhibitRec[];
	lines: LineRec[]; links: LinkRec[]; anchors: AnchorRec[];
}

export const newStore = (): Store => ({
	items: [], glyphs: [], rects: [], images: [], shapes: [], paths: [], strokes: [], segs: [], groups: [], numerals: [], chans: [], keys: [], exhibits: [],
	lines: [], links: [], anchors: []
});

const TABLE_OF: Record<number, keyof Store | undefined> = {
	[ItemType.glyph]: 'glyphs', [ItemType.rect]: 'rects', [ItemType.image]: 'images', [ItemType.shape]: 'shapes', [ItemType.path]: 'paths',
	[ItemType.stroke]: 'strokes', [ItemType.group]: 'groups', [ItemType.numeral]: 'numerals'
};
const BASE_KEY: Record<number, keyof Bases> = {
	[ItemType.glyph]: 'glyph', [ItemType.rect]: 'rect', [ItemType.image]: 'image', [ItemType.shape]: 'shape', [ItemType.path]: 'path',
	[ItemType.stroke]: 'stroke', [ItemType.group]: 'group', [ItemType.numeral]: 'numeral'
};

export interface Bases { glyph: number; rect: number; image: number; shape: number; path: number; stroke: number; seg: number; group: number; numeral: number; chan: number; key: number }

/**
 * Rebase `f` into `s`; its tables are appended and every index inside them is rebased. Its item list is NOT added to `s.items`
 * (a figure's items are listed through its cell grid, not through a block range): the rebased list is returned with the bases.
 */
export function appendFragment(s: Store, f: Fragment): { bases: Bases; items: FItem[] } {
	const b: Bases = {
		glyph: s.glyphs.length, rect: s.rects.length, image: s.images.length, shape: s.shapes.length, path: s.paths.length, stroke: s.strokes.length,
		seg: s.segs.length, group: s.groups.length, numeral: s.numerals.length, chan: s.chans.length, key: s.keys.length
	};
	const g = (v: number | undefined) => rebaseGroup16(v, b.group);
	const c = (v: number | undefined) => rebaseChan(v, b.chan);
	for (const x of all(f.glyphs)) s.glyphs.push({ ...x, group: g(x.group) } as GlyphInst);
	for (const x of all(f.rects)) s.rects.push({ radius: 0, ...x, group: g(x.group) } as RectInst);
	for (const x of all(f.images)) s.images.push({ ...x } as ImageInst);
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
	for (const x of all(f.chans)) s.chans.push({ ...x, firstKey: x.firstKey + b.key });
	for (const x of all(f.keys)) s.keys.push({ ...x });
	for (const x of all(f.exhibits)) s.exhibits.push({ ...x, firstChan: (x.firstChan ?? 0) + b.chan } as ExhibitRec);
	const items = f.items.map((it) => {
		const k = BASE_KEY[it.type];
		if (k === undefined) throw new Error(`emit: unknown item type ${it.type}`);
		return { ...it, index: it.index + b[k] };
	});
	return { bases: b, items };
}

/**
 * Place figure-local art at (dx, dy) in the page by wrapping it in one root group (translate and uniform scale, no
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
		exhibits: all(art.exhibits).map((x) => ({ ...x, x0: (x.x0 ?? 0) * scale + dx, x1: (x.x1 ?? 0) * scale + dx, y0: (x.y0 ?? 0) * scale + dy, y1: (x.y1 ?? 0) * scale + dy })),
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

/** Per-cell item lists of one figure (global store indices), grid origin at the figure box top-left. `list` holds the cell lists back to back (relative to the list start). */
export function buildFigureGrid(s: Store, items: FItem[], box: Box, ctx: EmitContext, where: string): { cols: number; rows: number; cells: { start: number; count: number }[]; list: number[] } {
	const cols = Math.max(1, Math.ceil((box.x1 - box.x0) / CELL_W)), rows = Math.max(1, Math.ceil((box.y1 - box.y0) / CELL_H));
	const boxes = items.filter((it) => it.type !== ItemType.group).map((it) => ({ it, ...itemBounds(s, it, ctx) }));
	const cells: { start: number; count: number }[] = [];
	const list: number[] = [];
	for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
		const x0 = box.x0 + cx * CELL_W, x1 = x0 + CELL_W, y0 = box.y0 + cy * CELL_H, y1 = y0 + CELL_H;
		const start = list.length;
		let animatedHere = 0;
		for (const { it, box: b, animated } of boxes) {
			if (b.x1 + GRID_PAD < x0 || b.x0 - GRID_PAD > x1 || b.y1 + GRID_PAD < y0 || b.y0 - GRID_PAD > y1) continue;
			list.push(packItem(it.type, it.index));
			if (animated) animatedHere++;
		}
		if (animatedHere > MAX_CELL_ITEMS) throw new Error(`${where}: grid cell (${cx},${cy}) holds ${animatedHere} animated items (limit ${MAX_CELL_ITEMS}); split or reduce the figure`);
		cells.push({ start, count: list.length - start });
	}
	return { cols, rows, cells, list };
}

// ---- model ----------------------------------------------------------------------------------------

export interface PageParts {
	widthClass: number; colW: number; docX0: number; docX1: number; docH: number; foldY: number; foldH: number; peekH: number;
	blocks: BlockRec[]; notes: NoteRec[];
	/** per exhibit (in exhibit table order): the placed items and the box; absent for a script exhibit (no static items, empty grid) */
	exhibitItems: ({ items: FItem[]; box: Box } | undefined)[];
}

export interface EmitResult { model: ReadingModel; bytes: Uint8Array }

/** Validate and assemble the page into one model, then pack it. Block item lists are s.items (already contiguous per block); figure cell lists are appended after them. */
export function emitReading(s: Store, p: PageParts, ctx: EmitContext, where: string): EmitResult {
	const items: number[] = s.items.map((it) => packItem(it.type, it.index));
	const cells: { start: number; count: number }[] = [];
	const exhibits = s.exhibits.map((f, i) => {
		const fi = p.exhibitItems[i];
		if (!fi) {
			if (f.kind !== ExhibitKind.script) throw new Error(`${where}: timeline exhibit ${i} has no items`);
			return { ...f, firstCell: cells.length, gridCols: 0, gridRows: 0 };
		}
		const g = buildFigureGrid(s, fi.items, fi.box, ctx, `${where} exhibit ${f.id}`);
		const firstCell = cells.length, base = items.length;
		for (const w of g.list) items.push(w);
		for (const c of g.cells) cells.push({ start: c.start + base, count: c.count });
		return { ...f, firstCell, gridCols: g.cols, gridRows: g.rows };
	});
	for (const f of exhibits) if (f.chanCount > 256) throw new Error(`${where}: exhibit ${f.id} has ${f.chanCount} channels (limit 256)`);
	if (s.chans.length > 256) throw new Error(`${where}: ${s.chans.length} animation channels, the runtime table holds 256`);
	const model: ReadingModel = {
		widthClass: p.widthClass, colW: p.colW, docX0: p.docX0, docX1: p.docX1, docH: p.docH, foldY: p.foldY, foldH: p.foldH, peekH: p.peekH,
		plainTextBytes: ctx.text.length,
		blocks: p.blocks, notes: p.notes, cells, items,
		glyphs: s.glyphs, rects: s.rects, images: s.images, shapes: s.shapes, paths: s.paths, strokes: s.strokes, segs: s.segs, groups: s.groups, numerals: s.numerals,
		digitSets: ctx.digitSets, chans: s.chans, keys: s.keys, exhibits, lines: s.lines, links: s.links, anchors: s.anchors,
		extra: ctx.extra.finish(), text: ctx.text, strings: ctx.strings, palette: ctx.palette
	};
	if (model.palette.length !== PALETTE2_SIZE) throw new Error(`${where}: palette must have ${PALETTE2_SIZE} entries`);
	return { model, bytes: packReading(model) };
}
