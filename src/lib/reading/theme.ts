// THE colour token table of the reader (docs/READING_GPU.md "Colour and typography", docs/READING.md 2.4). Pure TS, no DOM: the build
// (scripts/magazine/palette.ts, scripts/reader/shiki-theme.ts), the page shader (ground) and the tests all read the numbers here and nowhere else.
// Everything is OKLCH (L 0..1, C, h degrees). ONE colour system for every article, the room and its UI: one flat tinted near-black
// ground (never #000), one text ramp, ONE accent, one syntax palette, one set of figure colours. No per-article hue, tint or glow,
// nothing that moves with scroll or page. Every text-bearing token is checked against its real ground by scripts/magazine/theme.test.ts.

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

export const CONTRAST = { text: 4.5, large: 3, graphic: 3, /** body ink: far above AA, long reading */ body: 9 } as const;

// ---- ground and elevations -----------------------------------------------------------------------------

/** The one hue of the ground, surfaces and text tints (deep blue-grey: the cool counterpart of the warm accent). */
export const TINT_HUE = 265;
/** Page ground: deep tinted near-black, flat (the same pixels on every page and at every scroll position). */
export const GROUND = { L: 0.15, C: 0.014 } as const;

/** Elevation steps above the ground (opaque L; the tint follows the article hue). Each also has a hairline: the border drawn on it. */
export const ELEVATION = {
	ground: { L: GROUND.L, C: GROUND.C },
	/** code panel */
	code: { L: 0.188, C: 0.013 },
	/** figure card, tinted field */
	card: { L: 0.212, C: 0.014 },
	/** popover, cite card, menus */
	popover: { L: 0.235, C: 0.015 }
} as const;
export type ElevationName = keyof typeof ELEVATION;
/** Hairline: ink at this alpha over the surface it borders (about 1.6x to 1.8x contrast against it, deliberately faint; linear-light mix). */
export const HAIRLINE_ALPHA = 0.03;

// ---- text ramp -----------------------------------------------------------------------------------------

/** Text colours (L, C), all >= 4.5:1 on every elevation (tertiary is the floor: popover). */
export const TEXT = {
	primary: { L: 0.93, C: 0.008 },
	secondary: { L: 0.78, C: 0.009 },
	tertiary: { L: 0.665, C: 0.011 }
} as const;
export type TextName = keyof typeof TEXT;

// ---- accent --------------------------------------------------------------------------------------------

/** The one accent: warm amber, the hue of the room's lamps (world/scene LampColour {4, 2.4, 1.1}, NeonAmber). Used identically everywhere. */
export const ACCENT = { L: 0.8, C: 0.125, h: 68, tintAlpha: 0.14, selectionAlpha: 0.28 } as const;
/** The one supporting data colour a figure may use when it needs a second series (a fixed cool teal, same lightness family as the accent). */
export const ACCENT2 = { L: 0.76, C: 0.09, h: 205 } as const;
/** Text drawn on a filled accent. */
export const ACCENT_INK = { L: 0.2, C: 0.01 } as const;
/** Tinted field block (a `field` fill) and its text, plus the three neutral steps figures draw with. */
export const FIELD = { L: 0.3, C: 0.1 } as const;
/** Figure neutrals, light to dark: each >= 1.5:1 against the ground (shapes), the first two carry ink text at >= 4.5:1. */
export const NEUTRAL = { L: [0.5, 0.38, 0.32], C: 0.012 } as const;

// ---- syntax (designed for the dark code panel, hue independent) -----------------------------------------

/**
 * Twelve slots (PALETTE2_SIZE 32 minus PAL_SYNTAX_START 20 = 12 syntax slots in the RDR palette). Lightness 0.76 to 0.84 on the
 * L 0.20 panel gives 6.5:1 to 9:1; chroma 0.075 to 0.125 keeps them balanced (no pure red or blue, nothing above C 0.13). Hue families follow the
 * dark-theme consensus (Tokyo Night, Catppuccin Mocha, Rose Pine, GitHub Dark, Night Owl): keyword mauve, function blue, type gold,
 * string green, number orange, constant cyan, attribute and macro pink, property coral, operator cream, comment a readable (4.5:1) blue grey.
 */
export const SYNTAX = {
	keyword: [0.76, 0.12, 305],
	function: [0.78, 0.11, 258],
	type: [0.84, 0.115, 92],
	string: [0.8, 0.12, 145],
	number: [0.78, 0.125, 52],
	constant: [0.8, 0.09, 200],
	attribute: [0.78, 0.11, 345],
	property: [0.77, 0.1, 22],
	operator: [0.84, 0.04, 75],
	punctuation: [0.72, 0.02, 265],
	comment: [0.655, 0.04, 265],
	variable: [0.9, 0.012, 265]
} as const satisfies Record<string, Oklch>;
export type SyntaxName = keyof typeof SYNTAX;
/** Slot order: RDR palette syntax slot k is SYNTAX_ORDER[k]. */
export const SYNTAX_ORDER = Object.keys(SYNTAX) as SyntaxName[];

export const syntaxRgb = (): Record<SyntaxName, Rgb> =>
	Object.fromEntries(SYNTAX_ORDER.map((k) => [k, quant(ok(...(SYNTAX[k] as unknown as [number, number, number])))])) as Record<SyntaxName, Rgb>;
export const syntaxHex = (): Record<SyntaxName, string> =>
	Object.fromEntries(SYNTAX_ORDER.map((k) => [k, toHex(quant(ok(...(SYNTAX[k] as unknown as [number, number, number]))))])) as Record<SyntaxName, string>;

// ---- the table ---------------------------------------------------------------------------------------

export interface Theme {	/** opaque surfaces */
	surface: Record<ElevationName, Rgb>;
	/** the border colour of each surface (ink over it at HAIRLINE_ALPHA) */
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
}

/** All tokens, quantised to 8 bits (what the palette and the shiki theme ship). */
function buildTheme(h: number): Theme {
	const surface = Object.fromEntries(
		(Object.keys(ELEVATION) as ElevationName[]).map((k) => [k, quant(ok(ELEVATION[k].L, ELEVATION[k].C, h))])
	) as Record<ElevationName, Rgb>;
	const text = Object.fromEntries(
		(Object.keys(TEXT) as TextName[]).map((k) => [k, quant(ok(TEXT[k].L, TEXT[k].C, h))])
	) as Record<TextName, Rgb>;
	const hairline = Object.fromEntries(
		(Object.keys(surface) as ElevationName[]).map((k) => [k, quant(over(text.primary, surface[k], HAIRLINE_ALPHA))])
	) as Record<ElevationName, Rgb>;
	const accent = quant(ok(ACCENT.L, ACCENT.C, ACCENT.h));
	return {
		surface, hairline, text,
		accent,
		accent2: quant(ok(ACCENT2.L, ACCENT2.C, ACCENT2.h)),
		accentTint: quant(over(accent, surface.ground, ACCENT.tintAlpha)),
		accentInk: quant(ok(ACCENT_INK.L, ACCENT_INK.C, TINT_HUE)),
		selection: quant(over(accent, surface.ground, ACCENT.selectionAlpha)),
		field: quant(ok(FIELD.L, FIELD.C, ACCENT.h)),
		neutral: NEUTRAL.L.map((L) => quant(ok(L, NEUTRAL.C, h))) as unknown as readonly [Rgb, Rgb, Rgb],
		syntax: syntaxRgb()
	};
}

/** THE theme: the only instance. */
export const THEME: Theme = buildTheme(TINT_HUE);

// ---- WGSL snippets so the shader reads the same numbers ---------------------------------------------------

/** Constants the ground shader splices in: the flat ground as `oklch(L, C, hue)`. */
export const GROUND_WGSL = { L: GROUND.L.toFixed(4), chroma: GROUND.C.toFixed(4), hue: TINT_HUE.toFixed(1) } as const;
