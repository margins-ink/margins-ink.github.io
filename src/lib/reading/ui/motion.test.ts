import { describe, expect, test } from 'bun:test';
import { DUR, EASE_POINTS, ease } from './motion';

describe('motion tokens (ix site.css --ease, --dur-fast)', () => {
	test('values', () => {
		expect([...EASE_POINTS]).toEqual([0.2, 0.7, 0.2, 1]);
		expect(DUR.fast).toBe(150);
		expect(ease(0)).toBe(0);
		expect(ease(1)).toBe(1);
		expect(ease(0.5)).toBeGreaterThan(0.5); // ease-out: front loaded
	});
});
