// Template data for docs/MAGAZINE.md 1.3 (areas are an ASCII map over the 12 x N grid, `|` is the spine).
import { template } from '../../../src/lib/magazine/types';

// Distilled, default: headline left, definition and deck right, one diagram per sheet (A bleeds left, B bleeds
// right), a caption under each, pull quote bottom-right, folios. Rows (baselines): margin 3, headline band 7,
// diagrams fr (11), captions 3, quote 7, folio 4 = 35.
export const duo = template('duo', {
	cols: 12,
	rows: ['3b', '7b', 'fr', '7b', '6b', '4b'],
	areas: `
    . . . . . . | . . . . . .
    H H H H H H | D D D D D D
    A A A A A A | B B B B B B
    a a a a a a | b b b b b b
    . . . . . . | Q Q Q Q Q Q
    f f f f f f | g g g g g g`,
	slots: {
		H: { type: 'head', font: 'display', size: 7.5 },
		D: { type: 'deck', font: 'body', size: 1.4 },
		A: { type: 'figure', bleed: ['left'] },
		B: { type: 'figure', bleed: ['right'] },
		a: { type: 'caption', font: 'label', size: 0.78 },
		b: { type: 'caption', font: 'label', size: 0.78 },
		Q: { type: 'pullquote', font: 'display', size: 2.4 },
		f: { type: 'folio', font: 'label', size: 0.72 },
		g: { type: 'folio', font: 'label', size: 0.72 }
	},
	fit: { tracking: [-0.005, 0.005], leading: [0.98, 1.02], maxStretch: 1 },
	narrow: {
		cols: 6,
		rows: ['3b', '5b', '5b', 'fr', '5b', 'fr', '5b', '5b', '4b'],
		areas: `
    . . . . . .
    H H H H H H
    D D D D D D
    A A A A A A
    a a a a a a
    B B B B B B
    b b b b b b
    Q Q Q Q Q Q
    f f f f f f`
	}
});
