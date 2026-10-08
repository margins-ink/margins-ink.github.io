import { describe, expect, test } from 'bun:test';
import { boundsOf, joinRows, pulse, rowRadii, shapeRows, squareMask, sweepWidth, PULSE_MS, SELECTION_ALPHA, type Row } from './selshape';

const r = (left: number, top: number, right: number, bottom: number): Row => ({ left, top, right, bottom });

describe('selection shape', () => {
	test('pulse: 1 at both ends, 1.025 at the peak, fast ease-out up then slow down', () => {
		expect(pulse(0)).toBe(1);
		expect(pulse(1)).toBe(1);
		expect(pulse(0.18)).toBeCloseTo(1.025, 6);
		expect(pulse(0.09)).toBeGreaterThan(1.02);
		for (const p of [0.05, 0.3, 0.5, 0.9]) expect(pulse(p)).toBeLessThan(1.025);
		expect(pulse(0.5)).toBeGreaterThan(pulse(0.8));
	});

	test('joinRows merges fragments of a line and makes neighbours meet without a gap', () => {
		const rows = joinRows([r(10, 0, 50, 20), r(60, 1, 90, 19), r(0, 24, 70, 44)]);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toEqual({ left: 10, top: 0, right: 90, bottom: 22 });
		expect(rows[1].top).toBe(22);
		expect(rows[1].bottom).toBe(44);
	});

	test('a paragraph break stays two shapes; snapping puts the shared edge on a device pixel', () => {
		expect(joinRows([r(0, 0, 50, 20), r(0, 60, 50, 80)], 10)).toHaveLength(2);
		const split = joinRows([r(0, 0, 50, 20), r(0, 60, 50, 80)], 10);
		expect(squareMask(split, 0)).toBe(0);
		const j = joinRows([r(0, 0, 50, 20.3), r(0, 23, 50, 40)], Infinity, 2);
		expect(j[0].bottom * 2).toBe(Math.round(j[0].bottom * 2));
		expect(j[0].bottom).toBe(j[1].top);
	});

	test('radii: square corners face a neighbour that covers them, round otherwise', () => {
		const rows = joinRows([r(0, 0, 100, 20), r(0, 20, 60, 40), r(0, 40, 80, 60)]);
		expect(rowRadii(rows, 0)).toEqual([4, 4, 4, 0]);
		// row 1 is narrower than row 0 above: its top corners stay square, its right-bottom corner is under the wider row 2: square
		expect(rowRadii(rows, 1)).toEqual([0, 0, 0, 0]);
		expect(rowRadii(rows, 2)).toEqual([0, 4, 4, 4]);
		expect(squareMask(rows, 0)).toBe(8);
		expect(rowRadii([r(0, 0, 10, 8)], 0)).toEqual([2, 2, 2, 2]);
	});

	test('shapeRows: rest is scale 1 and one shape per row; the pulse scales about the centre and adds a light per row', () => {
		const rows = joinRows([r(0, 0, 100, 20), r(0, 20, 60, 40)]);
		const rest = shapeRows(rows, -1);
		expect(rest.scale).toBe(1);
		expect(rest.rows.every((s) => !s.sweep && s.alpha === SELECTION_ALPHA)).toBe(true);
		expect(rest.rows).toHaveLength(2);
		expect(shapeRows(rows, PULSE_MS).rows.some((s) => s.sweep)).toBe(false);
		const mid = shapeRows(rows, 0.18 * PULSE_MS);
		expect(mid.scale).toBeCloseTo(1.025, 6);
		const b = boundsOf(rows);
		expect(mid.rows[0].x).toBeCloseTo(b.cx + (0 - b.cx) * 1.025, 9);
		expect(mid.rows.filter((s) => s.sweep)).toHaveLength(2);
		// the light of a later row enters later; at phase 0.5 it peaks at 0.12
		const late = shapeRows(rows, 150).rows.filter((s) => s.sweep);
		expect(late[0].alpha).toBeCloseTo(0.12, 6);
		expect(shapeRows(rows, 10).rows.filter((s) => s.sweep)[1].alpha).toBe(0);
	});

	test('reduced motion: always the resting shape', () => {
		const s = shapeRows([r(0, 0, 10, 20)], 100, true);
		expect(s.scale).toBe(1);
		expect(s.rows.some((x) => x.sweep)).toBe(false);
	});

	test('sweep width encodes mask and phase', () => {
		const w = sweepWidth(5, 0.25);
		expect(w % 16).toBe(5);
		expect(Math.floor(w / 16)).toBe(250);
	});
});
