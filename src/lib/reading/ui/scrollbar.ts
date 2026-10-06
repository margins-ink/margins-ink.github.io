// GPU scrollbar (docs/READING_GPU.md "GPU scrollbar"): pure geometry, hit test, spring and fade state machine, overlays, and the
// track-click and thumb-drag mappings. The reader owns the pointer capture and calls reading_scroll_to with the returned scrollY.
import type { Overlay } from '../page-api';
import type { ScrollbarFrame, ScrollbarGeom, ScrollbarHit, ScrollbarInput, ScrollbarState } from './types';

export const SB = {
	hitW: 14, width: 6, widthHover: 12, edge: 2, minThumb: 40,
	/** idle time before the fade starts, the fade out, and the fade in (ms) */
	fadeAfterMs: 1200, fadeOutMs: 300, fadeInMs: 100,
	/** the width spring settles (5 percent) in this many ms */
	springMs: 120,
	thumbAlpha: 0.28, thumbAlphaHover: 0.5, thumbAlphaDrag: 0.9,
	trackAlpha: 0.07, tickAlpha: 0.35,
	/** track click moves one viewport minus this overlap (same as Space) */
	pageOverlap: 40
} as const;

const OMEGA = 4.74 / (SB.springMs / 1000);

export const newScrollbar = (): ScrollbarState => ({ opacity: 0, width: SB.width, widthVel: 0, idleMs: 0, lastScrollY: NaN, hover: false });

export function scrollbarGeom(i: ScrollbarInput): ScrollbarGeom {
	const inset = i.insetTop ?? 0;
	const trackH = Math.max(0, i.viewH - inset);
	const maxY = Math.max(0, i.docPx - i.viewH);
	const active = maxY > 0 && trackH > 0;
	const thumbH = active ? Math.min(trackH, Math.max(SB.minThumb, (i.viewH * i.viewH) / i.docPx)) : 0;
	const f = maxY > 0 ? Math.min(1, Math.max(0, i.scrollY / maxY)) : 0;
	return { active, trackY0: inset, trackH, thumbH, thumbY: inset + f * (trackH - thumbH), hitX: i.viewW - SB.hitW, maxY };
}

export function scrollbarHit(i: ScrollbarInput, x: number, y: number): ScrollbarHit {
	const g = scrollbarGeom(i);
	if (!g.active || x < g.hitX || x > i.viewW || y < g.trackY0 || y > g.trackY0 + g.trackH) return null;
	return y >= g.thumbY && y <= g.thumbY + g.thumbH ? 'thumb' : 'track';
}

/** Critically damped spring, exact solution over dt seconds. */
function spring(x: number, v: number, target: number, dt: number): [number, number] {
	const d = x - target;
	const c = v + OMEGA * d;
	const e = Math.exp(-OMEGA * dt);
	return [target + (d + c * dt) * e, (v - OMEGA * c * dt) * e];
}

export function scrollbarStep(s: ScrollbarState, dtMs: number, i: ScrollbarInput): ScrollbarState {
	const g = scrollbarGeom(i);
	const hover = g.active && (i.dragging || (!!i.pointer && scrollbarHit(i, i.pointer.x, i.pointer.y) !== null));
	const moved = Number.isFinite(s.lastScrollY) && s.lastScrollY !== i.scrollY;
	const awake = hover || i.dragging || moved;
	const idleMs = awake ? 0 : s.idleMs + dtMs;
	const target = hover || i.dragging ? SB.widthHover : SB.width;
	const [width, widthVel] = spring(s.width, s.widthVel, target, dtMs / 1000);
	let opacity = s.opacity;
	if (!g.active) opacity = 0;
	else if (idleMs < SB.fadeAfterMs) opacity = Math.min(1, opacity + dtMs / SB.fadeInMs);
	else opacity = Math.max(0, Math.min(opacity, 1 - (idleMs - SB.fadeAfterMs) / SB.fadeOutMs));
	const settled = Math.abs(width - target) < 0.01 && Math.abs(widthVel) < 0.05;
	return { opacity, width: settled ? target : width, widthVel: settled ? 0 : widthVel, idleMs, lastScrollY: i.scrollY, hover };
}

/** Overlays of a state (the track while grown, section ticks while hovered, the thumb). Empty when invisible. */
export function renderScrollbar(s: ScrollbarState, i: ScrollbarInput): Overlay[] {
	const g = scrollbarGeom(i);
	if (!g.active || s.opacity <= 0.002) return [];
	const out: Overlay[] = [];
	const w = s.width;
	const x = i.viewW - SB.edge - w;
	const grow = Math.min(1, Math.max(0, (w - SB.width) / (SB.widthHover - SB.width)));
	const [ir, ig, ib] = i.ink;
	if (grow > 0.01) out.push({ x, y: g.trackY0, w, h: g.trackH, radius: w / 2, r: ir, g: ig, b: ib, a: SB.trackAlpha * grow * s.opacity });
	if (grow > 0.01 && i.ticks && g.maxY > 0) {
		for (const t of i.ticks) {
			const f = Math.min(1, Math.max(0, t / g.maxY));
			const y = g.trackY0 + f * (g.trackH - g.thumbH) + g.thumbH / 2;
			out.push({ x: i.viewW - SB.edge - 5, y: y - 0.5, w: 4, h: 1, radius: 0.5, r: ir, g: ig, b: ib, a: SB.tickAlpha * grow * s.opacity });
		}
	}
	const drag = i.dragging;
	const [r, gg, b] = drag ? i.accent : i.ink;
	const a = drag ? SB.thumbAlphaDrag : s.hover ? SB.thumbAlphaHover : SB.thumbAlpha;
	out.push({ x, y: g.thumbY, w, h: g.thumbH, radius: w / 2, r, g: gg, b, a: a * s.opacity });
	return out;
}

export function scrollbarOverlays(s: ScrollbarState, dtMs: number, i: ScrollbarInput): Overlay[] {
	return renderScrollbar(scrollbarStep(s, dtMs, i), i);
}

export function scrollbarFrame(s: ScrollbarState, dtMs: number, i: ScrollbarInput): ScrollbarFrame {
	const state = scrollbarStep(s, dtMs, i);
	const overlays = renderScrollbar(state, i);
	const target = state.hover || i.dragging ? SB.widthHover : SB.width;
	const springing = state.width !== target;
	const fading = state.opacity > 0 && (state.idleMs >= SB.fadeAfterMs || state.opacity < 1);
	const animating = springing || fading;
	const wakeInMs = !animating && state.opacity > 0 && state.idleMs < SB.fadeAfterMs ? SB.fadeAfterMs - state.idleMs : Infinity;
	return { state, overlays, animating, wakeInMs };
}

/** Target scrollY of a click on the track outside the thumb: one page toward the click, clamped. */
export function scrollbarTrackClick(i: ScrollbarInput, y: number): number {
	const g = scrollbarGeom(i);
	if (!g.active) return i.scrollY;
	const dir = y < g.thumbY ? -1 : y > g.thumbY + g.thumbH ? 1 : 0;
	return Math.min(g.maxY, Math.max(0, i.scrollY + dir * Math.max(0, i.viewH - SB.pageOverlap)));
}

/** Grab offset of the pointer inside the thumb (px from the thumb top); a press outside the thumb grabs its centre. */
export function scrollbarDragStart(i: ScrollbarInput, y: number): number {
	const g = scrollbarGeom(i);
	const off = y - g.thumbY;
	return off >= 0 && off <= g.thumbH ? off : g.thumbH / 2;
}

/** scrollY for the pointer at y while dragging with the given grab offset: proportional over the track, clamped to 0..maxY. */
export function scrollbarDragTo(i: ScrollbarInput, grab: number, y: number): number {
	const g = scrollbarGeom(i);
	const span = g.trackH - g.thumbH;
	if (!g.active || span <= 0) return 0;
	return Math.min(g.maxY, Math.max(0, ((y - grab - g.trackY0) / span) * g.maxY));
}
