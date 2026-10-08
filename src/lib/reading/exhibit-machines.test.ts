// The stepper families of the museum (world/src/museum/kind_{rewrite,graph,grid}.rs) end to end through world.wasm, each cross-checked
// against an independent TypeScript reference, with golden numbers and one planted-bug control per family.
// Run: bun run build:world && bun test src/lib/reading/exhibit-machines.test.ts
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import { wasiImports } from '../wasi';
import { LOAD_BLOCK, LOAD_EXHIBIT, LOAD_HEADER, XD, XKEY, XPOINTER, XS, XSHAPE } from './abi';

const WASM = new URL('../gpu/room/world.wasm', import.meta.url);
const T = (rel: string) => fs.readFileSync(new URL(`../../routes/(site)/thoughts/${rel}`, import.meta.url), 'utf8');
const LAMBDA = T('models/exhibits/lambda.flecs');
const MERKLE = T('models/exhibits/merkle.flecs');
const IFD = T('ifd/exhibits/graph.flecs');
const PATH = T('optimal-parkour/exhibits/path.flecs');
const TURING = T('models/exhibits/turing.flecs');

type X = Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };

function boot(n = 4, room = false) {
	let memory!: WebAssembly.Memory;
	const mod = new WebAssembly.Module(fs.readFileSync(WASM));
	const x = new WebAssembly.Instance(mod, wasiImports(() => memory)).exports as unknown as X;
	memory = x.memory;
	if (room) {
		const input = new TextEncoder().encode(JSON.stringify({ items: [{ slug: 'models', date: '2026-01-01', archived: false, tex: [0, 0, 1, 1] }], signs: [[0, 0, 1, 1], [0, 0, 1, 1], [0, 0, 1, 1]], map: [0, 0, 1, 1] }));
		const ip = x.world_input(input.length) >>> 0;
		new Uint8Array(memory.buffer, ip, input.length).set(input);
		if (x.world_build() !== 0) throw new Error('world_build failed');
	} else expect(x.reading_init()).toBe(0);
	const words = LOAD_HEADER + n * LOAD_BLOCK + n * LOAD_EXHIBIT;
	const p = x.reading_buf(words) >>> 0;
	const u = new Uint32Array(memory.buffer, p, words);
	const f = new Float32Array(memory.buffer, p, words);
	u.fill(0);
	u[0] = n; u[2] = n;
	f[5] = 20 * n + 4; u[9] = 2;
	let o = LOAD_HEADER;
	for (let i = 0; i < n; i++) {
		f[o] = 2 + 20 * i; f[o + 1] = 2 + 20 * i + 18; f[o + 2] = 0; f[o + 3] = 36;
		u[o + 4] = 21; u[o + 7] = i;
		o += LOAD_BLOCK;
	}
	for (let i = 0; i < n; i++) {
		u[o] = 100 + i; u[o + 1] = 0; f[o + 2] = 6; f[o + 3] = 0; u[o + 4] = i; u[o + 5] = 1;
		o += LOAD_EXHIBIT;
	}
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
		load: (ex: number, src: string): string | null => (x.exhibit_load(ex, stage(src)) === 0 ? null : out()),
		inspect: (src: string) => ({ ok: x.exhibit_inspect(stage(src)) === 0, text: out() }),
		snapshot: (ex: number): string => text(x.exhibit_snapshot(ex)),
		restore: (ex: number, s: string): boolean => x.exhibit_restore(ex, stage(s)) === 0,
		key: (code: number, mods = 0) => x.exhibit_key(code, mods) !== 0,
		click: (ex: number, px: number, py: number) => {
			x.exhibit_pointer(ex, XPOINTER.move, px, py, 1, 0);
			x.exhibit_pointer(ex, XPOINTER.down, px, py, 1, 0);
			x.exhibit_pointer(ex, XPOINTER.up, px, py, 1, 0);
		},
		row: (ex: number) => {
			const r = new Float32Array(x.memory.buffer, x.exhibit_state_ptr() >>> 0, XS.max * XS.stride).slice(ex * XS.stride, (ex + 1) * XS.stride);
			return { loaded: r[XS.loaded], running: r[XS.running], halted: r[XS.halted], steps: r[XS.steps], kind: r[XS.kind] };
		},
		tick: (frames: number) => { for (let i = 0; i < frames; i++) x.reading_tick(1000 / 60); },
		pack: (ex: number) => {
			const n = x.exhibit_pack(ex);
			const items = new Float32Array(x.memory.buffer, x.exhibit_draw_ptr() >>> 0, n * XD.stride).slice();
			const str = (i: number) => text(x.exhibit_str_len(i), x.exhibit_str_ptr(i) >>> 0);
			return { n, items, str };
		},
		/** every label of the draw list */
		labels: (ex: number): string[] => {
			const d = api.pack(ex);
			const r: string[] = [];
			for (let i = 0; i < d.n; i++) if (d.items[i * XD.stride + XD.shape] === XSHAPE.label) r.push(d.str(d.items[i * XD.stride + XD.aux]));
			return r;
		},
		entities: () => x.reading_entity_count()
	};
	return api;
}
type World = ReturnType<typeof boot>;

interface Part { name: string; kind: string; place: [number, number, number, number]; label: string }
const parts = (w: World, src: string): Record<string, Part> => {
	const r = w.inspect(src);
	if (!r.ok) throw new Error(r.text);
	return Object.fromEntries((JSON.parse(r.text).parts as Part[]).map((p) => [p.name, p]));
};
const press = (w: World, p: Part) => w.click(0, p.place[0] + p.place[2] / 2, p.place[1] + p.place[3] / 2);
const find = (w: World, re: RegExp) => w.labels(0).find((s) => re.test(s)) ?? '';
/** Click Run and tick until halted. */
function run(w: World, ps: Record<string, Part>, cap = 2000) {
	press(w, ps.b_run);
	let n = 0;
	while (!w.row(0).halted && n++ < cap) w.tick(1);
	expect(w.row(0).halted, 'the run halts').toBe(1);
}
/** Make an exhibit fast: 3000 steps/s is 50 per tick (at most 64 per frame run). */
const fast = (src: string, id: string) => src.replace(`(Runs, ${id})`, `(Runs, ${id})\n  Rate: {3000}`);

function mulberry32(a: number) {
	return () => {
		a |= 0; a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---------------------------------------------------------------------------------------------------------------------------------
// lambda: a de Bruijn reference reducer

type L = { k: 'v'; i: number } | { k: 'l'; b: L } | { k: 'a'; f: L; x: L };
const V = (i: number): L => ({ k: 'v', i });
const Lam = (b: L): L => ({ k: 'l', b });
const App = (f: L, x: L): L => ({ k: 'a', f, x });
const church = (n: number): L => { let b = V(0); for (let i = 0; i < n; i++) b = App(V(1), b); return Lam(Lam(b)); };
const SUCC = Lam(Lam(Lam(App(V(1), App(App(V(2), V(1)), V(0))))));
const ADD = Lam(Lam(Lam(Lam(App(App(V(3), V(1)), App(App(V(2), V(1)), V(0)))))));
const OMEGA = App(Lam(App(V(0), V(0))), Lam(App(V(0), V(0))));
const shift = (t: L, d: number, c: number): L => t.k === 'v' ? (t.i >= c ? V(t.i + d) : t) : t.k === 'l' ? Lam(shift(t.b, d, c + 1)) : App(shift(t.f, d, c), shift(t.x, d, c));
const subst = (t: L, j: number, s: L): L => t.k === 'v' ? (t.i === j ? s : t) : t.k === 'l' ? Lam(subst(t.b, j + 1, shift(s, 1, 0))) : App(subst(t.f, j, s), subst(t.x, j, s));
const beta = (b: L, a: L) => shift(subst(b, 0, shift(a, 1, 0)), -1, 0);
type Path = ('b' | 'f' | 'x')[];
const isRedex = (t: L) => t.k === 'a' && t.f.k === 'l';
function pre(t: L, p: Path = []): Path[] {
	if (t.k === 'v') return [];
	if (t.k === 'l') return pre(t.b, [...p, 'b']);
	return [...(isRedex(t) ? [p] : []), ...pre(t.f, [...p, 'f']), ...pre(t.x, [...p, 'x'])];
}
function post(t: L, p: Path = []): Path[] {
	if (t.k === 'v') return [];
	if (t.k === 'l') return post(t.b, [...p, 'b']);
	return [...post(t.f, [...p, 'f']), ...post(t.x, [...p, 'x']), ...(isRedex(t) ? [p] : [])];
}
function at(t: L, p: Path, f: (r: L) => L): L {
	if (p.length === 0) return f(t);
	const [h, ...rest] = p;
	if (t.k === 'l' && h === 'b') return Lam(at(t.b, rest, f));
	if (t.k === 'a' && h === 'f') return App(at(t.f, rest, f), t.x);
	if (t.k === 'a' && h === 'x') return App(t.f, at(t.x, rest, f));
	throw new Error('bad path');
}
const contract = (t: L, p: Path) => at(t, p, (r) => (r.k === 'a' && r.f.k === 'l' ? beta(r.f.b, r.x) : r));
const size = (t: L): number => (t.k === 'v' ? 1 : t.k === 'l' ? 1 + size(t.b) : 1 + size(t.f) + size(t.x));
/** Reduce to normal form (or 200 steps, the script's fuel); `first` picks which redex a click contracts first. */
function reduce(t: L, applicative: boolean, first?: number, fuel = 200) {
	let steps = 0;
	while (steps < fuel) {
		const rs = applicative ? post(t) : pre(t);
		if (!rs.length) return { steps, nf: t, halted: 'accept' as const };
		const pick = steps === 0 && first !== undefined ? pre(t)[first] : rs[0];
		t = contract(t, pick);
		steps++;
		if (size(t) > 300) return { steps, nf: t, halted: 'big' as const };
	}
	return { steps, nf: t, halted: 'fuel' as const };
}
const numeral = (t: L): number | null => {
	if (t.k !== 'l' || t.b.k !== 'l') return null;
	let n = 0, c = t.b.b;
	while (c.k === 'a' && c.f.k === 'v' && c.f.i === 1) { n++; c = c.x; }
	return c.k === 'v' && c.i === 0 ? n : null;
};
const NAMES = 'abcdefghij';
const print = (t: L, d = 0): string => (t.k === 'v' ? NAMES[d - 1 - t.i] : t.k === 'l' ? `(λ${NAMES[d]}. ${print(t.b, d + 1)})` : `(${print(t.f, d)} ${print(t.x, d)})`);

const withTerm = (src: string, id: string, term: string) => src.replace(new RegExp(`(${id} : Preset \\{[\\s\\S]*?Lambda: \\{")[^"]*("\\})`), `$1${term}$2`);

describe('lambda: the reducer', () => {
	test('golden: succ 2 is the numeral 3 in 3 steps, add 2 3 is 5 in 6, in both orders', () => {
		const ps0 = parts(boot(), LAMBDA);
		for (const [id, steps, n] of [['succ2', 3, 3], ['add23', 6, 5]] as const) {
			const t = id === 'succ2' ? App(SUCC, church(2)) : App(App(ADD, church(2)), church(3));
			expect(reduce(t, false).steps, `reference ${id}`).toBe(steps);
			const w = boot();
			expect(w.load(0, fast(LAMBDA, 'succ2'))).toBeNull();
			if (id !== 'succ2') press(w, ps0.b_add23);
			run(w, ps0);
			expect(w.row(0).steps).toBe(steps);
			expect(find(w, /^step \d+ +normal form/)).toBe(`step ${steps}   normal form: the Church numeral ${n}`);
		}
	});
	test('golden: ignore omega is 2 steps in normal order and loops under applicative order (fuel 200)', () => {
		const w = boot();
		const ps = parts(w, LAMBDA);
		expect(w.load(0, fast(LAMBDA, 'succ2'))).toBeNull();
		press(w, ps.b_lazy);
		run(w, ps);
		expect(w.row(0).steps).toBe(2);
		expect(find(w, /normal form/)).toContain('Church numeral 2');
		// applicative order: the toggle restarts nothing visible but flips the strategy; Reset reloads the preset, so toggle after it
		press(w, ps.b_reset);
		press(w, ps.b_order);
		w.tick(1);
		run(w, ps);
		expect(w.row(0).steps).toBe(200);
		expect(find(w, /out of fuel/)).toContain('no normal form reached');
		const r = reduce(App(App(Lam(Lam(V(0))), OMEGA), church(2)), true);
		expect(r.halted).toBe('fuel');
		// omega alone never halts in either order
		press(w, ps.b_loop);
		run(w, ps);
		expect(w.row(0).steps).toBe(200);
	});
	test('300 random closed terms: step count and outcome agree with the reference in both orders', () => {
		const rnd = mulberry32(11);
		const gen = (d: number, env: number): L => {
			const r = rnd();
			if (d <= 0 || r < 0.15) return env > 0 ? V(Math.floor(rnd() * env)) : Lam(gen(d - 1, 1));
			if (r < 0.55 || env === 0) return Lam(gen(d - 1, env + 1));
			return App(gen(d - 1, env), gen(d - 1, env));
		};
		const w = boot();
		const ps = parts(w, LAMBDA);
		let checked = 0, fuel = 0;
		for (let k = 0; k < 300; k++) {
			const t = gen(5, 0);
			const applicative = k % 2 === 1;
			const ref = reduce(t, applicative);
			if (ref.halted === 'big' || size(t) > 120) continue;
			expect(w.load(0, withTerm(fast(LAMBDA, 'succ2'), 'succ2', print(t)))).toBeNull();
			if (applicative) press(w, ps.b_order);
			run(w, ps);
			expect(w.row(0).steps, print(t)).toBe(ref.steps);
			const s = find(w, /^step \d+ /);
			if (ref.halted === 'accept') {
				expect(s, print(t)).toMatch(/normal form/);
				const n = numeral(ref.nf);
				if (n !== null) expect(s).toContain(`Church numeral ${n}`);
			} else { expect(s, print(t)).toMatch(/out of fuel/); fuel++; }
			checked++;
		}
		expect(checked).toBeGreaterThan(150);
		console.log(`lambda cross-check: ${checked} terms, ${fuel} out of fuel`);
	});
	test('clicking the lambda of a redex contracts that redex: the step count follows the reference', () => {
		const w = boot();
		const ps = parts(w, LAMBDA);
		for (const [id, term, steps] of [['add23', App(App(ADD, church(2)), church(3)), 6]] as const) {
			void id;
			for (let k = 0; k < 3; k++) {
				w.load(0, fast(LAMBDA, 'succ2'));
				press(w, ps.b_add23);
				const d = w.pack(0);
				// the chips behind each lambda of a redex: panelHi rrects inside the view
				const chips: [number, number][] = [];
				for (let i = 0; i < d.n; i++) {
					const o = i * XD.stride;
					if (d.items[o + XD.shape] === XSHAPE.rrect && d.items[o + XD.tone] === 9 && d.items[o + XD.y] > 7) chips.push([d.items[o + XD.x] + d.items[o + XD.w] / 2, d.items[o + XD.y] + d.items[o + XD.h] / 2]);
				}
				expect(chips.length).toBe(pre(term).length);
				const kk = Math.min(k, chips.length - 1);
				w.click(0, ...chips[kk]);
				expect(w.row(0).steps).toBe(1);
				run(w, ps);
				expect(w.row(0).steps).toBe(reduce(term, false, kk).steps);
				expect(find(w, /normal form/)).toContain('Church numeral 5');
				void steps;
			}
		}
	});
	test('snapshot: a half-run term round trips, a stale script is refused', () => {
		const w = boot();
		const ps = parts(w, LAMBDA);
		w.load(0, LAMBDA);
		press(w, ps.b_add23);
		press(w, ps.b_step);
		w.tick(2);
		press(w, ps.b_step);
		w.tick(2);
		expect(w.row(0).steps).toBe(2);
		const snap = w.snapshot(0);
		const before = w.labels(0).join('|');
		w.load(0, LAMBDA);
		expect(w.labels(0).join('|')).not.toBe(before);
		expect(w.restore(0, snap)).toBe(true);
		expect(w.snapshot(0)).toBe(snap);
		expect(w.labels(0).join('|')).toBe(before);
		expect(w.row(0).steps).toBe(2);
		run(w, ps);
		expect(find(w, /normal form/)).toContain('Church numeral 5');
		expect(w.row(0).steps).toBe(6);
		// a snapshot of another script text is refused
		w.load(1, LAMBDA.replace('A lambda term reducing', 'Another'));
		expect(w.restore(1, snap)).toBe(false);
	});
	test('planted bug: add with m f (m f x) gives 4 for add 2 3, so the golden catches it', () => {
		const bad = LAMBDA.replace('λm n f x. m f (n f x)', 'λm n f x. m f (m f x)');
		expect(bad).not.toBe(LAMBDA);
		const w = boot();
		const ps = parts(w, bad);
		w.load(0, fast(bad, 'succ2'));
		press(w, ps.b_add23);
		run(w, ps);
		expect(find(w, /normal form/)).not.toContain('Church numeral 5');
		expect(find(w, /normal form/)).toContain('Church numeral 4');
	});
});

// ---------------------------------------------------------------------------------------------------------------------------------
// graph: a TypeScript reference of the hash, the cache and the step order, read from the script text

interface GN { id: string; label: string; alt: string; tag: number; body: string; place: [number, number, number, number]; ins: number[] }
function readGraph(src: string): GN[] {
	const pre = src.slice(0, src.indexOf('Preset {'));
	void pre;
	const body = src.slice(src.indexOf('Preset {'), src.indexOf('\n}\n', src.indexOf('Preset {')));
	const nodes: GN[] = [];
	const names: string[] = [];
	for (const m of body.matchAll(/^ {2}(\w+) : (Source|Action|Tree) \{([\s\S]*?)\n {2}\}/gm)) {
		names.push(m[1]);
		const g = (re: RegExp) => re.exec(m[3])?.[1] ?? '';
		nodes.push({
			id: m[1], label: g(/Label: \{"([^"]*)"\}/), alt: g(/LabelAlt: \{"([^"]*)"\}/), tag: ['Source', 'Action', 'Tree'].indexOf(m[2]), body: g(/Content: \{"([^"]*)"\}/),
			place: g(/Place: \{([^}]*)\}/).split(',').map(Number) as [number, number, number, number], ins: [...m[3].matchAll(/\(Reads, (\w+)\)/g)].map((r) => names.indexOf(r[1]))
		});
	}
	// the runtime orders nodes top to bottom, left to right, then by name (entity ids are not declaration order after a reload)
	const order = nodes.map((_, i) => i).sort((a, b) => nodes[a].place[1] - nodes[b].place[1] || nodes[a].place[0] - nodes[b].place[0] || (nodes[a].id < nodes[b].id ? -1 : 1));
	const rank = order.map((_, i) => order.indexOf(i));
	const sorted = order.map((i) => ({ ...nodes[i], ins: nodes[i].ins.map((d) => rank[d]).sort((a, b) => a - b) }));
	return sorted;
}
function fnv(h: number, bytes: number[]) { for (const b of bytes) { h = (h ^ b) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; } return h; }
const hex4 = (h: number) => ((h ^ (h >>> 16)) & 0xffff).toString(16).padStart(4, '0');
function hashes(ns: GN[], ver: boolean[]): number[] {
	const cur: number[] = new Array(ns.length).fill(0);
	const done = new Set<number>();
	while (done.size < ns.length) {
		const i = ns.findIndex((n, k) => !done.has(k) && n.ins.every((d) => done.has(d)));
		const n = ns[i];
		let h = fnv(0x811c9dc5, [n.tag]);
		h = fnv(h, [...new TextEncoder().encode(n.body)]);
		h = fnv(h, [0xff]);
		if (n.tag === 0) h = fnv(h, [ver[i] ? 1 : 0]);
		for (const d of n.ins) h = fnv(h, [cur[d] & 255, (cur[d] >>> 8) & 255, (cur[d] >>> 16) & 255, cur[d] >>> 24]);
		cur[i] = h;
		done.add(i);
	}
	return cur;
}
/** The reference run: edits are source toggles in order; returns the counts of the last settle of everything. */
class RefGraph {
	ns: GN[]; ver: boolean[]; shown: number[]; store = new Set<number>(); built = 0; hit = 0; cursor = 0; order: number[];
	constructor(ns: GN[]) {
		this.ns = ns; this.ver = ns.map(() => false); this.shown = hashes(ns, this.ver); this.shown.forEach((h) => this.store.add(h));
		const topo: number[] = []; const done = new Set<number>();
		while (topo.length < ns.length) { const i = ns.findIndex((n, k) => !done.has(k) && n.ins.every((d) => done.has(d))); topo.push(i); done.add(i); }
		this.order = topo.filter((i) => ns[i].tag !== 0);
	}
	get cur() { return hashes(this.ns, this.ver); }
	edit(i: number) { this.ver[i] = !this.ver[i]; this.shown[i] = this.cur[i]; this.store.add(this.cur[i]); this.built = 0; this.hit = 0; this.cursor = 0; }
	step() { const n = this.order[this.cursor++]; const h = this.cur[n]; if (this.store.has(h)) this.hit++; else { this.built++; this.store.add(h); } this.shown[n] = h; }
	all() { while (this.cursor < this.order.length) this.step(); }
}
const centreOf = (n: GN): [number, number] => [n.place[0] + n.place[2] / 2, n.place[1] + n.place[3] / 2];
const done = (w: World) => find(w, /^done /);

function graphSuite(name: string, src: string, hitWord: string, builtWord: string, cases: { edit: string[]; built: number; hit: number }[], titleId: string) {
	describe(`graph: ${name}`, () => {
		const ns = readGraph(src);
		const idx = (id: string) => ns.findIndex((n) => n.id === id);
		const load = () => { const w = boot(); const ps = parts(w, src); expect(w.load(0, fast(src, titleId))).toBeNull(); return { w, ps }; };
		const edit = (w: World, id: string) => w.click(0, ...centreOf(ns[idx(id)]));
		test('the keys on screen are the reference keys, with old and new after an edit', () => {
			const { w } = load();
			const ref = new RefGraph(ns);
			const shown = () => new Set(w.labels(0));
			for (const h of ref.cur) expect(shown().has(hex4(h)), `key ${hex4(h)}`).toBe(true);
			const target = ns.find((n) => n.tag === 0 && ref.ns.some((m) => m.ins.includes(ns.indexOf(n))))!;
			const before = ref.cur;
			ref.edit(ns.indexOf(target));
			edit(w, target.id);
			const after = ref.cur;
			for (let i = 0; i < ns.length; i++) if (after[i] !== before[i]) expect(shown().has(`${hex4(before[i])} → ${hex4(after[i])}`) || shown().has(hex4(after[i])), `${ns[i].id} moved`).toBe(true);
			expect(after.filter((h, i) => h !== before[i]).length).toBeGreaterThan(1);
		});
		for (const c of cases) {
			test(`golden: edit ${c.edit.join(' and ')}: ${c.built} ${builtWord}, ${c.hit} ${hitWord}`, () => {
				const { w, ps } = load();
				const ref = new RefGraph(ns);
				for (const e of c.edit) { edit(w, e); ref.edit(idx(e)); }
				ref.all();
				expect([ref.built, ref.hit], 'reference').toEqual([c.built, c.hit]);
				run(w, ps);
				expect(done(w)).toBe(`done   ${c.built} ${builtWord}, ${c.hit} ${hitWord}`);
				expect(w.row(0).steps).toBe(ref.order.length);
			});
		}
		test('editing a file back is all hits: the cache keeps every key it has seen', () => {
			const { w, ps } = load();
			const e = cases[0].edit[0];
			edit(w, e); run(w, ps);
			edit(w, e);
			expect(w.row(0).halted).toBe(0);
			run(w, ps);
			expect(done(w)).toBe(`done   0 ${builtWord}, ${ns.filter((n) => n.tag !== 0).length} ${hitWord}`);
		});
		test('200 random edit and step sequences agree with the reference and survive a snapshot', () => {
			const rnd = mulberry32(3);
			const w = boot();
			const ps = parts(w, src);
			const sources = ns.filter((n) => n.tag === 0);
			for (let s = 0; s < 40; s++) {
				expect(w.load(0, src)).toBeNull();
				const ref = new RefGraph(ns);
				for (let k = 0; k < 14; k++) {
					if (rnd() < 0.4) { const e = sources[Math.floor(rnd() * sources.length)]; edit(w, e.id); ref.edit(ns.indexOf(e)); }
					else if (ref.cursor < ref.order.length) { press(w, ps.b_step); w.tick(2); ref.step(); }
					if (rnd() < 0.2) {
						const snap = w.snapshot(0);
						const labels = w.labels(0).join('|');
						w.load(0, src);
						expect(w.restore(0, snap)).toBe(true);
						expect(w.snapshot(0)).toBe(snap);
						expect(w.labels(0).join('|')).toBe(labels);
					}
				}
				expect(w.row(0).steps).toBe(ref.cursor);
				while (ref.cursor < ref.order.length) { press(w, ps.b_step); w.tick(2); ref.step(); }
				w.tick(2);
				if (ref.order.length) expect(done(w), `seq ${s}`).toBe(`done   ${ref.built} ${builtWord}, ${ref.hit} ${hitWord}`);
			}
		});
		test('keyboard: focus, Enter on Step, Space runs, the nodes are reachable by pointer only', () => {
			const { w } = load();
			w.x.exhibit_focus(0);
			expect(w.key('s'.charCodeAt(0))).toBe(true);
			w.tick(2);
			expect(w.row(0).steps).toBe(1);
			expect(w.key(32)).toBe(true);
			expect(w.row(0).running).toBe(1);
		});
		test('draw list: within 1200 items and inside the frame in every state', () => {
			const { w, ps } = load();
			const rnd = mulberry32(8);
			const sources = ns.filter((n) => n.tag === 0);
			for (let k = 0; k < 30; k++) {
				if (rnd() < 0.5) edit(w, sources[Math.floor(rnd() * sources.length)].id); else press(w, ps.b_step);
				w.tick(2);
				const d = w.pack(0);
				expect(d.n).toBeLessThanOrEqual(1200);
				for (let i = 0; i < d.n; i++) {
					const o = i * XD.stride;
					expect([...d.items.slice(o, o + 8)].every(Number.isFinite)).toBe(true);
					if (d.items[o + XD.shape] === XSHAPE.rrect) { expect(d.items[o + XD.x] + d.items[o + XD.w]).toBeLessThanOrEqual(36.2); expect(d.items[o + XD.y] + d.items[o + XD.h]).toBeLessThanOrEqual(22.2); }
				}
			}
		});
	});
}

graphSuite('the ifd action graph', IFD, 'cache hit', 'rebuilt', [
	{ edit: ['schema'], built: 2, hit: 4 },
	{ edit: ['derive_rs'], built: 3, hit: 3 },
	{ edit: ['main_rs'], built: 1, hit: 5 },
	{ edit: ['build_rs'], built: 3, hit: 3 },
	{ edit: ['itoa_rs', 'serde_rs'], built: 3, hit: 3 }
], 'workspace');
graphSuite('the models codebase', MERKLE, 'reused', 'new hash', [
	{ edit: ['config'], built: 3, hit: 1 },
	{ edit: ['util'], built: 4, hit: 0 },
	{ edit: ['util', 'config'], built: 4, hit: 0 }
], 'codebase');

describe('graph: planted bug and rename', () => {
	test('planted bug: an app that does not read render keeps its hash when config changes, so the golden (3 new hashes) fails', () => {
		const bad = MERKLE.replace('    (Reads, parse)\n    (Reads, render)\n', '    (Reads, parse)\n');
		expect(bad).not.toBe(MERKLE);
		const w = boot();
		const ps = parts(w, bad);
		w.load(0, fast(bad, 'codebase'));
		const ns = readGraph(bad);
		w.click(0, ...centreOf(ns.find((n) => n.id === 'config')!));
		run(w, ps);
		expect(done(w)).not.toBe('done   3 new hash, 1 reused');
		expect(done(w)).toBe('done   1 new hash, 3 reused');
	});
	test('rename: a click on a name in rename mode swaps the name and moves no hash', () => {
		const w = boot();
		const ps = parts(w, MERKLE);
		w.load(0, MERKLE);
		const ns = readGraph(MERKLE);
		const keys = (l: string[]) => l.filter((s) => /^[0-9a-f]{4}$/.test(s)).join(',');
		const k0 = keys(w.labels(0));
		expect(k0.split(',').length).toBe(6);
		press(w, ps.b_rename);
		w.click(0, ...centreOf(ns.find((n) => n.id === 'parse')!));
		const after = w.labels(0);
		expect(after).toContain('read_input');
		expect(after).not.toContain('parse');
		expect(keys(after)).toBe(k0);
		// in rename mode a source is renamable (it has an alt) and clicking it does not edit it
		w.click(0, ...centreOf(ns.find((n) => n.id === 'util')!));
		expect(w.labels(0)).toContain('helpers');
		expect(keys(w.labels(0))).toBe(k0);
		// the mode is in the snapshot
		const snap = w.snapshot(0);
		w.load(0, MERKLE);
		expect(w.restore(0, snap)).toBe(true);
		expect(w.labels(0)).toContain('read_input');
	});
	test('a source with inputs and a read of a node outside the preset are refused', () => {
		const w = boot();
		const withInput = MERKLE.replace('  config : Source {', '  config : Source {\n    (Reads, util)');
		expect(w.load(0, withInput)).toMatch(/Source has no inputs/);
		const stray = MERKLE.replace('(Reads, util)\n    (Reads, config)', '(Reads, nowhere)\n    (Reads, config)');
		expect(w.load(0, stray)).not.toBeNull();
		expect(w.row(0).loaded).toBe(0);
	});
});

// ---------------------------------------------------------------------------------------------------------------------------------
// grid: reference A* / Dijkstra with the same tie breaks

function readBoards(src: string) {
	const out: Record<string, string[]> = {};
	for (const m of src.matchAll(/(\w+) : Preset \{[\s\S]*?Board: \{"([^"]*)"\}/g)) out[m[1]] = m[2].split('/');
	return out;
}
function refSearch(rows: string[], astar: boolean) {
	const R = rows.length, C = rows[0].length;
	const wall = rows.flatMap((r) => [...r].map((c) => c === '#'));
	const s = rows.join('').indexOf('S'), g = rows.join('').indexOf('G');
	const h = (i: number) => (astar ? Math.abs((i % C) - (g % C)) + Math.abs(Math.floor(i / C) - Math.floor(g / C)) : 0);
	const gs = new Array(R * C).fill(Infinity), parent = new Array(R * C).fill(-1), closed = new Array(R * C).fill(false);
	let seq = 1;
	let open: [number, number, number, number, number][] = [[h(s), h(s), 0, s, 0]];
	gs[s] = 0;
	let expanded = 0;
	for (;;) {
		open.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
		const top = open.shift();
		if (!top) return { expanded, path: -1, wall };
		const [, , , i, gv] = top;
		if (closed[i] || gs[i] !== gv) continue;
		closed[i] = true; expanded++;
		if (i === g) { let n = 0, c = i; while (parent[c] >= 0) { c = parent[c]; n++; } return { expanded, path: n, wall }; }
		const x = i % C, y = Math.floor(i / C);
		const nb = [y > 0 ? i - C : -1, x + 1 < C ? i + 1 : -1, y + 1 < R ? i + C : -1, x > 0 ? i - 1 : -1];
		for (const n of nb) {
			if (n < 0 || wall[n] || closed[n]) continue;
			if (gv + 1 < gs[n]) { gs[n] = gv + 1; parent[n] = i; open.push([gv + 1 + h(n), h(n), seq++, n, gv + 1]); }
		}
	}
}
function cell(i: number, rows: string[]): [number, number] {
	const C = rows[0].length, R = rows.length;
	const v = [1, 7.2, 34, 12.3];
	const cs = Math.min(v[2] / C, v[3] / R, 2);
	const x0 = v[0] + (v[2] - cs * C) / 2;
	return [x0 + ((i % C) + 0.5) * cs, v[1] + (Math.floor(i / C) + 0.5) * cs];
}
const summary = (w: World) => find(w, /expanded/);

/** expanded blocks / path length, verified against the reference search above (the open field A* run is the straight line: 13 moves, 14 pops) */
const GOLDEN: Record<string, string> = { 'open Dijkstra': '120/13', 'open A*': '14/13', 'gap Dijkstra': '131/19', 'gap A*': '51/19', 'cup Dijkstra': '141/23', 'cup A*': '118/23' };

describe('grid: Dijkstra and A*', () => {
	const boards = readBoards(PATH);
	test('golden: expansions and path length per preset and algorithm match the reference', () => {
		expect(Object.keys(boards)).toEqual(['open', 'gap', 'cup']);
		const w = boot();
		const ps = parts(w, PATH);
		const got: Record<string, string> = {};
		for (const id of ['open', 'gap', 'cup']) {
			for (const astar of [false, true]) {
				expect(w.load(0, fast(PATH, 'open'))).toBeNull();
				press(w, ps[`b_${id}`]);
				if (astar) press(w, ps.b_astar);
				w.tick(1);
				run(w, ps);
				const ref = refSearch(boards[id], astar);
				const name = astar ? 'A*' : 'Dijkstra';
				expect(summary(w)).toBe(`${name}   expanded ${ref.expanded}   path ${ref.path}`);
				expect(w.row(0).steps).toBe(ref.expanded);
				got[`${id} ${name}`] = `${ref.expanded}/${ref.path}`;
			}
		}
		console.log('grid goldens', JSON.stringify(got));
		expect(got).toEqual(GOLDEN);
	});
	test('the claim: on the open field and the gap A* expands fewer blocks than Dijkstra', () => {
		for (const id of ['open', 'gap']) expect(refSearch(boards[id], true).expanded).toBeLessThan(refSearch(boards[id], false).expanded);
	});
	test('clicking a block toggles a wall and restarts the search; the result follows the reference on the edited board', () => {
		const rnd = mulberry32(21);
		const w = boot();
		const ps = parts(w, PATH);
		for (let k = 0; k < 30; k++) {
			const id = ['open', 'gap', 'cup'][k % 3];
			const rows = boards[id].map((r) => r.split(''));
			expect(w.load(0, fast(PATH, 'open'))).toBeNull();
			press(w, ps[`b_${id}`]);
			const astar = rnd() < 0.5;
			if (astar) press(w, ps.b_astar);
			press(w, ps.b_step); w.tick(2);
			for (let e = 0; e < 4; e++) {
				const i = Math.floor(rnd() * rows.length * rows[0].length);
				const y = Math.floor(i / rows[0].length), x = i % rows[0].length;
				if (rows[y][x] === 'S' || rows[y][x] === 'G') continue;
				rows[y][x] = rows[y][x] === '#' ? '.' : '#';
				w.click(0, ...cell(i, boards[id]));
				expect(w.row(0).steps, 'an edit restarts the run').toBe(0);
			}
			run(w, ps);
			const ref = refSearch(rows.map((r) => r.join('')), astar);
			expect(summary(w)).toBe(ref.path < 0 ? `${astar ? 'A*' : 'Dijkstra'}   expanded ${ref.expanded}   no path` : `${astar ? 'A*' : 'Dijkstra'}   expanded ${ref.expanded}   path ${ref.path}`);
		}
	});
	test('a walled-in goal halts with no path (NoRule)', () => {
		const sealed = PATH.replace('..S............G..', '..S...........#G#.').replace('................../..S', '..............###./..S').replace('..S...........#G#./..................', '..S...........#G#./..............###.');
		const rows = readBoards(sealed).open;
		expect(rows[3] + rows[4] + rows[5]).toBe('..............###...S...........#G#...............###.');
		expect(refSearch(rows, true).path).toBe(-1);
		const w = boot();
		const ps = parts(w, sealed);
		w.load(0, fast(sealed, 'open'));
		run(w, ps);
		expect(summary(w)).toMatch(/no path$/);
	});
	test('snapshot: walls, algorithm and progress round trip; a snapshot of another board is refused', () => {
		const rnd = mulberry32(5);
		const w = boot();
		const ps = parts(w, PATH);
		for (let k = 0; k < 40; k++) {
			w.load(0, PATH);
			press(w, ps[`b_${['open', 'gap', 'cup'][k % 3]}`]);
			if (rnd() < 0.5) press(w, ps.b_astar);
			for (let e = 0; e < 3; e++) w.click(0, ...cell(Math.floor(rnd() * 162), boards.open));
			for (let s = 0; s < Math.floor(rnd() * 25); s++) { press(w, ps.b_step); w.tick(2); }
			const snap = w.snapshot(0);
			const labels = w.labels(0).join('|');
			w.load(0, PATH);
			expect(w.restore(0, snap)).toBe(true);
			expect(w.snapshot(0)).toBe(snap);
			expect(w.labels(0).join('|')).toBe(labels);
		}
		const other = PATH.replace('Dijkstra and A* on a grid', 'Other');
		w.load(1, other);
		expect(w.restore(1, w.snapshot(0))).toBe(false);
	});
	test('planted bug: an extra wall on the open field changes the expansions, so the golden catches it', () => {
		const bad = PATH.replace('..S............G..', '..S....#.......G..');
		expect(bad).not.toBe(PATH);
		const a = refSearch(readBoards(PATH).open, false), b = refSearch(readBoards(bad).open, false);
		expect(b.expanded).not.toBe(a.expanded);
		const w = boot();
		const ps = parts(w, bad);
		w.load(0, fast(bad, 'open'));
		run(w, ps);
		expect(summary(w)).not.toBe(`Dijkstra   expanded ${a.expanded}   path ${a.path}`);
	});
	test('keyboard: A toggles the algorithm, S steps; the draw list stays within 1200 items', () => {
		const w = boot();
		w.load(0, PATH);
		w.x.exhibit_focus(0);
		expect(w.key('a'.charCodeAt(0))).toBe(true);
		expect(summary(w)).toMatch(/^A\*/);
		expect(w.key('s'.charCodeAt(0))).toBe(true);
		w.tick(2);
		expect(w.row(0).steps).toBe(1);
		expect(w.pack(0).n).toBeLessThanOrEqual(1200);
		expect(w.key(XKEY.escape)).toBe(true);
	});
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe('in the room world', () => {
	test('every new script loads next to the scene scripts: no name clashes, and the four run', () => {
		const w = boot(5, true);
		expect(w.load(0, LAMBDA)).toBeNull();
		expect(w.load(1, MERKLE)).toBeNull();
		expect(w.load(2, IFD)).toBeNull();
		expect(w.load(3, PATH)).toBeNull();
		expect(w.load(4, TURING)).toBeNull();
		w.tick(30);
		for (let i = 0; i < 5; i++) expect(w.row(i).loaded).toBe(1);
	});
	test('the generated Timeline script (exhibit.ts exhibitSource) loads, and a Timeline component is not a thing', () => {
		const w = boot(5, true);
		expect(w.load(0, 'fig_two_machines : Timeline {}')).toBeNull();
		expect(w.load(1, 'fig_x : Timeline { Timeline: {duration: 1, mode: 2, poster: 0} }')).toMatch(/not a component/);
		w.tick(5);
		expect(w.row(0).loaded).toBe(1);
	});
	test('inspect: each script describes itself, frames inside 36 x 22 and items within 1200', () => {
		const w = boot();
		for (const [src, kind] of [[LAMBDA, 'rewrite'], [MERKLE, 'graph'], [IFD, 'graph'], [PATH, 'grid']] as const) {
			const r = w.inspect(src);
			expect(r.ok, r.text).toBe(true);
			const j = JSON.parse(r.text);
			expect(j.kind).toBe(kind);
			expect(j.frame.w).toBeLessThanOrEqual(36);
			expect(j.frame.h).toBeLessThanOrEqual(22);
			expect(j.items).toBeLessThanOrEqual(1200);
			expect(j.presets.length).toBeGreaterThan(0);
			console.log(kind, j.title, 'items', j.items);
		}
	});
});
