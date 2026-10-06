import { describe, expect, test } from 'bun:test';
import { BlockKind, LineFlag, sampleReading, type ReadingModel } from '../magazine/format';
import { selectionText } from './textlayer';

function model(): ReadingModel {
	const m = sampleReading();
	const mk = (block: number, flags = 0) => ({ yTop: 0, yBot: 1, x0: 0, x1: 1, firstGlyph: 0, glyphCount: 0, textOff: 0, textLen: 0, block, size: 1, font: 0, flags });
	m.lines = [mk(0), mk(0, LineFlag.joinNext), mk(0), mk(1), mk(1), mk(2), mk(2), mk(3), mk(3)];
	m.blocks = [0, 1, 2, 3].map((i) => ({ ...m.blocks[0], kind: i === 2 ? BlockKind.code : i === 3 ? BlockKind.list : BlockKind.para }));
	return m;
}

describe('selectionText', () => {
	test('joins soft breaks with a space, hyphen cuts with nothing, blocks with a blank line', () => {
		const m = model();
		const t = selectionText(m, [
			{ line: 0, text: 'The quick' }, { line: 1, text: 'brown ex' }, { line: 2, text: 'ample here' },
			{ line: 3, text: 'Next para' }, { line: 4, text: 'continues' }
		]);
		expect(t).toBe('The quick brown example here\n\nNext para continues');
	});
	test('code is verbatim with newlines', () => {
		const m = model();
		expect(selectionText(m, [{ line: 5, text: 'fn a() {' }, { line: 6, text: '    1 + 1' }])).toBe('fn a() {\n    1 + 1');
	});
	test('list items start on a new line', () => {
		const m = model();
		expect(selectionText(m, [{ line: 7, text: '- one two' }, { line: 8, text: '- three' }])).toBe('- one two\n- three');
	});
	test('partial first and last lines and empty selection', () => {
		const m = model();
		expect(selectionText(m, [])).toBe('');
		expect(selectionText(m, [{ line: 1, text: 'own ex' }, { line: 2, text: 'amp' }])).toBe('own examp');
	});
});
