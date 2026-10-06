// Tests for the `type` lane: fonts (Inter + Instrument Sans in the glyph build), palette gamut and contrast, voices.
import { describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { DISPLAY_AXES, F, FONT_SPECS, FontSet, GlyphTableBuilder, MAG_FONT_DIR, fontPath } from '../reader/fonts';
import { buildPalette, checkPalette, contrast, fitChroma, inGamut, oklchToLinear, schemeEntries } from './palette';
import { VOICES, checkVoices, voiceFor } from './voices';

const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(fontPath(f))).digest('hex');

describe('fonts', () => {
	test('stored bytes match SOURCE.md hashes', () => {
		const src = fs.readFileSync(`${MAG_FONT_DIR}/SOURCE.md`, 'utf8');
		for (const f of ['Inter.ttf', 'Inter-Italic.ttf', 'InstrumentSans.ttf', 'InstrumentSans-Italic.ttf']) expect(src).toContain(sha(f));
	});
	test('every spec file resolves and no Newsreader remains', () => {
		for (const s of FONT_SPECS) {
			expect(fs.existsSync(fontPath(s.file))).toBe(true);
			expect(s.file).not.toContain('Newsreader');
		}
	});
	test('Instrument Sans wdth moves advances and outlines reach the glyph table', () => {
		const set = new FontSet();
		const wide = set.fonts[set.display(100, 600)], tight = set.fonts[set.display(75, 600)];
		const aw = wide.shape('IFD is fine').reduce((s, g) => s + g.xAdvance, 0);
		const at = tight.shape('IFD is fine').reduce((s, g) => s + g.xAdvance, 0);
		expect(at).toBeLessThan(aw * 0.95);
		const tb = new GlyphTableBuilder();
		for (const g of tight.shape('IFD is fine 100,000')) tb.add(`${tight.spec.name}#${g.gid}`, tight.outline(g.gid));
		expect(tb.count).toBeGreaterThan(8);
		expect(tb.finish().curves.length).toBeGreaterThan(0);
	});
	test('display() memoises, reuses the default instance, and fails closed out of range', () => {
		const s = new FontSet();
		expect(s.display(80, 600)).toBe(F.display);
		expect(s.display(75, 700)).toBe(s.display(75, 700));
		expect(() => s.display(70, 600)).toThrow();
		expect(() => s.display(80, 800)).toThrow();
		expect(DISPLAY_AXES.wdth[0]).toBe(75);
	});
	test('Inter body covers the prose character set; missing() has a planted control', () => {
		const s = new FontSet();
		expect(s.missing(F.body, 'IFD is fine. Import From Derivation: ${drv}/foo, “quoted” ’ → (a|b)')).toEqual([]);
		expect(s.missing(F.display, 'IFD is fine 100,000 “”')).toEqual([]);
		expect(s.missing(F.body, String.fromCodePoint(0x10fffd))).toEqual([0x10fffd]); // planted: a plane-16 private-use code point no face has
	});
	test('tnum exists in Inter and Instrument Sans (tabular 1 as wide as 0)', () => {
		const s = new FontSet();
		const adv = (fi: number, t: string, feat: string[]) => s.fonts[fi].shape(t, feat).map((g) => g.xAdvance);
		for (const fi of [F.body, F.display]) {
			const one = adv(fi, '1', ['tnum'])[0], zero = adv(fi, '0', ['tnum'])[0];
			expect(Math.abs(one - zero)).toBeLessThan(1e-6);
		}
	});
});

describe('palette', () => {
	test('every voice hue passes gamut and contrast in both schemes', () => {
		for (const v of VOICES) for (const sc of ['light', 'dark'] as const) checkPalette(v.hue, sc);
	});
	test('buildPalette is 64 words, deterministic, light differs from dark', () => {
		const a = buildPalette(265), b = buildPalette(265);
		expect(a.length).toBe(64);
		expect(Array.from(a)).toEqual(Array.from(b));
		expect(a[0]).not.toBe(a[32]);
	});
	test('fitChroma caps an out-of-gamut request and keeps an in-gamut one', () => {
		const c = fitChroma(0.76, 0.4, 148);
		expect(c).toBeLessThan(0.4);
		expect(inGamut(oklchToLinear([0.76, c, 148]))).toBe(true);
		expect(fitChroma(0.5, 0.05, 265)).toBe(0.05);
	});
	test('planted controls: a clipped entry and a low-contrast ink must fail', () => {
		const p = schemeEntries(265, 'light');
		expect(() => checkPalette(265, 'light', { ...p, accent: [1.2, -0.1, 0.5] })).toThrow(/gamut/);
		expect(() => checkPalette(265, 'light', { ...p, ink: [0.6, 0.6, 0.6] })).toThrow(/contrast/);
		expect(contrast([0, 0, 0], [1, 1, 1])).toBeCloseTo(21, 5);
	});
});

describe('voices', () => {
	test('table is valid; ifd matches the doc', () => {
		checkVoices();
		expect(voiceFor('ifd')).toMatchObject({ hue: 265, wdth: 80, wght: 600, template: 'duo' });
	});
	test('controls: unknown slug, out-of-range axis and a duplicate combo fail', () => {
		expect(() => voiceFor('nope')).toThrow();
		expect(() => voiceFor('ifd', { wdth: 60 })).toThrow();
		const x = VOICES[0];
		expect(() => checkVoices([x, { ...x, slug: 'other' }])).toThrow(/shares/);
	});
});
