import { template } from '../../../src/lib/magazine/types';

// Full text, code-heavy: prose columns on the outer edges (A left, B right; thread 0), an 8-column code measure
// around the spine (C left, D right; thread 1) on a panel field F. F is an underlay: its cells sit in the top and
// bottom rows so its bbox is the full-height band. Code lines sit on the 1.6 em grid (loose for 0.85 em mono).
const prose = { type: 'body', font: 'body', size: 1, thread: 0, align: 'left', hyphenate: true, shape: 'rect' } as const;
const code = { type: 'code', font: 'code', size: 0.85, thread: 1, align: 'left' } as const;
const folio = { type: 'folio', font: 'label', size: 0.8 } as const;

export const textCode = template('text-code', {
	cols: 12,
	rows: ['3b', 'fr', '4b'],
	areas: `
    h h F F F F | F F F F i i
    A A C C C C | D D D D B B
    f f F F F F | F F F F g g`,
	slots: { F: { type: 'field', bleed: ['top', 'bottom'] }, h: folio, i: folio, A: prose, B: prose, C: code, D: code, f: folio, g: folio },
	fit: { tracking: [-0.005, 0.005], maxStretch: 1 },
	narrow: {
		cols: 6,
		rows: ['3b', 'fr', 'fr', '4b'],
		areas: `
    h h h h h h
    A A A A A A
    F C C C C F
    f f f f f f`
	}
});
