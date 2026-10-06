// UI font tables for fonts.bin (docs/READING_GPU.md "GPU chrome"): for the sans and mono UI slots, every character the chrome can draw
// (Basic Latin, Latin-1, general punctuation, arrows, plus every character of the article titles, section names, reference titles and
// neighbour titles) gets a union glyph id and an advance; ASCII pairs get kerning for the sans. Runs inside the magazine build before
// the union table is finished, so the glyphs land in the same atlas as the article text.
import { encodeUiTables, type UiFontData } from '../../src/lib/reading/ui/tables';
import { NO_GLYPH, type UiFont } from '../../src/lib/reading/ui/types';
import { F, type FontSet, type GlyphTableBuilder } from '../reader/fonts';

/** Font indices of the UI slots: Instrument Sans at wdth 100 wght 500 (a display instance of the FontSet) and the code font. */
export const UI_SANS_AXES = { wdth: 100, wght: 500 } as const;
export const uiSlots = (fonts: FontSet): Record<UiFont, number> => ({ sans: fonts.display(UI_SANS_AXES.wdth, UI_SANS_AXES.wght), mono: F.code });

const RANGES: [number, number][] = [[0x20, 0x7e], [0xa0, 0xff], [0x2000, 0x206f], [0x2190, 0x21ff]];
/** Kerning is computed over printable ASCII pairs only (UI strings are mostly ASCII); other pairs advance by the plain advances. */
const KERN_MIN = 0.0005;

/** Sorted union of the fixed ranges and every code point of `texts` (control characters dropped). */
export function uiCodepoints(texts: Iterable<string>): number[] {
	const set = new Set<number>();
	for (const [a, b] of RANGES) for (let c = a; c <= b; c++) set.add(c);
	for (const t of texts) for (const ch of t) { const cp = ch.codePointAt(0)!; if (cp >= 0x20 && cp !== 0x7f) set.add(cp); }
	return [...set].sort((a, b) => a - b);
}

/** Build the section bytes; adds the glyphs it needs to `union`. Characters no font covers are left out (shapeUi draws notdef for them). */
export function buildUiTables(fonts: FontSet, union: GlyphTableBuilder, texts: Iterable<string>): Uint8Array {
	const slots = uiSlots(fonts);
	const cps = uiCodepoints(texts);
	const data = {} as Record<UiFont, UiFontData>;
	const glyph = (fi: number, gid: number) => {
		const cs = fonts.fonts[fi].outline(gid);
		return cs.length ? union.add(`${fi}:${gid}`, cs, [fi, gid]) : NO_GLYPH;
	};
	for (const name of ['sans', 'mono'] as const) {
		const fi = slots[name];
		const font = fonts.fonts[fi];
		const d: UiFontData = { notdef: { glyphId: NO_GLYPH, adv: 0.5 }, cp: [], gid: [], adv: [], kern: [] };
		const nd = font.shape('\u0000')[0];
		const ndGid = nd ? glyph(fi, 0) : NO_GLYPH;
		d.notdef = { glyphId: ndGid, adv: nd ? nd.xAdvance : 0.5 };
		for (const cp of cps) {
			const g = font.shape(String.fromCodePoint(cp))[0];
			if (g && g.gid !== 0) { d.cp.push(cp); d.gid.push(glyph(fi, g.gid)); d.adv.push(g.xAdvance); continue; }
			const fb = fonts.fallback(cp);
			if (fb) { d.cp.push(cp); d.gid.push(glyph(fb.font, fb.gid)); d.adv.push(fb.adv); }
		}
		if (name === 'sans') {
			const own = new Map<number, number>();
			d.cp.forEach((cp, i) => own.set(cp, i));
			const ascii: number[] = [];
			for (let c = 0x21; c <= 0x7e; c++) if (own.has(c) && fonts.fonts[fi].shape(String.fromCharCode(c))[0].gid !== 0) ascii.push(c);
			for (const l of ascii) {
				for (const r of ascii) {
					const s = font.shape(String.fromCharCode(l, r));
					if (s.length !== 2) continue;
					const k = s[0].xAdvance - d.adv[own.get(l)!];
					if (Math.abs(k) >= KERN_MIN) d.kern.push([l, r, k]);
				}
			}
		}
		data[name] = d;
	}
	return encodeUiTables(data);
}
