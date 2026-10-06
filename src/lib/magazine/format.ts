// RDR2: binary format for magazine spreads (docs/MAGAZINE.md section 1.6).
// Shared by the build (scripts/magazine) and the runtime. No node imports here.
//
// Container, f16 helpers, glyph tables and fonts.bin are reused unchanged from the RDR1 module
// (src/lib/reader/format.ts): same little-endian container, every section 4-byte aligned, magic
// 'RDR2' tells the two apart. Every record table below is described once in SCHEMA (field order,
// natural alignment, total padded to 4 bytes); pack and unpack are generated from it, so the byte
// layout is exactly what SCHEMA lists and REC2 gives the sizes.

import {
	packContainer, unpackContainer, toF16, fromF16, roundF16, cstr, PALETTE_SIZE,
	type Container, type GlyphTable
} from '../reader/format';

export { toF16, fromF16, roundF16, cstr, packContainer, unpackContainer, PALETTE_SIZE };
export type { GlyphTable, Container };

export const ARTICLE2_MAGIC = 0x32524452; // 'RDR2'
export const SPREAD_W = 80; // em, two facing sheets
export const SPREAD_H = 56;
export const LINE_H = 1.6;
export const CELL_W = 6;
export const CELL_H = 1.6;
export const MAX_CELL_ITEMS = 24; // compile error above this for animated cells (section 2.2)
export const NONE16 = 0xffff; // "no group / no frame" for u16 fields
export const NO_CHAN = -1; // "constant" for i16 channel fields
export const CHAN_UNIFORM_FLOATS = 256; // per-frame channel uniform, array<f32, 256>

/** Item word: [type:4 | index:28]. */
export const ItemType = { glyph: 0, rect: 1, image: 2, shape: 3, path: 4, stroke: 5, group: 6, numeral: 7 } as const;
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

/** Palette: 32 entries x (light, dark). 0..7 as RDR1, 8.. per article (MAGAZINE.md 3.2). */
export const PALETTE2_SIZE = 32;
export const PAL2 = {
	ink: 0, link: 1, muted: 2, heading: 3, rule: 4, selection: 5, codeBg: 6, quoteBar: 7,
	accent: 8, accent2: 9, accentTint: 10, accentInk: 11, neutral1: 12, neutral2: 13, neutral3: 14,
	panel: 15, field: 16, paper: 17
} as const;
export type PaletteName = keyof typeof PAL2;

export const Sec2 = {
	spreads: 1, gridCells: 2, items: 3, glyphs: 4, rects: 5, images: 6, lines: 7, links: 8, anchors: 9,
	exDir: 10, exCurves: 11, exBands: 12, text: 13, strings: 14, palette: 15,
	shapes: 30, paths: 31, strokes: 32, segs: 33, groups: 34, chans: 35, keys: 36, figures: 37, digitSets: 38, numerals: 39
} as const;

// ---- schema-driven record codec ----------------------------------------------------------------

type FT = 'f32' | 'u32' | 'i32' | 'u16' | 'i16' | 'u8' | 'f16';
type Fields = readonly (readonly [string, FT])[];
const SZ: Record<FT, number> = { f32: 4, u32: 4, i32: 4, u16: 2, i16: 2, u8: 1, f16: 2 };

export const SCHEMA = {
	spread: [['x', 'f32'], ['w', 'f32'], ['h', 'f32'], ['template', 'u16'], ['gridCols', 'u8'], ['gridRows', 'u8'],
		['firstItem', 'u32'], ['itemCount', 'u32'], ['firstCell', 'u32'], ['tone565', 'u16'], ['materialMask', 'u8'], ['accentIdx', 'u8'],
		['firstLine', 'u32'], ['lineCount', 'u32']],
	glyph: [['x', 'f32'], ['y', 'f32'], ['glyphId', 'u32'], ['size', 'f16'], ['colour', 'u8'], ['flags', 'u8'], ['charOffset', 'u32'], ['group', 'u16'], ['frame', 'u16']],
	rect: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['colour', 'u8'], ['kind', 'u8'], ['group', 'u16']],
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
	line: [['yTop', 'f32'], ['yBot', 'f32'], ['x0', 'f32'], ['x1', 'f32'], ['firstGlyph', 'u32'], ['glyphCount', 'u32'], ['charOffset', 'u32'], ['frame', 'u32']],
	link: [['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['kind', 'u32'], ['offset', 'u32'], ['spread', 'u32']],
	anchor: [['idOffset', 'u32'], ['spread', 'u32'], ['y', 'f32']],
	chan: [['firstKey', 'u32'], ['keyCount', 'u32']],
	key: [['t', 'f32'], ['v', 'f32'], ['ease', 'u32']],
	figure: [['id', 'u32'], ['firstChan', 'u32'], ['chanCount', 'u32'], ['mode', 'u32'], ['duration', 'f32'], ['poster', 'f32'],
		['alt', 'u32'], ['describe', 'u32'], ['x0', 'f32'], ['y0', 'f32'], ['x1', 'f32'], ['y1', 'f32'], ['spread', 'u32'], ['pad0', 'u32'], ['pad1', 'u32'], ['pad2', 'u32']],
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

export type SpreadRec = Rec<'spread'>;
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
export interface MagazineModel {
	widthClass: number; // 0 wide (80 x 56 spread), 1 narrow (28 x 56 single sheet)
	emPx0: number;
	spreadW: number; spreadH: number; sheetW: number;
	marginOuter: number; marginSpine: number; gutter: number; // em
	cellW: number; cellH: number;
	plainTextBytes: number;
	spreads: SpreadRec[];
	/** per spread, gridCols * gridRows entries, row-major, concatenated in spread order */
	cells: CellRec[];
	/** item words, see packItem */
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
	/** 2 * PALETTE2_SIZE, RGBA8 as 0xAABBGGRR; light entries then dark entries */
	palette: Uint32Array;
}

const PARAMS = ['widthClass', 'emPx0', 'spreadW', 'spreadH', 'sheetW', 'marginOuter', 'marginSpine', 'gutter', 'cellW', 'cellH', 'plainTextBytes', 'spreadCount', 'figureCount'] as const;
const PARAMS_F = new Set<string>(['emPx0', 'spreadW', 'spreadH', 'sheetW', 'marginOuter', 'marginSpine', 'gutter', 'cellW', 'cellH']);

/** Header params (magic 'RDR2' is in the container) in the order stored. */
export const RDR2_PARAMS = PARAMS;

export function packMagazine(m: MagazineModel): Uint8Array {
	const fa = new Float32Array(1);
	const ua = new Uint32Array(fa.buffer);
	const params = PARAMS.map((k) => {
		const v = k === 'spreadCount' ? m.spreads.length : k === 'figureCount' ? m.figures.length : (m as unknown as Record<string, number>)[k];
		return PARAMS_F.has(k) ? ((fa[0] = v), ua[0]) : v;
	});
	for (const c of m.cells) if (c.count > 0xffff) throw new Error('rdr2: grid cell item count overflow');
	if (m.palette.length !== 2 * PALETTE2_SIZE) throw new Error('rdr2: palette must have 2 * PALETTE2_SIZE entries');
	const digits = new Uint32Array(m.digitSets.length * 10);
	m.digitSets.forEach((s, i) => {
		if (s.length !== 10) throw new Error('rdr2: digit set needs 10 glyph ids');
		digits.set(s, i * 10);
	});
	const t = <K extends SchemaKey>(id: number, name: K, rows: Partial<Rec<K>>[]) => ({ id, data: packTable(name, rows), count: rows.length });
	const items = new Uint32Array(m.items);
	return packContainer(ARTICLE2_MAGIC, params, [
		t(Sec2.spreads, 'spread', m.spreads),
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

export function unpackMagazine(bytes: Uint8Array): MagazineModel {
	const c = unpackContainer(bytes);
	if (c.magic !== ARTICLE2_MAGIC) throw new Error('not an RDR2 bin');
	const p: Record<string, number> = {};
	PARAMS.forEach((k, i) => (p[k] = PARAMS_F.has(k) ? c.paramsF[i] : c.params[i]));
	const sec = (id: number) => {
		const s = c.sections.get(id);
		if (!s) throw new Error(`rdr2: missing section ${id}`);
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
		widthClass: p.widthClass, emPx0: p.emPx0, spreadW: p.spreadW, spreadH: p.spreadH, sheetW: p.sheetW,
		marginOuter: p.marginOuter, marginSpine: p.marginSpine, gutter: p.gutter, cellW: p.cellW, cellH: p.cellH,
		plainTextBytes: p.plainTextBytes,
		spreads: tbl(Sec2.spreads, 'spread'), cells: tbl(Sec2.gridCells, 'cell'), items: Array.from(u32v(Sec2.items)),
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
