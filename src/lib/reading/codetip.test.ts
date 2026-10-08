import { describe, expect, test } from 'bun:test';
import { BlockKind, GlyphFlag, type ReadingModel } from '../magazine/format';
import { SYNTAX_ORDER } from './theme';
import { codeTipOf, codeTokenAt, roleOf, ROLES, tipText, WORDS } from './codetip';

const slot = (n: string) => 20 + SYNTAX_ORDER.indexOf(n as never);
const enc = new TextEncoder();

/** one code block, one line: [text, slot] runs laid out on a 0.6 em pitch, spaces without glyphs */
function codeModel(runs: [string, string][]): ReadingModel {
	const glyphs: ReadingModel['glyphs'] = [];
	let src = '', x = 1;
	for (const [t, s] of runs) for (const ch of t) {
		if (ch !== ' ') glyphs.push({ x, y: 5, glyphId: 1, size: 0.8, colour: slot(s), flags: GlyphFlag.code, charOffset: src.length, group: 0 } as never);
		src += ch; x += 0.6;
	}
	const text = enc.encode(src);
	return {
		text, strings: new Uint8Array(1), glyphs,
		blocks: [{ kind: BlockKind.code }],
		lines: [{ yTop: 4, yBot: 6, x0: 1, x1: x, firstGlyph: 0, glyphCount: glyphs.length, textOff: 0, textLen: text.length, block: 0, size: 0.8, font: 0, flags: 0 }]
	} as unknown as ReadingModel;
}
const at = (m: ReadingModel, j: number) => codeTokenAt(m, 0, j, m.glyphs[j].x + 0.1);

describe('code tips', () => {
	test('exact words win, then the dotted word on its last segment, then the role', () => {
		const m = codeModel([['let', 'keyword'], [' ', 'variable'], ['builtins', 'type'], ['.', 'operator'], ['readFile', 'type']]);
		expect(codeTipOf(at(m, 0)!)).toBe(WORDS.let);
		expect(codeTipOf(at(m, 3)!)).toBe(WORDS.builtins); // the first segment of builtins.readFile explains builtins
		const rf = at(m, 12)!;
		expect(rf.text).toBe('readFile');
		expect(rf.dotted).toBe('builtins.readFile');
		expect(codeTipOf(rf)).toBe(WORDS['builtins.readFile']);
	});
	test('tokens split at colour changes and at spaces; the pointer in a gap hits nothing', () => {
		const m = codeModel([['in', 'keyword'], [' ', 'variable'], ['inherit', 'keyword']]);
		const t = at(m, 0)!;
		expect([t.text, t.g0, t.g1]).toEqual(['in', 0, 1]);
		expect(at(m, 2)!.text).toBe('inherit');
		expect(codeTokenAt(m, 0, 1, m.glyphs[1].x + 0.6 + 0.2)).toBeNull(); // right of "in" over the space
	});
	test('role fallback by palette slot and text', () => {
		expect(roleOf(slot('keyword'), 'fn')).toBe(ROLES.keyword);
		expect(roleOf(slot('string'), '"x"')).toBe(ROLES.string);
		expect(roleOf(slot('comment'), '// c')).toBe(ROLES.comment);
		expect(roleOf(slot('number'), '42')).toBe(ROLES.number);
		expect(roleOf(slot('operator'), '=')).toBe(ROLES.operator);
		expect(roleOf(slot('operator'), '{')).toBe(ROLES.punctuation);
		expect(roleOf(slot('operator'), 'schema')).toBe(ROLES.variable);
		expect(roleOf(5, 'x')).toBeNull();
		expect(tipText('zzz', '', slot('function'))).toBe(ROLES.title);
	});
	test('inline code spans get a wash over the whole span (spaces included) and no tip', () => {
		const m = codeModel([['nix', 'inline'], [' ', 'inline'], ['flake', 'inline']]);
		(m.blocks[0] as { kind: number }).kind = BlockKind.para;
		const t = at(m, 0)!;
		expect(t.inline).toBe(true);
		expect([t.g0, t.g1]).toEqual([0, 7]);
		expect(codeTipOf(t)).toBeNull();
	});
});
