// Smoke test of the reader exports in world.wasm: bun scripts/reader-smoke.ts
// Opens/closes an article 50 times and checks the entity count returns to its baseline.
import { resolve } from 'node:path';

const wasm = await Bun.file(resolve(import.meta.dir, '../src/lib/gpu/room/world.wasm')).arrayBuffer();
let memory!: WebAssembly.Memory;
const dv = () => new DataView(memory.buffer);
const imports = {
	wasi_snapshot_preview1: {
		environ_sizes_get: (a: number, b: number) => (dv().setUint32(a, 0, true), dv().setUint32(b, 0, true), 0),
		environ_get: () => 0,
		clock_time_get: (_i: number, _p: bigint, out: number) => (dv().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true), 0),
		fd_close: () => 0, fd_fdstat_get: () => 8, fd_prestat_get: () => 8, fd_prestat_dir_name: () => 8, fd_seek: () => 8,
		fd_write: (fd: number, iov: number, n: number, out: number) => {
			let total = 0;
			for (let i = 0; i < n; i++) {
				const p = dv().getUint32(iov + i * 8, true), l = dv().getUint32(iov + i * 8 + 4, true);
				total += l;
				console.warn('wasm:', new TextDecoder().decode(new Uint8Array(memory.buffer, p, l)));
			}
			dv().setUint32(out, total, true);
			return 0;
		},
		poll_oneoff: () => 8,
		random_get: (p: number, n: number) => (crypto.getRandomValues(new Uint8Array(memory.buffer, p, n)), 0),
		proc_exit: (c: number) => { throw new Error(`exit ${c}`); }
	}
};
const { instance } = await WebAssembly.instantiate(wasm, imports);
const x = instance.exports as any;
memory = x.memory;

const items = [
	{ slug: 'a', date: '2026-01-01', archived: false, tex: [0, 0, 100, 140] },
	{ slug: 'b', date: '2026-02-01', archived: false, tex: [100, 0, 100, 140] },
	{ slug: 'c', date: '2025-02-01', archived: true, tex: [200, 0, 100, 140] }
];
const input = new TextEncoder().encode(JSON.stringify({ items, signs: [[0, 0, 10, 10], [0, 0, 10, 10], [0, 0, 10, 10]], map: [0, 0, 10, 10] }));
new Uint8Array(memory.buffer, x.world_input(input.length), input.length).set(input);
if (x.world_build() !== 0) throw new Error(new TextDecoder().decode(new Uint8Array(memory.buffer, x.world_buf(5), x.world_buf_len(5))));

const state = () => new Float32Array(memory.buffer, x.reader_state_ptr(), 40);
const events: string[] = [];
const drain = () => { for (let e; (e = x.event_poll()); ) events.push(`${e >>> 24}:${e & 0xffffff}`); };
const fail = (m: string) => { console.error('FAIL', m); process.exit(1); };

x.set_viewport(56);
x.set_reading_pose(0.1, 1.5, 2.0, 0.31, 0.434);
// one warm-up cycle: the first open registers tables/pair ids lazily
x.article_open(0, 2, 40, 56, 0.6, 1);
x.world_tick(16);
x.article_close(1);
const base = x.world_entity_count();
console.log('baseline entities', base);

// one open with state samples
x.article_open(1, 5, 40, 56, 0.6, 0);
const ents = x.world_entity_count();
console.log('entities with 5 pages', ents, '(+', ents - base, ')');
let overshoot = 0;
for (let i = 0; i <= 120; i++) {
	x.world_tick(1000 / 60);
	drain();
	const s = state();
	overshoot = Math.max(overshoot, s[0] - 1);
	if (i % 12 === 0) console.log(`f${i} t=${s[0].toFixed(3)} lift=${s[6].toFixed(2)} camT=${s[7].toFixed(2)} magPos=(${s[12].toFixed(3)},${s[13].toFixed(3)},${s[14].toFixed(3)}) half=(${s[16].toFixed(3)},${s[17].toFixed(3)}) obj=${s[5]} art=${s[4]}`);
}
if (overshoot > 1e-4) fail(`overshoot ${overshoot}`);
if (!events.includes(`1:1`)) fail(`no Opened event: ${events}`);
x.scroll_by(30);
for (let i = 0; i < 10; i++) x.world_tick(1000 / 120);
let s = state();
console.log('scroll', s[2], 'max', s[3], 'first/visible/centre', s[8], s[9], s[10]);
if (s[2] !== 30 || s[3] <= 0) fail('scroll');
x.scroll_by(1e6);
x.world_tick(8);
if (state()[2] !== state()[3]) fail('scroll clamp');
x.scroll_fling(-200);
for (let i = 0; i < 300; i++) x.world_tick(1000 / 120);
drain();
console.log('after fling', state()[2], 'events', events.join(' '));
x.article_close(0);
for (let i = 0; i < 120; i++) x.world_tick(1000 / 60);
drain();
if (!events.some((e) => e.startsWith('2:'))) fail('no Closed event');
if (x.world_entity_count() !== base) fail(`entities after close ${x.world_entity_count()} != ${base}`);
if (state()[4] !== -1) fail('state still active');

// leak test: 50 open/close cycles, mix of animated and snapped
for (let c = 0; c < 50; c++) {
	x.article_open(c % 3, 3 + (c % 5), 40, 56, 0.6, c & 1);
	for (let i = 0; i < 5; i++) x.world_tick(16);
	if (c % 7 === 0) x.article_open((c + 1) % 3, 4, 40, 56, 0.6, 1); // switch while open
	x.article_close(c % 2);
	for (let i = 0; i < 90; i++) x.world_tick(16);
	x.article_close(1);
}
drain();
const end = x.world_entity_count();
console.log('entities after 50 cycles', end, 'baseline', base, 'memory MB', (memory.buffer.byteLength / 1048576).toFixed(1));
if (end !== base) fail('entity leak');
console.log('OK');
