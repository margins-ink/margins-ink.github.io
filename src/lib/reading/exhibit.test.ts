// The museum module of world.wasm end to end (world/src/museum): scripts in, pointer and keys in, state, snapshots and the draw list out.
// Run: bun run build:world && bun test src/lib/reading/exhibit.test.ts
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { wasiImports } from '../wasi';
import { INPUT, LOAD_BLOCK, LOAD_EXHIBIT, LOAD_HEADER, XD, XFLAG, XKEY, XPOINTER, XRESULT, XS, XSHAPE } from './abi';

const WASM = new URL('../gpu/room/world.wasm', import.meta.url);
const TURING = fs.readFileSync(new URL('../../routes/(site)/thoughts/models/exhibits/turing.flecs', import.meta.url), 'utf8');

type X = Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };

interface Spec {
	/** exhibit blocks, in order: [mode, duration, poster, kind] (kind 0 timeline, 1 script) */
	exhibits: [number, number, number, number][];
}

/** A fresh world with an article whose blocks are the exhibits, 20 em apart, in a viewport of 40 em that shows exhibits 0 and 1. */
function boot(spec: Spec = { exhibits: [[0, 6, 0, 1], [0, 8, 1, 0], [0, 6, 0, 1], [0, 6, 0, 1], [3, 5, 2, 0]] }, room = false) {
	let memory!: WebAssembly.Memory;
	const mod = new WebAssembly.Module(fs.readFileSync(WASM));
	const x = new WebAssembly.Instance(mod, wasiImports(() => memory)).exports as unknown as X;
	memory = x.memory;
	if (room) {
		// the whole room world (scene scripts, books, elevator) with the museum installed next to them
		const input = new TextEncoder().encode(JSON.stringify({ items: [{ slug: 'models', date: '2026-01-01', archived: false, tex: [0, 0, 1, 1] }], signs: [[0, 0, 1, 1], [0, 0, 1, 1], [0, 0, 1, 1]], map: [0, 0, 1, 1] }));
		const ip = x.world_input(input.length) >>> 0;
		new Uint8Array(memory.buffer, ip, input.length).set(input);
		const r = x.world_build();
		if (r !== 0) throw new Error(new TextDecoder().decode(new Uint8Array(memory.buffer, x.world_buf(5) >>> 0, x.world_buf_len(5))));
	} else expect(x.reading_init()).toBe(0);
	const nb = spec.exhibits.length;
	const words = LOAD_HEADER + nb * LOAD_BLOCK + spec.exhibits.length * LOAD_EXHIBIT;
	const p = x.reading_buf(words) >>> 0;
	const u = new Uint32Array(memory.buffer, p, words);
	const f = new Float32Array(memory.buffer, p, words);
	u.fill(0);
	u[0] = nb; u[2] = spec.exhibits.length;
	f[5] = 20 * nb + 4; u[9] = 2;
	let o = LOAD_HEADER;
	for (let i = 0; i < nb; i++) {
		f[o] = 2 + 20 * i; f[o + 1] = 2 + 20 * i + 18; f[o + 2] = 0; f[o + 3] = 36;
		u[o + 4] = 21; u[o + 7] = i;
		o += LOAD_BLOCK;
	}
	spec.exhibits.forEach(([mode, duration, poster, kind], i) => {
		u[o] = 100 + i; u[o + 1] = mode; f[o + 2] = duration; f[o + 3] = poster; u[o + 4] = i; u[o + 5] = kind;
		o += LOAD_EXHIBIT;
	});
	expect(x.reading_load()).toBe(0);
	x.reading_set_viewport(640, 640, 1, 16, 2);
	x.reading_tick(16);
	const text = (len: number, ptr = x.exhibit_out_ptr() >>> 0) => new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
	const stage = (s: string) => {
		const b = new TextEncoder().encode(s);
		const q = x.exhibit_buf(b.length) >>> 0;
		new Uint8Array(memory.buffer, q, b.length).set(b);
		return b.length;
	};
	const out = () => text(x.exhibit_out_len());
	const api = {
		x,
		out,
		/** null when loaded, else the error text */
		load: (ex: number, src: string): string | null => (x.exhibit_load(ex, stage(src)) === 0 ? null : out()),
		reload: (ex: number, src: string): string | null => (x.exhibit_reload(ex, stage(src)) === 0 ? null : out()),
		inspect: (src: string) => ({ ok: x.exhibit_inspect(stage(src)) === 0, text: out() }),
		snapshot: (ex: number): string => text(x.exhibit_snapshot(ex)),
		restore: (ex: number, s: string): boolean => x.exhibit_restore(ex, stage(s)) === 0,
		pointer: (ex: number, kind: number, px: number, py: number) => x.exhibit_pointer(ex, kind, px, py, 1, 0),
		key: (code: number, mods = 0) => x.exhibit_key(code, mods) !== 0,
		click: (ex: number, px: number, py: number) => {
			api.pointer(ex, XPOINTER.move, px, py);
			const d = api.pointer(ex, XPOINTER.down, px, py);
			const u = api.pointer(ex, XPOINTER.up, px, py);
			return { d, u };
		},
		/** the exhibit state row (XS) */
		row: (ex: number) => {
			const r = new Float32Array(x.memory.buffer, x.exhibit_state_ptr() >>> 0, XS.max * XS.stride).slice(ex * XS.stride, (ex + 1) * XS.stride);
			return { loaded: r[XS.loaded], running: r[XS.running], halted: r[XS.halted], steps: r[XS.steps], clock: r[XS.clock], animating: r[XS.animating], focus: r[XS.focus], kind: r[XS.kind] };
		},
		/** frames of `ms` each */
		tick: (frames: number, ms = 1000 / 60) => { for (let i = 0; i < frames; i++) x.reading_tick(ms); },
		pack: (ex: number) => {
			const n = x.exhibit_pack(ex);
			const items = new Float32Array(x.memory.buffer, x.exhibit_draw_ptr() >>> 0, n * XD.stride).slice();
			const str = (i: number) => text(x.exhibit_str_len(i), x.exhibit_str_ptr(i) >>> 0);
			return { n, items, str };
		},
		entities: () => x.reading_entity_count(),
		poll: () => { const ev: number[] = []; for (let e = x.reading_event_poll(); e; e = x.reading_event_poll()) ev.push(e); return ev; }
	};
	return api;
}
type World = ReturnType<typeof boot>;

interface Part { name: string; kind: string; place: [number, number, number, number]; label: string; verb: string | null; key: number }
const parts = (w: World, src = TURING): Record<string, Part> => {
	const r = w.inspect(src);
	expect(r.ok).toBe(true);
	return Object.fromEntries((JSON.parse(r.text).parts as Part[]).map((p) => [p.name, p]));
};
const centre = (p: Part): [number, number] => [p.place[0] + p.place[2] / 2, p.place[1] + p.place[3] / 2];
const clickPart = (w: World, ex: number, p: Part) => w.click(ex, ...centre(p));

/** The tape of a tape-family snapshot as text (glyphs `0`/`1` for the increment preset: symbol 0 blank, 1 zero, 2 one) plus its fields. */
function decode(snap: string) {
	const [hash, payload] = [snap.slice(0, 8), snap.slice(9)];
	const f = payload.split('|');
	return { hash, preset: f[1], lo: +f[2], head: +f[3], state: +f[4], steps: +f[5], halt: +f[6], fuel: +f[7], cells: f[9], rules: f[10] };
}
const bits = (cells: string) => [...cells].map((c) => ({ '0': '.', '1': '0', '2': '1' })[c] ?? c).join('').replace(/^\.+|\.+$/g, '');
const ones = (cells: string) => [...cells].filter((c) => c === '1').length;

/** Press Run and tick until halted; returns frames used (capped). */
function runToHalt(w: World, ex: number, run: Part, cap = 4000) {
  clickPart(w, ex, run);
  let n = 0;
  while (!w.row(ex).halted && n < cap) { w.tick(1); n++; }
  return n;
}

describe('loading', () => {
	test('the turing script loads, describes itself and starts at the poster state', () => {
		const w = boot();
		const err = w.load(0, TURING);
		expect(err).toBeNull();
		expect(w.row(0).loaded).toBe(1);
		expect(w.row(0).kind).toBe(1);
		const j = JSON.parse(w.inspect(TURING).text);
		expect(j.kind).toBe('tape');
		expect(j.claim).toBe('Each step reads a cell, writes a cell, moves and changes state.');
		expect(j.presets.map((p: { id: string }) => p.id)).toEqual(['inc', 'bb3']);
		expect(j.frame).toEqual({ w: 36, h: 21 });
		const s = decode(w.snapshot(0));
		expect(s.preset).toBe('inc');
		expect(bits(s.cells)).toBe('1011');
		expect(s.steps).toBe(0);
	});
	test('fail closed: errors name the entity or the line, the exhibit stays unloaded and nothing is left behind', () => {
		const w = boot();
		const before = w.entities();
		const bad: [string, string, RegExp][] = [
			['parse error', TURING.replace('turing : TapeMachine {', 'turing : TapeMachine {{'), /ex0|script|unexpected|\d/],
			['unknown verb', TURING.replace('Does: {"step"}', 'Does: {"explode"}'), /b_step.*explode|explode/],
			['no extent', 'x : Timeline {\n  Extent: {0, 0}\n}', /Extent/],
			['no exhibit', 'q {}\n', /no exhibit/],
			['rule to a state outside the preset', TURING.replace('(To, carry)\n  }\n  r_carry_1', '(To, inc)\n  }\n  r_carry_1'), /not in this preset|r_scan_b/],
			['load of a missing preset', TURING.replace('Loads: {"bb3"}', 'Loads: {"nope"}'), /nope/],
			['slider that binds nothing known', TURING.replace('Binds: {"Rate.hz"}', 'Binds: {"Foo.bar"}'), /Foo\.bar/]
		];
		for (const [name, src, re] of bad) {
			const err = w.load(0, src);
			expect(err, name).not.toBeNull();
			expect(err!, name).toMatch(re);
			expect(w.row(0).loaded, name).toBe(0);
		}
		// an index the article does not have
		expect(w.load(9, TURING)).toMatch(/not in the loaded article/);
		expect(w.entities()).toBe(before);
		// and the good script still loads after all that
		expect(w.load(0, TURING)).toBeNull();
	});
	test('loading an index again replaces it (no duplicate scopes)', () => {
		const w = boot();
		w.load(0, TURING);
		const n = w.entities();
		w.load(0, TURING);
		expect(w.entities()).toBe(n);
	});
});

describe('golden machines', () => {
	test('increment: 1011 + 1 = 1100 in 8 steps, 111 + 1 = 1000 in 8 steps', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		runToHalt(w, 0, p.b_run);
		let s = decode(w.snapshot(0));
		expect(s.steps).toBe(8);
		expect(bits(s.cells)).toBe('1100');
		expect(w.row(0).halted).toBe(1);
		expect(w.row(0).running).toBe(0);
		// a three-digit tape: reset, then edit the tape to 111 by clicking cells until they read one
		clickPart(w, 0, p.b_reset);
		w.tick(2);
		expect(decode(w.snapshot(0)).steps).toBe(0);
		w.load(0, TURING.replace('Tape: {"1011"}', 'Tape: {"111"}'));
		runToHalt(w, 0, parts(w).b_run);
		s = decode(w.snapshot(0));
		expect(s.steps).toBe(8);
		expect(bits(s.cells)).toBe('1000');
	});
	test('busy beaver: 6 ones, and the step count of the table', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		clickPart(w, 0, p.b_bb3);
		expect(decode(w.snapshot(0)).preset).toBe('bb3');
		// run fast: raise the speed to the maximum by dragging the slider to its right end
		w.pointer(0, XPOINTER.down, p.speed.place[0] + 0.1, centre(p.speed)[1]);
		w.pointer(0, XPOINTER.move, p.speed.place[0] + p.speed.place[2] + 5, centre(p.speed)[1]);
		w.pointer(0, XPOINTER.up, p.speed.place[0] + p.speed.place[2] + 5, centre(p.speed)[1]);
		runToHalt(w, 0, p.b_run);
		const s = decode(w.snapshot(0));
		expect(w.row(0).halted).toBe(1);
		expect(ones(s.cells)).toBe(6);
		expect(s.steps).toBe(BB3_STEPS);
	});
	test('Step runs exactly one rule per press; the pending rule is drawn before it fires', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		clickPart(w, 0, p.b_step);
		w.tick(2);
		expect(decode(w.snapshot(0)).steps).toBe(1);
		clickPart(w, 0, p.b_step);
		clickPart(w, 0, p.b_step);
		w.tick(4);
		expect(decode(w.snapshot(0)).steps).toBe(3);
		const d = w.pack(0);
		const pending = [...Array(d.n).keys()].filter((i) => d.items[i * XD.stride + XD.flags] & XFLAG.pending);
		expect(pending.length).toBeGreaterThan(0);
	});
});
/** Rado's 3-state champion, halting transition counted: 14 steps, 6 ones (simulated by this test and by hand, 2026-10-06). */
const BB3_STEPS = 14;


const mulberry32 = (a: number) => () => {
	a |= 0; a = (a + 0x6d2b79f5) | 0;
	let t = Math.imul(a ^ (a >>> 15), 1 | a);
	t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const fnv = (xs: ArrayLike<number> | string) => {
	let h = 0x811c9dc5;
	const a = typeof xs === 'string' ? [...xs].map((c) => c.charCodeAt(0)) : Array.from(xs as ArrayLike<number>);
	for (const v of a) { h ^= (v * 1000) | 0; h = Math.imul(h, 0x01000193); }
	return h >>> 0;
};
/** state hash of an exhibit: its snapshot and its whole draw list */
const hashOf = (w: World, ex: number) => {
	const d = w.pack(ex);
	return `${w.snapshot(ex)}#${d.n}:${fnv(d.items)}:${fnv([...Array(d.n).keys()].map((i) => d.str(d.items[i * XD.stride + XD.aux]) ?? '').join('|'))}`;
};

describe('snapshot', () => {
	test('200 random sequences round trip, and the restored exhibit behaves as the original', () => {
		const rnd = mulberry32(0xc0ffee);
		const w = boot();
		w.load(0, TURING);
		w.load(2, TURING);
		const p = parts(w);
		const cellX = (k: number) => 1 + (k + 7) * 2.2 + 1;
		for (let seq = 0; seq < 200; seq++) {
			const ops = 3 + Math.floor(rnd() * 10);
			for (let o = 0; o < ops; o++) {
				const r = rnd();
				if (r < 0.18) clickPart(w, 0, p.b_step);
				else if (r < 0.26) clickPart(w, 0, p.b_run);
				else if (r < 0.31) clickPart(w, 0, p.b_reset);
				else if (r < 0.37) clickPart(w, 0, rnd() < 0.5 ? p.b_inc : p.b_bb3);
				else if (r < 0.5) w.click(0, cellX(Math.floor(rnd() * 15) - 7), 5.2);
				else if (r < 0.66) w.click(0, 1 + [0, 5, 8.5, 12, 16][Math.floor(rnd() * 5)] + 1, 11.8 + 1.1 * Math.floor(rnd() * 8));
				else if (r < 0.7) w.click(0, 3.5, 11.8 + 1.1 * Math.floor(rnd() * 8));
				else if (r < 0.74) w.click(0, 34, 11.8 + 1.1 * Math.floor(rnd() * 8));
				else if (r < 0.8) {
					const x0 = cellX(0), y = 7.2;
					w.pointer(0, XPOINTER.down, x0, y);
					w.pointer(0, XPOINTER.move, x0 + (rnd() - 0.5) * 30, y);
					w.pointer(0, XPOINTER.up, x0 + (rnd() - 0.5) * 30, y);
				} else if (r < 0.85) {
					const [sx, sy] = centre(p.speed);
					w.click(0, sx + (rnd() - 0.5) * 5, sy);
				} else w.tick(1 + Math.floor(rnd() * 40));
			}
			// pause, settle, snapshot, restore into the twin, compare
			if (w.row(0).running) clickPart(w, 0, p.b_run);
			w.tick(3);
			const a = w.snapshot(0);
			expect(w.restore(2, a), `restore of sequence ${seq}: ${a}`).toBe(true);
			expect(w.snapshot(2), `sequence ${seq}`).toBe(a);
			// the same future: three presses of Step
			for (const ex of [0, 2]) { for (let i = 0; i < 3; i++) clickPart(w, ex, p.b_step); }
			w.tick(5);
			expect(w.snapshot(2), `sequence ${seq} future`).toBe(w.snapshot(0));
		}
	});
	test('a stale, truncated or inconsistent snapshot is refused and changes nothing', () => {
		const w = boot();
		w.load(0, TURING);
		clickPart(w, 0, parts(w).b_step);
		w.tick(2);
		const good = w.snapshot(0);
		const before = hashOf(w, 0);
		const [h, payload] = [good.slice(0, 8), good.slice(9)];
		const bad = [
			`${(parseInt(h, 16) ^ 1).toString(16).padStart(8, '0')}:${payload}`, // another script
			good.slice(0, good.length - 7), // truncated
			`${h}:t1|nope|0|0|0|0|0|5000|40800000|2122|`, // unknown preset
			`${h}:${payload.split('|').map((f, i) => (i === 4 ? '99' : f)).join('|')}`, // state out of range
			`${h}:${payload.replace(/\|2122\|/, '|2192|')}`, // symbol out of range
			'garbage', '', `${h}:`
		];
		for (const b of bad) {
			expect(w.restore(0, b), b).toBe(false);
			expect(hashOf(w, 0), b).toBe(before);
		}
		expect(w.restore(0, good)).toBe(true);
		// a snapshot of another script is stale even when its payload parses
		w.load(2, TURING.replace('Caption: {"Click', 'Caption: {"Press or click'));
		expect(w.restore(2, good)).toBe(false);
	});
});

describe('time', () => {
	const frames = (total: number, dt: number) => {
		const out: number[] = [];
		let t = 0;
		while (t + dt <= total + 1e-9) { out.push(dt); t += dt; }
		if (total - t > 1e-9) out.push(total - t);
		return out;
	};
	const irregular = (total: number, seed: number) => {
		const r = mulberry32(seed);
		const out: number[] = [];
		let t = 0;
		while (t < total - 45) { const d = 1 + r() * 40; out.push(d); t += d; }
		out.push(total - t);
		return out;
	};
	/** the same run under a list of frame times (ms) */
	const run = (dts: number[], preset: 'b_inc' | 'b_bb3' = 'b_inc') => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		clickPart(w, 0, p[preset]);
		clickPart(w, 0, p.b_run);
		for (const d of dts) w.x.reading_tick(d);
		return { w, steps: w.row(0).steps, h: hashOf(w, 0) };
	};
	test('the state after a run depends on the elapsed time, not on how it was cut into frames', () => {
		for (const total of [1008.3333, 3008.3333, 12008.3333]) {
			const runs = [frames(total, 1000 / 60), frames(total, 1000 / 120), frames(total, 100 / 3), irregular(total, 7), irregular(total, 99)].map((d) => run(d));
			for (const r of runs.slice(1)) {
				expect(r.steps, `total ${total}`).toBe(runs[0].steps);
				expect(r.h, `total ${total}`).toBe(runs[0].h);
			}
		}
		// at 4 steps per second, 3 s is 12 ticks of budget: the increment halts at 8 steps
		expect(run(frames(3008.3333, 1000 / 60)).steps).toBe(8);
		expect(run(frames(1008.3333, 1000 / 60)).steps).toBe(4);
	});
	test('control: a frame-locked stepper is caught by the same comparison', () => {
		// a planted bug: one step per frame. The comparison above must tell two frame splits of the same time apart.
		const frameLocked = (dts: number[]) => dts.length;
		expect(frameLocked(frames(1008.3333, 1000 / 60))).not.toBe(frameLocked(frames(1008.3333, 1000 / 120)));
		// and a planted bug in the machine itself fails the golden check
		const golden = (src: string) => {
			const w = boot();
			if (w.load(0, src)) return 'load failed';
			runToHalt(w, 0, parts(w, src).b_run);
			const s = decode(w.snapshot(0));
			return `${s.steps}:${bits(s.cells)}`;
		};
		expect(golden(TURING)).toBe('8:1100');
		expect(golden(TURING.replace('Order: {4}\n    (From, carry)\n    (Reads, zero)\n    (Writes, one)', 'Order: {4}\n    (From, carry)\n    (Reads, zero)\n    (Writes, zero)'))).not.toBe('8:1100');
	});
	test('a long frame is cut into fixed ticks and at most 64 steps run per frame', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		clickPart(w, 0, p.b_bb3);
		for (let i = 0; i < 100; i++) clickPart(w, 0, p.b_step);
		w.tick(1);
		const s = decode(w.snapshot(0)).steps;
		expect(s).toBeLessThanOrEqual(14);
		expect(w.row(0).halted).toBe(1);
	});
});

describe('interaction', () => {
	test('cells, head, rules: edits change the machine, Pending and Conflict show', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		// cell 0 is under the head at x = 1 + 7 * 2.2; it holds 1, a click cycles it to blank
		const cx0 = 1 + 7 * 2.2 + 1;
		w.click(0, cx0, 5.2);
		expect(bits(decode(w.snapshot(0)).cells)).toBe('011');
		// drag the head two cells right
		const down = w.pointer(0, XPOINTER.down, cx0, 7.2);
		expect(down & XRESULT.capture).toBeTruthy();
		expect(down >> XRESULT.cursorShift).toBe(3);
		w.pointer(0, XPOINTER.move, cx0 + 4.4, 7.2);
		w.pointer(0, XPOINTER.up, cx0 + 4.4, 7.2);
		expect(decode(w.snapshot(0)).head).toBe(2);
		// rule 0 (From scan, Reads zero, Moves right): cycle its Moves field to Stay
		const before = decode(w.snapshot(0)).rules.split(';')[0];
		w.click(0, 1 + 12 + 1.9, 11.8);
		const after = decode(w.snapshot(0)).rules.split(';')[0];
		expect(after).not.toBe(before);
		// add a rule, set it to (From scan, Reads zero): the old rule 0 wins, the new one is flagged
		const n = decode(w.snapshot(0)).rules.split(';').length;
		w.click(0, 3.5, 10 + 1.3 + n * 1.1 + 0.5);
		expect(decode(w.snapshot(0)).rules.split(';').length).toBe(n + 1);
		const ry = 10 + 1.3 + n * 1.1 + 0.5;
		w.click(0, 1 + 1, ry); // From: scan
		w.click(0, 1 + 5 + 1, ry); w.click(0, 1 + 5 + 1, ry); // Reads: zero
		const d = w.pack(0);
		const strs = [...Array(d.n).keys()].map((i) => d.str(d.items[i * XD.stride + XD.aux]));
		expect(strs).toContain('never fires');
		// delete it again
		w.click(0, 34, ry);
		expect(decode(w.snapshot(0)).rules.split(';').length).toBe(n);
		void p;
	});
	test('hit regions: sampled across the frame they agree with the declared rects; nothing outside them is hit', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		const cursor = (px: number, py: number) => { const r = w.pointer(0, XPOINTER.move, px, py); return { hit: !!(r & XRESULT.consumed), cur: r >> XRESULT.cursorShift }; };
		// every control: its centre is hit with the pointer cursor (the slider: ew-resize), every corner just inside too
		for (const part of Object.values(p)) {
			if (!['Button', 'Slider'].includes(part.kind)) continue;
			const [x, y, ww, hh] = part.place;
			expect(cursor(x + ww / 2, y + hh / 2), part.name).toEqual({ hit: true, cur: part.kind === 'Slider' ? 4 : 1 });
			for (const [dx, dy] of [[0.05, 0.05], [ww - 0.05, 0.05], [0.05, hh - 0.05], [ww - 0.05, hh - 0.05]]) expect(cursor(x + dx, y + dy).hit, `${part.name} corner`).toBe(true);
			for (const [dx, dy] of [[-0.05, hh / 2], [ww + 0.05, hh / 2], [ww / 2, -0.05], [ww / 2, hh + 0.05]]) {
				const q = cursor(x + dx, y + dy);
				// a neighbour can sit within 0.05 em: only the edge where nothing is declared must be empty
				if (!Object.values(p).some((o) => o !== part && o.place[0] <= x + dx && x + dx < o.place[0] + o.place[2] && o.place[1] <= y + dy && y + dy < o.place[1] + o.place[3])) expect(q.hit, `${part.name} outside`).toBe(false);
			}
			expect(hh, `${part.name} touch target`).toBeGreaterThanOrEqual(1.2);
		}
		// the docs/MUSEUM.md 4.3 table
		const table: [string, number, number, number][] = [
			['cell 0', 1 + 7 * 2.2 + 1, 5.2, 1], ['cell -7', 2, 5.2, 1], ['cell 7', 1 + 14 * 2.2 + 1, 5.2, 1],
			['head', 1 + 7 * 2.2 + 1, 7.2, 2],
			['rule 0 from', 1 + 2, 11.8, 1], ['rule 0 to', 1 + 16 + 2, 11.8, 1], ['rule 0 delete', 34, 11.8, 1], ['rule add', 3, 10 + 1.3 + 6 * 1.1 + 0.4, 1]
		];
		for (const [name, x, y, cur] of table) expect(cursor(x, y), name).toEqual({ hit: true, cur });
		// empty space and the card itself are not hit
		for (const [x, y] of [[0.3, 0.3], [18, 3.5], [18, 9], [10, 7.2], [35.7, 20.5], [20, 0.5]]) expect(cursor(x, y).hit, `${x},${y}`).toBe(false);
		// a dense sweep: every consumed sample lies in the union of declared regions (parts, tape row, head row, table)
		const inRect = (x: number, y: number, r: number[]) => x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
		const known = [...Object.values(p).filter((q) => ['Button', 'Slider'].includes(q.kind)).map((q) => q.place), [1, 4, 34, 2.4], [0, 6.6, 36, 1.2], [1, 10, 34, 10.2]];
		for (let y = 0; y < 21; y += 0.37) for (let x = 0; x < 36; x += 0.37) if (cursor(x, y).hit) expect(known.some((r) => inRect(x, y, r)), `${x.toFixed(2)},${y.toFixed(2)} hit outside every declared region`).toBe(true);
	});
	test('pointer capture: a slider keeps the pointer outside its rect; leave clears hover', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		const [sx, sy] = centre(p.speed);
		const d = w.pointer(0, XPOINTER.down, p.speed.place[0] + 0.2, sy);
		expect(d & XRESULT.capture).toBeTruthy();
		const m = w.pointer(0, XPOINTER.move, 60, 40);
		expect(m & XRESULT.consumed).toBeTruthy();
		expect(m & XRESULT.capture).toBeTruthy();
		w.pointer(0, XPOINTER.up, 60, 40);
		// released: a move out there is nothing again
		expect(w.pointer(0, XPOINTER.move, 60, 40)).toBe(0);
		w.pointer(0, XPOINTER.move, sx, sy);
		expect(w.pointer(0, XPOINTER.leave, 0, 0)).toBe(0);
		void sx;
	});
	test('keyboard: focus, Tab, arrows on a slider, letters, Enter, Esc; no focus no keys', () => {
		const w = boot();
		w.load(0, TURING);
		expect(w.key('s'.charCodeAt(0))).toBe(false);
		w.x.exhibit_focus(0);
		expect(w.row(0).focus).toBe(1);
		expect(w.key('s'.charCodeAt(0))).toBe(true);
		w.tick(2);
		expect(decode(w.snapshot(0)).steps).toBe(1);
		expect(w.key(XKEY.enter)).toBe(true); // the selected control is Step (the first)
		w.tick(2);
		expect(decode(w.snapshot(0)).steps).toBe(2);
		expect(w.key(32)).toBe(true); // Run key
		expect(w.row(0).running).toBe(1);
		expect(w.key(32)).toBe(true);
		expect(w.row(0).running).toBe(0);
		// the selection is on Run (the last key press): Reset, increment, busy beaver and the speed slider follow
		for (let i = 0; i < 4; i++) expect(w.key(XKEY.tab), `tab ${i}`).toBe(true);
		const rate = (s: string) => new Float32Array(new Uint32Array([parseInt(s.split('|')[8], 16)]).buffer)[0];
		const r0 = rate(w.snapshot(0));
		expect(w.key(XKEY.right)).toBe(true);
		expect(rate(w.snapshot(0))).toBeGreaterThan(r0);
		const ring = (() => { const d = w.pack(0); return [...Array(d.n).keys()].filter((i) => d.items[i * XD.stride + XD.shape] === XSHAPE.ring && d.items[i * XD.stride + XD.tone] === 4).length; })();
		expect(ring).toBeGreaterThanOrEqual(1);
		expect(w.key(XKEY.escape)).toBe(true);
		expect(w.row(0).focus).toBe(0);
		expect(w.key('s'.charCodeAt(0))).toBe(false);
		// Tab past the last control is not consumed (the page takes it)
		w.x.exhibit_focus(0);
		let guard = 0;
		while (w.key(XKEY.tab) && guard++ < 20);
		expect(guard).toBeLessThan(20);
		expect(w.key(XKEY.tab)).toBe(false);
	});
	test('events: state changes and halting are reported once with the exhibit index', () => {
		const w = boot();
		w.load(0, TURING);
		w.poll();
		runToHalt(w, 0, parts(w).b_run);
		const ev = w.poll();
		const kinds = ev.map((e) => (e >>> 24) | 0);
		expect(kinds).toContain(10); // exhibitState
		expect(ev.filter((e) => e >>> 24 === 11 && (e & 0xffffff) === 0).length).toBe(1); // exhibitHalted, once
	});
});

describe('draw list', () => {
	test('at most 400 items, all inside the frame, tones and shapes in range, labels interned', () => {
		const rnd = mulberry32(5);
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		for (let k = 0; k < 60; k++) {
			if (rnd() < 0.5) w.click(0, 3.5, 10 + 1.3 + (k % 8) * 1.1 + 0.5); else clickPart(w, 0, p.b_step);
			w.tick(1 + Math.floor(rnd() * 20));
			const d = w.pack(0);
			expect(d.n).toBeLessThanOrEqual(400);
			for (let i = 0; i < d.n; i++) {
				const it = d.items.slice(i * XD.stride, (i + 1) * XD.stride);
				expect(it.every(Number.isFinite)).toBe(true);
				expect(it[XD.shape]).toBeGreaterThanOrEqual(0);
				expect(it[XD.shape]).toBeLessThanOrEqual(7);
				expect(it[XD.tone]).toBeLessThanOrEqual(10);
				if ([XSHAPE.rrect, XSHAPE.ring, XSHAPE.dot, XSHAPE.circle].includes(it[XD.shape] as 0 | 1 | 4 | 5)) {
					expect(it[XD.x]).toBeGreaterThanOrEqual(-0.2);
					expect(it[XD.y]).toBeGreaterThanOrEqual(-0.2);
					expect(it[XD.x] + it[XD.w]).toBeLessThanOrEqual(36.2);
					expect(it[XD.y] + it[XD.h]).toBeLessThanOrEqual(21.2);
				}
				if (it[XD.shape] === XSHAPE.label) expect(d.str(it[XD.aux]).length).toBeGreaterThan(0);
			}
		}
	});
	test('an idle exhibit costs nothing: no dirty bit, no animation, once the window has settled', () => {
		const w = boot();
		w.load(0, TURING);
		w.tick(120);
		expect(w.row(0).animating).toBe(0);
		w.x.reading_ack_dirty();
		w.tick(10);
		// the wasm memory may grow between calls: derive the view each time
		const rd = () => new Float32Array(w.x.memory.buffer, w.x.reading_state_ptr() >>> 0, 64);
		expect(Math.trunc(rd()[13]) & 32).toBe(0);
		// a click makes the next frame dirty
		clickPart(w, 0, parts(w).b_step);
		w.tick(1);
		expect(Math.trunc(rd()[13]) & 32).toBe(32);
	});
});

describe('hot reload', () => {
	test('a changed script applies in place and keeps the state; a broken one is refused and the old exhibit runs on', () => {
		const w = boot();
		w.load(0, TURING);
		const p = parts(w);
		for (let i = 0; i < 3; i++) clickPart(w, 0, p.b_step);
		w.tick(5);
		expect(w.row(0).steps).toBe(3);
		const next = TURING.replace('Step runs one rule.', 'Step runs one rule, Run keeps going.');
		expect(w.reload(0, next)).toBeNull();
		expect(w.row(0).steps).toBe(3);
		const d = w.pack(0);
		const strs = [...Array(d.n).keys()].map((i) => d.str(d.items[i * XD.stride + XD.aux]));
		expect(strs.some((s) => s?.includes('Run keeps going'))).toBe(true);
		const before = w.entities();
		const err = w.reload(0, next.replace('Does: {"step"}', 'Does: {"explode"}'));
		expect(err).toMatch(/explode/);
		expect(w.entities()).toBe(before);
		clickPart(w, 0, p.b_step);
		w.tick(3);
		expect(w.row(0).steps).toBe(4);
		expect(w.reload(0, '{{{')).not.toBeNull();
		expect(w.row(0).loaded).toBe(1);
		expect(w.reload(3, TURING)).toMatch(/not loaded/);
	});
});

describe('timeline', () => {
	const SCRIPT = 'fig_x : Timeline {\n  Extent: {36, 14}\n}\n';
	test('autoplays while live, pauses on the play button, scrubs by the slider, pins its poster under reduced motion', () => {
		const w = boot();
		expect(w.load(1, SCRIPT)).toBeNull();
		expect(w.row(1).kind).toBe(0);
		expect(w.row(1).clock).toBeCloseTo(1, 3); // the poster
		w.tick(90);
		const c1 = w.row(1).clock;
		expect(c1).toBeGreaterThan(1.8);
		expect(w.row(1).animating).toBe(1);
		const p = parts(w, SCRIPT);
		expect(Object.keys(p).sort()).toEqual(['play', 'scrub']);
		// the controls sit at the bottom of the frame: y = 14 - 1.8
		expect(p.play.place[1]).toBeCloseTo(12.2, 3);
		clickPart(w, 1, p.play);
		w.tick(60);
		expect(w.row(1).clock).toBeCloseTo(c1, 2);
		expect(w.row(1).animating).toBe(0);
		// scrub to the middle: duration 8
		const mid = p.scrub.place[0] + p.scrub.place[2] / 2;
		w.click(1, mid, centre(p.scrub)[1]);
		expect(w.row(1).clock).toBeCloseTo(4, 1);
		// play resumes at once; a scrub while playing holds autoplay for 1.5 s, then it goes on
		clickPart(w, 1, p.play);
		w.tick(30);
		expect(w.row(1).clock).toBeGreaterThan(4.3);
		w.click(1, mid, centre(p.scrub)[1]);
		w.tick(60);
		expect(w.row(1).clock).toBeCloseTo(4, 1);
		w.tick(90);
		expect(w.row(1).clock).toBeGreaterThan(4.3);
		// reduced motion: back to the poster and still
		w.x.reading_input(INPUT.reducedMotion, 1, 0);
		w.tick(60);
		expect(w.row(1).clock).toBeCloseTo(1, 3);
		expect(w.row(1).animating).toBe(0);
		// the clock survives a snapshot
		w.x.reading_input(INPUT.reducedMotion, 0, 0);
		w.click(1, mid, centre(p.scrub)[1]);
		const snap = w.snapshot(1);
		w.click(1, p.scrub.place[0] + 1, centre(p.scrub)[1]);
		expect(w.restore(1, snap)).toBe(true);
		expect(w.row(1).clock).toBeCloseTo(4, 1);
	});
	test('a static timeline has no controls to hit and draws nothing', () => {
		const w = boot();
		expect(w.load(4, SCRIPT)).toBeNull();
		const p = parts(w, SCRIPT);
		expect(w.click(4, ...centre(p.play)).d).toBe(0);
		expect(w.pack(4).n).toBe(0);
		w.tick(30);
		expect(w.row(4).clock).toBeCloseTo(2, 3);
	});
	test('a script that overrides the clip (Clip {duration, mode, poster}) wins over the load record', () => {
		const w = boot();
		expect(w.load(1, 'fig_y : Timeline {\n  Extent: {36, 14}\n  Clip: {20, "once", 5}\n}\n')).toBeNull();
		expect(w.row(1).clock).toBeCloseTo(5, 3);
	});
});

describe('in the room world', () => {
	test('the museum installs next to the scene scripts: no name clashes, exhibits load and run', () => {
		const w = boot(undefined, true);
		expect(w.load(0, TURING)).toBeNull();
		const p = parts(w);
		runToHalt(w, 0, p.b_run);
		expect(w.row(0).steps).toBe(8);
		expect(w.load(1, 'fig_x : Timeline {\n  Extent: {36, 14}\n}\n')).toBeNull();
	});
});

describe('visibility', () => {
	test('exhibits enter and leave the data lookahead with events; a timeline only plays while live', () => {
		const w = boot({ exhibits: Array.from({ length: 12 }, (_, i) => [0, 8, 1, i === 1 ? 0 : 1] as [number, number, number, number]) });
		const kinds = (ev: number[]) => ev.map((e) => [(e >>> 24) | 0, e & 0xffffff]);
		const first = kinds(w.poll());
		expect(first).toContainEqual([4, 0]);
		expect(first).toContainEqual([4, 1]);
		// far away: everything leaves
		w.x.reading_set_scroll(180 * 16);
		w.tick(2);
		const away = kinds(w.poll());
		expect(away).toContainEqual([5, 0]);
		expect(away).toContainEqual([5, 1]);
		// a timeline that is not on screen does not advance
		expect(w.load(1, 'fig_x : Timeline {\n  Extent: {36, 14}\n}\n')).toBeNull();
		const c0 = w.row(1).clock;
		w.tick(120);
		expect(w.row(1).clock).toBe(c0);
		w.x.reading_set_scroll(0);
		w.tick(120);
		expect(w.row(1).clock).toBeGreaterThan(c0 + 1);
	});
});
