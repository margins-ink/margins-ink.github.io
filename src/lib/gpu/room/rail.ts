// The world's one scrollbar: the reader's GPU scrollbar (reading/ui/scrollbar.ts, same geometry, spring, fade and drag maths)
// drawn by the room's present pass (shader.ts `fs`, the `ov` rows of the Scene uniform), with a tick per floor and the floor's
// sign plate beside the thumb while it moves. The page has no native scrollbar; the empty spacer is the scroll range.
import { THEME } from '../../reading/theme';
import {
	newScrollbar, scrollbarDragStart, scrollbarDragTo, scrollbarGeom, scrollbarHit, scrollbarStep, SB
} from '../../reading/ui/scrollbar';
import type { ScrollbarInput, ScrollbarState } from '../../reading/ui/types';
import { ATLAS, signRect } from './atlas';

/** rows the shader reads: rects 0..MAX_RECTS-1, each 2 vec4 (x y w h in device px | r g b a) */
export const MAX_RECTS = 12;
/** floats appended to the Scene uniform: rects, label rect, label atlas uv, label alpha */
export const RAIL_FLOATS = MAX_RECTS * 8 + 12;
/** idle opacity floor: on the world the bar stays faintly visible */
const REST = 0.55;
/** the label stays this long after the last movement (ms) */
const LABEL_MS = 900;
const LABEL_W = 150;
const TICK_HIT = 10;

export interface RailView {
	/** canvas CSS size */
	w: number; h: number;
	/** scroll range of the page: spacer height, and the scroll offset in 0..docPx - h */
	docPx: number; scrollY: number;
	floors: number;
	/** device px per CSS px */
	dpr: number;
	/** zoom-out level 0..1: the bar dims while the camera is out of the cab */
	zoom: number;
}

export type RailHit = { kind: 'thumb' } | { kind: 'tick'; floor: number } | { kind: 'track'; scrollY: number };

export function createRail() {
	let st: ScrollbarState = newScrollbar();
	let ptr: { x: number; y: number } | null = null;
	let dragging = false;
	let grab = 0;
	let labelIdle = 1e9;
	let animating = true;
	const ink = THEME.text.primary as unknown as [number, number, number];
	const accent = THEME.accent as unknown as [number, number, number];

	const input = (v: RailView): ScrollbarInput => ({
		viewW: v.w, viewH: v.h, docPx: v.docPx, scrollY: v.scrollY, pointer: ptr, dragging, ink, accent
	});
	const tickY = (v: RailView, k: number) => {
		const g = scrollbarGeom(input(v));
		const f = v.floors > 1 ? k / (v.floors - 1) : 0;
		return g.trackY0 + f * (g.trackH - g.thumbH) + g.thumbH / 2;
	};
	const hitAt = (v: RailView, x: number, y: number): RailHit | null => {
		const i = input(v);
		const h = scrollbarHit(i, x, y);
		if (!h) return null;
		if (h === 'thumb') return { kind: 'thumb' };
		for (let k = 0; k < v.floors; k++) if (Math.abs(y - tickY(v, k)) <= TICK_HIT) return { kind: 'tick', floor: k };
		const g = scrollbarGeom(i);
		const dir = y < g.thumbY ? -1 : 1;
		return { kind: 'track', scrollY: Math.min(g.maxY, Math.max(0, v.scrollY + dir * Math.max(0, v.h - SB.pageOverlap))) };
	};
	/** scrollY of floor k (the page scroll that parks the cab there) */
	const floorScroll = (v: RailView, k: number) => (v.floors > 1 ? k / (v.floors - 1) : 0) * Math.max(0, v.docPx - v.h);

	return {
		hover(p: { x: number; y: number } | null) {
			ptr = p;
		},
		/** a press at (x, y): what it grabbed (null when it missed the bar, so the canvas handles it) */
		down(v: RailView, x: number, y: number): RailHit | null {
			const h = hitAt(v, x, y);
			if (h?.kind === 'thumb') {
				dragging = true;
				grab = scrollbarDragStart(input(v), y);
			}
			ptr = { x, y };
			return h;
		},
		/** a pointer move while dragging: the page scroll the pointer asks for */
		drag(v: RailView, y: number): number | null {
			if (!dragging) return null;
			return scrollbarDragTo(input(v), grab, y);
		},
		get dragging() {
			return dragging;
		},
		/** release: ends the drag and returns the scroll of the nearest floor (the detent: the cab already rests on floors, the thumb follows it) */
		up(v: RailView): number | null {
			if (!dragging) return null;
			dragging = false;
			const n = v.floors;
			const f = v.docPx > v.h ? v.scrollY / (v.docPx - v.h) : 0;
			return floorScroll(v, Math.min(n - 1, Math.max(0, Math.round(f * (n - 1)))));
		},
		floorScroll,
		/** frames are still needed (fade, spring, label) */
		get animating() {
			return animating;
		},
		/** advance by dt ms and write the Scene rows into `out` (RAIL_FLOATS floats) */
		frame(v: RailView, dtMs: number, out: Float32Array, label: (floor: number) => { x: number; y: number; w: number; h: number } | null) {
			const i = input(v);
			st = scrollbarStep(st, dtMs, i);
			const g = scrollbarGeom(i);
			out.fill(0);
			const moved = st.idleMs < 1;
			labelIdle = moved || dragging ? 0 : labelIdle + dtMs;
			if (!g.active) {
				animating = false;
				return;
			}
			const dim = 1 - 0.65 * v.zoom;
			// faintly visible at rest on the world
			const vis = Math.max(st.opacity, REST) * dim;
			const s = v.dpr;
			let n = 0;
			const rect = (x: number, y: number, w: number, h: number, c: readonly [number, number, number], a: number) => {
				if (n >= MAX_RECTS || a <= 0.002) return;
				out.set([x * s, y * s, w * s, h * s, c[0], c[1], c[2], a], n * 8);
				n++;
			};
			const w = st.width;
			const x = v.w - SB.edge - w;
			const grow = Math.min(1, Math.max(0, (w - SB.width) / (SB.widthHover - SB.width)));
			// a dark channel so the pale thumb reads over the bright window as well as the dark wall
			rect(x - 2, g.trackY0, w + 4, g.trackH, [0.02, 0.02, 0.03], (0.3 + 0.25 * grow) * vis);
			for (let k = 0; k < v.floors; k++) {
				const y = tickY(v, k);
				rect(v.w - SB.edge - 9, y - 0.75, 7, 1.5, ink, (0.45 + 0.3 * grow) * vis);
			}
			const a = dragging ? SB.thumbAlphaDrag : st.hover ? SB.thumbAlphaHover : SB.thumbAlpha;
			rect(x, g.thumbY, w, g.thumbH, dragging ? accent : ink, Math.min(1, a * 1.8) * vis);
			// the floor's sign plate beside the thumb while it moves
			const f = v.docPx > v.h ? v.scrollY / (v.docPx - v.h) : 0;
			const fl = Math.min(v.floors - 1, Math.max(0, Math.round(f * (v.floors - 1))));
			const la = labelIdle < LABEL_MS ? 1 : Math.max(0, 1 - (labelIdle - LABEL_MS) / 300);
			const lab = label(fl);
			const o = MAX_RECTS * 8;
			if (lab && la > 0.01 && dim > 0.5) {
				const lh = LABEL_W * (lab.h / lab.w);
				const lx = v.w - SB.edge - 24 - LABEL_W;
				const ly = Math.min(v.h - lh - 4, Math.max(4, g.thumbY + g.thumbH / 2 - lh / 2));
				out.set([lx * s, ly * s, LABEL_W * s, lh * s], o);
				out.set([lab.x / ATLAS, lab.y / ATLAS, (lab.x + lab.w) / ATLAS, (lab.y + lab.h) / ATLAS], o + 4);
				out[o + 8] = la * 0.95;
			}
			animating = st.width !== (st.hover || dragging ? SB.widthHover : SB.width) || (st.opacity > REST && st.idleMs >= SB.fadeAfterMs && st.opacity > 0) || labelIdle < LABEL_MS + 300 || st.idleMs < SB.fadeAfterMs + SB.fadeOutMs;
		}
	};
}

export type Rail = ReturnType<typeof createRail>;
export const signLabel = (i: number) => signRect(i);
