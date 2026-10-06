import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { breakLines, itemsFromText, lineText, shapedMeasure, type Item, type Measure } from '../kp';
import { loadEnUs } from '../hyph';
import { bindUnits } from '../microtype';
import { FONT_DIR, FONT_SPECS, LoadedFont } from '../../reader/fonts';

// deterministic stand-in font: 0.5 em per char
const mono: Measure = (s) => s.length * 0.5;

const TEXT =
	'The quick brown fox jumps over the lazy dog while extraordinarily knowledgeable programmers ' +
	'contemplate the implementation of typographic optimisation, hyphenation, and well-known algorithms ' +
	'for breaking paragraphs into beautifully balanced lines of text across several columns.';

function stats(items: Item[], widthEm: number, hyph: boolean) {
	const lines = breakLines(items, { lineWidth: () => widthEm });
	return { lines, texts: lines.map((l) => lineText(items, l)), hyphens: lines.filter((l) => l.hyphen).length };
}

describe('hyphenation', () => {
	const h = loadEnUs();
	test('known words match TeX output', () => {
		expect(h.hyphenate('hyphenation')).toEqual([2, 6]); // hy-phen-ation
		expect(h.hyphenate('typographic')).toEqual([2, 4]); // ty-po-graphic (rightmin 3)
		expect(h.hyphenate('the')).toEqual([]);
		expect(h.hyphenate('programmers').length).toBeGreaterThan(0);
	});
	test('exceptions override patterns and forbid breaks', () => {
		expect(h.hyphenate('associate')).toEqual([2, 4]); // as-so-ciate
		expect(h.hyphenate('project')).toEqual([]);
		const h2 = loadEnUs(['democrat']);
		expect(h2.hyphenate('democrat')).toEqual([]);
	});
	test('non-letter words are left alone', () => {
		expect(h.hyphenate("don't")).toEqual([]);
		expect(h.hyphenate('2026-10-06')).toEqual([]);
	});
});

describe('knuth-plass', () => {
	test('every line fits (justified), lines reproduce the text', () => {
		const items = itemsFromText(TEXT, mono, { hyphenator: loadEnUs() });
		const { lines, texts } = stats(items, 24, true);
		expect(lines.length).toBeGreaterThan(4);
		for (const l of lines.slice(0, -1)) {
			expect(l.ratio).toBeGreaterThanOrEqual(-1.0001);
			expect(l.ratio).toBeLessThanOrEqual(3.0001);
		}
		// no overfull line, text round-trips modulo hyphenation breaks
		const joined = texts.map((t) => (t.endsWith('-') && !/\w-\w/.test(t.slice(-3)) ? t.slice(0, -1) : t + ' ')).join('');
		expect(joined.replace(/\s+/g, ' ').trim()).toBe(TEXT.replace(/\s+/g, ' ').trim().replace(/-\s/g, '-'));
	});

	test('hyphenation reduces stretch versus no hyphenation (K-P uses it)', () => {
		const withHy = itemsFromText(TEXT, mono, { hyphenator: loadEnUs() });
		const without = itemsFromText(TEXT, mono, { hyphenator: null });
		const sum = (it: Item[]) => breakLines(it, { lineWidth: () => 20 }).slice(0, -1).reduce((a, l) => a + l.ratio * l.ratio, 0);
		expect(sum(withHy)).toBeLessThan(sum(without));
	});

	test('no three hyphens in a row on a narrow measure; double hyphens discouraged', () => {
		const items = itemsFromText(TEXT.repeat(3), mono, { hyphenator: loadEnUs() });
		const lines = breakLines(items, { lineWidth: () => 30 });
		let run = 0, worst = 0;
		for (const l of lines) { run = l.hyphen ? run + 1 : 0; worst = Math.max(worst, run); }
		expect(worst).toBeLessThanOrEqual(2); // maxConsecutiveHyphens default
	});

	test('per-line widths: an exclusion on the first 3 lines narrows them', () => {
		const items = itemsFromText(TEXT, mono, { hyphenator: loadEnUs() });
		const lines = breakLines(items, { lineWidth: (i) => (i < 3 ? { x0: 6, x1: 24 } : { x0: 0, x1: 24 }) });
		expect(lines[0].x0).toBe(6);
		expect(lines[0].width).toBe(18);
		expect(lines[3].x0).toBe(0);
		for (const l of lines.slice(0, 3)) expect(l.natural).toBeLessThanOrEqual(18 + 0.08 * 8);
	});

	test('ragged: natural spaces, no line wider than the measure, rag within allowance', () => {
		const items = itemsFromText(TEXT, mono, { align: 'ragged', hyphenator: loadEnUs() });
		const lines = breakLines(items, { lineWidth: () => 24, raggedStretch: 1.5 });
		for (const l of lines) expect(l.natural).toBeLessThanOrEqual(24 + 1e-6);
		for (const l of lines.slice(0, -1)) expect(24 - l.natural).toBeLessThan(4.5);
	});

	test('looseness changes line count', () => {
		const items = itemsFromText(TEXT, mono, { hyphenator: loadEnUs() });
		const base = breakLines(items, { lineWidth: () => 24 }).length;
		const more = breakLines(items, { lineWidth: () => 24, looseness: 1, tolerance: 3, tolerance2: 5 }).length;
		expect(more).toBeGreaterThanOrEqual(base);
	});

	test('overfull word falls back to emergency pass instead of throwing', () => {
		const items = itemsFromText('a supercalifragilisticexpialidocious b', mono, { hyphenator: null });
		const lines = breakLines(items, { lineWidth: () => 5 });
		expect(lines.length).toBeGreaterThan(0);
	});

	test('control: without shrink the justified line ratios are worse (planted)', () => {
		const a = itemsFromText(TEXT, mono, { hyphenator: loadEnUs(), shrink: 0.08 });
		const b = itemsFromText(TEXT, mono, { hyphenator: loadEnUs(), shrink: 0 });
		const worst = (it: Item[]) => Math.max(...breakLines(it, { lineWidth: () => 24 }).slice(0, -1).map((l) => Math.abs(l.ratio)));
		expect(worst(b)).toBeGreaterThanOrEqual(worst(a));
	});

	test('non-breaking unit glue never splits', () => {
		const t = bindUnits('It took 12 ms and 400 MB of memory to hold the answer in place for 3 s total today');
		expect(t).toContain('12 ms');
		const items = itemsFromText(t, mono, { hyphenator: loadEnUs() });
		for (const w of [10, 12, 14, 16, 18]) {
			for (const l of breakLines(items, { lineWidth: () => w })) {
				const s = lineText(items, l);
				expect(s.startsWith('ms') || s.startsWith('MB')).toBe(false);
				expect(/\d$/.test(s)).toBe(false);
			}
		}
	});
});

describe('hanging punctuation', () => {
	test('opening quote hangs left; boxes carry hang widths', () => {
		const items = itemsFromText('\u201Cwell, hello', mono, { hyphenator: null });
		const lines = breakLines(items, { lineWidth: () => 30 });
		expect(lines[0].hangLeft).toBeCloseTo(0.7 * 0.5);
		const comma = items.find((i) => i.t === 'box' && i.text === 'hello');
		expect(comma && comma.t === 'box' ? comma.hr : 0).toBeUndefined();
		expect(items.find((i) => i.t === 'box' && i.text === '\u201Cwell,')).toMatchObject({ hl: 0.35, hr: 0.4 * 0.5 });
	});
	test('a trailing comma hangs into the margin: it fits only with microtype', () => {
		const run = (microtype: boolean) => {
			const items = itemsFromText('aaaa bbbb, cccc', mono, { align: 'ragged', hyphenator: null, microtype });
			return breakLines(items, { lineWidth: () => 4.6, raggedStretch: 2 }).map((l) => lineText(items, l));
		};
		expect(run(true)[0]).toBe('aaaa bbbb,');
		expect(run(false)[0]).toBe('aaaa');
	});
	test('a trailing hyphen hangs: hyphen break width counts 30% of the glyph', () => {
		const items = itemsFromText('extraordinarily', mono, { hyphenator: loadEnUs(), align: 'ragged' });
		const lines = breakLines(items, { lineWidth: () => 6, raggedStretch: 3 });
		const hy = lines.find((l) => l.hyphen);
		expect(hy).toBeDefined();
		expect(hy!.hangRight).toBeCloseTo(0.7 * 0.5);
	});
});

describe('with real shaping (Inter via harfbuzzjs)', () => {
	const spec = FONT_SPECS.find((s) => s.file === 'Inter.ttf');
	const have = spec && fs.existsSync(path.join(FONT_DIR, spec.file));
	(have ? test : test.skip)('lines fit a 28 em measure using shaped advances', () => {
		const font = new LoadedFont(spec!);
		const items = itemsFromText(TEXT, shapedMeasure(font), { hyphenator: loadEnUs(), space: font.shape(' ')[0].xAdvance });
		const lines = breakLines(items, { lineWidth: () => 28 });
		expect(lines.length).toBeGreaterThan(3);
		for (const l of lines.slice(0, -1)) expect(l.natural).toBeLessThanOrEqual(28 + 1e-6 + 0.08 * 10);
	});
});
