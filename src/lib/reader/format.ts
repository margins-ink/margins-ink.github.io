// Binary formats for the in-world reader (docs/READER.md sections 2.3, 6 stage 1-2).
// Shared by the build (scripts/reader) and the runtime. No node imports here.
//
// Container (all little-endian, every section 4-byte aligned):
//   u32 magic, u32 version, u32 nParams, u32 nSections
//   u32 params[nParams]            (floats are stored as their f32 bit pattern)
//   { u32 id, u32 byteOffset, u32 byteLength, u32 count } * nSections
//   section bytes
//
// Glyph tables (fonts.bin "union" table and each article's "extra" table) are Slug-style:
//   dir     u32 x 8 per glyph: curveStart, bandStart, nH | nV << 16, numCurves, bbox x0 y0 x1 y1 (f32, em)
//   curves  u16 x 4 per texel (f16): a curve starting at texel t is (x1,y1,x2,y2) at t and (x3,y3) in
//           the first two channels of texel t+1. Connected curves share the texel; a contour of n
//           curves uses n+1 texels, the last one marked with f16 NaN in z/w (CONTOUR_END). A straight line is the quad {p1, p2, p2}.
//   bands   u32 per texel. Per glyph at bandStart: nH + nV header texels (count | offset << 16, offset
//           relative to bandStart), then curve lists whose entries are absolute curve texel indices.
//           Horizontal bands first. Curves in horizontal bands are sorted by descending max x, in
//           vertical bands by descending max y. Bands overlap by BAND_EPS em.

export const FONTS_MAGIC = 0x31464452; // 'RDF1'
export const ARTICLE_MAGIC = 0x31524452; // 'RDR1'
export const FORMAT_VERSION = 1;
export const BAND_EPS = 1 / 1024;
/** f16 NaN stored in the z/w channels of a contour's last texel (it only holds p3.xy); lets tools find contour ends. The shader never reads those channels. */
export const CONTOUR_END = 0x7e00;

export const PALETTE_SIZE = 24;
/** Reserved palette entries. 8..23 are syntax colours. */
export const Pal = { ink: 0, link: 1, muted: 2, heading: 3, rule: 4, selection: 5, codeBg: 6, quoteBar: 7 } as const;

export const ItemType = { glyph: 0, rect: 1, image: 2, eqn: 3 } as const;
export const RectKind = { rule: 0, codeBg: 1, quoteBar: 2, tableLine: 3, noteBox: 4, inlineCodeBg: 5, mathRule: 6 } as const;
export const LinkKind = { url: 0, anchor: 1, ref: 2, article: 3 } as const;
export const GlyphFlag = { code: 1, math: 2, link: 4, super: 8 } as const;
/** glyphId bit 31 set: index into the article's extra (math) glyph table instead of fonts.bin. */
export const EXTRA_BIT = 0x80000000;

export const Sec = {
	pages: 1, gridCells: 2, items: 3, glyphs: 4, rects: 5, images: 6, lines: 7, links: 8, anchors: 9,
	exDir: 10, exCurves: 11, exBands: 12, text: 13, strings: 14, palette: 15,
	fonts: 20, dir: 21, curves: 22, bands: 23, fontTable: 24
} as const;

export const REC = { page: 36, cell: 8, glyph: 20, rect: 20, image: 24, line: 28, link: 28, anchor: 12 } as const;

// ---- f16 -------------------------------------------------------------------------------------

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

export function toF16(v: number): number {
	f32[0] = v;
	const x = u32[0];
	const sign = (x >>> 16) & 0x8000;
	let exp = ((x >>> 23) & 0xff) - 127 + 15;
	let man = x & 0x7fffff;
	if (exp >= 31) return sign | 0x7c00;
	if (exp <= 0) {
		if (exp < -10) return sign;
		man |= 0x800000;
		const shift = 14 - exp;
		let h = man >>> shift;
		const rem = man & ((1 << shift) - 1);
		const half = 1 << (shift - 1);
		if (rem > half || (rem === half && (h & 1))) h++;
		return sign | h;
	}
	let h = (exp << 10) | (man >>> 13);
	const rem = man & 0x1fff;
	if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;
	return sign | h;
}

export function fromF16(h: number): number {
	const s = h & 0x8000 ? -1 : 1;
	const e = (h >>> 10) & 0x1f;
	const m = h & 0x3ff;
	if (e === 0) return s * m * 2 ** -24;
	if (e === 31) return m ? NaN : s * Infinity;
	return s * (1 + m / 1024) * 2 ** (e - 15);
}

/** Round to the nearest f16-representable value. */
export const roundF16 = (v: number) => fromF16(toF16(v));

// ---- container -------------------------------------------------------------------------------

export interface SectionIn {
	id: number;
	data: ArrayBufferView;
	count: number;
}

export function packContainer(magic: number, params: number[], sections: SectionIn[]): Uint8Array {
	const head = 16 + params.length * 4 + sections.length * 16;
	let off = head;
	const offs = sections.map((s) => {
		const o = off;
		off += (s.data.byteLength + 3) & ~3;
		return o;
	});
	const out = new Uint8Array(off);
	const dv = new DataView(out.buffer);
	dv.setUint32(0, magic, true);
	dv.setUint32(4, FORMAT_VERSION, true);
	dv.setUint32(8, params.length, true);
	dv.setUint32(12, sections.length, true);
	params.forEach((p, i) => dv.setUint32(16 + i * 4, p >>> 0, true));
	sections.forEach((s, i) => {
		const b = 16 + params.length * 4 + i * 16;
		dv.setUint32(b, s.id, true);
		dv.setUint32(b + 4, offs[i], true);
		dv.setUint32(b + 8, s.data.byteLength, true);
		dv.setUint32(b + 12, s.count, true);
		out.set(new Uint8Array(s.data.buffer, s.data.byteOffset, s.data.byteLength), offs[i]);
	});
	return out;
}

export interface Container {
	magic: number;
	params: Uint32Array;
	/** f32 reinterpretation of params */
	paramsF: Float32Array;
	sections: Map<number, { bytes: Uint8Array; count: number }>;
	buf: ArrayBuffer;
}

export function unpackContainer(input: Uint8Array): Container {
	// Copy so every section view is 4-aligned regardless of the caller's byteOffset.
	const buf = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
	const dv = new DataView(buf);
	const magic = dv.getUint32(0, true);
	if (dv.getUint32(4, true) !== FORMAT_VERSION) throw new Error('reader format: bad version');
	const nParams = dv.getUint32(8, true);
	const nSec = dv.getUint32(12, true);
	const params = new Uint32Array(buf, 16, nParams);
	const paramsF = new Float32Array(buf, 16, nParams);
	const sections = new Map<number, { bytes: Uint8Array; count: number }>();
	for (let i = 0; i < nSec; i++) {
		const b = 16 + nParams * 4 + i * 16;
		const id = dv.getUint32(b, true);
		const o = dv.getUint32(b + 4, true);
		const l = dv.getUint32(b + 8, true);
		sections.set(id, { bytes: new Uint8Array(buf, o, l), count: dv.getUint32(b + 12, true) });
	}
	return { magic, params, paramsF, sections, buf };
}

const sec = (c: Container, id: number) => {
	const s = c.sections.get(id);
	if (!s) throw new Error(`reader format: missing section ${id}`);
	return s;
};
const u32v = (c: Container, id: number) => {
	const b = sec(c, id).bytes;
	return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
};
const u16v = (c: Container, id: number) => {
	const b = sec(c, id).bytes;
	return new Uint16Array(b.buffer, b.byteOffset, b.byteLength >> 1);
};
const f32v = (c: Container, id: number) => {
	const b = sec(c, id).bytes;
	return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
};

// ---- glyph table -----------------------------------------------------------------------------

export interface GlyphTable {
	dir: Uint32Array;
	curves: Uint16Array;
	bands: Uint32Array;
}

export interface GlyphRec {
	curveStart: number;
	bandStart: number;
	nH: number;
	nV: number;
	numCurves: number;
	x0: number;
	y0: number;
	x1: number;
	y1: number;
}

export function glyphRec(t: GlyphTable, i: number): GlyphRec {
	const o = i * 8;
	const f = new Float32Array(1);
	const u = new Uint32Array(f.buffer);
	const fl = (k: number) => ((u[0] = t.dir[o + k]), f[0]);
	return {
		curveStart: t.dir[o], bandStart: t.dir[o + 1], nH: t.dir[o + 2] & 0xffff, nV: t.dir[o + 2] >>> 16,
		numCurves: t.dir[o + 3], x0: fl(4), y0: fl(5), x1: fl(6), y1: fl(7)
	};
}

export const glyphCount = (t: GlyphTable) => t.dir.length >> 3;

// ---- fonts.bin -------------------------------------------------------------------------------

export interface FontInfo {
	name: string;
	upem: number;
	ascender: number;
	descender: number;
	capHeight: number;
	xHeight: number;
}

export function packFontsBin(t: GlyphTable, fonts: FontInfo[], glyphFont: Uint32Array, glyphSrcId: Uint32Array): Uint8Array {
	const meta = new TextEncoder().encode(JSON.stringify(fonts));
	// per glyph: fontIndex, source glyph id (debug / runtime lookup), 2 x u32
	const gmap = new Uint32Array(glyphFont.length * 2);
	glyphFont.forEach((f, i) => ((gmap[i * 2] = f), (gmap[i * 2 + 1] = glyphSrcId[i])));
	return packContainer(FONTS_MAGIC, [glyphFont.length], [
		{ id: Sec.fontTable, data: meta, count: fonts.length },
		{ id: Sec.fonts, data: gmap, count: glyphFont.length },
		{ id: Sec.dir, data: t.dir, count: t.dir.length >> 3 },
		{ id: Sec.curves, data: t.curves, count: t.curves.length >> 2 },
		{ id: Sec.bands, data: t.bands, count: t.bands.length }
	]);
}

export function readFontsBin(bytes: Uint8Array) {
	const c = unpackContainer(bytes);
	if (c.magic !== FONTS_MAGIC) throw new Error('not fonts.bin');
	const table: GlyphTable = { dir: u32v(c, Sec.dir), curves: u16v(c, Sec.curves), bands: u32v(c, Sec.bands) };
	const fonts: FontInfo[] = JSON.parse(new TextDecoder().decode(sec(c, Sec.fontTable).bytes));
	const gmap = u32v(c, Sec.fonts);
	return { table, fonts, glyphFont: (i: number) => gmap[i * 2], glyphSrc: (i: number) => gmap[i * 2 + 1] };
}

// ---- article model + codec -------------------------------------------------------------------

export interface PageRec { y0: number; h: number; firstLine: number; lineCount: number; firstItem: number; itemCount: number; tone565: number; coverage: number; pageNo: number }
export interface GlyphInst { x: number; y: number; glyphId: number; size: number; colour: number; flags: number; charOffset: number }
export interface RectInst { x0: number; y0: number; x1: number; y1: number; colour: number; kind: number }
export interface ImageInst { x0: number; y0: number; x1: number; y1: number; imageId: number; radius: number; altOffset: number }
export interface LineRec { yTop: number; yBot: number; x0: number; x1: number; firstGlyph: number; glyphCount: number; charOffset: number }
export interface LinkRec { x0: number; y0: number; x1: number; y1: number; kind: number; offset: number; page: number }
export interface AnchorRec { idOffset: number; page: number; y: number }

export interface ArticleModel {
	widthClass: number; // 0 wide, 1 narrow
	emPx0: number;
	sheetW: number; sheetH: number; measure: number; marginX: number; marginY: number;
	cellW: number; cellH: number; gridCols: number; gridRows: number;
	plainTextBytes: number;
	pages: PageRec[];
	cells: { start: number; count: number }[]; // pages * cols * rows
	items: number[];
	glyphs: GlyphInst[];
	rects: RectInst[];
	images: ImageInst[];
	lines: LineRec[];
	links: LinkRec[];
	anchors: AnchorRec[];
	extra: GlyphTable;
	text: Uint8Array;
	strings: Uint8Array;
	palette: Uint32Array; // 2 * PALETTE_SIZE, RGBA8 as 0xAABBGGRR; light then dark
}

const P = ['widthClass', 'emPx0', 'sheetW', 'sheetH', 'measure', 'marginX', 'marginY', 'cellW', 'cellH', 'gridCols', 'gridRows', 'plainTextBytes', 'pageCount'] as const;
const PF = new Set(['emPx0', 'sheetW', 'sheetH', 'measure', 'marginX', 'marginY', 'cellW', 'cellH']);

export function packArticle(m: ArticleModel): Uint8Array {
	const fa = new Float32Array(1);
	const ua = new Uint32Array(fa.buffer);
	const params = P.map((k) => {
		const v = k === 'pageCount' ? m.pages.length : (m as any)[k];
		if (PF.has(k)) return ((fa[0] = v), ua[0]);
		return v;
	});

	const mk = (n: number, size: number) => {
		const b = new ArrayBuffer(n * size);
		return { dv: new DataView(b), b };
	};
	const pages = mk(m.pages.length, REC.page);
	m.pages.forEach((p, i) => {
		const o = i * REC.page, d = pages.dv;
		d.setFloat32(o, p.y0, true); d.setFloat32(o + 4, p.h, true);
		d.setUint32(o + 8, p.firstLine, true); d.setUint32(o + 12, p.lineCount, true);
		d.setUint32(o + 16, p.firstItem, true); d.setUint32(o + 20, p.itemCount, true);
		d.setUint16(o + 24, p.tone565, true); d.setUint16(o + 26, p.pageNo, true);
		d.setFloat32(o + 28, p.coverage, true); d.setUint32(o + 32, 0, true);
	});
	const cells = mk(m.cells.length, REC.cell);
	m.cells.forEach((c, i) => {
		if (c.count > 0xffff) throw new Error('grid cell item count overflow');
		cells.dv.setUint32(i * 8, c.start, true); cells.dv.setUint16(i * 8 + 4, c.count, true);
	});
	const items = new Uint32Array(m.items);
	const glyphs = mk(m.glyphs.length, REC.glyph);
	m.glyphs.forEach((g, i) => {
		const o = i * REC.glyph, d = glyphs.dv;
		d.setFloat32(o, g.x, true); d.setFloat32(o + 4, g.y, true); d.setUint32(o + 8, g.glyphId, true);
		d.setUint16(o + 12, toF16(g.size), true); d.setUint8(o + 14, g.colour); d.setUint8(o + 15, g.flags);
		d.setUint32(o + 16, g.charOffset, true);
	});
	const rects = mk(m.rects.length, REC.rect);
	m.rects.forEach((r, i) => {
		const o = i * REC.rect, d = rects.dv;
		d.setFloat32(o, r.x0, true); d.setFloat32(o + 4, r.y0, true); d.setFloat32(o + 8, r.x1, true); d.setFloat32(o + 12, r.y1, true);
		d.setUint8(o + 16, r.colour); d.setUint8(o + 17, r.kind);
	});
	const images = mk(m.images.length, REC.image);
	m.images.forEach((r, i) => {
		const o = i * REC.image, d = images.dv;
		d.setFloat32(o, r.x0, true); d.setFloat32(o + 4, r.y0, true); d.setFloat32(o + 8, r.x1, true); d.setFloat32(o + 12, r.y1, true);
		d.setUint16(o + 16, r.imageId, true); d.setUint8(o + 18, r.radius); d.setUint32(o + 20, r.altOffset, true);
	});
	const lines = mk(m.lines.length, REC.line);
	m.lines.forEach((l, i) => {
		const o = i * REC.line, d = lines.dv;
		d.setFloat32(o, l.yTop, true); d.setFloat32(o + 4, l.yBot, true); d.setFloat32(o + 8, l.x0, true); d.setFloat32(o + 12, l.x1, true);
		d.setUint32(o + 16, l.firstGlyph, true); d.setUint32(o + 20, l.glyphCount, true); d.setUint32(o + 24, l.charOffset, true);
	});
	const links = mk(m.links.length, REC.link);
	m.links.forEach((l, i) => {
		const o = i * REC.link, d = links.dv;
		d.setFloat32(o, l.x0, true); d.setFloat32(o + 4, l.y0, true); d.setFloat32(o + 8, l.x1, true); d.setFloat32(o + 12, l.y1, true);
		d.setUint32(o + 16, l.kind, true); d.setUint32(o + 20, l.offset, true); d.setUint32(o + 24, l.page, true);
	});
	const anchors = mk(m.anchors.length, REC.anchor);
	m.anchors.forEach((a, i) => {
		const o = i * REC.anchor, d = anchors.dv;
		d.setUint32(o, a.idOffset, true); d.setUint32(o + 4, a.page, true); d.setFloat32(o + 8, a.y, true);
	});

	return packContainer(ARTICLE_MAGIC, params, [
		{ id: Sec.pages, data: new Uint8Array(pages.b), count: m.pages.length },
		{ id: Sec.gridCells, data: new Uint8Array(cells.b), count: m.cells.length },
		{ id: Sec.items, data: items, count: items.length },
		{ id: Sec.glyphs, data: new Uint8Array(glyphs.b), count: m.glyphs.length },
		{ id: Sec.rects, data: new Uint8Array(rects.b), count: m.rects.length },
		{ id: Sec.images, data: new Uint8Array(images.b), count: m.images.length },
		{ id: Sec.lines, data: new Uint8Array(lines.b), count: m.lines.length },
		{ id: Sec.links, data: new Uint8Array(links.b), count: m.links.length },
		{ id: Sec.anchors, data: new Uint8Array(anchors.b), count: m.anchors.length },
		{ id: Sec.exDir, data: m.extra.dir, count: m.extra.dir.length >> 3 },
		{ id: Sec.exCurves, data: m.extra.curves, count: m.extra.curves.length >> 2 },
		{ id: Sec.exBands, data: m.extra.bands, count: m.extra.bands.length },
		{ id: Sec.text, data: m.text, count: m.text.length },
		{ id: Sec.strings, data: m.strings, count: m.strings.length },
		{ id: Sec.palette, data: m.palette, count: m.palette.length }
	]);
}

/** Decode into the same model shape (used by the validator, dump tool and tests). */
export function unpackArticle(bytes: Uint8Array): ArticleModel {
	const c = unpackContainer(bytes);
	if (c.magic !== ARTICLE_MAGIC) throw new Error('not an article bin');
	const p: any = {};
	P.forEach((k, i) => (p[k] = PF.has(k) ? c.paramsF[i] : c.params[i]));
	const dv = (id: number) => {
		const b = sec(c, id).bytes;
		return new DataView(b.buffer, b.byteOffset, b.byteLength);
	};
	const n = (id: number) => sec(c, id).count;
	const arr = <T>(id: number, size: number, f: (d: DataView, o: number) => T) => {
		const d = dv(id);
		return Array.from({ length: n(id) }, (_, i) => f(d, i * size));
	};
	return {
		widthClass: p.widthClass, emPx0: p.emPx0, sheetW: p.sheetW, sheetH: p.sheetH, measure: p.measure,
		marginX: p.marginX, marginY: p.marginY, cellW: p.cellW, cellH: p.cellH, gridCols: p.gridCols, gridRows: p.gridRows,
		plainTextBytes: p.plainTextBytes,
		pages: arr(Sec.pages, REC.page, (d, o) => ({
			y0: d.getFloat32(o, true), h: d.getFloat32(o + 4, true), firstLine: d.getUint32(o + 8, true), lineCount: d.getUint32(o + 12, true),
			firstItem: d.getUint32(o + 16, true), itemCount: d.getUint32(o + 20, true), tone565: d.getUint16(o + 24, true), pageNo: d.getUint16(o + 26, true),
			coverage: d.getFloat32(o + 28, true)
		})),
		cells: arr(Sec.gridCells, REC.cell, (d, o) => ({ start: d.getUint32(o, true), count: d.getUint16(o + 4, true) })),
		items: Array.from(u32v(c, Sec.items)),
		glyphs: arr(Sec.glyphs, REC.glyph, (d, o) => ({
			x: d.getFloat32(o, true), y: d.getFloat32(o + 4, true), glyphId: d.getUint32(o + 8, true), size: fromF16(d.getUint16(o + 12, true)),
			colour: d.getUint8(o + 14), flags: d.getUint8(o + 15), charOffset: d.getUint32(o + 16, true)
		})),
		rects: arr(Sec.rects, REC.rect, (d, o) => ({
			x0: d.getFloat32(o, true), y0: d.getFloat32(o + 4, true), x1: d.getFloat32(o + 8, true), y1: d.getFloat32(o + 12, true),
			colour: d.getUint8(o + 16), kind: d.getUint8(o + 17)
		})),
		images: arr(Sec.images, REC.image, (d, o) => ({
			x0: d.getFloat32(o, true), y0: d.getFloat32(o + 4, true), x1: d.getFloat32(o + 8, true), y1: d.getFloat32(o + 12, true),
			imageId: d.getUint16(o + 16, true), radius: d.getUint8(o + 18), altOffset: d.getUint32(o + 20, true)
		})),
		lines: arr(Sec.lines, REC.line, (d, o) => ({
			yTop: d.getFloat32(o, true), yBot: d.getFloat32(o + 4, true), x0: d.getFloat32(o + 8, true), x1: d.getFloat32(o + 12, true),
			firstGlyph: d.getUint32(o + 16, true), glyphCount: d.getUint32(o + 20, true), charOffset: d.getUint32(o + 24, true)
		})),
		links: arr(Sec.links, REC.link, (d, o) => ({
			x0: d.getFloat32(o, true), y0: d.getFloat32(o + 4, true), x1: d.getFloat32(o + 8, true), y1: d.getFloat32(o + 12, true),
			kind: d.getUint32(o + 16, true), offset: d.getUint32(o + 20, true), page: d.getUint32(o + 24, true)
		})),
		anchors: arr(Sec.anchors, REC.anchor, (d, o) => ({ idOffset: d.getUint32(o, true), page: d.getUint32(o + 4, true), y: d.getFloat32(o + 8, true) })),
		extra: { dir: u32v(c, Sec.exDir), curves: u16v(c, Sec.exCurves), bands: u32v(c, Sec.exBands) },
		text: sec(c, Sec.text).bytes.slice(),
		strings: sec(c, Sec.strings).bytes.slice(),
		palette: u32v(c, Sec.palette).slice()
	};
}

export const cstr = (strings: Uint8Array, off: number): string => {
	let e = off;
	while (e < strings.length && strings[e] !== 0) e++;
	return new TextDecoder().decode(strings.subarray(off, e));
};
