// Vector icons of the code tip's header chip (IntelliJ-style): one glyph per token kind, drawn from strokes in the GPU layer (no font, no image).
// Pure data in a 0..1 unit square, y down; the chip draws them scaled with round caps.
import type { TokenKind } from '../codetip';

export type Prim =
	| { t: 'line'; x1: number; y1: number; x2: number; y2: number }
	| { t: 'dot'; x: number; y: number; r: number }
	| { t: 'box'; x: number; y: number; w: number; h: number; r: number };

const poly = (...p: number[]): Prim[] => {
	const out: Prim[] = [];
	for (let i = 0; i + 3 < p.length; i += 2) out.push({ t: 'line', x1: p[i], y1: p[i + 1], x2: p[i + 2], y2: p[i + 3] });
	return out;
};

export const KIND_ICONS: Record<TokenKind, Prim[]> = {
	// f with a hook and a crossbar
	function: [...poly(0.66, 0.22, 0.56, 0.22, 0.5, 0.3, 0.44, 0.78, 0.36, 0.84, 0.3, 0.8), ...poly(0.3, 0.48, 0.7, 0.48)],
	// key: bow ring (a dot the chip draws hollow is two dots) and a toothed blade
	keyword: [{ t: 'box', x: 0.2, y: 0.34, w: 0.32, h: 0.32, r: 0.16 }, ...poly(0.52, 0.5, 0.8, 0.5), ...poly(0.7, 0.5, 0.7, 0.66), ...poly(0.8, 0.5, 0.8, 0.62)],
	// two opening quotes
	string: [{ t: 'dot', x: 0.36, y: 0.38, r: 0.075 }, ...poly(0.36, 0.42, 0.31, 0.62), { t: 'dot', x: 0.64, y: 0.38, r: 0.075 }, ...poly(0.64, 0.42, 0.59, 0.62)],
	// hash
	number: [...poly(0.4, 0.24, 0.34, 0.76), ...poly(0.64, 0.24, 0.58, 0.76), ...poly(0.26, 0.4, 0.76, 0.4), ...poly(0.24, 0.6, 0.74, 0.6)],
	// curly braces
	variable: [...poly(0.44, 0.24, 0.36, 0.32, 0.36, 0.45, 0.28, 0.5, 0.36, 0.55, 0.36, 0.68, 0.44, 0.76), ...poly(0.56, 0.24, 0.64, 0.32, 0.64, 0.45, 0.72, 0.5, 0.64, 0.55, 0.64, 0.68, 0.56, 0.76)],
	// speech bubble with a tail
	comment: [{ t: 'box', x: 0.2, y: 0.24, w: 0.6, h: 0.38, r: 0.1 }, ...poly(0.36, 0.62, 0.32, 0.8, 0.5, 0.62)],
	// equals
	operator: [...poly(0.27, 0.4, 0.73, 0.4), ...poly(0.27, 0.6, 0.73, 0.6)],
	// T in a box
	type: [{ t: 'box', x: 0.2, y: 0.2, w: 0.6, h: 0.6, r: 0.12 }, ...poly(0.36, 0.38, 0.64, 0.38), ...poly(0.5, 0.38, 0.5, 0.66)],
	// angle brackets (a tag)
	attribute: [...poly(0.4, 0.28, 0.24, 0.5, 0.4, 0.72), ...poly(0.6, 0.28, 0.76, 0.5, 0.6, 0.72)],
	// asterisk sparkle
	builtin: [...poly(0.5, 0.18, 0.5, 0.82), ...poly(0.18, 0.5, 0.82, 0.5), ...poly(0.32, 0.32, 0.68, 0.68), ...poly(0.68, 0.32, 0.32, 0.68)],
	// square brackets
	punct: [...poly(0.42, 0.24, 0.32, 0.24, 0.32, 0.76, 0.42, 0.76), ...poly(0.58, 0.24, 0.68, 0.24, 0.68, 0.76, 0.58, 0.76)]
};
