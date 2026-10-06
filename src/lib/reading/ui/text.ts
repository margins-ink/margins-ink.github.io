// UI text shaping at runtime (docs/READING_GPU.md "GPU chrome"): code point to union glyph id and advance from the per-font
// tables in fonts.bin, optional pair kerning, no other layout. Pure: tables are data, nothing here touches the DOM or the GPU.
import { readFontsBin } from '../../reader/format';
import { decodeUiTables } from './tables';
import { NO_GLYPH, type Shaped, type UiFont, type UiFontTable, type UiGlyph, type UiTables } from './types';

let tables: UiTables | null = null;

/** Register tables (tests, or a host that decoded them itself). */
export function setUiTables(t: UiTables | null): void { tables = t; }

/** Decode the UI section of fonts.bin and register it. Throws when the file predates UI tables. */
export function loadUiTables(fontsBin: Uint8Array): UiTables {
	const ui = readFontsBin(fontsBin).ui;
	if (!ui) throw new Error('fonts.bin has no UI font tables (rebuild with scripts/magazine/build.ts)');
	const t = decodeUiTables(ui);
	tables = t;
	return t;
}

const need = (): UiTables => {
	if (!tables) throw new Error('ui text: tables not loaded (call loadUiTables)');
	return tables;
};

/** Index of code point cp in the sorted table, or -1. */
function find(t: UiFontTable, cp: number): number {
	let lo = 0, hi = t.cp.length - 1;
	while (lo <= hi) {
		const m = (lo + hi) >> 1;
		const v = t.cp[m];
		if (v === cp) return m;
		if (v < cp) lo = m + 1; else hi = m - 1;
	}
	return -1;
}

/** Shape with explicit tables. Code points below 0x20 and DEL are dropped; unknown ones draw the notdef glyph. */
export function shapeWith(t: UiFontTable, text: string, sizePx: number): Shaped {
	const glyphs: Shaped['glyphs'] = [];
	let x = 0;
	let prev = -1;
	for (const ch of text) {
		const cp = ch.codePointAt(0)!;
		if (cp < 0x20 || cp === 0x7f) continue;
		const i = find(t, cp);
		const gid = i < 0 ? t.notdef.glyphId : t.gid[i];
		const adv = i < 0 ? t.notdef.adv : t.adv[i];
		if (prev >= 0 && cp < 0x10000) x += (t.kern.get((prev << 16) | cp) ?? 0) * sizePx;
		if (gid !== NO_GLYPH) glyphs.push({ dx: x, glyphId: gid });
		x += adv * sizePx;
		prev = cp;
	}
	return { glyphs, width: x };
}

export function shapeUi(text: string, font: UiFont, sizePx: number): Shaped {
	return shapeWith(need()[font], text, sizePx);
}

export function measureUi(text: string, font: UiFont, sizePx: number): number {
	return shapeWith(need()[font], text, sizePx).width;
}

/** `text` if it fits in maxW px, else the longest prefix plus the ellipsis that fits (trailing spaces trimmed); '' when not even the ellipsis fits. */
export function truncateUi(text: string, font: UiFont, sizePx: number, maxW: number, ellipsis = '…'): string {
	const t = need()[font];
	if (shapeWith(t, text, sizePx).width <= maxW) return text;
	const cps = [...text];
	let lo = 0, hi = cps.length - 1; // longest prefix length n in [0, len-1] with width(prefix + ellipsis) <= maxW
	let best = -1;
	while (lo <= hi) {
		const m = (lo + hi) >> 1;
		if (shapeWith(t, cps.slice(0, m).join('').trimEnd() + ellipsis, sizePx).width <= maxW) { best = m; lo = m + 1; } else hi = m - 1;
	}
	return best < 0 ? '' : cps.slice(0, best).join('').trimEnd() + ellipsis;
}

/** Shape and place a string: pen starts at x, baseline y (CSS px). */
export function uiGlyphs(text: string, font: UiFont, sizePx: number, x: number, baselineY: number, rgba: readonly [number, number, number, number], hdr?: number): UiGlyph[] {
	const s = shapeUi(text, font, sizePx);
	return s.glyphs.map((g) => ({
		x: x + g.dx, y: baselineY, glyphId: g.glyphId, font, size: sizePx, r: rgba[0], g: rgba[1], b: rgba[2], a: rgba[3], ...(hdr === undefined ? {} : { hdr })
	}));
}
