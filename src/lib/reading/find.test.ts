import { describe, expect, test } from 'bun:test';
import { findAll, findInModel, hitFrom, nextHit, normalizeForFind, prevHit, rangesToRects } from './find';
import { foldEndOf } from './hit';
import { demoModel, loadBin } from './testmodel';

const dec = new TextDecoder();
const enc = new TextEncoder();

/** Independent count: split the normalised text on the normalised query (non-overlapping, left to right). */
const naiveCount = (text: string, q: string) => {
	const nq = normalizeForFind(q);
	return nq ? normalizeForFind(text).split(nq).length - 1 : 0;
};

describe('findAll', () => {
	const text = 'Café cafe CAFÉ naïve NAIVE Straße straße “quoted” it’s a b';

	test('case and diacritics insensitive; ranges slice back to the matched source', () => {
		const r = findAll(text, 'cafe');
		expect(r.map((x) => text.slice(x.lo, x.hi))).toEqual(['Café', 'cafe', 'CAFÉ']);
		expect(findAll(text, 'NAIVE').map((x) => text.slice(x.lo, x.hi))).toEqual(['naïve', 'NAIVE']);
		expect(findAll(text, 'é').length).toBe(findAll(text, 'e').length); // a diacritic in the query folds too
		expect(findAll(text, 'it\'s').length).toBe(1); // straight apostrophe finds the curly one
		expect(findAll(text, '"quoted"').length).toBe(1);
		expect(findAll(text, 'a b').length).toBe(1); // no-break space
		expect(findAll(text, '')).toEqual([]);
		expect(findAll(text, 'zzz')).toEqual([]);
	});

	test('non-overlapping, in order', () => {
		expect(findAll('aaaa', 'aa')).toEqual([{ lo: 0, hi: 2 }, { lo: 2, hi: 4 }]);
	});

	test('a Uint8Array gives byte ranges that slice the UTF-8 text', () => {
		const bytes = enc.encode(text);
		const r = findAll(bytes, 'strasse'.replace('ss', 'ß'));
		expect(r.map((x) => dec.decode(bytes.subarray(x.lo, x.hi)))).toEqual(['Straße', 'straße']);
		const c = findAll(bytes, 'cafe');
		expect(c.map((x) => dec.decode(bytes.subarray(x.lo, x.hi)))).toEqual(['Café', 'cafe', 'CAFÉ']);
		// a planted off-by-one in the byte mapping would shift every range after the first multi-byte character
		expect(dec.decode(bytes.subarray(findAll(bytes, 'naive')[0].lo, findAll(bytes, 'naive')[0].hi))).toBe('naïve');
	});

	test('planted control: a case-sensitive accent-sensitive scan finds fewer', () => {
		expect(text.split('cafe').length - 1).toBe(1);
		expect(findAll(text, 'cafe').length).toBe(3);
	});
});

describe('find over the model', () => {
	const m = demoModel();

	test('hits map to blocks, notes and the fold; fold buttons are not searched', () => {
		const hits = findInModel(m, 'alpha');
		// brief para, folded para ("hidden alpha one"), the margin note
		expect(hits.length).toBe(3);
		expect(hits.map((h) => h.block)).toEqual([1, 6, -1]);
		expect(hits.map((h) => h.inFold)).toEqual([false, true, false]);
		expect(hits[2].note).toBe(0);
		expect(hits.map((h) => h.brief)).toEqual([true, false, true]); // block 1 carries the brief flag, the note is anchored to it
		expect(findInModel(m, 'Read the full post')).toEqual([]);
		expect(findInModel(m, 'tail paragraph')[0]).toMatchObject({ block: 8, inFold: false });
		for (const h of hits) expect(dec.decode(m.text.subarray(h.lo, h.hi)).toLowerCase()).toBe('alpha');
	});

	test('skipBrief drops the blocks the fold repeats', () => {
		expect(findInModel(m, 'alpha', { skipBrief: true }).map((h) => h.block)).toEqual([6]);
	});

	test('a match across a soft line break is one hit with a plate per line', () => {
		const hits = findInModel(m, 'delta café');
		expect(hits.length).toBe(1);
		const rects = rangesToRects(m, hits);
		expect(rects.length).toBe(2);
		expect(rects.map((r) => r.range)).toEqual([0, 0]);
		expect(rects[0].line).toBe(m.blocks[1].firstLine);
		expect(rects[1].line).toBe(m.blocks[1].firstLine + 1);
	});

	test('rects: x from glyph edges; closed fold gives none for folded hits', () => {
		const [h0, h1] = findInModel(m, 'alpha');
		const r = rangesToRects(m, [h0], { clipEm: foldEndOf(m) });
		expect(r.length).toBe(1);
		expect(r[0].x0).toBeCloseTo(0);
		// 'alpha' ends in a gap before the next glyph at column 6: one estimated space (0.27 em) is cut off that cell edge
		expect(r[0].x1).toBeCloseTo(6 - 0.27, 5);
		expect(rangesToRects(m, [h1], { clipEm: m.foldY + m.peekH })).toEqual([]);
		expect(rangesToRects(m, [h1], { clipEm: foldEndOf(m) }).length).toBe(1);
	});

	test('next, previous, nearest', () => {
		const hits = [{ lo: 5, hi: 8 }, { lo: 20, hi: 23 }, { lo: 40, hi: 43 }];
		expect(nextHit(hits, -1)).toBe(0);
		expect(nextHit(hits, 2)).toBe(0);
		expect(prevHit(hits, 0)).toBe(2);
		expect(prevHit(hits, -1)).toBe(2);
		expect(prevHit(hits, 2)).toBe(1);
		expect(nextHit([], 0)).toBe(-1);
		expect(hitFrom(hits, 0)).toBe(0);
		expect(hitFrom(hits, 8)).toBe(1);
		expect(hitFrom(hits, 21)).toBe(1);
		expect(hitFrom(hits, 43)).toBe(0); // wraps
	});
});

describe('find count equals a naive scan on the built articles', () => {
	for (const [slug, cls] of [['ifd', 'wide'], ['ifd', 'narrow'], ['hyperion', 'wide']] as const) {
		const m = loadBin(slug, cls);
		test.skipIf(!m)(`${slug} ${cls}`, () => {
			const full = dec.decode(m!.text);
			for (const q of ['the', 'The', 'nix', 'IFD', 'evaluat', 'e', 'café', '·', 'fold', 'zzzzqq', "'", 'a b']) {
				const hits = findAll(m!.text, q);
				expect(hits.length).toBe(naiveCount(full, q));
				// every hit slices back to the query under the same normalisation
				for (const h of hits.slice(0, 60)) expect(normalizeForFind(dec.decode(m!.text.subarray(h.lo, h.hi)))).toBe(normalizeForFind(q));
			}
			// through the model: only fold-button text is dropped
			const all = findAll(m!.text, 'the');
			expect(findInModel(m!, 'the').length).toBeLessThanOrEqual(all.length);
			expect(findInModel(m!, 'the').length).toBeGreaterThan(all.length - 3);
			// every in-fold hit is flagged, every hit has a line
			const fm = findInModel(m!, 'the');
			expect(fm.every((h) => h.line >= 0)).toBe(true);
		});
	}
});
