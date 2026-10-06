// Hot reload at the wasm level (no browser): bun test scripts/scene-reload.test.ts
// After `scene_reload` the cab must keep its state and keep moving, floors/objects must repack, and a bad script must leave everything intact.
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { wasiImports } from '../src/lib/wasi';

const SCENE = new URL('../world/scene/', import.meta.url).pathname;
const src = (f: string) => fs.readFileSync(SCENE + f, 'utf8');
const NEON = 'prefab NeonPink : Neon { LampColour: {6, 0.8, 3.2} }';

function boot(overrides: Record<string, string> = {}) {
	let memory!: WebAssembly.Memory;
	const mod = new WebAssembly.Module(fs.readFileSync(new URL('../src/lib/gpu/room/world.wasm', import.meta.url)));
	const x = new WebAssembly.Instance(mod, wasiImports(() => memory)).exports as Record<string, any>;
	memory = x.memory;
	const r = [0, 0, 1, 1];
	const items = [
		{ slug: 'a', date: '2026-01-01', archived: false, tex: r },
		{ slug: 'b', date: '2025-01-01', archived: false, tex: r },
		{ slug: 'c', date: '2024-01-01', archived: false, tex: r },
		{ slug: 'd', date: '2020-01-01', archived: true, tex: r }
	];
	const inp = new TextEncoder().encode(JSON.stringify({ items, signs: [r, r, r, r, r], map: r }));
	const ip = x.world_input(inp.length);
	new Uint8Array(memory.buffer, ip, inp.length).set(inp);
	for (const [name, text] of Object.entries(overrides)) {
		const b = new TextEncoder().encode(`${name}\n${text}`);
		const p = x.scene_buf(b.length);
		new Uint8Array(memory.buffer, p, b.length).set(b);
		expect(x.scene_override()).toBe(0);
	}
	expect(x.world_build()).toBe(0);
	const state = () => Array.from(new Float32Array(memory.buffer, x.elevator_state_ptr(), 40));
	const objs = () => new Float32Array(memory.buffer.slice(x.world_buf(0), x.world_buf(0) + x.world_buf_len(0)));
	const err = () => new TextDecoder().decode(new Uint8Array(memory.buffer, x.world_buf(5), x.world_buf_len(5)));
	const reload = (name: string, text: string) => {
		const b = new TextEncoder().encode(`${name}\n${text}`);
		const p = x.scene_buf(b.length);
		new Uint8Array(memory.buffer, p, b.length).set(b);
		return x.scene_reload();
	};
	const run = (frames: number) => {
		for (let i = 0; i < frames; i++) {
			x.elevator_tick(16);
			x.world_tick(16);
		}
	};
	return { x, state, objs, err, reload, run };
}

/** the cab leaves floor 0 for the last floor and arrives (the whole pipeline, systems and state buffer, must still run) */
function cabRides(w: ReturnType<typeof boot>) {
	w.x.elevator_scroll(1);
	w.run(600);
	const s = w.state();
	return s[3] === s[4] && s[3] > 0 && s[0] > 3;
}

test('control: a script that declares an entity named like a Rust component breaks the pipeline, and the ride check sees it', () => {
	expect(cabRides(boot())).toBe(true);
	// `Lights {}` shares the name of the Rust component `Lights`: the script creates the entity first, so the component lives on a
	// script-owned entity that the next update deletes (the pipeline stops; this was the first bug of the hot reload)
	const w = boot({ decor: src('12-decor.flecs').replaceAll('Illuminates', 'Lights') });
	expect(w.reload('decor', src('12-decor.flecs').replaceAll('Illuminates', 'Lights'))).toBe(0);
	expect(cabRides(w)).toBe(false);
});

test('reload keeps the cab state and the ride works; objects repack with the new colour', () => {
	const w = boot();
	w.x.elevator_scroll(1);
	w.run(60); // part way: gate and doors closing, car about to leave
	const before = w.state();
	const o0 = w.objs();
	expect(w.reload('decor', src('12-decor.flecs').replace(NEON, 'prefab NeonPink : Neon { LampColour: {0.8, 6, 0.8} }'))).toBe(0);
	const after = w.state();
	expect(after[4]).toBe(before[4]); // target survives
	expect(after[5]).toBeCloseTo(before[5], 5); // gate progress survives
	expect(w.objs().length).toBe(o0.length);
	expect(w.objs().some((v, i) => v !== o0[i])).toBe(true);
	expect(cabRides(w)).toBe(true);
});

test('planted bugs: a syntax error and an unknown component are reported and leave the scene intact', () => {
	const w = boot();
	const o0 = w.objs();
	for (const bad of [NEON.replace('{ LampColour: {6, 0.8, 3.2} }', '{ LampColour: {6, '), NEON.replace('LampColour', 'Nonsense')]) {
		expect(w.reload('decor', src('12-decor.flecs').replace(NEON, bad))).toBe(1);
		expect(w.err().length).toBeGreaterThan(0);
		expect(w.objs()).toEqual(o0);
	}
	expect(cabRides(w)).toBe(true);
	expect(w.reload('decor', src('12-decor.flecs'))).toBe(0);
});
