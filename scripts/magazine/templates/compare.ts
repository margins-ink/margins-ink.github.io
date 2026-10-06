import { template } from '../../../src/lib/magazine/types';

// Distilled: left and right sheets are two versions of one diagram or listing (L, R), headline strip across the
// top, quote in a strip over the spine. Head and quote may cross the spine; captions may not.
export const compare = template('compare', {
	cols: 12,
	rows: ['3b', '7b', 'fr', '3b', '5b', '4b'],
	areas: `
    . . . . . . | . . . . . .
    T T T T T T | T T T T T T
    L L L L L L | R R R R R R
    a a a a a a | b b b b b b
    . . . Q Q Q | Q Q Q . . .
    f f f f f f | g g g g g g`,
	slots: {
		T: { type: 'head', font: 'display', size: 7.5 },
		L: { type: 'figure', bleed: ['left'] },
		R: { type: 'figure', bleed: ['right'] },
		a: { type: 'caption', font: 'label', size: 0.78 },
		b: { type: 'caption', font: 'label', size: 0.78 },
		Q: { type: 'pullquote', font: 'display', size: 2.4 },
		f: { type: 'folio', font: 'label', size: 0.72 },
		g: { type: 'folio', font: 'label', size: 0.72 }
	},
	fit: { tracking: [-0.005, 0.005], leading: [0.98, 1.02], maxStretch: 1 },
	narrow: {
		cols: 6,
		rows: ['3b', '6b', 'fr', '3b', 'fr', '3b', '5b', '4b'],
		areas: `
    . . . . . .
    T T T T T T
    L L L L L L
    a a a a a a
    R R R R R R
    b b b b b b
    Q Q Q Q Q Q
    f f f f f f`
	}
});
