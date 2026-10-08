// Pure geometry of the reading page (docs/READING_CONTRACT.md "Frame protocol"): width class, em size, document origin, px/em mapping,
// and the accent colour. No DOM, no Svelte, so bun tests cover it.

/** The user's text-size steps (the Aa control). */
export const scaleSteps = [0.9, 1, 1.1, 1.25, 1.4] as const;
export const DEFAULT_SCALE = 1;

/** Horizontal gutter in CSS px per width class id (wide, mid, narrow). Wide is centred, 32 is the floor. */
export const GUTTER_PX = [32, 32, 20] as const;
/** Narrow: the column is the viewport minus 2 x 20 px. */
export const NARROW_MARGIN_PX = 40;
export const BAR_PX = { wide: 40, mid: 40, narrow: 44 } as const;
/** One body line in em (LINE_H of format.ts, repeated so this file stays import-free). */
export const LINE_EM = 1.62;

/** wide >= 1180, mid 720..1179, narrow < 720 (WIDTH_CLASSES of format.ts). */
export const widthClassFor = (viewW: number): 0 | 1 | 2 => (viewW >= 1180 ? 0 : viewW >= 720 ? 1 : 2);

export const barPxFor = (widthClass: number): number => (widthClass === 2 ? BAR_PX.narrow : BAR_PX.wide);

/** The nearest scale step to an arbitrary stored number. */
export function snapScale(s: number): number {
	let best: number = scaleSteps[1];
	for (const v of scaleSteps) if (Math.abs(v - s) < Math.abs(best - s)) best = v;
	return best;
}

/**
 * CSS px per em. wide and mid: clamp(17, 15.6 + 0.0036 * viewW, 21) * scale, then at most what fits the whole document extent
 * (docWidthEm = docX1 - docX0) between two gutters. narrow: the column fills the viewport minus 40 px, the scale may only shrink.
 */
export function emPxFor(viewW: number, widthClass: number, scale: number, docWidthEm: number, colW: number = docWidthEm): number {
	if (widthClass === 2) return (Math.min(scale, 1) * (viewW - NARROW_MARGIN_PX)) / colW;
	const base = Math.min(20, Math.max(17.5, 14.5 + 0.004 * viewW)) * scale;
	const fit = (viewW - 2 * GUTTER_PX[widthClass]) / docWidthEm;
	return Math.min(base, fit);
}

/** CSS px of document x = 0 (the left edge of the reading column): the document extent [docX0, docX1] is centred in the viewport. */
export const originXFor = (viewW: number, emPx: number, docX0: number, docX1: number): number => (viewW - (docX1 - docX0) * emPx) / 2 - docX0 * emPx;

/** CSS px of the left edge of the `.doc` element (document x = docX0). */
export const docLeftPx = (originX: number, emPx: number, docX0: number): number => originX + docX0 * emPx;

export const emToPx = (em: number, emPx: number): number => em * emPx;
export const pxToEm = (px: number, emPx: number): number => px / emPx;
/** viewport px y of document y (em) given the scroller's scrollTop */
export const docYToViewPx = (yEm: number, emPx: number, scrollPx: number, originY = 0): number => originY + yEm * emPx - scrollPx;
export const docXToViewPx = (xEm: number, emPx: number, originX: number): number => originX + xEm * emPx;

// ---- accent colour ----------------------------------------------------------------------------------------------


/** CSS cubic-bezier easing (the 480 ms enter curve is .2,.7,.2,1): x -> y, Newton with a bisection fallback. */
export function cubicBezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
	const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
	const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
	const sx = (t: number) => ((ax * t + bx) * t + cx) * t;
	const sy = (t: number) => ((ay * t + by) * t + cy) * t;
	const dx = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
	return (x: number) => {
		if (x <= 0) return 0;
		if (x >= 1) return 1;
		let t = x;
		for (let i = 0; i < 6; i++) {
			const e = sx(t) - x;
			if (Math.abs(e) < 1e-5) return sy(t);
			const d = dx(t);
			if (Math.abs(d) < 1e-6) break;
			t -= e / d;
		}
		let lo = 0, hi = 1;
		t = x;
		for (let i = 0; i < 24; i++) {
			const e = sx(t) - x;
			if (Math.abs(e) < 1e-5) break;
			if (e > 0) hi = t; else lo = t;
			t = (lo + hi) / 2;
		}
		return sy(t);
	};
}
