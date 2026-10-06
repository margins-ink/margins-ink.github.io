// RDR3: binary format of one article as a single scrolling page (docs/READING.md section 4, docs/READING_CONTRACT.md).
// Shared by the build (scripts/magazine) and the runtime. No node imports here.
//
// Container, f16 helpers, glyph tables and fonts.bin are reused unchanged from the RDR1 module
// (src/lib/reader/format.ts): same little-endian container, every section 4-byte aligned, magic
// 'RDR3' tells the formats apart. Every record table below is described once in SCHEMA (field order,
// natural alignment, total padded to 4 bytes); pack and unpack are generated from it, so the byte
// layout is exactly what SCHEMA lists and REC2 gives the sizes.
//
// Coordinates: em of the article (body size), document space: x = 0 is the left edge of the reading column,
// y = 0 the top of the page, y down. Three width classes are built per article (WIDTH_CLASSES); a class is a
// pure function of the viewport width, layout is class-specific and em-relative, so a resize is a scale plus a
// class switch (no relayout at runtime). Blocks are sorted by y0; notes (margin sidenotes) live in their own
// table, sorted by y0, because they overlap the blocks in y.

import {
	packContainer, unpackContainer, toF16, fromF16, roundF16, cstr, PALETTE_SIZE,
	type Container, type GlyphTable
} from '../reader/format';

export { toF16, fromF16, roundF16, cstr, packContainer, unpackContainer, PALETTE_SIZE };
export type { GlyphTable, Container };

export const ARTICLE2_MAGIC = 0x33524452; // 'RDR3'
export const ARTICLE3_MAGIC = ARTICLE2_MAGIC;
/** Body line pitch, em: two spacing units u = 0.81 em (docs/READING.md 2.3). */
export const LINE_H = 1.62;
export const UNIT = 0.81;
/** Figure cell grid (per figure, origin at the figure box top left). */
export const CELL_W = 6;
export const CELL_H = 1.62;
export const MAX_CELL_ITEMS = 48; // compile error above this for animated cells (section 2.2)
export const NONE16 = 0xffff; // "no group / no frame" for u16 fields
export const NO_CHAN = -1; // "constant" for i16 channel fields
export const CHAN_UNIFORM_FLOATS = 256; // per-frame channel uniform, array<f32, 256>

/** Item word: [type:4 | index:28]. */
export const ItemType = { glyph: 0, rect: 1, image: 2, shape: 3, path: 4, stroke: 5, group: 6, numeral: 7 } as const;

/** Block kinds (Block.kind). */
export const BlockKind = {
	hero: 0, heading: 1, para: 2, code: 3, quote: 4, list: 5, image: 6, figure: 7, rule: 8, math: 9, table: 10, fold: 11, refs: 12, footnotes: 13, caption: 14, pullquote: 15, numerals: 16, note: 17, label: 18, nextprev: 19, takeaway: 20
} as const;
export type BlockKindId = (typeof BlockKind)[keyof typeof BlockKind];
/** Block.flags bits. */
export const BlockFlag = { lead: 1, folded: 2, brief: 4, wide: 8, margin: 16, hairTop: 32, tick: 64 } as const;
/** Width classes: viewport >= 1180 wide (notes in the margin), 720..1179 mid (inline notes), < 720 narrow. */
export const WIDTH_CLASSES = [
	{ id: 0, name: 'wide', minPx: 1180, col: 34 },
	{ id: 1, name: 'mid', minPx: 720, col: 34 },
	{ id: 2, name: 'narrow', minPx: 0, col: 21 }
] as const;
/** Line font roles (Line.font): which CSS face the DOM text layer uses for the line. */
/** Line.flags: the next line of the block continues this one without a space (hyphen or dash cut); the copy handler joins soft breaks with a space otherwise. */
export const LineFlag = { joinNext: 1 } as const;
/** LineRec.block of a margin note's line: NOTE_BIT | index into the notes table */
export const NOTE_BIT = 0x80000000;
export const LineFont = { body: 0, bold: 1, italic: 2, code: 3, sans: 4, display: 5, lead: 6 } as const;
export type ItemTypeId = (typeof ItemType)[keyof typeof ItemType];
export const packItem = (type: number, index: number): number => ((type << 28) | (index & 0x0fffffff)) >>> 0;
export const itemType = (w: number): number => w >>> 28;
export const itemIndex = (w: number): number => w & 0x0fffffff;

export const RectKind = { rule: 0, codeBg: 1, quoteBar: 2, tableLine: 3, noteBox: 4, inlineCodeBg: 5, mathRule: 6, field: 7, panel: 8 } as const;
export const LinkKind = { url: 0, anchor: 1, ref: 2, article: 3 } as const;
export const GlyphFlag = { code: 1, math: 2, link: 4, super: 8, display: 16 } as const;
export const ShapeKind = { rrect: 0, circle: 1, line: 2, arrowHead: 3, hatch: 4, dot: 5, ring: 6 } as const;
export const ShapeFlag = { stroke: 1, fillNone: 2, hatch: 4 } as const;
export const StrokeFlag = { capRound: 0, capButt: 1, capSquare: 2, joinRound: 0, joinBevel: 4, closed: 8, evenOdd: 16 } as const;
export const PathFlag = { evenOdd: 1 } as const;
export const NumeralStyle = { fill: 0, outline: 1 } as const;
export const FigureMode = { loop: 0, once: 1, scrub: 2, static: 3 } as const;
export const Material = { matte: 1, coated: 2, field: 4, foil: 8 } as const;
export const Ease = { linear: 0, inSine: 1, outSine: 2, inOutSine: 3, inCubic: 4, outCubic: 5, inOutCubic: 6, step: 7, outBack: 8 } as const;
export type EaseName = keyof typeof Ease;

/** Palette: 32 entries, dark only. 0..7 as RDR1, 8.. per article (MAGAZINE.md 3.2). */
export const PALETTE2_SIZE = 32;
export const PAL2 = {
	ink: 0, link: 1, muted: 2, heading: 3, rule: 4, selection: 5, codeBg: 6, quoteBar: 7,
	accent: 8, accent2: 9, accentTint: 10, accentInk: 11, neutral1: 12, neutral2: 13, neutral3: 14,
	panel: 15, field: 16, paper: 17
} as const;
export type PaletteName = keyof typeof PAL2;

export const Sec2 = {
	blocks: 1, gridCells: 2, items: 3, glyphs: 4, rects: 5, images: 6, lines: 7, links: 8, anchors: 9,
	exDir: 10, exCurves: 11, exBands: 12, text: 13, strings: 14, palette: 15,
	shapes: 30, paths: 31, strokes: 32, segs: 33, groups: 34, chans: 35, keys: 36, figures: 37, digitSets: 38, numerals: 39, notes: 40
} as const;

// ---- schema-driven record codec ----------------------------------------------------------------

type FT = 'f32' | 'u32' | 'i32' | 'u16' | 'i16' | 'u8' | 'f16';
type Fields = readonly (readonly [string, FT])[];
const SZ: Record<FT, number> = { f32: 4, u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, f16: 2 };

export const SCHEMA = {
	// A block of the page: the unit of culling, of the text layer element and of the Flecs entity. Box in document em.
	// items: [firstItem, firstItem + itemCount) of the items table, in draw order (text blocks: glyph / rect / image words);
	// a figure block has no items of its own, its figure record names a cell grid. section: index of the h2 it belongs to
	// (0 = before the first h2). anchor: string offset of the heading / figure id, 0 = none. fig: figure index or -1.
	block: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['firstItem', 'u32'], ['itemCount', 'u32'], ['firstLine', 'u32'], ['lineCount', 'u32'],
		['anchor', 'u32'], ['fig', 'i32'], ['kind', 'u8'], ['level', 'u8'], ['flags', 'u8'], ['pad0', 'u8'], ['section', 'u16'], ['pad1', 'u16'], ['textOff', 'u32'], ['textLen', 'u32']],
	// a margin sidenote: same fields as a block plus the block it annotates
	note: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['firstItem', 'u32'], ['itemCount', 'u32'], ['firstLine', 'u32'], ['lineCount', 'u32'],
		['anchorBlock', 'u32'], ['anchorLine', 'u32'], ['refIndex', 'i32']],
	glyph: [['x', 'f32'], ['y', 'f32'], ['glyphId', 'u32'], ['size', 'f16'], ['colour', 'u8'], ['flags', 'u8'], ['charOffset', 'u32'], ['group', 'u16'], ['pad', 'u16']],
	// radius: corner radius in em (0 = square), drawn as a rounded box (code panels, pull quote fields)
	rect: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['colour', 'u8'], ['kind', 'u8'], ['group', 'u16'], ['radius', 'f16']],
	image: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['imageId', 'u16'], ['radius', 'u8'], ['pad', 'u8'], ['altOffset', 'u32']],
	// analytic primitive; bounds in em. dot: aux = stroke index it travels along, flags = count (<= 32), param = stagger, chan = u in [0,1].
	shape: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['kind', 'u8'], ['colour', 'u8'], ['colour2', 'u8'], ['flags', 'u8'],
		['radius', 'f16'], ['param', 'f16'], ['group', 'u16'], ['chan', 'i16'], ['mixChan', 'i16'], ['pad', 'i16'], ['aux', 'u32']],
	// filled contours: a glyph of the article's extra table drawn with a colour, a transform and an optional group
	path: [['x', 'f32'], ['y', 'f32'], ['scale', 'f32'], ['glyphIdx', 'u32'], ['colour', 'u8'], ['flags', 'u8'], ['group', 'u16']],
	stroke: [['firstSeg', 'u32'], ['segCount', 'u32'], ['width', 'f32'], ['flags', 'u8'], ['colour', 'u8'], ['group', 'u16'],
		['dashOn', 'f16'], ['dashOff', 'f16'], ['phaseChan', 'i16'], ['trimT0Chan', 'i16'], ['trimT1Chan', 'i16'], ['widthChan', 'i16'],
		['colour2', 'u8'], ['pad', 'u8'], ['mixChan', 'i16']],
	// quadratic segment: p0 p1 p2 (em), arc length at segment start (cum) and its own length
	seg: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['x2', 'f32'], ['y2', 'f32'], ['cum', 'f32'], ['len', 'f32']],
	// each *Chan is a channel index or NO_CHAN; then the constant value of the same name is used
	group: [['parent', 'i32'], ['txChan', 'i16'], ['tyChan', 'i16'], ['rotChan', 'i16'], ['scaleChan', 'i16'], ['opacityChan', 'i16'], ['pad', 'i16'],
		['tx', 'f32'], ['ty', 'f32'], ['rot', 'f32'], ['scale', 'f32'], ['opacity', 'f32'], ['pivotX', 'f32'], ['pivotY', 'f32']],
	// odometer: `digits` cells of cellW em, value read from `chan`, digit glyph ids from digitSets[digitSet]
	numeral: [['x', 'f32'], ['y', 'f32'], ['cellW', 'f32'], ['size', 'f16'], ['colour', 'u8'], ['style', 'u8'], ['digits', 'u8'], ['digitSet', 'u8'],
		['chan', 'i16'], ['group', 'u16'], ['pad', 'u16']],
	// one typeset line = one span of the DOM text layer: text bytes [textOff, textOff + textLen) of the text section (soft break whitespace
	// and the hyphen glyph excluded). x0..x1 is the ink extent, yTop..yBot the line box. size is in em of the article, font a LineFont.
	line: [['yTop', 'f32'], ['yBot', 'f32'], ['x0', 'f32'], ['x1', 'f32'], ['firstGlyph', 'u32'], ['glyphCount', 'u32'], ['textOff', 'u32'], ['textLen', 'u32'],
		['block', 'u32'], ['size', 'f16'], ['font', 'u8'], ['flags', 'u8']],
	// a link inside line `line`: rect in document em, target string at `offset`, text bytes [t0, t1) of the text section
	link: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['kind', 'u32'], ['offset', 'u32'], ['line', 'u32'], ['t0', 'u32'], ['t1', 'u32']],
	anchor: [['idOffset', 'u32'], ['block', 'u32'], ['y', 'f32']],
	chan: [['firstKey', 'u32'], ['keyCount', 'u32']],
	key: [['t', 'f32'], ['v', 'f32'], ['ease', 'u32']],
	// bounds x0..y1 in document em (the placed figure box); the cell grid (CELL_W x CELL_H em cells, origin x0,y0) lists the figure's items per cell
	figure: [['id', 'u32'], ['firstChan', 'u32'], ['chanCount', 'u32'], ['mode', 'u32'], ['duration', 'f32'], ['poster', 'f32'],
		['alt', 'u32'], ['describe', 'u32'], ['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['block', 'u32'],
		['firstCell', 'u32'], ['gridCols', 'u16'], ['gridRows', 'u16'], ['scale', 'f32']],
	cell: [['start', 'u32'], ['count', 'u16'], ['pad', 'u16']]
} as const satisfies Record<string, Fields>;

type SchemaKey = keyof typeof SCHEMA;
type Rec<K extends SchemaKey> = { -readonly [F in (typeof SCHEMA)[K][number] as F[0] extends `pad${string}` ? never : F[0]]: number } &
	{ -readonly [F in (typeof SCHEMA)[K][number] as F[0] extends `pad${string}` ? F[0] : never]?: number };

const layoutCache = new Map<string, { offs: number[]; size: number }>();
function layout(name: SchemaKey) {
	let l = layoutCache.get(name);
	if (!l) {
		let o = 0;
		const offs = (SCHEMA[name] as Fields).map(([, t]) => {
			o = (o + SZ[t] - 1) & ~(SZ[t] - 1);
			const at = o;
			o += SZ[t];
			return at;
		});
		l = { offs, size: (o + 3) & ~3 };
		layoutCache.set(name, l);
	}
	return l;
}

/** Record sizes in bytes, computed from SCHEMA. */
export const REC2 = Object.fromEntries((Object.keys(SCHEMA) as SchemaKey[]).map((k) => [k, layout(k).size])) as { [K in SchemaKey]: number };
/** Byte offset of a field inside its record. */
export const fieldOffset = (name: SchemaKey, field: string): number => {
	const j = (SCHEMA[name] as Fields).findIndex(([k]) => k === field);
	if (j < 0) throw new Error(`rdr2: no field ${name}.${field}`);
	return layout(name).offs[j];
};

function packTable<K extends SchemaKey>(name: K, rows: Partial<Rec<K>>[]): Uint8Array {
	const { offs, size } = layout(name);
	const fields = SCHEMA[name] as Fields;
	const out = new Uint8Array(rows.length * size);
	const dv = new DataView(out.buffer);
	rows.forEach((r, i) => {
		fields.forEach(([k, t], j) => {
			const o = i * size + offs[j];
			const v = (r as Record<string, number>)[k] ?? 0;
			switch (t) {
				case 'f32': dv.setFloat32(o, v, true); break;
				case 'u32': dv.setUint32(o, v >>> 0, true); break;
				case 'i32': dv.setInt32(o, v, true); break;
				case 'u16': dv.setUint16(o, v, true); break;
				case 'i16': dv.setInt16(o, v, true); break;
				case 'u8': dv.setUint8(o, v); break;
				case 'f16': dv.setUint16(o, toF16(v), true); break;
			}
		});
	});
	return out;
}

function unpackTable<K extends SchemaKey>(name: K, bytes: Uint8Array, count: number): Rec<K>[] {
	const { offs, size } = layout(name);
	const fields = SCHEMA[name] as Fields;
	const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	return Array.from({ length: count }, (_, i) => {
		const r: Record<string, number> = {};
		fields.forEach(([k, t], j) => {
			const o = i * size + offs[j];
			r[k] = t === 'f32' ? dv.getFloat32(o, true) : t === 'u32' ? dv.getUint32(o, true) : t === 'i32' ? dv.getInt32(o, true)
				: t === 'u16' ? dv.getUint16(o, true) : t === 'i16' ? dv.getInt16(o, true) : t === 'u8' ? dv.getUint8(o) : fromF16(dv.getUint16(o, true));
		});
		return r as Rec<K>;
	});
}

// ---- model -------------------------------------------------------------------------------------

export type BlockRec = Rec<'block'>;
export type NoteRec = Rec<'note'>;
export type GlyphInst = Rec<'glyph'>;
export type RectInst = Rec<'rect'>;
export type ImageInst = Rec<'image'>;
export type ShapeInst = Rec<'shape'>;
export type PathInst = Rec<'path'>;
export type StrokeRec = Rec<'stroke'>;
export type SegRec = Rec<'seg'>;
export type GroupRec = Rec<'group'>;
export type NumeralInst = Rec<'numeral'>;
export type LineRec = Rec<'line'>;
export type LinkRec = Rec<'link'>;
export type AnchorRec = Rec<'anchor'>;
export type ChanRec = Rec<'chan'>;
export type KeyRec = Rec<'key'>;
export type FigureRec = Rec<'figure'>;
export type CellRec = Rec<'cell'>;

/** Rows may omit pad fields (they pack as 0); other fields are required by the type. */
export interface ReadingModel {
	/** WIDTH_CLASSES id */
	widthClass: number;
	/** reading column width, em (34, or 21 on the narrow class) */
	colW: number;
	/** document x extent [docX0, docX1] em the layout uses (notes and wide figures reach outside the column) */
	docX0: number; docX1: number;
	/** total height of the fully expanded page, em */
	docH: number;
	/** the fold: y where the folded region starts (after the control row), full height of the folded region, height of the visible peek; foldH = 0 when the article has no fold */
	foldY: number; foldH: number; peekH: number;
	plainTextBytes: number;
	blocks: BlockRec[];
	notes: NoteRec[];
	/** per figure, gridCols * gridRows entries, row-major, concatenated in figure order */
	cells: CellRec[];
	/** item words, see packItem: block item lists first, then figure cell lists */
	items: number[];
	glyphs: GlyphInst[];
	rects: RectInst[];
	images: ImageInst[];
	shapes: ShapeInst[];
	paths: PathInst[];
	strokes: StrokeRec[];
	segs: SegRec[];
	groups: GroupRec[];
	numerals: NumeralInst[];
	/** 10 glyph ids (digits 0..9) per set */
	digitSets: number[][];
	chans: ChanRec[];
	keys: KeyRec[];
	figures: FigureRec[];
	lines: LineRec[];
	links: LinkRec[];
	anchors: AnchorRec[];
	extra: GlyphTable; // path and math outlines, glyph-table layout of RDR1
	text: Uint8Array;
	strings: Uint8Array;
	/** PALETTE2_SIZE entries, RGBA8 as 0xAABBGGRR (the world has one look: dark) */
	palette: Uint32Array;
}

const PARAMS = ['widthClass', 'colW', 'docX0', 'docX1', 'docH', 'foldY', 'foldH', 'peekH', 'plainTextBytes', 'blockCount', 'noteCount', 'figureCount'] as const;
const PARAMS_F = new Set<string>(['colW', 'docX0', 'docX1', 'docH', 'foldY', 'foldH', 'peekH']);

/** Header params (magic 'RDR3' is in the container) in the order stored. */
export const RDR3_PARAMS = PARAMS;

export function packReading(m: ReadingModel): Uint8Array {
	const fa = new Float32Array(1);
	const ua = new Uint32Array(fa.buffer);
	const params = PARAMS.map((k) => {
		const v = k === 'blockCount' ? m.blocks.length : k === 'noteCount' ? m.notes.length : k === 'figureCount' ? m.figures.length : (m as unknown as Record<string, number>)[k];
		return PARAMS_F.has(k) ? ((fa[0] = v), ua[0]) : v;
	});
	for (const c of m.cells) if (c.count > 0xffff) throw new Error('rdr3: grid cell item count overflow');
	if (m.palette.length !== PALETTE2_SIZE) throw new Error('rdr3: palette must have PALETTE2_SIZE entries');
	const digits = new Uint32Array(m.digitSets.length * 10);
	m.digitSets.forEach((s, i) => {
		if (s.length !== 10) throw new Error('rdr3: digit set needs 10 glyph ids');
		digits.set(s, i * 10);
	});
	const t = <K extends SchemaKey>(id: number, name: K, rows: Partial<Rec<K>>[]) => ({ id, data: packTable(name, rows), count: rows.length });
	const items = new Uint32Array(m.items);
	return packContainer(ARTICLE2_MAGIC, params, [
		t(Sec2.blocks, 'block', m.blocks),
		t(Sec2.notes, 'note', m.notes),
		t(Sec2.gridCells, 'cell', m.cells),
		{ id: Sec2.items, data: items, count: items.length },
		t(Sec2.glyphs, 'glyph', m.glyphs),
		t(Sec2.rects, 'rect', m.rects),
		t(Sec2.images, 'image', m.images),
		t(Sec2.shapes, 'shape', m.shapes),
		t(Sec2.paths, 'path', m.paths),
		t(Sec2.strokes, 'stroke', m.strokes),
		t(Sec2.segs, 'seg', m.segs),
		t(Sec2.groups, 'group', m.groups),
		t(Sec2.numerals, 'numeral', m.numerals),
		t(Sec2.chans, 'chan', m.chans),
		t(Sec2.keys, 'key', m.keys),
		t(Sec2.figures, 'figure', m.figures),
		{ id: Sec2.digitSets, data: digits, count: m.digitSets.length },
		t(Sec2.lines, 'line', m.lines),
		t(Sec2.links, 'link', m.links),
		t(Sec2.anchors, 'anchor', m.anchors),
		{ id: Sec2.exDir, data: m.extra.dir, count: m.extra.dir.length >> 3 },
		{ id: Sec2.exCurves, data: m.extra.curves, count: m.extra.curves.length >> 2 },
		{ id: Sec2.exBands, data: m.extra.bands, count: m.extra.bands.length },
		{ id: Sec2.text, data: m.text, count: m.text.length },
		{ id: Sec2.strings, data: m.strings, count: m.strings.length },
		{ id: Sec2.palette, data: m.palette, count: m.palette.length }
	]);
}

export function unpackReading(bytes: Uint8Array): ReadingModel {
	const c = unpackContainer(bytes);
	if (c.magic !== ARTICLE2_MAGIC) throw new Error('not an RDR3 bin');
	const p: Record<string, number> = {};
	PARAMS.forEach((k, i) => (p[k] = PARAMS_F.has(k) ? c.paramsF[i] : c.params[i]));
	const sec = (id: number) => {
		const s = c.sections.get(id);
		if (!s) throw new Error(`rdr3: missing section ${id}`);
		return s;
	};
	const tbl = <K extends SchemaKey>(id: number, name: K) => unpackTable(name, sec(id).bytes, sec(id).count);
	const u32v = (id: number) => {
		const b = sec(id).bytes;
		return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
	};
	const u16v = (id: number) => {
		const b = sec(id).bytes;
		return new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
	};
	const digits = u32v(Sec2.digitSets);
	return {
		widthClass: p.widthClass, colW: p.colW, docX0: p.docX0, docX1: p.docX1, docH: p.docH, foldY: p.foldY, foldH: p.foldH, peekH: p.peekH,
		plainTextBytes: p.plainTextBytes,
		blocks: tbl(Sec2.blocks, 'block'), notes: tbl(Sec2.notes, 'note'), cells: tbl(Sec2.gridCells, 'cell'), items: Array.from(u32v(Sec2.items)),
		glyphs: tbl(Sec2.glyphs, 'glyph'), rects: tbl(Sec2.rects, 'rect'), images: tbl(Sec2.images, 'image'),
		shapes: tbl(Sec2.shapes, 'shape'), paths: tbl(Sec2.paths, 'path'), strokes: tbl(Sec2.strokes, 'stroke'), segs: tbl(Sec2.segs, 'seg'),
		groups: tbl(Sec2.groups, 'group'), numerals: tbl(Sec2.numerals, 'numeral'),
		digitSets: Array.from({ length: sec(Sec2.digitSets).count }, (_, i) => Array.from(digits.subarray(i * 10, i * 10 + 10))),
		chans: tbl(Sec2.chans, 'chan'), keys: tbl(Sec2.keys, 'key'), figures: tbl(Sec2.figures, 'figure'),
		lines: tbl(Sec2.lines, 'line'), links: tbl(Sec2.links, 'link'), anchors: tbl(Sec2.anchors, 'anchor'),
		extra: { dir: u32v(Sec2.exDir), curves: u16v(Sec2.exCurves), bands: u32v(Sec2.exBands) },
		text: sec(Sec2.text).bytes.slice(), strings: sec(Sec2.strings).bytes.slice(), palette: u32v(Sec2.palette).slice()
	};
}

/** NUL-terminated string at `off` of the strings section (0 is the empty string). */
export function stringAt(strings: Uint8Array, off: number): string {
	if (!off) return '';
	let e = off;
	while (e < strings.length && strings[e] !== 0) e++;
	return new TextDecoder().decode(strings.subarray(off, e));
}

// ---- sample buffer -------------------------------------------------------------------------------

/**
 * A small valid model: one hero block with a glyph line, one figure block with a shape, a stroke, a group, a numeral,
 * and one note. For tests and for lanes that need bytes before the build exists.
 */
export function sampleReading(): ReadingModel {
	return {
		widthClass: 0, colW: 34, docX0: -3, docX1: 54, docH: 40, foldY: 30, foldH: 10, peekH: 4, plainTextBytes: 5,
		blocks: [
			{ x0: 0, y0: 4, x1: 34, y1: 9, firstItem: 0, itemCount: 1, firstLine: 0, lineCount: 1, anchor: 0, fig: -1, kind: BlockKind.hero, level: 1, flags: 0, section: 0, textOff: 0, textLen: 5 },
			{ x0: -3, y0: 12, x1: 49, y1: 38, firstItem: 1, itemCount: 0, firstLine: 1, lineCount: 0, anchor: 2, fig: 0, kind: BlockKind.figure, level: 0, flags: BlockFlag.wide, section: 0, textOff: 0, textLen: 0 }
		],
		notes: [{ x0: 37, y0: 12, x1: 54, y1: 15, firstItem: 1, itemCount: 0, firstLine: 1, lineCount: 0, anchorBlock: 0, anchorLine: 0, refIndex: 0 }],
		cells: [{ start: 1, count: 4 }],
		items: [packItem(ItemType.glyph, 0), packItem(ItemType.shape, 0), packItem(ItemType.stroke, 0), packItem(ItemType.group, 0), packItem(ItemType.numeral, 0)],
		glyphs: [{ x: 0, y: 8, glyphId: 0x80000001, size: 4.2, colour: 3, flags: 16, charOffset: 0, group: NONE16 }],
		rects: [], images: [],
		shapes: [{ x0: 8, y0: 14, x1: 18, y1: 18, kind: ShapeKind.rrect, colour: 8, colour2: 13, flags: 0, radius: 0.4, param: 0, group: 0, chan: 1, mixChan: NO_CHAN, aux: 0 }],
		paths: [],
		strokes: [{ firstSeg: 0, segCount: 1, width: 0.18, flags: 0, colour: 8, group: 0, dashOn: 0.6, dashOff: 0.4, phaseChan: 0, trimT0Chan: NO_CHAN, trimT1Chan: 2, widthChan: NO_CHAN, colour2: 0, mixChan: NO_CHAN }],
		segs: [{ x0: 18, y0: 13, x1: 18, y1: 18, x2: 18, y2: 24, cum: 0, len: 11 }],
		groups: [{ parent: -1, txChan: NO_CHAN, tyChan: NO_CHAN, rotChan: NO_CHAN, scaleChan: 3, opacityChan: NO_CHAN, tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: 9, pivotY: 5 }],
		numerals: [{ x: 30, y: 30, cellW: 6.5, size: 14, colour: 13, style: 1, digits: 3, digitSet: 0, chan: 4, group: NONE16 }],
		digitSets: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
		chans: [{ firstKey: 0, keyCount: 2 }],
		keys: [{ t: 0, v: 0, ease: 0 }, { t: 14, v: 72, ease: 5 }],
		figures: [{ id: 0, firstChan: 0, chanCount: 1, mode: 0, duration: 14, poster: 11, alt: 6, describe: 12, x0: -3, y0: 12, x1: 49, y1: 38, block: 1, firstCell: 0, gridCols: 1, gridRows: 1, scale: 1.44 }],
		lines: [{ yTop: 4, yBot: 9, x0: 0, x1: 20, firstGlyph: 0, glyphCount: 1, textOff: 0, textLen: 5, block: 0, size: 4.2, font: LineFont.display, flags: 0 }],
		links: [{ x0: 0, y0: 4, x1: 5, y1: 9, kind: 1, offset: 3, line: 0, t0: 0, t1: 5 }],
		anchors: [{ idOffset: 0, block: 1, y: 12 }],
		extra: { dir: new Uint32Array(8), curves: new Uint16Array(8), bands: new Uint32Array(2) },
		text: new TextEncoder().encode('Hello'), strings: new TextEncoder().encode('a\0b\0'),
		palette: Uint32Array.from({ length: PALETTE2_SIZE }, (_, i) => 0xff000000 | i)
	};
}
