// Loop test for watch.ts without a GPU: a WebSocket client asks for a spread, gets fonts + article frames,
// and a forced rebuild pushes a fresh article without re-sending identical fonts. Prints the loop latency.
import { afterAll, expect, test } from 'bun:test';
import { unpackMagazine } from '../../src/lib/magazine/format';
import { createWatch } from './watch';

const w = await createWatch({ port: 0, fixture: true, watchFiles: false });
afterAll(() => w.stop());

function client() {
	const ws = new WebSocket(`ws://localhost:${w.port}/ws`);
	const frames: (string | Uint8Array)[] = [];
	const waiters: (() => void)[] = [];
	ws.binaryType = 'arraybuffer';
	ws.onmessage = (e) => { frames.push(typeof e.data === 'string' ? e.data : new Uint8Array(e.data as ArrayBuffer)); waiters.splice(0).forEach((f) => f()); };
	const until = async (n: number) => { while (frames.length < n) await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 2000); }); expect(frames.length).toBeGreaterThanOrEqual(n); };
	return { ws, frames, until, open: new Promise<void>((r) => (ws.onopen = () => r())) };
}

test('want -> fonts + article; rebuild -> article only; bad request -> error frame', async () => {
	const c = client();
	await c.open;
	const t0 = performance.now();
	c.ws.send(JSON.stringify({ type: 'want', reqs: [{ slug: 'ifd', cls: 'wide', layer: 'distilled' }] }));
	await c.until(4);
	const ms = performance.now() - t0;
	expect(JSON.parse(c.frames[0] as string).type).toBe('fonts');
	const head = JSON.parse(c.frames[2] as string);
	expect(head).toMatchObject({ type: 'article', key: 'ifd|wide||distilled' });
	expect(unpackMagazine(c.frames[3] as Uint8Array).spreads.length).toBe(1);
	console.log(`watch loop: first want to article ${ms.toFixed(0)} ms (build ${head.ms.toFixed(0)} ms), fixture producer`);

	const t1 = performance.now();
	await w.rebuild(Date.now());
	await c.until(6);
	console.log(`watch loop: rebuild to article frames ${(performance.now() - t1).toFixed(0)} ms`);
	expect(JSON.parse(c.frames[4] as string).type).toBe('article'); // fonts hash unchanged: not re-sent
	c.ws.close();
});

test('control: more than 12 requests is refused', async () => {
	const c = client();
	await c.open;
	c.ws.send(JSON.stringify({ type: 'want', reqs: Array.from({ length: 13 }, () => ({ slug: 'ifd', cls: 'wide', layer: 'distilled' })) }));
	await c.until(1);
	expect(JSON.parse(c.frames[0] as string).type).toBe('error');
	c.ws.close();
});
