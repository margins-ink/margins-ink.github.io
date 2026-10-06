import { describe, expect, test } from 'bun:test';
import { packFontsBin, readFontsBin } from '../../src/lib/reader/format';
import { measureUi, setUiTables, shapeUi, loadUiTables } from '../../src/lib/reading/ui/text';
import { FontSet, GlyphTableBuilder } from '../reader/fonts';
import { buildUiTables, uiCodepoints, uiSlots } from './uifont';

const fonts = new FontSet();
const union = new GlyphTableBuilder();
const title = 'Zürich → “Ünïcode” naïve café — ½ ≤ ✓';
const ui = buildUiTables(fonts, union, [title]);
const bin = packFontsBin(union.finish(), fonts.fonts.map((f) => f.info), Uint32Array.from(union.tag.map((t) => Number(t[0]))), Uint32Array.from(union.tag.map((t) => Number(t[1]))), ui);
const tables = loadUiTables(bin);

describe('ui font tables from the real fonts', () => {
	test('fonts.bin without the section stays readable', () => {
		const old = packFontsBin(union.finish(), fonts.fonts.map((f) => f.info), Uint32Array.from(union.tag.map((t) => Number(t[0]))), Uint32Array.from(union.tag.map((t) => Number(t[1]))));
		expect(readFontsBin(old).ui).toBeUndefined();
		expect(() => loadUiTables(old)).toThrow();
		loadUiTables(bin);
	});
	test('coverage: Basic Latin, Latin-1, arrows, punctuation and the title characters', () => {
		for (const name of ['sans', 'mono'] as const) {
			const t = tables[name];
			const has = (cp: number) => t.cp.includes(cp);
			for (let c = 0x20; c <= 0x7e; c++) expect(has(c)).toBe(true);
			for (const ch of 'Àÿéüñ×÷©®°±½¿¡') expect(has(ch.codePointAt(0)!)).toBe(true);
			for (const ch of '→←↑↓“”‘’…–—•‹›') expect(has(ch.codePointAt(0)!)).toBe(true);
			for (const ch of title) if (ch !== ' ') expect(has(ch.codePointAt(0)!)).toBe(true);
		}
		expect(uiCodepoints(['ж']).includes(0x436)).toBe(true);
	});
	test('widths equal harfbuzz advances (sans kerned, mono 0.6 em)', () => {
		const slots = uiSlots(fonts);
		const sans = fonts.fonts[slots.sans];
		const hbw = (s: string) => sans.shape(s).reduce((a, g) => a + g.xAdvance, 0);
		for (const s of ['Contents', 'AVATAR To', 'Instrument', 'Copied']) expect(measureUi(s, 'sans', 100)).toBeCloseTo(hbw(s) * 100, 0);
		expect(measureUi('abcdef', 'mono', 10)).toBeCloseTo(6 * 0.6 * 10, 1);
	});
	test('kerning is present for AV and absent for the mono', () => {
		expect(tables.sans.kern.get((0x41 << 16) | 0x56)!).toBeLessThan(0);
		expect(tables.mono.kern.size).toBe(0);
	});
	test('glyph ids index the union table; space has none; unknown characters use notdef', () => {
		const s = shapeUi('A B', 'sans', 10);
		expect(s.glyphs.length).toBe(2);
		for (const g of s.glyphs) expect(g.glyphId).toBeLessThan(union.count);
		expect(shapeUi('\u{10FFFF}', 'sans', 10).glyphs.length).toBeLessThanOrEqual(1);
		setUiTables(tables);
	});
});
