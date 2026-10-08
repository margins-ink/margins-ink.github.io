import { expect, test } from 'bun:test';
import { buildIcon, buildAll, emitRust } from './build';
import { resolve } from 'node:path';

const SRC = resolve(import.meta.dir, '../../node_modules/@iconify/json/json/material-icon-theme.json');

test('a square with a square hole triangulates to its area (planted: ignoring the hole would give 1)', () => {
	const ic = buildIcon('t', '<path fill="#ff0000" d="M0 0h10v10H0zM2.5 2.5v5h5v-5z"/>', 10);
	let a = 0;
	for (let t = 0; t < ic.tris.length; t += 6) a += Math.abs((ic.tris[t] * (ic.tris[t + 3] - ic.tris[t + 5]) + ic.tris[t + 2] * (ic.tris[t + 5] - ic.tris[t + 1]) + ic.tris[t + 4] * (ic.tris[t + 1] - ic.tris[t + 3])) / 2);
	expect(a).toBeCloseTo(0.75, 3);
	expect(ic.colours).toEqual([[1, 0, 0]]);
});

test('rust and toml: triangle area equals the filled ring area and colours match the set', () => {
	const [rust, toml] = buildAll(['rust', 'toml'], SRC);
	for (const ic of [rust, toml]) {
		let a = 0;
		for (let t = 0; t < ic.tris.length; t += 6) a += Math.abs((ic.tris[t] * (ic.tris[t + 3] - ic.tris[t + 5]) + ic.tris[t + 2] * (ic.tris[t + 5] - ic.tris[t + 1]) + ic.tris[t + 4] * (ic.tris[t + 1] - ic.tris[t + 3])) / 2);
		expect(a / ic.area).toBeGreaterThan(0.99);
		expect(a / ic.area).toBeLessThan(1.01);
		for (const v of ic.tris) { expect(v).toBeGreaterThan(-0.01); expect(v).toBeLessThan(1.01); }
	}
	expect(rust.colours).toHaveLength(1);
	expect(toml.colours).toHaveLength(2);
});

test('unknown names and unsupported markup fail loudly; the Rust table lists names in order', () => {
	expect(() => buildAll(['no-such-icon'], SRC)).toThrow();
	expect(() => buildIcon('x', '<path fill="#000" transform="scale(2)" d="M0 0h1v1z"/>', 1)).toThrow();
	expect(emitRust(buildAll(['toml', 'rust'], SRC))).toContain('["toml", "rust"]');
});
