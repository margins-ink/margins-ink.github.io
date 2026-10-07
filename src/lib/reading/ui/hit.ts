// Hit testing of the GPU chrome (lane U2). `hits` are in draw order (back to front), so the topmost rect is the LAST match.
import type { HitRect } from './layout';

export type { HitRect };

export interface ChromeHit { id: string; cursor: string; onClick?: string; capture?: boolean; rect: { x: number; y: number; w: number; h: number } }

/** topmost chrome rect under (x, y), or null (then the article's own hit test runs) */
export function hitChrome(hits: readonly HitRect[], x: number, y: number): ChromeHit | null {
	for (let i = hits.length - 1; i >= 0; i--) {
		const h = hits[i];
		if (x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h) {
			return { id: h.id, cursor: h.cursor, onClick: h.onClick, capture: h.capture, rect: { x: h.x, y: h.y, w: h.w, h: h.h } };
		}
	}
	return null;
}

/** the rect of a hit by id (the capture target), or null when it is not drawn this frame */
export function hitById(hits: readonly HitRect[], id: string): HitRect | null {
	for (let i = hits.length - 1; i >= 0; i--) if (hits[i].id === id) return hits[i];
	return null;
}

/** 0..1 position of x along a hit rect, clamped (scrollbar thumb); the thumb drag uses `thumbScrollY` */
export function fractionIn(h: HitRect, x: number): number {
	return h.w <= 0 ? 0 : Math.max(0, Math.min(1, (x - h.x) / h.w));
}

/**
 * Proportional scroll target of a scrollbar thumb drag: the pointer holds the thumb at the grab offset.
 * `grabDy` = pointer y minus thumb top at press; track and thumb heights in px.
 */
export function thumbScrollY(pointerY: number, grabDy: number, trackTop: number, trackH: number, thumbH: number, docPx: number, viewH: number): number {
	const range = trackH - thumbH;
	if (range <= 0) return 0;
	const f = Math.max(0, Math.min(1, (pointerY - grabDy - trackTop) / range));
	return f * (docPx - viewH);
}
