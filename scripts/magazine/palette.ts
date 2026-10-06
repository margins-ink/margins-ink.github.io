// OKLCH palette per article hue (docs/MAGAZINE.md 3.2). Build time only: the shader flips light and dark with a
// uniform, so both columns are baked here. Fail closed: `checkPalette` throws when an entry clips sRGB or a
// contrast floor is missed. Chroma is capped per hue (`fitChroma`) so requested accents stay inside the gamut.
import { PAL2, PALETTE2_SIZE } from '../../src/lib/magazine/format';

export type Rgb = readonly [number, number, number]; // sRGB 0..1, gamma encoded
export type Oklch = readonly [number, number, number]; // L 0..1, C, h degrees

/** Slots the type lane adds beyond PAL2 (PAL2 is owned by the contract lane): text colour on a `field` block. */
export const PAL_EXT = { fieldInk: 18 } as const;
/** First slot free for the compile lane's quantised syntax colours. */
export const PAL_SYNTAX_START = 19;

// ---- OKLab (Ottosson 2020, public domain reference) ----------------------------------------------------

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH to linear sRGB, unclamped (components outside [0,1] mean out of gamut). */
export function oklchToLinear([L, C, h]: Oklch): [number, number, number] {
	const a = C * Math.cos((h * Math.PI) / 180), b = C * Math.sin((h * Math.PI) / 180);
	const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
	const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
	const s_ = L - 0.0894841775 * a - 1.291485548 * b;
	const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s
	];
}

export function linearToOklch([r, g, b]: readonly [number, number, number]): Oklch {
	const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
	const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
	const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
	const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
	const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
	const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
	const deg = (Math.atan2(B, A) * 180) / Math.PI;
	return [L, Math.hypot(A, B), deg < 0 ? deg + 360 : deg];
}

const EPS = 1e-4;
export const inGamut = (lin: readonly number[]) => lin.every((c) => c >= -EPS && c <= 1 + EPS);

/** Largest chroma <= C that keeps (L, c, h) inside sRGB (bisection). */
export function fitChroma(L: number, C: number, h: number): number {
	if (inGamut(oklchToLinear([L, C, h]))) return C;
	let lo = 0, hi = C;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (inGamut(oklchToLinear([L, mid, h]))) lo = mid; else hi = mid;
	}
	return lo;
}

export const toRgb = (c: Oklch): Rgb => oklchToLinear(c).map((v) => toGamma(Math.min(1, Math.max(0, v)))) as unknown as Rgb;
export const fromRgb = (c: Rgb): Oklch => linearToOklch(c.map(toLinear) as unknown as [number, number, number]);
export const luminance = (c: Rgb): number => { const [r, g, b] = c.map(toLinear); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** WCAG 2 contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
	const x = luminance(a), y = luminance(b);
	return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** `fg` at `alpha` over `bg`, mixed in linear light. */
export function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
	return fg.map((v, i) => toGamma(toLinear(v) * alpha + toLinear(bg[i]) * (1 - alpha))) as unknown as Rgb;
}

// ---- the palette ---------------------------------------------------------------------------------------

export type Scheme = 'light' | 'dark';
export type PaletteEntries = Record<keyof typeof PAL2 | keyof typeof PAL_EXT, Rgb>;

const wrap = (h: number) => ((h % 360) + 360) % 360;
const ok = (L: number, C: number, h: number): Rgb => toRgb([L, fitChroma(L, C, h), h]);

/** One scheme of the palette for article hue `h` (section 3.2 numbers). */
export function schemeEntries(h: number, scheme: Scheme): PaletteEntries {
	const dark = scheme === 'dark';
	const paper = dark ? ok(0.2, 0.012, h) : ok(0.965, 0.012, h);
	const ink = dark ? ok(0.93, 0.008, h) : ok(0.2, 0.01, h);
	const accent = dark ? ok(0.76, 0.15, h) : ok(0.52, 0.19, h);
	const accent2 = ok(dark ? 0.76 : 0.52, 0.12, wrap(h + 40));
	const accentTint = over(accent, paper, 0.12);
	const field = dark ? ok(0.3, 0.1, h) : accent;
	const neutral = dark ? [0.45, 0.3, 0.15] : [0.55, 0.7, 0.85];
	return {
		ink, link: accent, muted: over(ink, paper, 0.88), heading: ink, rule: over(ink, paper, 0.18),
		selection: over(accent, paper, 0.28), codeBg: dark ? ok(0.25, 0.012, h) : ok(0.935, 0.012, h), quoteBar: accent,
		accent, accent2, accentTint,
		// text on an accent fill: paper in light, deep ink in dark (an accent fill is L 0.76 in dark)
		accentInk: dark ? ok(0.2, 0.01, h) : paper,
		neutral1: ok(neutral[0], 0.01, h), neutral2: ok(neutral[1], 0.01, h), neutral3: ok(neutral[2], 0.01, h),
		panel: dark ? ok(0.25, 0.012, h) : ok(0.935, 0.012, h), field, paper,
		// text on a `field` block (light: accent L 0.52, dark: L 0.30), so ink flips with the scheme
		fieldInk: dark ? ink : paper
	};
}

/** Contrast floors (MAGAZINE.md 3.2 and 6 A5): body 12:1 light, 9:1 dark; graphics 3:1; text 4.5:1. */
export function checkPalette(h: number, scheme: Scheme, p: PaletteEntries = schemeEntries(h, scheme)): void {
	const fail = (m: string) => { throw new Error(`palette hue ${h} ${scheme}: ${m}`); };
	for (const [name, c] of Object.entries(p)) {
		const lin = c.map(toLinear);
		if (!inGamut(lin)) fail(`${name} out of sRGB gamut`);
	}
	const need = (what: string, a: Rgb, b: Rgb, min: number) => { const r = contrast(a, b); if (r < min) fail(`${what} contrast ${r.toFixed(2)} < ${min}`); };
	need('ink on paper', p.ink, p.paper, scheme === 'light' ? 12 : 9);
	need('muted on paper', p.muted, p.paper, 4.5);
	need('link on paper', p.link, p.paper, 4.5);
	need('ink on panel', p.ink, p.panel, 9);
	need('accent graphics on paper', p.accent, p.paper, 3);
	need('accent2 graphics on paper', p.accent2, p.paper, 3);
	need('accentInk on accent', p.accentInk, p.accent, 4.5);
	need('fieldInk on field', p.fieldInk, p.field, 4.5);
	need('neutral1 on paper', p.neutral1, p.paper, 1.5);
}

const pack = (c: Rgb) => ((255 << 24) | (Math.round(c[2] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[0] * 255)) >>> 0;

/**
 * RDR2 palette section: 2 * PALETTE2_SIZE words, RGBA8 as 0xAABBGGRR, light then dark. Slots 0..18 are filled;
 * `syntax` (compile lane) supplies slots PAL_SYNTAX_START.. as [light, dark] pairs, rest stay ink.
 */
export function buildPalette(h: number, syntax: readonly (readonly [Rgb, Rgb])[] = []): Uint32Array {
	const out = new Uint32Array(2 * PALETTE2_SIZE);
	(['light', 'dark'] as const).forEach((sc, col) => {
		checkPalette(h, sc);
		const p = schemeEntries(h, sc);
		for (let i = 0; i < PALETTE2_SIZE; i++) out[col * PALETTE2_SIZE + i] = pack(p.ink);
		for (const [name, i] of Object.entries({ ...PAL2, ...PAL_EXT })) out[col * PALETTE2_SIZE + i] = pack(p[name as keyof PaletteEntries]);
		syntax.forEach((pair, k) => {
			if (PAL_SYNTAX_START + k >= PALETTE2_SIZE) throw new Error('palette: too many syntax colours');
			out[col * PALETTE2_SIZE + PAL_SYNTAX_START + k] = pack(pair[col]);
		});
	});
	return out;
}

export const hex = (c: Rgb) => '#' + c.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
