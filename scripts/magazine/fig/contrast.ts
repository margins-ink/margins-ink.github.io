// Figure colour contrast (the one theme, src/lib/reading/theme.ts). Every colour a figure draws is a palette name; each is checked
// against what it is actually drawn on: the page ground for free shapes, strokes and text, the host fill for a label.
//   filled shape (rrect, circle, path fill)  >= SHAPE_MIN (1.5) against the ground
//   stroke, arrow, ring, text, numeral        >= TEXT_MIN (4.5) against the ground
//   dots                                      >= DOT_MIN (3)
//   label inside a shape                      >= TEXT_MIN against that shape's fill (both ends of a mixed fill)
//   hatch lines                               >= SHAPE_MIN against the fill they sit on
// Fail closed: the build (fig/emit.ts buildFigures) throws on any message.
import type { ColorRef, FigureSpec } from '../../../src/lib/magazine/dsl';
import { PAL2, type PaletteName } from '../../../src/lib/magazine/format';
import { contrast } from '../../../src/lib/reading/theme';
import { paletteEntries, type PaletteEntries } from '../palette';

export const SHAPE_MIN = 1.5;
export const TEXT_MIN = 4.5;
export const DOT_MIN = 3;

const ends = (c: ColorRef | 'none' | undefined): PaletteName[] => (!c || c === 'none' ? [] : typeof c === 'string' ? [c] : [c.mix[0], c.mix[1]]);

/** Label colour on a fill: dark ink on the bright accent fills, light ink on the dark neutral steps, paper on bright greys. */
export function labelColour(fill: ColorRef | 'none'): PaletteName {
	if (fill === 'none') return 'ink';
	const a = typeof fill === 'string' ? fill : fill.mix[0];
	return a === 'accent' || a === 'field' || a === 'accent2' ? 'accentInk' : a === 'muted' || a === 'ink' ? 'paper' : 'ink';
}

export function figureContrast(figId: string, spec: FigureSpec, pal: PaletteEntries = paletteEntries()): string[] {
	const msg: string[] = [];
	const ground = pal.paper;
	const need = (what: string, fg: PaletteName, bg: PaletteName | 'ground', min: number) => {
		const r = contrast(pal[fg], bg === 'ground' ? ground : pal[bg]);
		if (r < min) msg.push(`${figId}: ${what} ${fg} on ${bg} is ${r.toFixed(2)}:1, needs ${min}:1`);
	};
	const stroke = (id: string, s: { color: ColorRef } | undefined) => { for (const c of ends(s?.color)) need(`${id} stroke`, c, 'ground', TEXT_MIN); };
	for (const p of spec.paths ?? []) {
		for (const c of ends(p.fill)) need(`path ${p.id} fill`, c, 'ground', SHAPE_MIN);
		stroke(`path ${p.id}`, p.stroke);
	}
	for (const n of spec.nodes) {
		switch (n.kind) {
			case 'rrect':
			case 'circle': {
				for (const c of ends(n.fill)) need(`${n.id} fill`, c, 'ground', SHAPE_MIN);
				stroke(n.id, n.stroke);
				if (n.kind === 'rrect' && n.hatch) for (const f of ends(n.fill)) for (const h of ends(n.stroke?.color ?? 'muted')) need(`${n.id} hatch`, h, f, SHAPE_MIN);
				if (n.label) for (const f of ends(n.fill)) need(`${n.id} label`, labelColour(n.fill), f, TEXT_MIN);
				if (n.label && n.fill === 'none') need(`${n.id} label`, 'ink', 'ground', TEXT_MIN);
				break;
			}
			case 'text': for (const c of ends(n.color)) need(`${n.id} text`, c, 'ground', TEXT_MIN); break;
			case 'arrow': stroke(n.id, n.stroke); break;
			case 'dots': for (const c of ends(n.color)) need(`${n.id} dots`, c, 'ground', DOT_MIN); break;
			case 'numeral': for (const c of ends(n.color)) need(`${n.id} numeral`, c, 'ground', TEXT_MIN); break;
		}
	}
	void PAL2;
	return msg;
}
