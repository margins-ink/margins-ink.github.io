import { template } from '../../../src/lib/magazine/types';

// Full text: two 3-column text frames per sheet (15.4 em measure); figures are placed inline by the planner as
// exclusions; running head on top, folio under. Thread 0 reads A, B, C, D.
const body = { type: 'body', font: 'body', size: 1, thread: 0, align: 'justify', hyphenate: true, shape: 'rect' } as const;
const folio = { type: 'folio', font: 'label', size: 0.72 } as const;

export const text = template('text', {
	cols: 12,
	rows: ['3b', 'fr', '4b'],
	areas: `
    h h h h h h | i i i i i i
    A A A B B B | C C C D D D
    f f f f f f | g g g g g g`,
	slots: { h: folio, i: folio, A: body, B: body, C: body, D: body, f: folio, g: folio },
	fit: { tracking: [-0.005, 0.005], maxStretch: 1 },
	narrow: {
		cols: 6,
		rows: ['3b', 'fr', '4b'],
		areas: `
    h h h h h h
    A A A A A A
    f f f f f f`
	}
});
