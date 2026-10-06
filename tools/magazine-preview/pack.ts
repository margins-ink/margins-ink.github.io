// Pure packing for the preview page: an RDR2 model plus the shared glyph table become one u32 storage buffer
// that preview.wgsl.ts reads. No DOM, no GPU: unit tested under bun. The room shader (shader lane) has its own
// buffer layout; this one only has to serve one flat spread, so it stays small.
import { fromF16, itemIndex, itemType, ItemType, PALETTE2_SIZE, toF16, type GlyphTable, type MagazineModel } from '../../src/lib/magazine/format';

/** Header word indices, mirrored in preview.wgsl.ts. */
export const PH = {
	magic: 0, fdir: 1, fcur: 2, fband: 3, xdir: 4, xcur: 5, xband: 6, spread: 7, cell: 8, item: 9, glyph: 10, rect: 11, shape: 12, pal: 13,
	spreadCount: 14, size: 16
} as const;
export const MAGIC = 0x56575250; // 'PRWV'
export const SPREAD_WORDS = 8; // [firstCell, cols, rows, tone565, w f32, h f32, x f32, layer]
export const GLYPH_WORDS = 5;
export const RECT_WORDS = 5;
export const SHAPE_WORDS = 6;

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const bits = (v: number) => ((f32[0] = v), u32[0]);

const words = (a: Uint16Array | Uint32Array): Uint32Array => {
	if (a instanceof Uint32Array) return a;
	const out = new Uint32Array((a.length + 1) >> 1);
	new Uint16Array(out.buffer).set(a);
	return out;
};

export interface Packed {
	data: Uint32Array;
	spreads: { index: number; w: number; h: number; x: number; layer: number; cols: number; rows: number }[];
}

export function packPreview(fonts: GlyphTable, m: MagazineModel): Packed {
	const parts: Uint32Array[] = [];
	let at = PH.size;
	const put = (a: Uint32Array) => {
		const o = at;
		parts.push(a);
		at += a.length;
		return o;
	};
	const h = new Uint32Array(PH.size);
	h[PH.magic] = MAGIC;
	h[PH.fdir] = put(fonts.dir);
	h[PH.fcur] = put(words(fonts.curves));
	h[PH.fband] = put(fonts.bands);
	h[PH.xdir] = put(m.extra.dir);
	h[PH.xcur] = put(words(m.extra.curves));
	h[PH.xband] = put(m.extra.bands);

	const sp = new Uint32Array(m.spreads.length * SPREAD_WORDS);
	m.spreads.forEach((s, i) => {
		const o = i * SPREAD_WORDS;
		sp[o] = s.firstCell; sp[o + 1] = s.gridCols; sp[o + 2] = s.gridRows; sp[o + 3] = s.tone565;
		sp[o + 4] = bits(s.w); sp[o + 5] = bits(s.h); sp[o + 6] = bits(s.x); sp[o + 7] = (s as { layer?: number }).layer ?? 0;
	});
	h[PH.spread] = put(sp);
	h[PH.spreadCount] = m.spreads.length;

	const cells = new Uint32Array(m.cells.length * 2);
	m.cells.forEach((c, i) => { cells[i * 2] = c.start; cells[i * 2 + 1] = c.count; });
	h[PH.cell] = put(cells);
	h[PH.item] = put(Uint32Array.from(m.items));

	const g = new Uint32Array(m.glyphs.length * GLYPH_WORDS);
	m.glyphs.forEach((x, i) => {
		const o = i * GLYPH_WORDS;
		g[o] = bits(x.x); g[o + 1] = bits(x.y); g[o + 2] = x.glyphId >>> 0;
		g[o + 3] = (toF16(x.size) | (x.colour << 16) | (x.flags << 24)) >>> 0; g[o + 4] = x.frame;
	});
	h[PH.glyph] = put(g);
	const r = new Uint32Array(m.rects.length * RECT_WORDS);
	m.rects.forEach((x, i) => {
		const o = i * RECT_WORDS;
		r[o] = bits(x.x0); r[o + 1] = bits(x.y0); r[o + 2] = bits(x.x1); r[o + 3] = bits(x.y1); r[o + 4] = x.colour | (x.kind << 8);
	});
	h[PH.rect] = put(r);
	const sh = new Uint32Array(m.shapes.length * SHAPE_WORDS);
	m.shapes.forEach((x, i) => {
		const o = i * SHAPE_WORDS;
		sh[o] = bits(x.x0); sh[o + 1] = bits(x.y0); sh[o + 2] = bits(x.x1); sh[o + 3] = bits(x.y1);
		sh[o + 4] = (x.kind | (x.colour << 8) | (x.colour2 << 16) | (x.flags << 24)) >>> 0; sh[o + 5] = (toF16(x.radius) | (toF16(x.param) << 16)) >>> 0;
	});
	h[PH.shape] = put(sh);
	if (m.palette.length !== 2 * PALETTE2_SIZE) throw new Error('preview: bad palette length');
	h[PH.pal] = put(m.palette);

	const data = new Uint32Array(at);
	data.set(h, 0);
	let o = PH.size;
	for (const p of parts) { data.set(p, o); o += p.length; }
	const spreads = m.spreads.map((s, index) => ({ index, w: s.w, h: s.h, x: s.x, layer: (s as { layer?: number }).layer ?? 0, cols: s.gridCols, rows: s.gridRows }));
	return { data, spreads };
}

/** CPU reference for the cell lookup the shader does: items of the cell containing (x, y) em, spread-local. */
export function itemsAt(m: MagazineModel, spread: number, x: number, y: number): { type: number; index: number }[] {
	const s = m.spreads[spread];
	const cx = Math.min(s.gridCols - 1, Math.max(0, Math.floor(x / m.cellW)));
	const cy = Math.min(s.gridRows - 1, Math.max(0, Math.floor(y / m.cellH)));
	const c = m.cells[s.firstCell + cy * s.gridCols + cx];
	return m.items.slice(c.start, c.start + c.count).map((w) => ({ type: itemType(w), index: itemIndex(w) }));
}

export { ItemType, fromF16 };
