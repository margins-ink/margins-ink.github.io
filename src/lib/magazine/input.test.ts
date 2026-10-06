import { describe, expect, test } from 'bun:test';
import { MagazineInput, keyAction, releaseTarget, velocity, type BookSink, type BookView, type PointerIn } from './input';
import { edgeAt, formatHash, geom, overviewAt, overviewLayout, parseHash, peelFrac, readingOrder, tabAt } from './hit';

const mkView = (o: Partial<BookView> = {}): BookView => ({
	f: 0, layer: 0, spreads: 5, zoom: 1, narrow: false, overview: false, focus: null, pxPerEm: 10,
	links: [], figures: [], overviewAt: () => null, figureTime: () => 0, ...o
});

function harness(o: Partial<BookView> = {}) {
	const calls: string[] = [];
	const v = mkView(o);
	const sink = new Proxy({} as BookSink, {
		get: (_, k: string) => (...a: unknown[]) => void calls.push(`${k}(${a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(',')})`)
	});
	return { calls, v, inp: new MagazineInput(sink, () => v) };
}
const P = (x: number, y: number, t: number, spread = 0, over: Partial<PointerIn> = {}): PointerIn => ({ id: 1, x: x * 10, y: y * 10, t, type: 'mouse', spreadPoint: { spread, x, y }, ...over });

describe('release rule', () => {
	test('flick goes one spread in its direction, else nearest', () => {
		expect(releaseTarget(2.4, 1.5, 1, 5)).toBe(3);
		expect(releaseTarget(2.4, -1.5, 1, 5)).toBe(2);
		expect(releaseTarget(2.6, 0.5, 1, 5)).toBe(3);
		expect(releaseTarget(2.4, 0.5, 1, 5)).toBe(2);
		expect(releaseTarget(5, 3, 1, 5)).toBe(5);
		expect(releaseTarget(1, -3, 1, 5)).toBe(1);
	});
	test('velocity uses the last 80 ms only', () => {
		const s = [{ t: 0, f: 0 }, { t: 500, f: 0.5 }, { t: 540, f: 0.6 }, { t: 580, f: 0.7 }];
		expect(velocity(s)).toBeCloseTo((0.7 - 0.6) / 0.04, 3);
	});
});

describe('wheel never opens the full text', () => {
	test('layer 0: bounce and pulse once per gesture, no goto/open', () => {
		const { calls, inp } = harness();
		for (let i = 0; i < 6; i++) inp.wheelIn({ dx: 0, dy: 120, mode: 0, ctrl: false, t: i * 16, pageH: 900 });
		expect(calls).toEqual(['bounce()', 'pulseTab()']);
		inp.tick(1000);
		expect(calls.some((c) => c.startsWith('openFull') || c.startsWith('goto'))).toBe(false);
	});
	test('layer 1: grabs, accumulates dy/900 and releases idle with velocity', () => {
		const { calls, inp } = harness({ layer: 1, f: 2 });
		inp.wheelIn({ dx: 0, dy: 90, mode: 0, ctrl: false, t: 0, pageH: 900 });
		inp.wheelIn({ dx: 0, dy: 90, mode: 0, ctrl: false, t: 16, pageH: 900 });
		expect(calls[0]).toBe('grab(1)');
		expect(calls.filter((c) => c.startsWith('by'))).toEqual(['by(0.1)', 'by(0.1)']);
		inp.tick(100);
		expect(calls.some((c) => c.startsWith('release'))).toBe(false);
		inp.tick(200);
		expect(calls[calls.length - 1]).toMatch(/^release\(/);
	});
	test('zoomed: wheel pans, ctrl zooms', () => {
		const { calls, inp } = harness({ layer: 1, f: 2, zoom: 3 });
		expect(inp.wheelIn({ dx: 5, dy: 5, mode: 0, ctrl: false, t: 0, pageH: 900, ndcDx: 0.1, ndcDy: 0.2 })).toBe('handled');
		expect(calls).toEqual(['panBy(-0.1,0.2)']);
		expect(inp.wheelIn({ dx: 0, dy: 5, mode: 0, ctrl: true, t: 1, pageH: 900 })).toBe('zoom');
	});
});

describe('keys', () => {
	const k = (key: string, v: BookView, shift = false) => keyAction({ key, shift, mod: false, t: 0 }, v);
	test('layer 0: T and Enter open, arrows and space only pulse', () => {
		const v = mkView();
		expect(k('t', v)).toEqual({ a: 'openFull' });
		expect(k('Enter', v)).toEqual({ a: 'openFull' });
		for (const key of ['ArrowRight', ' ', 'PageDown', 'End']) expect(k(key, v)).toEqual({ a: 'pulse' });
	});
	test('layer 1: turning, Home closes, End goes last, Escape closes', () => {
		const v = mkView({ layer: 1, f: 2 });
		expect(k('ArrowRight', v)).toEqual({ a: 'by', n: 1 });
		expect(k(' ', v, true)).toEqual({ a: 'by', n: -1 });
		expect(k('Home', v)).toEqual({ a: 'closeFull' });
		expect(k('End', v)).toEqual({ a: 'goto', n: 5 });
		expect(k('Escape', v)).toEqual({ a: 'closeFull' });
		expect(k('T', v)).toEqual({ a: 'closeFull' });
	});
	test('Escape priority: focus, overview, layer; arrows seek while focused', () => {
		expect(k('Escape', mkView({ layer: 1, overview: true, focus: 3 }))).toEqual({ a: 'unfocus' });
		expect(k('Escape', mkView({ layer: 1, overview: true }))).toEqual({ a: 'overview', on: false });
		expect(k('ArrowRight', mkView({ layer: 1, focus: 3 }))).toEqual({ a: 'seek', dt: 0.25 });
		expect(k('Escape', mkView())).toEqual({ a: 'none' });
	});
	test('keyIn clamps by() to 1..N through goto', () => {
		const { calls, inp } = harness({ layer: 1, f: 5 });
		inp.keyIn({ key: 'ArrowRight', shift: false, mod: false, t: 0 });
		expect(calls).toEqual(['goto(5)']);
	});
});

describe('corner peel', () => {
	test('drag past 25% opens, below snaps shut', () => {
		const g = geom(false);
		expect(tabAt(g, 78, 54)).toBe(true);
		expect(peelFrac(g, 78, 68)).toBeCloseTo(0.25);
		for (const [endX, open] of [[60, true], [72, false]] as const) {
			const { calls, inp } = harness();
			inp.pointerDown(P(78, 54, 0));
			inp.pointerMove(P(endX, 52, 50));
			inp.pointerUp(P(endX, 52, 100));
			expect(calls[calls.length - 1]).toBe(`cornerRelease(${open})`);
			expect(calls.some((c) => c.startsWith('openFull'))).toBe(false);
		}
	});
	test('a tap on the tab opens the full text at spread 1', () => {
		const { calls, inp } = harness();
		inp.pointerDown(P(78, 54, 0));
		inp.pointerUp(P(78, 54, 40));
		expect(calls).toEqual(['cornerRelease(false)', 'openFull(1)']);
	});
});

describe('clicks and scrubs in the full layer', () => {
	test('outer 12% edge click turns, inside does nothing', () => {
		const g = geom(false);
		expect(edgeAt(g, 3, 10)).toBe(-1);
		expect(edgeAt(g, 78, 10)).toBe(1);
		expect(edgeAt(g, 40, 10)).toBe(0);
		const { calls, inp } = harness({ layer: 1, f: 2 });
		inp.pointerDown(P(78, 20, 0, 2, { x: 0, y: 0 }));
		inp.pointerUp(P(78, 20, 30, 2, { x: 0, y: 0 }));
		expect(calls).toEqual(['goto(3)']);
	});
	test('links win over edges', () => {
		const link = { x0: 74, y0: 18, x1: 79, y1: 22, kind: 0, target: 'u', spread: 2 };
		const { calls, inp } = harness({ layer: 1, f: 2, links: [link] });
		inp.pointerDown(P(77, 20, 0, 2, { x: 0, y: 0 }));
		inp.pointerUp(P(77, 20, 30, 2, { x: 0, y: 0 }));
		expect(calls.length).toBe(1);
		expect(calls[0].startsWith('follow(')).toBe(true);
	});
	test('drag from the right margin scrubs, release carries velocity', () => {
		const { calls, inp } = harness({ layer: 1, f: 2 });
		inp.pointerDown(P(78, 20, 0, 2));
		inp.pointerMove(P(70, 20, 30, 2, { x: 700 }));
		inp.pointerMove(P(58, 20, 60, 2, { x: 580 }));
		inp.pointerUp(P(58, 20, 70, 2, { x: 580 }));
		expect(calls[0]).toBe('grab(1)');
		expect(calls.filter((c) => c.startsWith('by')).length).toBe(2);
		expect(calls[calls.length - 1]).toMatch(/^release\(/);
	});
	test('double-click on a figure focuses it', () => {
		const fig = { x0: 5, y0: 10, x1: 30, y1: 30, id: 7, spread: 0, mode: 0, duration: 12 };
		const { calls, inp } = harness({ figures: [fig] });
		inp.pointerDown(P(10, 15, 0, 0, { x: 100, y: 150 }));
		inp.pointerUp(P(10, 15, 20, 0, { x: 100, y: 150 }));
		inp.pointerDown(P(10, 15, 100, 0, { x: 100, y: 150 }));
		inp.pointerUp(P(10, 15, 120, 0, { x: 100, y: 150 }));
		expect(calls).toEqual(['focusFigure(7)']);
	});
});

describe('figure scrubbing', () => {
	const fig = { x0: 5, y0: 10, x1: 30, y1: 30, id: 7, spread: 0, mode: 0, duration: 10 };
	test('a horizontal drag inside a figure scrubs: begin once, by = dx / width * duration, end with velocity', () => {
		const { calls, inp } = harness({ figures: [fig] });
		expect(inp.pointerDown(P(10, 15, 0))).toBe('handled');
		inp.pointerMove(P(15, 15, 30));
		inp.pointerMove(P(20, 15, 60));
		inp.pointerUp(P(20, 15, 70));
		expect(calls[0]).toBe('figureScrubBegin(7)');
		const by = calls.filter((c) => c.startsWith('figureScrubBy')).map((c) => Number(/,(.*)\)/.exec(c)![1]));
		expect(by.length).toBe(2);
		expect(by[0]).toBeCloseTo((5 / 25) * 10, 6);
		expect(calls[calls.length - 1]).toMatch(/^figureScrubEnd\(7,/);
		expect(Number(/,(.*)\)/.exec(calls[calls.length - 1])![1])).toBeGreaterThan(0);
	});
	test('control: a drag outside any figure never scrubs, and a static figure does not either', () => {
		const a = harness({ figures: [fig] });
		a.inp.pointerDown(P(60, 15, 0));
		a.inp.pointerMove(P(70, 15, 30));
		a.inp.pointerUp(P(70, 15, 40));
		expect(a.calls.some((c) => c.startsWith('figureScrub'))).toBe(false);
		const b = harness({ figures: [{ ...fig, mode: 3 }] });
		expect(b.inp.pointerDown(P(10, 15, 0))).toBe('ignore');
		expect(b.calls.length).toBe(0);
	});
	test('a click on a figure does not start a scrub; hover reports the figure and clears off it', () => {
		const { calls, inp } = harness({ figures: [fig] });
		inp.pointerDown(P(10, 15, 0));
		inp.pointerUp(P(10, 15, 10));
		expect(calls.some((c) => c.startsWith('figureScrub'))).toBe(false);
		const h = harness({ figures: [fig] });
		h.inp.pointerMove({ ...P(10, 15, 0), id: 9 });
		h.inp.pointerMove({ ...P(60, 15, 20), id: 9 });
		expect(h.calls).toEqual(['figureHover(7)', 'figureHover(null)']);
	});
});

describe('overview, hash, order', () => {
	test('overview cells tile without overlap and hit-test back', () => {
		const cells = overviewLayout(7, 16 / 9);
		expect(cells.length).toBe(7);
		for (const c of cells) {
			expect(c.x).toBeGreaterThanOrEqual(0);
			expect(c.x + c.w).toBeLessThanOrEqual(1.0001);
			expect(c.y + c.h).toBeLessThanOrEqual(1.0001);
			expect(overviewAt(cells, c.x + c.w / 2, c.y + c.h / 2)).toBe(c.spread);
		}
		expect(overviewAt(cells, 0.001, 0.001)).toBeNull();
	});
	test('overview click goes to the spread and closes', () => {
		const { calls, inp } = harness({ overview: true, overviewAt: () => 3 });
		inp.overviewClick(0.5, 0.5);
		expect(calls).toEqual(['overview(false)', 'openFull(3)']);
	});
	test('hash parse and format round trip; bad fragments are rejected', () => {
		expect(parseHash('#s3', 5)).toEqual({ layer: 1, spread: 3 });
		expect(parseHash('#full', 5)).toEqual({ layer: 1, spread: 1 });
		expect(parseHash('#full/s4', 5)).toEqual({ layer: 1, spread: 4 });
		expect(parseHash('#s0', 5)).toEqual({ layer: 0, spread: 0 });
		expect(parseHash('#s9', 5)).toBeNull();
		expect(parseHash('#full/s0', 5)).toBeNull();
		expect(parseHash('#intro', 5)).toBeNull();
		expect(formatHash({ layer: 0, spread: 0 })).toBe('');
		expect(parseHash(formatHash({ layer: 1, spread: 3 }), 5)).toEqual({ layer: 1, spread: 3 });
	});
	test('reading order is frame, then y, then x', () => {
		const ls = [{ frame: 1, yTop: 0, x0: 0 }, { frame: 0, yTop: 5, x0: 0 }, { frame: 0, yTop: 1, x0: 9 }, { frame: 0, yTop: 1, x0: 2 }];
		expect(readingOrder(ls).map((l) => [l.frame, l.yTop, l.x0])).toEqual([[0, 1, 2], [0, 1, 9], [0, 5, 0], [1, 0, 0]]);
	});
});
