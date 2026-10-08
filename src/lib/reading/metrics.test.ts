import { describe, expect, test } from 'bun:test';
import { cubicBezier, emPxFor, originXFor, scaleSteps, snapScale, widthClassFor } from './metrics';

describe('width class', () => {
	test('boundaries', () => {
		expect(widthClassFor(1180)).toBe(0);
		expect(widthClassFor(1179)).toBe(1);
		expect(widthClassFor(720)).toBe(1);
		expect(widthClassFor(719)).toBe(2);
		expect(widthClassFor(390)).toBe(2);
	});
});

describe('emPx', () => {
	test('wide follows the clamp', () => {
		expect(emPxFor(1440, 0, 1, 57)).toBeCloseTo(15.2 + 0.0012 * 1440, 2);
		expect(emPxFor(1180, 0, 1, 57)).toBeCloseTo(Math.min(15.2 + 0.0012 * 1180, (1180 - 48) / 57), 2);
		expect(emPxFor(3000, 0, 1, 57)).toBeCloseTo(17, 5);
	});
	test('scale multiplies until the document no longer fits', () => {
		expect(emPxFor(1440, 0, 1.6, 57)).toBeCloseTo((1440 - 48) / 57, 5);
		expect(emPxFor(1440, 0, 1.1, 57)).toBeCloseTo((15.2 + 0.0012 * 1440) * 1.1, 2);
	});
	test('mid fits between gutters', () => {
		expect(emPxFor(820, 1, 1, 38)).toBeCloseTo(Math.min(15.2 + 0.0012 * 820, (820 - 48) / 38), 1);
		expect(emPxFor(720, 1, 1.4, 38)).toBeCloseTo((720 - 48) / 38, 5);
	});
	test('narrow fills the viewport minus 48 and never grows', () => {
		expect(emPxFor(390, 2, 1, 21)).toBeCloseTo(342 / 21, 5);
		expect(emPxFor(390, 2, 1.4, 21)).toBeCloseTo(342 / 21, 5);
		expect(emPxFor(390, 2, 0.9, 21)).toBeCloseTo((342 / 21) * 0.9, 5);
	});
});

describe('originX', () => {
	test('centres the extent', () => {
		const em = 20;
		const o = originXFor(1440, em, -3, 54);
		const left = o + -3 * em;
		const right = o + 54 * em;
		expect(left).toBeCloseTo(1440 - right, 6);
	});
	test('column only', () => {
		expect(originXFor(1000, 10, 0, 34)).toBeCloseTo(330, 6);
	});
});

describe('scale', () => {
	test('steps and snapping', () => {
		expect(scaleSteps).toEqual([0.9, 1, 1.1, 1.25, 1.4]);
		expect(snapScale(1.2)).toBe(1.25);
		expect(snapScale(0.5)).toBe(0.9);
		expect(snapScale(9)).toBe(1.4);
	});
});

describe('cubic bezier', () => {
	const f = cubicBezier(0.2, 0.7, 0.2, 1);
	test('endpoints and monotone', () => {
		expect(f(0)).toBe(0);
		expect(f(1)).toBe(1);
		let p = 0;
		for (let i = 1; i <= 20; i++) {
			const v = f(i / 20);
			expect(v).toBeGreaterThanOrEqual(p - 1e-9);
			p = v;
		}
		expect(f(0.5)).toBeGreaterThan(0.8);
	});
});
