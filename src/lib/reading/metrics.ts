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
	const base = Math.min(21, Math.max(17, 15.6 + 0.0036 * viewW)) * scale;
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

const toLin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.max(c, 0) ** (1 / 2.4) - 0.055);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** OKLCH to straight sRGB 0..1, clipped to the gamut by clamping (the build's palette script owns gamut checks). */
export function oklchToSrgb(L: number, C: number, hueDeg: number): [number, number, number] {
	const h = (hueDeg * Math.PI) / 180;
	const a = C * Math.cos(h);
	const b = C * Math.sin(h);
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
	const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
	const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
	return [clamp01(toGamma(r)), clamp01(toGamma(g)), clamp01(toGamma(bl))];
}

/** OKLCH hue in degrees (0..360) of straight sRGB 0..1. */
export function srgbHue(r: number, g: number, b: number): number {
	const lr = toLin(r), lg = toLin(g), lb = toLin(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const deg = (Math.atan2(B, A) * 180) / Math.PI;
	return deg < 0 ? deg + 360 : deg;
}

/** Hue of a palette entry stored as 0xAABBGGRR. */
export function paletteHue(entry: number): number {
	return srgbHue((entry & 255) / 255, ((entry >>> 8) & 255) / 255, ((entry >>> 16) & 255) / 255);
}

/** The article accent oklch(0.78 0.14 hue) as straight sRGB. */
export const accentSrgb = (hueDeg: number): [number, number, number] => oklchToSrgb(0.78, 0.14, hueDeg);

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
