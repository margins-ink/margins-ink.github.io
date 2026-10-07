import { describe, expect, test } from 'bun:test';
import { BlockKind, ItemType, RectKind, packItem, sampleReading, type ReadingModel } from '../magazine/format';
import { PAGE_WGSL, DATA_BASE, MH } from './page.wgsl';
import { assemblePage, blockSpan, docToClip, itemRange, noteRuns, packUiText, textRuns } from './page';
import { NO_GLYPH, type UiGlyph } from './ui/types';

const m = { originX: 100, originY: 50, scrollPx: 200, emPx: 20, viewW: 1000, viewH: 800 };

describe('docToClip', () => {
	test('maps document em to clip space', () => {
		// px = (100 + 5 * 20, 50 + 12 * 20 - 200) = (200, 90)
		const [x, y] = docToClip(m, 5, 12);
		expect(x).toBeCloseTo(200 / 1000 * 2 - 1, 6);
		expect(y).toBeCloseTo(1 - 90 / 800 * 2, 6);
	});
	test('dy moves down, dx moves left', () => {
		const [x0, y0] = docToClip(m, 5, 12);
		const [x1, y1] = docToClip(m, 5, 12, 12, 30);
		expect(y1).toBeLessThan(y0);
		expect(x1).toBeCloseTo(x0 - 60 / 1000, 6);
	});
	test('viewport corners', () => {
		const c = { originX: 0, originY: 0, scrollPx: 0, emPx: 10, viewW: 100, viewH: 50 };
		expect(docToClip(c, 0, 0)).toEqual([-1, 1]);
		expect(docToClip(c, 10, 5)).toEqual([1, -1]);
	});
});

const blk = (firstItem: number, itemCount: number, kind: number = BlockKind.para) => ({
	x0: 0, y0: 0, x1: 1, y1: 1, firstItem, itemCount, firstLine: 0, lineCount: 0, anchor: 0, ex: -1, kind, level: 0, flags: 0, section: 0, textOff: 0, textLen: 0
});

describe('itemRange', () => {
	const model = { blocks: [blk(0, 10), blk(10, 5), blk(15, 0, BlockKind.exhibit), blk(15, 7), blk(22, 3)] };
	test('envelope of the visible blocks', () => {
		expect(itemRange(model, 1, 3)).toEqual({ first: 10, count: 12 });
		expect(itemRange(model, 0, 5)).toEqual({ first: 0, count: 25 });
	});
	test('empty and clamped', () => {
		expect(itemRange(model, 2, 1)).toEqual({ first: 0, count: 0 });
		expect(itemRange(model, 4, 99)).toEqual({ first: 22, count: 3 });
		expect(itemRange(model, -3, 5)).toEqual({ first: 0, count: 15 });
	});
});

describe('textRuns', () => {
	const items = Array.from({ length: 30 }, (_, i) => packItem(ItemType.glyph, i));
	items[20] = packItem(ItemType.rect, 0);
	const rects = [{ x0: 0, y0: 0, x1: 1, y1: 1, colour: 1, kind: RectKind.codeBg, group: 0xffff, radius: 0.6 }];
	const model = { blocks: [blk(0, 10), blk(10, 5), blk(15, 10, BlockKind.code), blk(25, 5)], items, rects };
	test('merges contiguous blocks', () => {
		expect(textRuns(model, 0, 2)).toEqual([{ first: 0, count: 15, alpha: 1, dy: 0, dx: 0, clipBlock: -1 }]);
	});
	test('splits at blocks with their own alpha', () => {
		const runs = textRuns(model, 0, 4, { alpha: new Map([[1, 0.5]]) });
		expect(runs.map((r) => [r.first, r.count, r.alpha])).toEqual([[0, 10, 1], [10, 5, 0.5], [15, 5, 1], [20, 1, 1], [21, 4, 1], [25, 5, 1]]); // the code block (15..25) is always scissored to its panel
	});
	test('code block with dx: panel stays, text is clipped to the block', () => {
		const runs = textRuns(model, 2, 3, { dx: new Map([[2, 40]]) });
		expect(runs).toEqual([
			{ first: 15, count: 5, alpha: 1, dy: 0, dx: 40, clipBlock: 2 },
			{ first: 20, count: 1, alpha: 1, dy: 0, dx: 0, clipBlock: -1 },
			{ first: 21, count: 4, alpha: 1, dy: 0, dx: 40, clipBlock: 2 }
		]);
	});
	test('dx is ignored for non-code blocks; alpha 0 skips', () => {
		expect(textRuns(model, 0, 1, { dx: new Map([[0, 9]]) })[0].dx).toBe(0);
		expect(textRuns(model, 0, 1, { alpha: new Map([[0, 0]]) })).toEqual([]);
	});
});

describe('noteRuns and blockSpan', () => {
	const notes = [0, 1, 2].map((i) => ({ x0: 0, y0: 0, x1: 1, y1: 1, firstItem: 40 + i * 3, itemCount: 3, firstLine: 0, lineCount: 0, anchorBlock: i, anchorLine: 0, refIndex: i }));
	test('coalesces adjacent notes, filters by only', () => {
		expect(noteRuns({ notes }, 0, 3)).toEqual([{ first: 40, count: 9, alpha: 1, dy: 0, dx: 0, clipBlock: -1 }]);
		expect(noteRuns({ notes }, 0, 3, { first: 1, count: 1 }).map((r) => [r.first, r.count])).toEqual([[43, 3]]);
	});
	test('blockSpan applies only', () => {
		expect(blockSpan({ visFirst: 2, visCount: 5 }, 10)).toEqual([2, 7]);
		expect(blockSpan({ visFirst: 2, visCount: 5, only: { first: 0, count: 3 } }, 10)).toEqual([2, 3]);
		expect(blockSpan({ visFirst: 8, visCount: 9 }, 10)).toEqual([8, 10]);
	});
});

describe('assemblePage', () => {
	test('sample article lays out header and sections', () => {
		const model: ReadingModel = sampleReading();
		const a = assemblePage({ dir: new Uint32Array(8), curves: new Uint16Array(8), bands: new Uint32Array(2) }, model);
		expect(a.words[MH.nBlocks]).toBe(2);
		expect(a.words[MH.nExhibits]).toBe(1);
		expect(a.words[MH.fdir]).toBe(DATA_BASE);
		const offs = Object.entries(MH).filter(([k]) => !k.startsWith('n') && k !== 'magic' && k !== 'chans').map(([, v]) => a.words[v]).sort((x, y) => x - y);
		expect(offs[offs.length - 1]).toBeLessThanOrEqual(a.words.length);
		for (let i = 1; i < offs.length; i++) expect(offs[i]).toBeGreaterThanOrEqual(offs[i - 1]);
	});
});

describe('WGSL', () => {
	test('no leftover spread / peel / selection identifiers', () => {
		for (const bad of ['spread_albedo', 'mg_peel', 'MG_SEL_BASE', 'mg_hov', 'MH_SPREADS', 'PAL_PAPER']) expect(PAGE_WGSL).not.toContain(bad);
	});
	test('has every entry point and no unresolved interpolation', () => {
		for (const e of ['vs_ground', 'fs_ground', 'vs_text', 'fs_text', 'vs_fig', 'fs_fig', 'vs_ovl', 'fs_ovl', 'vs_ui', 'fs_ui', 'fn fig_eval']) expect(PAGE_WGSL).toContain(e);
		expect(PAGE_WGSL).not.toContain('${');
		expect(PAGE_WGSL).not.toContain('undefined');
	});
});

describe('packUiText', () => {
	const g = (o: Partial<UiGlyph> = {}): UiGlyph => ({ x: 10, y: 20, glyphId: 7, font: 'sans', size: 14, r: 0.1, g: 0.2, b: 0.3, a: 0.5, ...o });
	const run = (list: UiGlyph[], glyphs = 100, extended = false, gain = 1) => {
		const out = new Float32Array(4096 * 12);
		return { n: packUiText(list, glyphs, extended, gain, out), out };
	};
	test('layout: x y size id, rgba straight, hdr', () => {
		const { n, out } = run([g(), g({ x: 11, glyphId: 9 })]);
		expect(n).toBe(2);
		expect([...out.slice(0, 3)]).toEqual([10, 20, 14]);
		expect(out[3]).toBe(7);
		expect(out[4]).toBeCloseTo(0.1, 6);
		expect(out[7]).toBe(0.5);
		expect(out[8]).toBe(1);
		expect(out[12]).toBe(11);
		expect(out[15]).toBe(9);
	});
	test('glyph ids out of range, NO_GLYPH, bad size, NaN and zero alpha are skipped', () => {
		const { n, out } = run([g({ glyphId: 100 }), g({ glyphId: NO_GLYPH }), g({ size: 0 }), g({ x: NaN }), g({ a: 0 }), g({ glyphId: 99 })]);
		expect(n).toBe(1);
		expect(out[3]).toBe(99);
	});
	test('hdr only on extended canvases and capped by hdrGain; alpha clamped', () => {
		expect(run([g({ hdr: 3 })], 100, false, 2).out[8]).toBe(1);
		expect(run([g({ hdr: 3 })], 100, true, 2).out[8]).toBe(2);
		expect(run([g({ hdr: 1.5 })], 100, true, 2).out[8]).toBe(1.5);
		expect(run([g({ a: 4 })]).out[7]).toBe(1);
	});
	test('capped at 8192 glyphs', () => {
		expect(run(Array.from({ length: 9000 }, () => g())).n).toBe(8192);
	});
	test('shader reads the same union glyph table and coverage as the article text', () => {
		const ui = PAGE_WGSL.slice(PAGE_WGSL.indexOf('fn vs_ui'));
		expect(ui).toContain('reader[MH_FDIR]');
		expect(ui).toContain('slug_cov(u32(g0.w)');
		expect(ui).toContain('pg_out(');
		expect(PAGE_WGSL).toContain('@group(1) @binding(4) var<storage, read> uitext');
	});
});
