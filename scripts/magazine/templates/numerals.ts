import { template } from '../../../src/lib/magazine/types';

// Distilled: 3 to 5 giant numerals (1..5) with labels (a..e), one small diagram G, headline H and quote Q.
// Narrow class shows numerals 1 and 2 only (35 baselines do not hold five).
const cap = { type: 'caption', font: 'label', size: 0.78 } as const;
const num = { type: 'numeral', font: 'numeral', size: 10 } as const;
const folio = { type: 'folio', font: 'label', size: 0.72 } as const;

export const numerals = template('numerals', {
	cols: 12,
	rows: ['3b', '7b', '7b', '7b', '7b', '4b'],
	areas: `
    . . . . . . | . . . . . .
    H H H H H H | Q Q Q Q Q Q
    1 1 1 1 a a | G G G G G G
    2 2 2 2 b b | 4 4 4 4 d d
    3 3 3 3 c c | 5 5 5 5 e e
    f f f f f f | g g g g g g`,
	slots: {
		H: { type: 'head', font: 'display', size: 7.5 },
		Q: { type: 'pullquote', font: 'display', size: 2.4 },
		G: { type: 'figure' },
		'1': num, '2': num, '3': num, '4': num, '5': num,
		a: cap, b: cap, c: cap, d: cap, e: cap,
		f: folio, g: folio
	},
	fit: { tracking: [-0.005, 0.005], leading: [0.98, 1.02], maxStretch: 1 },
	narrow: {
		cols: 6,
		rows: ['3b', '5b', '4b', '6b', '6b', 'fr', '4b'],
		areas: `
    . . . . . .
    H H H H H H
    Q Q Q Q Q Q
    1 1 1 1 a a
    2 2 2 2 b b
    G G G G G G
    f f f f f f`
	}
});
