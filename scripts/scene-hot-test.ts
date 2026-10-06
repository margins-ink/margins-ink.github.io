// Hot reload test (dev server on :5180, headless Chrome on CDP_PORT 9333): bun scripts/scene-hot-test.ts
// Edits world/scene/12-decor.flecs while the page runs, asserts the render changes, the cab state survives, a bad script is
// rejected with the scene intact, and prints the save-to-pixels latency. The file is restored at the end.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open, sleep } from './cdp';

// a private dev server watches a COPY of world/scene, so the shared tree and :5180 are never touched
const COPY = mkdtempSync(join(process.env.TMPDIR_TESTS ?? '/Volumes/Projects/tmp', 'scene-hot-'));
cpSync(new URL('../world/scene', import.meta.url).pathname, COPY, { recursive: true });
const FILE = join(COPY, '12-decor.flecs');
const PORT = process.env.SITE_PORT ?? '5185';
const server = Bun.spawn(['bun', 'node_modules/vite/bin/vite.js', 'dev', '--port', PORT, '--strictPort', '--host', '127.0.0.1'], {
	cwd: new URL('..', import.meta.url).pathname,
	env: { ...process.env, SCENE_DIR: COPY },
	stdout: 'ignore',
	stderr: 'ignore'
});
for (let i = 0; i < 100; i++) {
	if (await fetch(`http://127.0.0.1:${PORT}/`).then((r) => r.ok, () => false)) break;
	await Bun.sleep(300);
}
const orig = readFileSync(FILE, 'utf8');
const URL_ = `http://127.0.0.1:${PORT}/`;
let failed = 0;
const check = (name: string, ok: boolean, extra: unknown = '') => {
	console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(extra));
	if (!ok) failed++;
};
const RUG = 'prefab NeonPink : Neon { LampColour: {6, 0.8, 3.2} }';
if (!orig.includes(RUG)) throw new Error('NeonPink line not found');
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => (server.kill(), process.exit(2)));
const page = await open(URL_);
try {
	for (let i = 0; i < 100; i++) {
		if (await page.eval<boolean>('!!globalThis.__sceneHot')) break;
		await sleep(200);
	}
	// the first scroll teleports the cab to that floor (room.setProgress); consume it, then ride back to the top
	await page.eval('scrollTo(0, 1e6)');
	await sleep(500);
	await page.eval('scrollTo(0, 0)');
	await sleep(9000);
	const es = () => page.eval<number[]>('Array.from(__elev.state())');
	/** ms from the save (server clock) to the GPU being done with the new frame (page clock), parsed from the page's own log line; same machine */
	const savedToPixels = () => Number(/(\d+) ms from save/.exec(reloaded().at(-1)?.text ?? '')?.[1] ?? NaN);
	const reloaded = () => page.msgs.filter((m) => /scene: .*reloaded/.test(m.text));
	const rejected = () => page.msgs.filter((m) => m.type === 'error' && /rejected/.test(m.text));
	// the lobby's pink neon 'hi!' sign: emissive, so its colour does not wait for the lightmap rebake
	const probe = async () => page.avg(await page.shot(), 690, 95, 100, 90);
	const edit = async (src: string) => {
		const t0 = Date.now();
		writeFileSync(FILE, src);
		return t0;
	};
	const waitFor = async (f: () => boolean, ms = 5000) => {
		for (let t = 0; t < ms && !f(); t += 25) await sleep(25);
		return f();
	};

	const base = await probe();
	const s0 = await es();
	console.log('baseline rug rgb', base.map((v) => v.toFixed(1)).join(','), 'cab floor', s0[3], 'pos m', s0[0].toFixed(3));

	// 1. colour edit: the terracotta rug turns green
	let n = reloaded().length;
	const green_ = orig.replace(RUG, 'prefab NeonPink : Neon { LampColour: {0.8, 6, 0.8} }');
	let t0 = await edit(green_);
	// another lane editing src/ makes the dev server reload the page now and then; one retry covers a save lost to that
	if (!(await waitFor(() => reloaded().length > n, 3000))) {
		console.log('note: first save not seen (page reloaded under us?), retrying once');
		await edit(orig);
		await sleep(500);
		t0 = await edit(green_);
	}
	check('colour edit: reload message', await waitFor(() => reloaded().length > n), page.msgs.slice(-5));
	const latency = savedToPixels();
	await sleep(600);
	const green = await probe();
	console.log('after edit rgb', green.map((v) => v.toFixed(1)).join(','), `save-to-pixels ${latency} ms`);
	check('colour edit: render changed (green up, red down)', green[1] > base[1] + 10 && green[0] < base[0] - 10, { base, green });
	const s1 = await es();
	check('cab state survives (floor, position, doors open)', s1[3] === s0[3] && Math.abs(s1[0] - s0[0]) < 1e-4 && s1[6] > 0.99, { s0, s1 });
	const lat: number[] = [latency];

	// 2. more latency samples, alternating colours
	for (let i = 0; i < 5; i++) {
		n = reloaded().length;
		t0 = await edit(orig.replace(RUG, `prefab NeonPink : Neon { LampColour: {${i % 2 ? '0.8, 6, 0.8' : '0.8, 0.8, 6'}} }`));
		await waitFor(() => reloaded().length > n);
		lat.push(savedToPixels());
	}
	console.log('save-to-pixels ms', lat.join(' '), 'median', [...lat].sort((a, b) => a - b)[Math.floor(lat.length / 2)]);

	// 3. planted bugs: a syntax error and an unknown component leave the scene intact and report
	const good = await edit(orig.replace(RUG, 'prefab NeonPink : Neon { LampColour: {0.8, 6, 0.8} }'));
	await sleep(1200);
	const before = await probe();
	for (const [label, bad] of [
		['syntax error', orig.replace(RUG, 'prefab RugTerracotta : DecorRug { Albedo: {0.9, ')],
		['unknown component', orig.replace(RUG, 'prefab NeonPink : Neon { Nonsense: {1, 2} }')]
	] as const) {
		const r0 = rejected().length;
		await edit(bad);
		check(`${label}: console.error`, await waitFor(() => rejected().length > r0), page.msgs.slice(-4));
		await sleep(800);
		const toast = await page.eval<string>("document.getElementById('scene-hot-toast')?.textContent ?? ''");
		check(`${label}: on-screen toast with the error`, /rejected/.test(toast), toast);
		console.log('  toast:', toast.split('\n').slice(0, 3).join(' | '));
		const after = await probe();
		check(`${label}: scene intact`, after.every((v, i) => Math.abs(v - before[i]) < 3), { before, after });
	}
	// recovery: a good script works again afterwards
	n = reloaded().length;
	await edit(orig);
	check('recovery after errors: reload message', await waitFor(() => reloaded().length > n));
	await sleep(800);
	const rest = await probe();
	check('recovery: original (pink) sign back, not the green one', rest[0] > rest[1] && Math.abs(rest[0] - base[0]) < 12 && Math.abs(rest[2] - base[2]) < 12, { base, rest });
	const s2 = await es();
	check('cab state survives errors and recovery', s2[3] === s0[3] && Math.abs(s2[0] - s0[0]) < 1e-4, { s0, s2 });

	// 4. mid-travel: the cab keeps travelling through a reload
	await page.eval('scrollTo(0, 1e6)');
	let m0 = await es();
	for (let i = 0; i < 100 && !(m0[10] !== 0 && m0[0] > 0.3); i++) {
		await sleep(50);
		m0 = await es();
	}
	n = reloaded().length;
	await edit(orig.replace(RUG, 'prefab NeonPink : Neon { LampColour: {6, 6, 0.8} }'));
	await waitFor(() => reloaded().length > n);
	const m1 = await es();
	check('mid-travel: still travelling, position continuous', m0[10] !== 0 && m1[0] >= m0[0] - 1e-3 && m1[0] - m0[0] < 1.5, { m0: m0.slice(0, 13), m1: m1.slice(0, 13) });
	await sleep(6000);
	const m2 = await es();
	check('mid-travel: arrives at its target floor with doors open', m2[3] === m2[4] && m2[3] > 0 && m2[6] > 0.99, m2.slice(0, 13));
	const errors = page.msgs.filter((m) => m.type === 'exception' || (m.type === 'error' && !/rejected/.test(m.text)));
	check('no other errors', errors.length === 0, errors);
} finally {
	await page.close();
	server.kill();
}
process.exit(failed ? 1 : 0);
