import { describe, expect, test } from 'bun:test';
import {
	SB, newScrollbar, scrollbarDragStart, scrollbarDragTo, scrollbarFrame, scrollbarGeom, scrollbarHit, scrollbarOverlays, scrollbarStep, scrollbarTrackClick
} from './scrollbar';
import type { ScrollbarInput, ScrollbarState } from './types';

const base: ScrollbarInput = { viewW: 1000, viewH: 800, docPx: 8000, scrollY: 0, pointer: null, dragging: false, ink: [0.9, 0.9, 0.9], accent: [0.3, 0.6, 1] };
const at = (o: Partial<ScrollbarInput>): ScrollbarInput => ({ ...base, ...o });
const run = (s: ScrollbarState, ms: number, i: ScrollbarInput, dt = 16) => { for (let t = 0; t < ms; t += dt) s = scrollbarStep(s, dt, i); return s; };

describe('geometry', () => {
	test('thumb height is viewH^2/docPx with a 40 px floor', () => {
		expect(scrollbarGeom(base).thumbH).toBeCloseTo(80, 6);
		expect(scrollbarGeom(at({ docPx: 800 * 100 })).thumbH).toBe(40);
		expect(scrollbarGeom(at({ docPx: 800 * 1.25 })).thumbH).toBeCloseTo(640, 6);
	});
	test('thumb travels the track in proportion to scrollY', () => {
		const top = scrollbarGeom(at({ scrollY: 0 }));
		const mid = scrollbarGeom(at({ scrollY: 3600 }));
		const end = scrollbarGeom(at({ scrollY: 7200 }));
		expect(top.thumbY).toBe(0);
		expect(mid.thumbY).toBeCloseTo((800 - 80) / 2, 6);
		expect(end.thumbY + end.thumbH).toBeCloseTo(800, 6);
	});
	test('inset moves the track down; a short document has no scrollbar', () => {
		const g = scrollbarGeom(at({ insetTop: 40 }));
		expect(g.trackY0).toBe(40);
		expect(g.trackH).toBe(760);
		expect(scrollbarGeom(at({ docPx: 700 })).active).toBe(false);
		expect(scrollbarOverlays(newScrollbar(), 16, at({ docPx: 700 }))).toEqual([]);
	});
});

describe('hit', () => {
	test('14 px area at the right edge: thumb, track, nothing', () => {
		expect(scrollbarHit(base, 995, 40)).toBe('thumb');
		expect(scrollbarHit(base, 986.5, 40)).toBe('thumb');
		expect(scrollbarHit(base, 985, 400)).toBeNull();
		expect(scrollbarHit(base, 990, 400)).toBe('track');
		expect(scrollbarHit(at({ docPx: 700 }), 995, 40)).toBeNull();
	});
});

describe('state machine', () => {
	test('grows 6 to 12 px on hover within about 120 ms and shrinks back', () => {
		const hov = at({ pointer: { x: 995, y: 300 } });
		let s = run(newScrollbar(), 32, hov);
		expect(s.width).toBeGreaterThan(SB.width);
		expect(s.width).toBeLessThan(SB.widthHover);
		s = run(newScrollbar(), 128, hov, 8);
		expect(SB.widthHover - s.width).toBeLessThan(0.05 * (SB.widthHover - SB.width) + 0.01); // 5 percent settle time
		s = run(s, 600, hov);
		expect(s.width).toBe(SB.widthHover);
		s = run(s, 600, at({ pointer: null }));
		expect(s.width).toBe(SB.width);
	});
	test('spring never overshoots the target (critically damped)', () => {
		let s = newScrollbar();
		const hov = at({ pointer: { x: 995, y: 300 } });
		for (let t = 0; t < 600; t += 4) { s = scrollbarStep(s, 4, hov); expect(s.width).toBeLessThanOrEqual(SB.widthHover + 1e-9); }
	});
	test('fades out after 1.2 s idle and comes back on scroll', () => {
		let s = run(newScrollbar(), 200, base);
		expect(s.opacity).toBe(1);
		s = run(s, 900, base);
		expect(s.opacity).toBe(1); // 1.2 s not reached
		s = run(s, 1000, base);
		expect(s.opacity).toBe(0);
		expect(scrollbarOverlays(s, 16, base)).toEqual([]);
		s = scrollbarStep(s, 16, at({ scrollY: 100 }));
		expect(s.opacity).toBeGreaterThan(0);
		s = run(s, 200, at({ scrollY: 100 }));
		expect(s.opacity).toBe(1);
	});
	test('hover keeps it visible indefinitely', () => {
		const hov = at({ pointer: { x: 995, y: 300 } });
		expect(run(newScrollbar(), 5000, hov).opacity).toBe(1);
	});
	test('idle means no animation: once faded and settled, no frames are needed', () => {
		let s = run(newScrollbar(), 3000, base);
		const f = scrollbarFrame(s, 16, base);
		expect(f.animating).toBe(false);
		expect(f.wakeInMs).toBe(Infinity);
		expect(f.overlays).toEqual([]);
		// right after a scroll it is visible and not animating, but wakes at the fade start
		s = run(s, 400, at({ scrollY: 50 }));
		const g = scrollbarFrame(s, 16, at({ scrollY: 50 }));
		expect(g.animating).toBe(false);
		expect(g.wakeInMs).toBeGreaterThan(0);
		expect(g.wakeInMs).toBeLessThanOrEqual(SB.fadeAfterMs);
	});
});

describe('overlays', () => {
	const alpha = (i: ScrollbarInput, s: ScrollbarState) => scrollbarOverlays(s, 16, i).at(-1)!;
	test('thumb is ink at .28, .5 on hover, accent while dragging', () => {
		const s = run(newScrollbar(), 100, base);
		expect(alpha(base, s).a).toBeCloseTo(0.28, 5);
		expect(alpha(base, s).r).toBe(0.9);
		const hov = at({ pointer: { x: 995, y: 300 } });
		const sh = run(s, 300, hov);
		expect(alpha(hov, sh).a).toBeCloseTo(0.5, 5);
		const dr = at({ dragging: true, pointer: { x: 995, y: 300 } });
		const sd = run(sh, 300, dr);
		const o = alpha(dr, sd);
		expect([o.r, o.g, o.b]).toEqual([0.3, 0.6, 1]);
	});
	test('thumb rect sits against the right edge with the spring width', () => {
		const s = run(newScrollbar(), 100, base);
		const o = alpha(base, s);
		expect(o.w).toBe(6);
		expect(o.x + o.w).toBe(1000 - SB.edge);
		expect(o.h).toBeCloseTo(80, 6);
		expect(o.radius).toBe(3);
	});
	test('ticks only while hovered', () => {
		const withTicks = at({ ticks: [0, 3600, 7200] });
		const s = run(newScrollbar(), 100, withTicks);
		expect(scrollbarOverlays(s, 16, withTicks).length).toBe(1);
		const hov = at({ ticks: [0, 3600, 7200], pointer: { x: 995, y: 300 } });
		const sh = run(s, 300, hov);
		expect(scrollbarOverlays(sh, 16, hov).length).toBe(1 + 1 + 3);
	});
	test('fading scales alpha', () => {
		let s = run(newScrollbar(), 100, base);
		s = run(s, 1100 + SB.fadeOutMs / 2, base, 10);
		const o = scrollbarOverlays(s, 1, base).at(-1)!;
		expect(o.a).toBeGreaterThan(0);
		expect(o.a).toBeLessThan(0.28);
	});
});

describe('track click and drag', () => {
	test('track click pages one viewport (minus the 40 px overlap) toward the click, clamped', () => {
		expect(scrollbarTrackClick(at({ scrollY: 1000 }), 700)).toBe(1000 + 760);
		expect(scrollbarTrackClick(at({ scrollY: 1000 }), 0)).toBe(240);
		expect(scrollbarTrackClick(at({ scrollY: 100 }), 0)).toBe(0);
		expect(scrollbarTrackClick(at({ scrollY: 7000 }), 799)).toBe(7200);
	});
	test('drag maps pointer proportionally; grab offset keeps the thumb under the pointer', () => {
		const i = at({ scrollY: 3600 });
		const g = scrollbarGeom(i);
		const grab = scrollbarDragStart(i, g.thumbY + 20);
		expect(grab).toBe(20);
		expect(scrollbarDragTo(i, grab, g.thumbY + 20)).toBeCloseTo(3600, 6); // no movement, no jump
		expect(scrollbarDragTo(i, grab, 20)).toBe(0);
		expect(scrollbarDragTo(i, grab, 800)).toBe(7200);
		// moving the pointer by a fraction f of the free track moves scrollY by f * maxY
		const span = g.trackH - g.thumbH;
		expect(scrollbarDragTo(i, grab, g.thumbY + 20 + span / 4)).toBeCloseTo(3600 + 7200 / 4, 5);
	});
	test('a press outside the thumb grabs its centre', () => {
		expect(scrollbarDragStart(base, 500)).toBe(40);
	});
	test('PLANTED BUG CONTROL: mapping by viewH instead of the free track is rejected', () => {
		const i = at({ scrollY: 0 });
		const wrong = (y: number) => (y / i.viewH) * 7200;
		expect(Math.abs(wrong(100) - scrollbarDragTo(i, 40, 100))).toBeGreaterThan(1);
	});
});
