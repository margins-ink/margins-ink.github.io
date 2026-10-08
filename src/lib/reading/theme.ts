// THE colour token table of the reader (docs/READING_GPU.md "Colour and typography", docs/READING.md 2.4). Pure TS, no DOM: the build
// (scripts/magazine/palette.ts, scripts/reader/shiki-theme.ts), the page shader (ground) and the tests all read the numbers here and nowhere else.
// 2026-10-07 (Andrew: "match code theme and general theme for everything of ix/packages/web"): every value below is copied from
// /Volumes/Projects/indexable-inc/ix/packages/web (src/styles/site.css `.site` dark block, src/lib/docs/Blocks.svelte `.doc`,
// src/styles/doc-code.css `.code-roles` dark). ix is monochrome: the accent IS ink-1 (no hue). OKLCH helpers stay for tests and the ground shader.
// Every text-bearing token is checked against its real ground by scripts/magazine/theme.test.ts.

export type Rgb = readonly [number, number, number]; // sRGB 0..1, gamma encoded
export type Oklch = readonly [number, number, number]; // L 0..1, C, h degrees

// ---- OKLab (Ottosson 2020, public domain reference) ----------------------------------------------------

export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
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
/** Round to what ships (8 bits per channel): contrast is measured on these values. */
export const quant = (c: Rgb): Rgb => c.map((v) => Math.round(v * 255) / 255) as unknown as Rgb;
export const toHex = (c: Rgb): string => '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
export const fromHex = (h: string): Rgb => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
/** OKLab Euclidean distance between two colours (perceptual difference; about 0.02 is just noticeable). */
export function deltaE(a: Rgb, b: Rgb): number {
	const [L1, C1, h1] = fromRgb(a), [L2, C2, h2] = fromRgb(b);
	const x1 = C1 * Math.cos((h1 * Math.PI) / 180), y1 = C1 * Math.sin((h1 * Math.PI) / 180);
	const x2 = C2 * Math.cos((h2 * Math.PI) / 180), y2 = C2 * Math.sin((h2 * Math.PI) / 180);
	return Math.hypot(L1 - L2, x1 - x2, y1 - y2);
}

/** An OKLCH colour pulled into the sRGB gamut by lowering chroma only (hue and lightness are the design). */
export const ok = (L: number, C: number, h: number): Rgb => toRgb([L, fitChroma(L, C, h), h]);

// ---- thresholds (WCAG 2.2 AA) --------------------------------------------------------------------------

export const CONTRAST = { text: 4.5, large: 3, graphic: 3, /** body ink on the page ground (ix ink-2 #b3b2af on #101011 is 8.97:1; was 9, lowered to 8.9 for the exact ix value) */ body: 8.9, /** code text on the code panel (ix code-ink and syntax colours) */ code: 6.5 } as const;

// ---- ix tokens (site.css `.site` dark block), exact hex ----------------------------------------------------

/** ix greys g-0..g-13 (site.css lines 58-71). */
export const IX = {
	g1: '#101011', g2: '#141415', g3: '#19191a', g4: '#1f1f20', g5: '#28282a', g6: '#333335', g7: '#414143', g8: '#57575a', g9: '#727274', g10: '#929190', g11: '#b3b2af', g12: '#d4d3cf', g13: '#ebeae6',
	ink3: '#878684', codeInk: '#a9a8a5', docCodeInk: '#ff7369'
} as const;
/** --code-bg: color-mix(in srgb, g-2 70%, g-1) (site.css line 93). */
const mixSrgb = (a: string, b: string, wa: number): string => toHex(fromHex(a).map((v, i) => v * wa + fromHex(b)[i] * (1 - wa)) as unknown as Rgb);
export const CODE_BG_HEX = mixSrgb(IX.g2, IX.g1, 0.7);

/** Kept for the tests: tint hue of the (now neutral) figure steps. */
export const TINT_HUE = 265;
/** Page ground = ix --bg (g-1). */
export const GROUND_HEX = IX.g1;

/** Surfaces: ground = --bg, code = --code-bg, card = --bg-3, popover = --bg-4. Each hairline is ix --line (ground, code) or --line-2 (card, popover). */
export const ELEVATION = { ground: IX.g1, code: CODE_BG_HEX, card: IX.g3, popover: IX.g4 } as const;
export type ElevationName = keyof typeof ELEVATION;
export const HAIRLINE = { ground: IX.g5, code: IX.g5, card: IX.g6, popover: IX.g6 } as const;

/** Text ramp: ink-1, ink-2 (body), ink-3. */
export const TEXT = { primary: IX.g13, secondary: IX.g11, tertiary: IX.ink3 } as const;
export type TextName = keyof typeof TEXT;

// ---- accent: monochrome (accent = ink-1) -----------------------------------------------------------------

/** The accent is ink-1 itself. Text on an accent fill is the ground ink. The second series is a mid grey (g-10). */
export const ACCENT_HEX = IX.g13;
export const ACCENT2_HEX = IX.g10;
export const ACCENT_INK_HEX = IX.g1;
/** ix --s-tint: ink-1 at 6% over the surface (inline code pill); selection and emphasis tint use ink-1 at these alphas. */
export const TINT_ALPHA = 0.06, EMPHASIS_ALPHA = 0.14, SELECTION_ALPHA = 0.22;
/** Figure `field` block (neutral, one step above card) and the three neutral steps figures draw with, light to dark. */
export const FIELD_HEX = IX.g7;
export const NEUTRAL_HEX = [IX.g8, IX.g7, IX.g6] as const;

// ---- syntax: doc-code.css `.code-roles` dark, exact -------------------------------------------------------

/** The six ix roles (doc-code.css dark values). comment 7d8590; weights (keyword 600, title 500) are not carried by the palette. */
export const ROLES = { keyword: '#ff7b72', string: '#7ee2a8', title: '#d2a8ff', attr: '#79c0ff', number: '#ffb86b', comment: '#7d8590' } as const;

/**
 * Twelve slots (PALETTE2_SIZE 32 minus PAL_SYNTAX_START 20), mapped onto the six roles plus ix code-ink. hljs groups: keyword/literal -> keyword red;
 * string/regexp -> green; title/function -> purple; attr/property/variable/built_in/class/type -> blue; number/symbol/meta -> orange; comment -> grey.
 * Operators, punctuation and plain identifiers have no ix role: they take ix `--code-ink`. `inline` is not a syntax colour: it is the docs inline-code
 * colour (Blocks.svelte `--doc-code-ink`, #ff7369) carried in a slot so the baked layout can use it; no Shiki scope maps to it.
 */
export const SYNTAX = {
	keyword: ROLES.keyword,
	function: ROLES.title,
	type: ROLES.attr,
	string: ROLES.string,
	number: ROLES.number,
	constant: ROLES.attr,
	attribute: ROLES.number,
	property: ROLES.attr,
	operator: IX.codeInk,
	inline: IX.docCodeInk,
	comment: ROLES.comment,
	variable: IX.codeInk
} as const satisfies Record<string, string>;
export type SyntaxName = keyof typeof SYNTAX;
/** Slot order: RDR palette syntax slot k is SYNTAX_ORDER[k]. */
export const SYNTAX_ORDER = Object.keys(SYNTAX) as SyntaxName[];

export const syntaxRgb = (): Record<SyntaxName, Rgb> => Object.fromEntries(SYNTAX_ORDER.map((k) => [k, fromHex(SYNTAX[k])])) as Record<SyntaxName, Rgb>;
export const syntaxHex = (): Record<SyntaxName, string> => ({ ...SYNTAX });

// ---- the table ---------------------------------------------------------------------------------------

export interface Theme {
	/** opaque surfaces */
	surface: Record<ElevationName, Rgb>;
	/** the border colour of each surface (ix --line / --line-2) */
	hairline: Record<ElevationName, Rgb>;
	text: Record<TextName, Rgb>;
	accent: Rgb;
	accent2: Rgb;
	accentTint: Rgb;
	accentInk: Rgb;
	selection: Rgb;
	field: Rgb;
	neutral: readonly [Rgb, Rgb, Rgb];
	syntax: Record<SyntaxName, Rgb>;
	/** ink-1 at 6% over the ground: the inline code pill */
	pill: Rgb;
}

function buildTheme(): Theme {
	const map = <K extends string>(o: Record<K, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, fromHex(v as string)])) as Record<K, Rgb>;
	const surface = map(ELEVATION);
	const accent = fromHex(ACCENT_HEX);
	return {
		surface, hairline: map(HAIRLINE), text: map(TEXT),
		accent,
		accent2: fromHex(ACCENT2_HEX),
		accentTint: quant(over(accent, surface.ground, EMPHASIS_ALPHA)),
		accentInk: fromHex(ACCENT_INK_HEX),
		selection: quant(over(accent, surface.ground, SELECTION_ALPHA)),
		field: fromHex(FIELD_HEX),
		neutral: NEUTRAL_HEX.map(fromHex) as unknown as readonly [Rgb, Rgb, Rgb],
		syntax: syntaxRgb(),
		pill: quant(over(accent, surface.ground, TINT_ALPHA))
	};
}

/** THE theme: the only instance. */
export const THEME: Theme = buildTheme();

// ---- WGSL snippets so the shader reads the same numbers ---------------------------------------------------

/** Constants the ground shader splices in: the flat ground as `oklch(L, C, hue)`. */
const g = fromRgb(fromHex(GROUND_HEX));
export const GROUND_WGSL = { L: g[0].toFixed(4), chroma: g[1].toFixed(4), hue: g[2].toFixed(1) } as const;
