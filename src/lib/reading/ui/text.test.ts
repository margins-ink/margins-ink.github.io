import { afterEach, describe, expect, test } from 'bun:test';
import { decodeUiTables, encodeUiTables, type UiFontData } from './tables';
import { measureUi, setUiTables, shapeUi, truncateUi, uiGlyphs } from './text';
import { NO_GLYPH } from './types';

// synthetic font: a = 0.5, b = 0.25, space = 0.3, ellipsis = 1, i = 0.2; kern a-b = -0.05
const mk = (): UiFontData => ({
	notdef: { glyphId: 99, adv: 0.6 },
	cp: [0x20, 0x61, 0x62, 0x69, 0x2026],
	gid: [NO_GLYPH, 1, 2, 3, 4],
	adv: [0.3, 0.5, 0.25, 0.2, 1],
	kern: [[0x61, 0x62, -0.05]]
});
const tables = () => decodeUiTables(encodeUiTables({ sans: mk(), mono: { ...mk(), kern: [] } }));
afterEach(() => setUiTables(null));

describe('shapeUi', () => {
	test('width is the sum of advances times size, kerning applied', () => {
		setUiTables(tables());
		expect(measureUi('ab', 'sans', 10)).toBeCloseTo((0.5 + 0.25 - 0.05) * 10, 5);
		expect(measureUi('ab', 'mono', 10)).toBeCloseTo((0.5 + 0.25) * 10, 5);
		expect(measureUi('a b', 'sans', 20)).toBeCloseTo((0.5 + 0.3 + 0.25) * 20, 5);
	});
	test('glyph positions and ids; spaces emit no glyph', () => {
		setUiTables(tables());
		const s = shapeUi('a bi', 'sans', 100);
		expect(s.glyphs.map((g) => g.glyphId)).toEqual([1, 2, 3]);
		expect(s.glyphs[0].dx).toBe(0);
		expect(s.glyphs[1].dx).toBeCloseTo(80, 4); // a 50 + space 30
		expect(s.glyphs[2].dx).toBeCloseTo(105, 4); // + b 25
		expect(s.width).toBeCloseTo(125, 4);
	});
	test('PLANTED BUG CONTROL: a wrong advance fails the width test', () => {
		const bad = mk();
		bad.adv[1] = 0.55; // a is 0.55 instead of 0.5
		setUiTables(decodeUiTables(encodeUiTables({ sans: bad, mono: mk() })));
		expect(Math.abs(measureUi('ab', 'sans', 10) - 7)).toBeGreaterThan(0.1);
		expect(() => expect(measureUi('ab', 'sans', 10)).toBeCloseTo(7, 5)).toThrow();
	});
	test('missing characters draw the notdef; control characters vanish; astral code points count once', () => {
		setUiTables(tables());
		const s = shapeUi('a\u0001z\u{1F600}', 'sans', 10);
		expect(s.glyphs.map((g) => g.glyphId)).toEqual([1, 99, 99]);
		expect(s.width).toBeCloseTo((0.5 + 0.6 + 0.6) * 10, 5);
	});
	test('empty string', () => {
		setUiTables(tables());
		expect(shapeUi('', 'sans', 12)).toEqual({ glyphs: [], width: 0 });
	});
	test('throws before tables are loaded', () => {
		expect(() => shapeUi('a', 'sans', 10)).toThrow();
	});
});

describe('truncateUi', () => {
	test('fits: unchanged', () => {
		setUiTables(tables());
		expect(truncateUi('abab', 'mono', 10, 100)).toBe('abab');
	});
	test('longest prefix plus ellipsis within the budget, never wider than maxW', () => {
		setUiTables(tables());
		// mono: a 5, b 2.5 at size 10; ellipsis 10. 'ababab' = 22.5. budget 20: 'ab' + … = 17.5 ('aba' + … = 22.5)
		const out = truncateUi('ababab', 'mono', 10, 20);
		expect(out).toBe('ab…');
		expect(measureUi(out, 'mono', 10)).toBeLessThanOrEqual(20);
		for (const w of [10, 11, 15, 17.5, 22, 22.4]) expect(measureUi(truncateUi('ababab', 'mono', 10, w), 'mono', 10)).toBeLessThanOrEqual(w);
	});
	test('trailing space is trimmed before the ellipsis; too small gives empty', () => {
		setUiTables(tables());
		expect(truncateUi('ab  ab', 'mono', 10, 20)).toBe('ab…');
		expect(truncateUi('ababab', 'mono', 10, 5)).toBe('');
	});
});

describe('uiGlyphs', () => {
	test('places glyphs at x + dx on the baseline with the colour', () => {
		setUiTables(tables());
		const g = uiGlyphs('ai', 'sans', 10, 100, 40, [1, 0.5, 0.25, 0.8], 1.5);
		expect(g).toEqual([
			{ x: 100, y: 40, glyphId: 1, font: 'sans', size: 10, r: 1, g: 0.5, b: 0.25, a: 0.8, hdr: 1.5 },
			{ x: 105, y: 40, glyphId: 3, font: 'sans', size: 10, r: 1, g: 0.5, b: 0.25, a: 0.8, hdr: 1.5 }
		]);
	});
});

describe('tables codec', () => {
	test('round trip, unsorted input is sorted, odd byteOffset is fine', () => {
		const d = mk();
		const shuffled: UiFontData = { ...d, cp: [...d.cp].reverse(), gid: [...d.gid].reverse(), adv: [...d.adv].reverse() };
		const bytes = encodeUiTables({ sans: shuffled, mono: d });
		const padded = new Uint8Array(bytes.length + 3);
		padded.set(bytes, 3);
		const t = decodeUiTables(padded.subarray(3));
		expect([...t.sans.cp]).toEqual(d.cp);
		expect([...t.sans.gid]).toEqual(d.gid);
		expect(t.sans.kern.get((0x61 << 16) | 0x62)).toBeCloseTo(-0.05, 6);
		expect(t.sans.notdef).toEqual({ glyphId: 99, adv: expect.closeTo(0.6, 5) });
	});
});
