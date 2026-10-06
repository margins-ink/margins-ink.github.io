import { template } from '../../../src/lib/magazine/types';

// Distilled: one full-bleed diagram Z under both sheets and the spine, headline overprinted top-left, quote and
// up to 3 captions in a bottom strip. Z is an underlay (its cells wrap the overprinted areas, bleed on all sides).
export const solo = template('solo', {
	cols: 12,
	rows: ['3b', '7b', 'fr', '7b', '4b'],
	areas: `
    . . . . . . | . . . . . .
    H H H H H H | Z Z Z Z Z Z
    Z Z Z Z Z Z | Z Z Z Z Z Z
    Q Q Q Q Q Q | a a b b c c
    f f f f f f | g g g g g g`,
	slots: {
		Z: { type: 'figure', bleed: ['left', 'right', 'top', 'bottom'] },
		H: { type: 'head', font: 'display', size: 7.5 },
		Q: { type: 'pullquote', font: 'display', size: 2.4 },
		a: { type: 'caption', font: 'label', size: 0.78 },
		b: { type: 'caption', font: 'label', size: 0.78 },
		c: { type: 'caption', font: 'label', size: 0.78 },
		f: { type: 'folio', font: 'label', size: 0.72 },
		g: { type: 'folio', font: 'label', size: 0.72 }
	},
	fit: { tracking: [-0.005, 0.005], leading: [0.98, 1.02], maxStretch: 1 },
	narrow: {
		cols: 6,
		rows: ['3b', '6b', 'fr', '5b', '3b', '3b', '3b', '4b'],
		areas: `
    . . . . . .
    H H H H Z Z
    Z Z Z Z Z Z
    Q Q Q Q Q Q
    a a a a a a
    b b b b b b
    c c c c c c
    f f f f f f`
	}
});
