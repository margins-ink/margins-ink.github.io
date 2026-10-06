// bun tests for the preview lane: query parsing, panel geometry, the fixture round trip and the packed buffer.
import { describe, expect, test } from 'bun:test';
import { unpackMagazine, itemType, ItemType } from '../../src/lib/magazine/format';
import { readFontsBin } from '../../src/lib/reader/format';
import { buildFixture } from './fixture';
import { MAGIC, PH, packPreview, itemsAt } from './pack';
import { fit, panelRect, parseQuery, sheetGrid } from './query';

describe('query', () => {
	test('defaults to the distilled layer', () => {
		const q = parseQuery('');
		expect(q).toMatchObject({ slug: 'ifd', spread: 0, cls: 'wide', layer: 'distilled', t: 'poster', zoom: 1, grid: false });
	});
	test('parses the documented keys', () => {
		const q = parseQuery('?slug=hyperion&spread=3&class=narrow&dark=1&t=4.2&zoom=2&grid=1&frames=1&variants=duo,solo,compare&sheet=0,3,6');
		expect(q).toMatchObject({ slug: 'hyperion', spread: 3, cls: 'narrow', dark: true, t: 4.2, zoom: 2, grid: true, frames: true });
		expect(q.variants).toEqual(['duo', 'solo', 'compare']);
		expect(q.sheet).toEqual([0, 3, 6]);
	});
	test('fails closed on bad input', () => {
		expect(() => parseQuery('?class=tall')).toThrow();
		expect(() => parseQuery('?variants=duo,bogus')).toThrow();
		expect(() => parseQuery('?zoom=100')).toThrow();
		expect(() => parseQuery('?t=-1')).toThrow();
	});
	test('panel rects tile inside the canvas without overlap', () => {
		const n = 5, { cols, rows } = sheetGrid(n);
		expect([cols, rows]).toEqual([3, 2]);
		const rs = Array.from({ length: n }, (_, i) => panelRect(i, n, 1200, 800));
		for (const [x, y, w, h] of rs) { expect(x).toBeGreaterThan(0); expect(x + w).toBeLessThanOrEqual(1200); expect(y + h).toBeLessThanOrEqual(800); }
		for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
			const a = rs[i], b = rs[j];
			expect(a[0] + a[2] <= b[0] || b[0] + b[2] <= a[0] || a[1] + a[3] <= b[1] || b[1] + b[3] <= a[1]).toBe(true);
		}
	});
	test('fit centres the spread', () => {
		const f = fit(80, 56, 1600, 800, 1);
		expect(f.ppe).toBeCloseTo(800 / 56, 6);
		expect(f.x0 + 1600 / f.ppe / 2).toBeCloseTo(40, 6);
	});
});

describe('fixture and pack', () => {
	const fx = buildFixture();
	const model = unpackMagazine(fx.article);
	const fonts = readFontsBin(fx.fonts);
	test('round-trips as RDR2 with both families in the table', () => {
		expect(model.spreads.length).toBe(1);
		expect(model.glyphs.length).toBeGreaterThan(200);
		const names = fonts.fonts.map((f) => f.name);
		expect(names.some((n) => n.startsWith('Inter'))).toBe(true);
		expect(names.some((n) => n.startsWith('Instrument Sans'))).toBe(true);
		expect(names.some((n) => n.startsWith('Newsreader'))).toBe(false);
	});
	test('every glyph id resolves in the union table', () => {
		const n = fonts.table.dir.length >> 3;
		for (const g of model.glyphs) expect(g.glyphId).toBeLessThan(n);
	});
	test('packed buffer has valid section offsets and the cell lookup agrees with the model', () => {
		const p = packPreview(fonts.table, model);
		expect(p.data[PH.magic]).toBe(MAGIC);
		for (const k of ['fdir', 'fcur', 'fband', 'spread', 'cell', 'item', 'glyph', 'rect', 'shape', 'pal'] as const) {
			expect(p.data[PH[k]]).toBeGreaterThanOrEqual(PH.size);
			expect(p.data[PH[k]]).toBeLessThanOrEqual(p.data.length);
		}
		// the headline's first glyph must be found in its own cell
		const g = model.glyphs[0];
		const hit = itemsAt(model, 0, g.x + 0.5, g.y - 0.5).some((i) => i.type === ItemType.glyph);
		expect(hit).toBe(true);
		expect(model.items.every((w) => itemType(w) <= 7)).toBe(true);
	});
	test('control: a cell far from any content is empty, and a corrupted palette length is rejected', () => {
		expect(itemsAt(model, 0, 0.5, SPREAD_CORNER).length).toBe(0);
		expect(() => packPreview(fonts.table, { ...model, palette: model.palette.slice(0, 10) })).toThrow();
	});
});

const SPREAD_CORNER = 55.5;
