import { describe, expect, test } from 'bun:test';
import { sampleReading, type ReadingModel } from '../magazine/format';
import { anchorAt, blockAtY, docToLayoutY, layoutToDocY, lineRangeForYSpan, resolveAnchor } from './scrollstate';

const blocks = [{ y1: 5 }, { y1: 12 }, { y1: 20 }, { y1: 40 }];

describe('blockAtY', () => {
	test('first block with y1 > y', () => {
		expect(blockAtY(blocks, 0)).toBe(0);
		expect(blockAtY(blocks, 5)).toBe(1);
		expect(blockAtY(blocks, 19.9)).toBe(2);
		expect(blockAtY(blocks, 99)).toBe(3);
		expect(blockAtY([], 1)).toBe(-1);
	});
});

describe('fold mapping', () => {
	const m = { foldY: 30, foldH: 10 };
	test('open fold maps identity, collapsed shifts the tail', () => {
		expect(docToLayoutY(m, 50, 40)).toBe(50);
		expect(layoutToDocY(m, 41, 40)).toBe(41);
		expect(layoutToDocY(m, 41, 34)).toBe(35);
		expect(docToLayoutY(m, 35, 34)).toBe(41);
		expect(layoutToDocY(m, 10, 34)).toBe(10);
	});
	test('round trip', () => {
		for (const y of [2, 33, 41, 60]) expect(docToLayoutY(m, layoutToDocY(m, y, 34), 34)).toBeCloseTo(y, 9);
	});
});

describe('anchors', () => {
	test('same class restores exactly, other class by text range fraction', () => {
		const m: ReadingModel = sampleReading();
		const k = anchorAt(m, 6, m.docH)!;
		expect(k.blockId).toBe(0);
		expect(k.offsetEm).toBeCloseTo(2, 6);
		const s = { ...k, fold: false, scale: 1 };
		expect(resolveAnchor(m, s)).toBeCloseTo(6, 6);
		const other: ReadingModel = { ...m, widthClass: 2, blocks: m.blocks.map((b) => ({ ...b, y0: b.y0 * 2, y1: b.y1 * 2 })) };
		expect(resolveAnchor(other, s)).toBeCloseTo(8 + (2 / 5) * 10 - 0, 0);
	});
	test('line ranges', () => {
		const m = sampleReading();
		expect(lineRangeForYSpan(m, 0, 100).first).toBe(0);
	});
});
