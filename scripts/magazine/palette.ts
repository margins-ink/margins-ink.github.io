// The RDR palette (docs/MAGAZINE.md 3.2): ONE palette for every article. Build time only: the world has one look (dark). Every number lives in src/lib/reading/theme.ts
// (the token table); this file only maps tokens onto the 32 palette slots and fails closed: `checkPalette` throws when an entry clips sRGB or a contrast floor is missed.
import { PAL2, PALETTE2_SIZE } from '../../src/lib/magazine/format';
import { CONTRAST, SYNTAX_ORDER, contrast, inGamut, THEME, toLinear, type Rgb } from '../../src/lib/reading/theme';

export {
	contrast, fitChroma, fromRgb, inGamut, linearToOklch, luminance, oklchToLinear, over, toRgb,
	type Oklch, type Rgb
} from '../../src/lib/reading/theme';

/** Slots the type lane adds beyond PAL2 (PAL2 is owned by the contract lane): text colour on a `field` block. */
export const PAL_EXT = { fieldInk: 18, ink3: 19 } as const;
/** First slot free for the syntax colours: SYNTAX_ORDER[k] lives in slot PAL_SYNTAX_START + k (12 slots to the end of the palette). */
export const PAL_SYNTAX_START = 20;
if (PAL_SYNTAX_START + SYNTAX_ORDER.length !== PALETTE2_SIZE) throw new Error('palette: the syntax table must fill the slots after PAL_SYNTAX_START exactly');

export type PaletteEntries = Record<keyof typeof PAL2 | keyof typeof PAL_EXT, Rgb>;

/** The palette (the same for every article). */
export function paletteEntries(): PaletteEntries {
	const t = THEME;
	return {
		ink: t.text.secondary, link: t.text.primary, muted: t.text.tertiary, heading: t.text.primary, rule: t.hairline.ground,
		selection: t.selection, codeBg: t.surface.code, quoteBar: t.accent,
		accent: t.accent, accent2: t.accent2, accentTint: t.accentTint, accentInk: t.accentInk,
		neutral1: t.neutral[0], neutral2: t.neutral[1], neutral3: t.neutral[2],
		panel: t.surface.card, field: t.field, paper: t.surface.ground,
		fieldInk: t.text.primary, ink3: t.text.tertiary
	};
}

/** Contrast floors: body ink 9:1; text 4.5:1 on every surface; graphics 3:1 (the full per-token matrix is scripts/magazine/theme.test.ts). */
export function checkPalette(p: PaletteEntries = paletteEntries()): void {
	const fail = (m: string) => { throw new Error(`palette: ${m}`); };
	for (const [name, c] of Object.entries(p)) {
		if (!inGamut(c.map(toLinear))) fail(`${name} out of sRGB gamut`);
	}
	const need = (what: string, a: Rgb, b: Rgb, min: number) => { const r = contrast(a, b); if (r < min) fail(`${what} contrast ${r.toFixed(2)} < ${min}`); };
	need('ink on paper', p.ink, p.paper, CONTRAST.body);
	need('muted on paper', p.muted, p.paper, CONTRAST.text);
	need('link on paper', p.link, p.paper, CONTRAST.text);
	need('ink3 on paper', p.ink3, p.paper, CONTRAST.text);
	// ix's code-ink (#a9a8a5) and body ink-2 (#b3b2af) on the code panel are 6.8:1 and 8.7:1, under our old 9:1: code text is held to CONTRAST.code (6.5)
	need('ink on code panel', p.ink, p.codeBg, CONTRAST.code);
	need('ink3 on code panel', p.ink3, p.codeBg, CONTRAST.text);
	need('ink3 on card', p.ink3, p.panel, CONTRAST.text);
	need('accent graphics on paper', p.accent, p.paper, CONTRAST.graphic);
	need('accent2 graphics on paper', p.accent2, p.paper, CONTRAST.graphic);
	need('accentInk on accent', p.accentInk, p.accent, CONTRAST.text);
	need('fieldInk on field', p.fieldInk, p.field, CONTRAST.text);
	need('neutral1 on paper', p.neutral1, p.paper, 1.5);
}

const pack = (c: Rgb) => ((255 << 24) | (Math.round(c[2] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[0] * 255)) >>> 0;

/** RDR2 palette section: PALETTE2_SIZE words, RGBA8 as 0xAABBGGRR. Slots 0..19 from PAL2 and PAL_EXT, 20..31 the twelve syntax colours in SYNTAX_ORDER. */
export function buildPalette(): Uint32Array {
	const out = new Uint32Array(PALETTE2_SIZE);
	checkPalette();
	const p = paletteEntries();
	const t = THEME;
	out.fill(pack(p.ink));
	for (const [name, i] of Object.entries({ ...PAL2, ...PAL_EXT })) out[i] = pack(p[name as keyof PaletteEntries]);
	SYNTAX_ORDER.forEach((k, i) => { out[PAL_SYNTAX_START + i] = pack(t.syntax[k]); });
	return out;
}
