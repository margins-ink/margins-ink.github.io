import { describe, expect, test } from 'bun:test';
import { ExhibitKind, sampleReading, type ReadingModel } from '../magazine/format';
import { TONE_NAMES, XD, XFLAG, XKEY, XPOINTER, XRESULT, XS, XSHAPE, type ExhibitApi } from './abi';
import {
	DRAG_THRESHOLD, MAX_EXHIBIT_ITEMS, OVL_SHAPE, RING_STROKE_EM, TONES, cachedText, convertItems, createExhibitDrawer, createRouter, cursorOf, evalTimelineChannels, exhibitClip, exhibitId,
	exhibitSource, keyMods, loadExhibits, mappingOf, newPools, routeKey, toLocal, toneColour, xkeyOf, type PtrEvent, type RouterDeps, type TextDeps
} from './exhibit';
import { applyExhibitReload } from './exhibit-hot';
import { fromBlob, keepExhibitFragment, parseExhibitFragment, setExhibitFragment, stripExhibitFragment, toBlob } from './exhibit-fragment';
import { createScrollState, type ScrollEnv } from './scrollstate';
import { THEME } from './theme';
import type { Overlay } from './page-api';
import type { UiGlyph } from './ui/types';

/** every glyph 0.5 em wide, glyph id = char code: shaping without the font tables */
const fakeText: TextDeps = {
	shape: (t, _f, s) => ({ glyphs: [...t].filter((c) => c !== ' ').map((c, i) => ({ dx: i * 0.5 * s, glyphId: c.codePointAt(0)! })), width: [...t].length * 0.5 * s }),
	truncate: (t, _f, s, w) => (t.length * 0.5 * s <= w ? t : t.slice(0, Math.max(0, Math.floor(w / (0.5 * s)) - 1)) + '…')
};

const item = (shape: number, x: number, y: number, w: number, h: number, tone = 1, flags = 0, aux = 0): number[] => {
	const a = new Array(XD.stride).fill(0);
	a[XD.x] = x; a[XD.y] = y; a[XD.w] = w; a[XD.h] = h; a[XD.shape] = shape; a[XD.tone] = tone; a[XD.flags] = flags; a[XD.aux] = aux;
	return a;
};
const pack = (...items: number[][]) => Float32Array.from(items.flat());
const run = (items: Float32Array, m = { x: 100, y: 50, k: 20 }, alpha = 1, strs: string[] = []) => {
	const out = { overlays: [] as Overlay[], uiText: [] as UiGlyph[] };
	convertItems(items, items.length / XD.stride, (i) => strs[i] ?? '', m, alpha, fakeText, newPools(), out);
	return out;
};

describe('tones', () => {
	test('every tone name maps to a THEME slot, in TONE_NAMES order', () => {
		expect(Object.keys(TONES).sort()).toEqual([...TONE_NAMES].sort());
		const slot: Record<string, readonly number[]> = {
			panel: THEME.surface.card, ink: THEME.text.primary, ink2: THEME.text.secondary, ink3: THEME.text.tertiary, accent: THEME.accent, accent2: THEME.accent2,
			rule: THEME.hairline.card, ground: THEME.surface.ground, accentTint: THEME.accentTint, panelHi: THEME.surface.popover, accentDim: THEME.accent, accentInk: THEME.accentInk,
			node: THEME.surface.popover, nodeHi: THEME.hairline.card, edge: THEME.ink4, line: THEME.hairline.ground, ink4: THEME.ink4
		};
		TONE_NAMES.forEach((name, id) => {
			const c = toneColour(id);
			expect([c[0], c[1], c[2]]).toEqual([...slot[name]]);
			expect(c[3]).toBe(name === 'accentDim' ? 0.45 : 1);
		});
		expect(toneColour(99)).toEqual(toneColour(TONE_NAMES.indexOf('ink')));
	});
	test('the monochrome accent is ink-1 (ix has no accent hue), distinct from the other tones', () => {
		const acc = toneColour(TONE_NAMES.indexOf('accent'));
		for (const n of ['panel', 'ink2', 'ink3', 'rule', 'ground']) expect(toneColour(TONE_NAMES.indexOf(n as never))).not.toEqual(acc);
	});
});

describe('item conversion', () => {
	const m = { x: 100, y: 50, k: 20 };
	test('rrect: box and radius in px', () => {
		const { overlays } = run(pack(item(XSHAPE.rrect, 1, 2, 3, 4, 0, 0, 0.25)), m);
		expect(overlays).toHaveLength(1);
		expect(overlays[0]).toMatchObject({ x: 120, y: 90, w: 60, h: 80, radius: 5, shape: OVL_SHAPE.rrect });
		const c = toneColour(0);
		expect([overlays[0].r, overlays[0].g, overlays[0].b, overlays[0].a]).toEqual([c[0], c[1], c[2], 1]);
	});
	test('circle and dot are the box circle', () => {
		for (const s of [XSHAPE.circle, XSHAPE.dot]) {
			const { overlays } = run(pack(item(s, 0, 0, 1, 1)), m);
			expect(overlays[0]).toMatchObject({ x: 100, y: 50, w: 20, h: 20, shape: OVL_SHAPE.circle });
		}
	});
	test('ring: a rounded outline, aux = corner radius em, fixed stroke (a radius must never become the stroke: it drew a filled disc)', () => {
		const o = run(pack(item(XSHAPE.ring, 0, 0, 2, 2, 4, 0, 0.6)), m).overlays[0];
		expect(o).toMatchObject({ w: 40, h: 40, shape: OVL_SHAPE.ring });
		expect(o.radius).toBeCloseTo(12, 5);
		expect(o.width).toBeCloseTo(RING_STROKE_EM * 20, 5);
		expect(run(pack(item(XSHAPE.ring, 0, 0, 2, 2, 4, 0, 0.001)), m).overlays[0].width).toBeCloseTo(RING_STROKE_EM * 20, 5);
	});
	test('line and arrow: start and delta in px', () => {
		const l = run(pack(item(XSHAPE.line, 1, 1, 2, -1, 6, 0, 0.05)), m).overlays[0];
		expect(l).toMatchObject({ x: 120, y: 70, w: 40, h: -20, shape: OVL_SHAPE.line });
		expect(l.width).toBeCloseTo(1, 5);
		const a = run(pack(item(XSHAPE.arrow, 0, 0, 3, 0, 4, 0, 0.2)), m).overlays[0];
		expect(a).toMatchObject({ x: 100, y: 50, w: 60, h: 0, shape: OVL_SHAPE.arrow });
		expect(a.width).toBeCloseTo(4, 5);
	});
	test('hatch: pitch in px, default pitch when none is given', () => {
		expect(run(pack(item(XSHAPE.hatch, 0, 0, 4, 1, 3, 0, 0.5)), m).overlays[0]).toMatchObject({ shape: OVL_SHAPE.hatch, width: 10 });
		expect(run(pack(item(XSHAPE.hatch, 0, 0, 4, 1)), m).overlays[0].width).toBeCloseTo(7, 6);
	});
	test('label: glyphs at the baseline, size in px, alignment', () => {
		const strs = ['abc'];
		const left = run(pack(item(XSHAPE.label, 2, 3, 0, 0.5, 1, 0, 0)), m, 1, strs).uiText; // size 10 px, width 15
		expect(left.map((g) => [g.x, g.y, g.size, g.glyphId])).toEqual([[140, 110, 10, 97], [145, 110, 10, 98], [150, 110, 10, 99]]);
		const centre = run(pack(item(XSHAPE.label, 2, 3, 0, 0.5, 1, 1 << 8, 0)), m, 1, strs).uiText;
		expect(centre[0].x).toBe(140 - 7.5);
		const right = run(pack(item(XSHAPE.label, 2, 3, 0, 0.5, 1, 2 << 8, 0)), m, 1, strs).uiText;
		expect(right[0].x).toBe(140 - 15);
		const mono = run(pack(item(XSHAPE.label, 0, 0, 0, 0.5, 1, XFLAG.mono, 0)), m, 1, strs).uiText;
		expect(mono[0].font).toBe('mono');
	});
	test('label: max width truncates, empty and tiny labels draw nothing', () => {
		const t = run(pack(item(XSHAPE.label, 0, 0, 1, 0.5, 1, 0, 0)), m, 1, ['abcdefgh']).uiText; // 20 px wide, 5 px per glyph
		expect(t.length).toBeLessThan(5);
		expect(run(pack(item(XSHAPE.label, 0, 0, 0, 0.5, 1, 0, 0)), m, 1, ['']).uiText).toHaveLength(0);
		expect(run(pack(item(XSHAPE.label, 0, 0, 0, 0.01, 1, 0, 0)), m, 1, ['abc']).uiText).toHaveLength(0);
	});
	test('alpha: block alpha multiplies, dim flag fades, accentDim keeps its own', () => {
		expect(run(pack(item(XSHAPE.rrect, 0, 0, 1, 1)), m, 0.5).overlays[0].a).toBeCloseTo(0.5, 6);
		expect(run(pack(item(XSHAPE.rrect, 0, 0, 1, 1, 1, XFLAG.dim)), m).overlays[0].a).toBeCloseTo(0.4, 6);
		expect(run(pack(item(XSHAPE.rrect, 0, 0, 1, 1, TONE_NAMES.indexOf('accentDim'))), m, 0.5).overlays[0].a).toBeCloseTo(0.225, 6);
		expect(run(pack(item(XSHAPE.rrect, 0, 0, 1, 1)), m, 0).overlays).toHaveLength(0);
	});
	test('non-finite and unknown items are skipped; the list is capped at 1200', () => {
		expect(run(pack(item(XSHAPE.rrect, NaN, 0, 1, 1), item(99, 0, 0, 1, 1), item(XSHAPE.rrect, 0, 0, Infinity, 1), item(XSHAPE.rrect, 0, 0, 1, 1))).overlays).toHaveLength(1);
		const many = pack(...Array.from({ length: MAX_EXHIBIT_ITEMS + 100 }, () => item(XSHAPE.rrect, 0, 0, 1, 1)));
		const out = { overlays: [] as Overlay[], uiText: [] as UiGlyph[] };
		convertItems(many, MAX_EXHIBIT_ITEMS + 100, () => '', m, 1, fakeText, newPools(), out);
		expect(out.overlays).toHaveLength(MAX_EXHIBIT_ITEMS);
	});
	test('every XSHAPE converts to something', () => {
		for (const s of Object.values(XSHAPE)) {
			const o = run(pack(item(s, 0, 0, 1, 1, 1, 0, 0)), m, 1, ['x']);
			expect(o.overlays.length + o.uiText.length).toBeGreaterThan(0);
		}
	});
	test('shaped strings are cached by (string, size, font)', () => {
		let calls = 0;
		const c = cachedText({ shape: (...a) => { calls++; return fakeText.shape(...a); }, truncate: fakeText.truncate });
		c.shape('abc', 'sans', 12); c.shape('abc', 'sans', 12); c.shape('abc', 'mono', 12); c.shape('abc', 'sans', 13);
		expect(calls).toBe(3);
	});
});

describe('scissor', () => {
	const model = sampleReading();
	const rect = { x: 40, y: 200, w: 500, h: 260 };
	const api = (items: number[][]): Pick<ExhibitApi, 'pack' | 'str' | 'state'> => ({
		pack: () => ({ count: items.length, items: pack(...items) }),
		str: () => 'x',
		state: () => { const s = new Float32Array(XS.stride * XS.max); for (let i = 0; i < XS.max; i++) s[i * XS.stride + XS.loaded] = 1; return s; }
	});
	const frame = (items: number[][], over: Partial<Parameters<ReturnType<typeof createExhibitDrawer>['frame']>[0]> = {}) =>
		createExhibitDrawer(fakeText).frame({
			model, api: api(items), emPx: 18, viewW: 800, viewH: 600, foldClipY: () => Infinity, rectOf: () => rect, alphaOf: () => 1, dyOf: () => 0, first: 0, count: 1, ...over
		});

	test('the clip is exactly the block rect, even with an item far off frame', () => {
		const planted = item(XSHAPE.rrect, 900, 900, 5, 5); // way outside the frame
		const out = frame([item(XSHAPE.rrect, 1, 1, 2, 2), planted]);
		expect(out).toHaveLength(1);
		expect(out[0].clip).toEqual({ x0: 40, y0: 200, x1: 540, y1: 460 });
		expect(out[0].overlays).toHaveLength(2); // the off-frame item is still emitted: the scissor is what cuts it
		const px = out[0].overlays[1];
		expect(px.x).toBeGreaterThan(out[0].clip.x1);
	});
	test('control: a clip that followed the items would differ from the block rect', () => {
		const out = frame([item(XSHAPE.rrect, 900, 900, 5, 5)]);
		const itemsBox = { x1: out[0].overlays[0].x + out[0].overlays[0].w };
		expect(out[0].clip.x1).not.toBe(itemsBox.x1);
	});
	test('intersects the viewport and the fold clip, null when nothing is left', () => {
		expect(exhibitClip({ x: -20, y: 580, w: 500, h: 100 }, 800, 600)).toEqual({ x0: 0, y0: 580, x1: 480, y1: 600 });
		expect(exhibitClip(rect, 800, 600, 300)).toEqual({ x0: 40, y0: 200, x1: 540, y1: 300 });
		expect(exhibitClip(rect, 800, 600, 150)).toBeNull();
		expect(exhibitClip({ x: 0, y: 700, w: 10, h: 10 }, 800, 600)).toBeNull();
		expect(frame([item(XSHAPE.rrect, 0, 0, 1, 1)], { rectOf: () => ({ x: 0, y: 700, w: 10, h: 10 }) })).toHaveLength(0);
	});
	test('the enter rise moves rect and clip together', () => {
		const out = frame([item(XSHAPE.rrect, 0, 0, 1, 1)], { dyOf: () => 12 });
		expect(out[0].clip).toEqual({ x0: 40, y0: 212, x1: 540, y1: 472 });
		expect(out[0].overlays[0].y).toBe(212);
	});
	test('exhibits that are not loaded, fully transparent, or at most three per frame', () => {
		expect(frame([item(XSHAPE.rrect, 0, 0, 1, 1)], { alphaOf: () => 0 })).toHaveLength(0);
		const unloaded = { ...api([item(XSHAPE.rrect, 0, 0, 1, 1)]), state: () => new Float32Array(XS.stride * XS.max) };
		expect(frame([], { api: unloaded })).toHaveLength(0);
		const m4 = { ...model, exhibits: [0, 1, 2, 3, 4].map(() => model.exhibits[0]) };
		expect(frame([item(XSHAPE.rrect, 0, 0, 1, 1)], { model: m4, count: 5 })).toHaveLength(3);
	});
	test('block alpha 0.5 fades the exhibit with the rise', () => {
		expect(frame([item(XSHAPE.rrect, 0, 0, 1, 1)], { alphaOf: () => 0.5 })[0].overlays[0].a).toBeCloseTo(0.5, 6);
	});
});

describe('local coordinates', () => {
	// px = block origin + local em * scale * emPx; pointer math is the inverse
	test('wide class, scale 1.44', () => {
		const m = mappingOf({ x: 120.5, y: 300 }, 1.44, 18);
		expect(m.k).toBeCloseTo(25.92, 9);
		const p = toLocal(m, 120.5 + 36 * 25.92, 300 + 21 * 25.92);
		expect(p.x).toBeCloseTo(36, 9);
		expect(p.y).toBeCloseTo(21, 9);
		expect(toLocal(m, 120.5, 300)).toEqual({ x: 0, y: 0 });
	});
	test('narrow class, scale 0.58', () => {
		const m = mappingOf({ x: 16, y: 80 }, 0.58, 15.5);
		const p = toLocal(m, 16 + 12 * 0.58 * 15.5, 80 + 4 * 0.58 * 15.5);
		expect(p.x).toBeCloseTo(12, 9);
		expect(p.y).toBeCloseTo(4, 9);
	});
	test('a drawn item and the pointer agree: the centre of a drawn box maps back to its em centre', () => {
		for (const [scale, emPx, rect] of [[1.44, 18, { x: 120.5, y: 300 }], [0.58, 15.5, { x: 16, y: 80 }]] as const) {
			const m = mappingOf(rect, scale, emPx);
			const o = run(pack(item(XSHAPE.rrect, 10, 4, 6, 2)), m).overlays[0];
			const c = toLocal(m, o.x + o.w / 2, o.y + o.h / 2);
			expect(c.x).toBeCloseTo(13, 6);
			expect(c.y).toBeCloseTo(5, 6);
		}
	});
	test('planted bug: ignoring the exhibit scale breaks the round trip', () => {
		const right = mappingOf({ x: 0, y: 0 }, 1.44, 18);
		const wrong = mappingOf({ x: 0, y: 0 }, 1, 18);
		const o = run(pack(item(XSHAPE.rrect, 10, 4, 6, 2)), right).overlays[0];
		expect(toLocal(wrong, o.x + o.w / 2, o.y + o.h / 2).x).not.toBeCloseTo(13, 1);
	});
});

// ---- the routing state machine -------------------------------------------------------------------------------------------------

interface Log { calls: [number, number, number, number, number, number][]; focus: number[]; capture: number[]; release: number[]; engine: unknown[] }
function harness(opts: { exAt?: (x: number, y: number) => number; result?: (ex: number, kind: number) => number } = {}) {
	const log: Log = { calls: [], focus: [], capture: [], release: [], engine: [] };
	const d: RouterDeps = {
		exhibitAt: opts.exAt ?? ((x, y) => (x >= 100 && x < 500 && y >= 100 && y < 300 ? 0 : -1)),
		local: (_ex, x, y) => ({ x: (x - 100) / 10, y: (y - 100) / 10 }),
		call: (ex, kind, x, y, b, mo) => { log.calls.push([ex, kind, x, y, b, mo]); return opts.result?.(ex, kind) ?? 0; },
		focus: (ex) => log.focus.push(ex),
		capture: (id) => log.capture.push(id),
		release: (id) => log.release.push(id),
		engineDown: (raw) => log.engine.push(raw)
	};
	return { r: createRouter(d), log };
}
const ev = (type: PtrEvent['type'], x: number, y: number, o: Partial<PtrEvent> = {}): PtrEvent => ({ type, id: 1, ptype: 'mouse', x, y, buttons: type === 'down' || type === 'move' ? 1 : 0, mods: 0, ...o });
const CAP = XRESULT.consumed | XRESULT.capture | (2 << XRESULT.cursorShift); // ew-resize

describe('pointer routing', () => {
	test('hover calls move with local em, leave when the pointer exits; wheel stays free', () => {
		const { r, log } = harness({ result: () => XRESULT.consumed | (1 << XRESULT.cursorShift) });
		const a = r.event(ev('move', 150, 130, { buttons: 0 }));
		expect(log.calls).toEqual([[0, XPOINTER.move, 5, 3, 0, 0]]);
		expect(a).toEqual({ swallow: false, inside: true, cursor: 'pointer' });
		expect(r.wheel()).toBe(false);
		r.event(ev('move', 600, 130, { buttons: 0 }));
		expect(log.calls[1][1]).toBe(XPOINTER.leave);
		expect(r.hover).toBe(-1);
		r.event(ev('move', 150, 130, { buttons: 0 }));
		r.event(ev('leave', 0, 0));
		expect(log.calls.at(-1)![1]).toBe(XPOINTER.leave);
	});
	test('mouse down inside: swallowed, focus set; no selection even when the exhibit ignores it', () => {
		const { r, log } = harness();
		const out = r.event(ev('down', 150, 130));
		expect(out.swallow).toBe(true);
		expect(log.focus).toEqual([0]);
		expect(log.capture).toEqual([]);
		expect(r.event(ev('up', 150, 130)).swallow).toBe(true); // the matching up goes to the same exhibit
		expect(log.calls.map((c) => c[1])).toEqual([XPOINTER.down, XPOINTER.up]);
	});
	test('capture bit: setPointerCapture, then routing continues outside the block until up; wheel is held meanwhile', () => {
		const { r, log } = harness({ result: (_e, k) => (k === XPOINTER.down ? CAP : XRESULT.consumed | (3 << XRESULT.cursorShift)) });
		r.event(ev('down', 150, 130));
		expect(log.capture).toEqual([1]);
		expect(r.captured).toBe(0);
		expect(r.wheel()).toBe(true);
		const m = r.event(ev('move', 900, 700)); // far outside the block
		expect(m.swallow).toBe(true);
		expect(m.cursor).toBe('grabbing');
		expect(log.calls.at(-1)).toEqual([0, XPOINTER.move, 80, 60, 1, 0]);
		r.event(ev('up', 900, 700));
		expect(log.release).toEqual([1]);
		expect(r.captured).toBe(-1);
		expect(r.wheel()).toBe(false);
		// a later move is plain hover again
		expect(r.event(ev('move', 900, 700, { buttons: 0 })).swallow).toBe(false);
	});
	test('click outside clears focus; a miss does not swallow', () => {
		const { r, log } = harness();
		r.event(ev('down', 150, 130)); r.event(ev('up', 150, 130));
		const out = r.event(ev('down', 700, 130));
		expect(out.swallow).toBe(false);
		expect(log.focus).toEqual([0, -1]);
		expect(r.focus).toBe(-1);
	});
	test('touch on a part is held until the threshold; horizontal travel on a capturing part captures it', () => {
		const { r, log } = harness({ result: (_e, k) => (k === XPOINTER.down ? CAP : XRESULT.consumed) });
		const t = (type: PtrEvent['type'], x: number, y: number) => ev(type, x, y, { ptype: 'touch', raw: { x, y } });
		expect(r.event(t('down', 150, 130)).swallow).toBe(true);
		expect(r.pending).toBe(true);
		expect(r.event(t('move', 150 + DRAG_THRESHOLD - 1, 131)).swallow).toBe(true); // still deciding
		expect(log.capture).toEqual([]);
		const out = r.event(t('move', 150 + DRAG_THRESHOLD + 2, 131));
		expect(out.swallow).toBe(true);
		expect(log.capture).toEqual([1]);
		expect(r.captured).toBe(0);
		expect(log.engine).toEqual([]); // the page never saw it
		r.event(t('up', 200, 131));
		expect(log.release).toEqual([1]);
	});
	test('touch: vertical travel cancels the press and replays the down into the page scroll', () => {
		const { r, log } = harness({ result: (_e, k) => (k === XPOINTER.down ? CAP : XRESULT.consumed) });
		const raw = { y: 130 };
		r.event(ev('down', 150, 130, { ptype: 'touch', raw }));
		const out = r.event(ev('move', 152, 130 + DRAG_THRESHOLD + 4, { ptype: 'touch' }));
		expect(out.swallow).toBe(false);
		expect(log.engine).toEqual([raw]);
		expect(log.calls.at(-1)![1]).toBe(XPOINTER.leave);
		expect(r.captured).toBe(-1);
		expect(log.capture).toEqual([]);
	});
	test('touch on a plain button (consumed, no capture) never captures, even horizontally; a tap goes up to the exhibit', () => {
		const { r, log } = harness({ result: (_e, k) => (k === XPOINTER.down ? XRESULT.consumed : 0) });
		r.event(ev('down', 150, 130, { ptype: 'touch', raw: 1 }));
		expect(r.event(ev('move', 150 + 30, 130, { ptype: 'touch' })).swallow).toBe(false);
		expect(log.engine).toEqual([1]);
		const h2 = harness({ result: (_e, k) => (k === XPOINTER.down ? XRESULT.consumed : 0) });
		h2.r.event(ev('down', 150, 130, { ptype: 'touch' }));
		expect(h2.r.event(ev('up', 150, 130, { ptype: 'touch' })).swallow).toBe(true);
		expect(h2.log.calls.map((c) => c[1])).toEqual([XPOINTER.down, XPOINTER.up]);
	});
	test('touch on empty exhibit area is page scroll from the first pixel', () => {
		const { r, log } = harness();
		expect(r.event(ev('down', 150, 130, { ptype: 'touch' })).swallow).toBe(false);
		expect(r.event(ev('move', 150, 170, { ptype: 'touch' })).swallow).toBe(false);
		expect(log.engine).toEqual([]);
	});
	test('cancel releases like up but sends leave', () => {
		const { r, log } = harness({ result: (_e, k) => (k === XPOINTER.down ? CAP : 0) });
		r.event(ev('down', 150, 130));
		r.event(ev('cancel', 150, 130));
		expect(log.calls.at(-1)![1]).toBe(XPOINTER.leave);
		expect(log.release).toEqual([1]);
	});
	test('a second pointer does not steal a capture', () => {
		const { r, log } = harness({ result: (_e, k) => (k === XPOINTER.down ? CAP : 0) });
		r.event(ev('down', 150, 130, { id: 1 }));
		const n = log.calls.length;
		r.event(ev('move', 150, 130, { id: 2, buttons: 0 }));
		expect(log.calls.length).toBe(n + 1); // handled as hover, not as the captured pointer's move
		expect(r.captured).toBe(0);
	});
	test('cursor ids map to CSS cursors', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 7, 15].map((i) => cursorOf(i << XRESULT.cursorShift))).toEqual(['default', 'pointer', 'grab', 'grabbing', 'ew-resize', 'crosshair', 'not-allowed', 'cell', 'default']);
	});
});

describe('keyboard', () => {
	const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) => xkeyOf({ key, ctrlKey: false, metaKey: false, altKey: false, ...o });
	test('XKEY codes: letters are char codes, named keys their XKEY, Cmd/Ctrl combos and scroll keys are not offered', () => {
		expect(k('r')).toBe(114);
		expect(k(' ')).toBe(32);
		expect(k('Enter')).toBe(XKEY.enter);
		expect(k('Escape')).toBe(XKEY.escape);
		expect(k('ArrowLeft')).toBe(XKEY.left);
		expect(k('ArrowDown')).toBe(XKEY.down);
		expect(k('Tab')).toBe(XKEY.tab);
		expect(k('Backspace')).toBe(XKEY.backspace);
		expect(k('Delete')).toBe(XKEY.delete);
		expect(k('c', { metaKey: true })).toBe(-1);
		expect(k('a', { ctrlKey: true })).toBe(-1);
		for (const n of ['PageDown', 'PageUp', 'Home', 'End', 'F5', 'Shift', 'Dead']) expect(k(n)).toBe(-1);
		expect(keyMods({ shiftKey: true, ctrlKey: false, metaKey: true, altKey: true })).toBe(7);
	});
	test('only a focused exhibit sees keys; consumed keys stop there', () => {
		const seen: number[] = [];
		const key = (c: number) => { seen.push(c); return c === 114; };
		expect(routeKey(-1, 114, 0, key, () => {})).toEqual({ handled: false, consumed: false });
		expect(seen).toEqual([]);
		expect(routeKey(0, 114, 0, key, () => {})).toEqual({ handled: true, consumed: true });
		expect(routeKey(0, 106, 0, key, () => {})).toEqual({ handled: false, consumed: false }); // j: not declared, the page's J runs
		expect(routeKey(0, -1, 0, key, () => {})).toEqual({ handled: false, consumed: false });
	});
	test('Esc the exhibit ignores releases focus and is handled (the article stays open); Tab it ignores leaves the exhibit', () => {
		let cleared = 0;
		expect(routeKey(2, XKEY.escape, 0, () => false, () => cleared++)).toEqual({ handled: true, consumed: false });
		expect(cleared).toBe(1);
		expect(routeKey(2, XKEY.tab, 1, () => false, () => cleared++)).toEqual({ handled: false, consumed: false });
		expect(cleared).toBe(2);
		expect(routeKey(2, XKEY.tab, 0, () => true, () => cleared++)).toEqual({ handled: true, consumed: true });
		expect(cleared).toBe(2);
	});
});

// ---- load, restore, channels ---------------------------------------------------------------------------------------------------

describe('loading', () => {
	const enc = new TextEncoder();
	const model = (): ReadingModel => {
		const m = sampleReading();
		const strings = enc.encode('\0turing\0ex0 : Exhibit {\n  Frame: {w: 36}\n}\0bad id!\0');
		const at = (s: string) => new TextDecoder().decode(strings).indexOf(s);
		return {
			...m, strings,
			exhibits: [
				{ ...m.exhibits[0], name: at('turing'), kind: ExhibitKind.script, src: at('ex0 :') },
				{ ...m.exhibits[0], name: at('bad id!'), kind: ExhibitKind.timeline, duration: 14.123456, mode: 2, poster: 11 }
			]
		};
	};
	test('script exhibits load their src, timelines a generated Timeline entity', () => {
		const m = model();
		expect(exhibitId(m, 0)).toBe('turing');
		expect(exhibitSource(m, 0)).toBe('ex0 : Exhibit {\n  Frame: {w: 36}\n}');
		expect(exhibitSource(m, 1)).toBe('fig_bad_id_ : Timeline {\n  Extent: {36, 19.4}\n}');
	});
	test('errors carry slug/id and the exhibit draws nothing', () => {
		const m = model();
		const seen: string[] = [];
		const rep = loadExhibits({ load: (i, src) => { seen.push(src); return i === 0 ? 'line 2: unexpected token' : null; } }, m, 'models');
		expect(rep.loaded).toEqual([false, true]);
		expect(rep.errors).toEqual(['models/turing: line 2: unexpected token']);
		expect(seen).toHaveLength(2);
	});
	test('timeline channels are evaluated at the engine clock (XS.clock), through the mode', () => {
		const m = sampleReading(); // loop, duration 14, channel 0 keys: 0 -> 0, 14 -> 72 (outCubic)
		const st = new Float32Array(XS.stride * XS.max);
		st[XS.loaded] = 1;
		const chans = new Float32Array(256);
		st[XS.clock] = 0;
		evalTimelineChannels(m, { state: () => st }, 0, 1, chans);
		expect(chans[0]).toBe(0);
		st[XS.clock] = 14 + 0.0; // loop wraps to 0
		evalTimelineChannels(m, { state: () => st }, 0, 1, chans);
		expect(chans[0]).toBe(0);
		st[XS.clock] = 7;
		evalTimelineChannels(m, { state: () => st }, 0, 1, chans);
		expect(chans[0]).toBeGreaterThan(36);
		const v = chans[0];
		st[XS.loaded] = 0; st[XS.clock] = 13;
		evalTimelineChannels(m, { state: () => st }, 0, 1, chans);
		expect(chans[0]).toBe(v); // not loaded: left alone
		// control: a stale clock is visible in the channel (the test would fail if the clock were ignored)
		st[XS.loaded] = 1;
		evalTimelineChannels(m, { state: () => st }, 0, 1, chans);
		expect(chans[0]).not.toBe(v);
	});
});

describe('url fragment', () => {
	test('blob round trip, including unicode and long payloads', () => {
		for (const t of ['a1b2c3d4:tape=1011;head=2', 'ünï©ode → λ', 'x'.repeat(5000)]) expect(fromBlob(toBlob(t))).toBe(t);
		expect(toBlob('???>>>')).not.toMatch(/[+/=]/);
		expect(fromBlob('***')).toBeNull();
	});
	test('set, replace in place, join with &, other hash content untouched', () => {
		let h = setExhibitFragment('', 'turing', 'AAA');
		expect(h).toBe('#x:turing=AAA');
		h = setExhibitFragment(h, 'merkle', 'BBB');
		expect(h).toBe('#x:turing=AAA&x:merkle=BBB');
		h = setExhibitFragment(h, 'turing', 'CCC');
		expect(h).toBe('#x:turing=CCC&x:merkle=BBB');
		expect(setExhibitFragment('#intro', 'turing', 'AAA')).toBe('#intro&x:turing=AAA');
		expect(setExhibitFragment('#intro&x:turing=AAA', 'turing', null)).toBe('#intro');
		expect(setExhibitFragment('#x:turing=AAA', 'turing', null)).toBe('');
		expect(parseExhibitFragment('#intro&x:turing=CCC&x:merkle=BBB')).toEqual([{ id: 'turing', blob: 'CCC' }, { id: 'merkle', blob: 'BBB' }]);
		expect(parseExhibitFragment('#intro')).toEqual([]);
		expect(parseExhibitFragment('#x:=bad&x:novalue')).toEqual([]);
	});
	test('anchor logic never sees x: parts; the section spy keeps them', () => {
		expect(stripExhibitFragment('#x:turing=AAA')).toBe('');
		expect(stripExhibitFragment('#intro&x:turing=AAA')).toBe('#intro');
		expect(keepExhibitFragment('#results', '#intro&x:turing=AAA')).toBe('#results&x:turing=AAA');
		expect(keepExhibitFragment('', '#x:turing=AAA')).toBe('#x:turing=AAA');
		expect(keepExhibitFragment('#results', '#intro')).toBe('#results');
	});
	test('goToHash ignores #x:', () => {
		const sc = createScrollState({} as ScrollEnv);
		expect(sc.goToHash('#x:turing=AAA')).toBe(false);
		sc.dispose();
	});
});

describe('dev hot reload', () => {
	const host = (err: string | null = null) => {
		const log = { reloads: [] as [string, string][], reports: [] as string[] };
		return { log, h: { slug: () => 'models', reload: (id: string, src: string) => { log.reloads.push([id, src]); return err; }, report: (m: string) => log.reports.push(m) } };
	};
	test('applies in place; wrong slug is skipped; errors are reported with slug/id; {reload:true} reloads the page', () => {
		let pages = 0;
		const ok = host();
		expect(applyExhibitReload(ok.h, { slug: 'models', id: 'turing', src: 's' }, () => pages++)).toBe('ok');
		expect(ok.log.reloads).toEqual([['turing', 's']]);
		expect(applyExhibitReload(ok.h, { slug: 'ifd', id: 'turing', src: 's' }, () => pages++)).toBe('skipped');
		expect(applyExhibitReload(ok.h, { slug: 'models', reload: true }, () => pages++)).toBe('page');
		expect(pages).toBe(1);
		const bad = host('turing.flecs: 4: unexpected');
		expect(applyExhibitReload(bad.h, { slug: 'models', id: 'turing', src: 'x' }, () => pages++)).toBe('error');
		expect(bad.log.reports).toEqual(['models/turing: turing.flecs: 4: unexpected']);
	});
});
