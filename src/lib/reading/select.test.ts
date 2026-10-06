import { describe, expect, test } from 'bun:test';
import { BlockKind, type ReadingModel } from '../magazine/format';
import { caretAt, foldEndOf, textIndex, type Caret } from './hit';
import { copyText, dragTo, lineAt, paraAt, press, rangeRects, selectAll, selectionRects, wordAt, type Sel } from './select';
import { selectionText } from './textlayer';
import { demoModel, loadBin } from './testmodel';

const dec = new TextDecoder();
const slice = (m: ReadingModel, lo: number, hi: number) => dec.decode(m.text.subarray(lo, hi));
const textOf = (m: ReadingModel, needle: string): number => {
	const i = new TextDecoder().decode(m.text).indexOf(needle);
	return new TextEncoder().encode(new TextDecoder().decode(m.text).slice(0, i)).length;
};
const blen = (s: string) => new TextEncoder().encode(s).length;
const mid = (m: ReadingModel, li: number) => (m.lines[li].yTop + m.lines[li].yBot) / 2;
/** caret at the centre of glyph j of line li */
const caretOnGlyph = (m: ReadingModel, li: number, j: number, frac = 0.5): Caret => {
	const L = m.lines[li];
	const g = m.glyphs[L.firstGlyph + j];
	const nx = j + 1 < L.glyphCount ? m.glyphs[L.firstGlyph + j + 1].x : L.x1;
	return caretAt(m, g.x + (nx - g.x) * frac, mid(m, li))!;
};

describe('copyText on the synthetic page', () => {
	const m = demoModel();
	const ix = textIndex(m);

	test('exact authored text: soft breaks, hyphen join, list markers, code newlines, blocks', () => {
		const all = copyText(m, selectAll(m));
		expect(all).toBe([
			'Title of the post',
			'alpha beta gamma delta café half-ated end.',
			'• one apple\n\n• two pears and a plum\n\n• three',
			'let x = 1;\n  fn long_name(argument_one, argument_two)',
			'hidden alpha one two in the fold',
			'folded last paragraph',
			'tail paragraph after the fold'
		].join('\n\n'));
	});

	test('planted ranges equal the source slice, and a planted off-by-one does not', () => {
		const a = textOf(m, 'beta');
		const b = textOf(m, 'plum') + 4;
		const sel: Sel = { anchor: a, focus: b };
		expect(copyText(m, sel)).toBe(slice(m, a, b));
		expect(copyText(m, { anchor: b, focus: a })).toBe(slice(m, a, b)); // backwards drag
		expect(copyText(m, { anchor: a + 1, focus: b })).not.toBe(slice(m, a, b));
		expect(copyText(m, { anchor: a, focus: b - 1 })).not.toBe(slice(m, a, b));
		expect(copyText(m, { anchor: a, focus: a })).toBe('');
	});

	test('closed fold: folded text and the fold button are not copied, open: only the button is dropped', () => {
		const closed = foldEndOf(m) - 10; // clip below foldEnd
		const c = copyText(m, selectAll(m), { clipEm: m.foldY + m.peekH });
		expect(c).not.toContain('hidden alpha');
		expect(c).not.toContain('folded last');
		expect(c).not.toContain('Read the full post');
		expect(c.endsWith('let x = 1;\n  fn long_name(argument_one, argument_two)\n\ntail paragraph after the fold')).toBe(true);
		const o = copyText(m, selectAll(m), { clipEm: foldEndOf(m) });
		expect(o).toContain('hidden alpha one two in the fold');
		expect(o).not.toContain('Read the full post');
		void closed;
	});

	test('select all stops before the margin note; a selection inside the note copies it', () => {
		expect(copyText(m, selectAll(m))).not.toContain('Side note');
		const a = textOf(m, 'Side note');
		expect(copyText(m, { anchor: a, focus: a + blen('Side note alpha') })).toBe('Side note alpha');
		expect(ix.bodyEnd).toBeLessThan(a);
	});
});

describe('units and gestures', () => {
	const m = demoModel();

	test('wordAt, lineAt, paraAt', () => {
		const off = textOf(m, 'café');
		expect(slice(m, ...wordAt(m, off + 1))).toBe('café'); // multi-byte character stays in the word
		expect(slice(m, ...wordAt(m, textOf(m, 'half-')))).toBe('half');
		expect(slice(m, ...wordAt(m, textOf(m, 'half-') + 4))).toBe('-');
		expect(slice(m, ...lineAt(m, textOf(m, 'gamma')))).toBe('alpha beta gamma delta');
		expect(slice(m, ...lineAt(m, textOf(m, 'two pears')))).toBe('\u2022 two pears and');
		expect(slice(m, ...paraAt(m, textOf(m, 'gamma')))).toBe('alpha beta gamma delta café half-ated end.');
		// a list item: marker included, continuation line included, neighbours excluded
		expect(slice(m, ...paraAt(m, textOf(m, 'plum')))).toBe('• two pears and a plum');
		// code: one visual line
		expect(slice(m, ...paraAt(m, textOf(m, 'fn long_name')))).toBe('  fn long_name(argument_one, argument_two)');
	});

	test('click, double click, triple click, drag by word, shift extend', () => {
		const p = m.blocks[1];
		const L1 = p.firstLine;
		// glyph 8 of line 0 is the 'e' of "beta" (a l p h a _ b e ...: spaces have no glyph)
		const c = caretOnGlyph(m, L1, 6);
		expect(slice(m, c.glyphOff, c.glyphOff + 1)).toBe('e');
		const g1 = press(m, c, 1);
		expect(g1.sel.anchor).toBe(g1.sel.focus);
		const g2 = press(m, c, 2);
		expect(copyText(m, g2.sel)).toBe('beta');
		const g3 = press(m, c, 3);
		expect(copyText(m, g3.sel)).toBe('alpha beta gamma delta café half-ated end.');
		// drag from the word to the right by words: whole words only
		const toDelta = caretOnGlyph(m, L1, 16);
		expect(copyText(m, dragTo(m, g2, toDelta).sel)).toBe('beta gamma delta');
		// and to the left: the anchor word stays whole
		const toAlpha = caretOnGlyph(m, L1, 1);
		expect(copyText(m, dragTo(m, g2, toAlpha).sel)).toBe('alpha beta');
		// char drag by glyph
		const a = press(m, caretOnGlyph(m, L1, 0, 0.1), 1);
		const d = dragTo(m, a, caretOnGlyph(m, L1, 3, 0.9));
		expect(copyText(m, d.sel)).toBe('alph');
		// shift extends from the old anchor
		const base = press(m, caretOnGlyph(m, L1, 0, 0.1), 1);
		const ext = press(m, caretOnGlyph(m, L1 + 1, 2, 0.1), 1, d.sel, true);
		expect(selLoHi(ext.sel)[0]).toBe(selLoHi(d.sel)[0]);
		expect(ext.sel.focus).toBe(caretOnGlyph(m, L1 + 1, 2, 0.1).off);
		void base;
	});
});
const selLoHi = (s: Sel) => [Math.min(s.anchor, s.focus), Math.max(s.anchor, s.focus)];

describe('selectionRects on the synthetic page', () => {
	const m = demoModel();

	test('range across three lines of a paragraph', () => {
		const a = textOf(m, 'gamma'), z = textOf(m, 'ated');
		const r = rangeRects(m, a, z + 2);
		const p = m.blocks[1];
		expect(r.map((q) => q.line)).toEqual([p.firstLine, p.firstLine + 1, p.firstLine + 2]);
		expect(r[0].x0).toBeCloseTo(11); // 'gamma' starts at column 11
		expect(r[0].x1).toBe(m.lines[p.firstLine].x1); // continues past the line end: filled
		expect(r[1].x0).toBe(m.lines[p.firstLine + 1].x0);
		expect(r[1].x1).toBe(m.lines[p.firstLine + 1].x1);
		expect(r[2].x0).toBe(m.lines[p.firstLine + 2].x0);
		expect(r[2].x1).toBeCloseTo(2, 0);
		expect(r[0].y0).toBe(m.lines[p.firstLine].yTop);
		expect(r[0].y1).toBe(m.lines[p.firstLine].yBot);
	});

	test('a word plate sits between its glyph edges (its trailing space is not covered)', () => {
		const a = textOf(m, 'beta');
		const r = rangeRects(m, a, a + 4);
		expect(r.length).toBe(1);
		expect(r[0].x0).toBeCloseTo(6);
		expect(r[0].x1).toBeGreaterThan(9.9);
		expect(r[0].x1).toBeLessThan(11);
	});

	test('code plates follow the horizontal scroll and are clipped to the panel', () => {
		const cb = m.blocks.findIndex((b) => b.kind === BlockKind.code);
		const b = m.blocks[cb];
		const a = textOf(m, 'let x');
		const r0 = rangeRects(m, a, a + 5);
		const r1 = rangeRects(m, a, a + 5, { codeDx: (i) => (i === cb ? 3 : 0) });
		expect(r0[0].x0).toBeCloseTo(0);
		expect(r1[0].x0).toBeCloseTo(0); // clipped at the panel edge
		expect(r1[0].x1).toBeCloseTo(r0[0].x1 - 3, 1);
		const far = textOf(m, 'argument_two');
		expect(rangeRects(m, far, far + 3).length).toBe(0); // beyond the panel at dx = 0 (x > 20)
		expect(rangeRects(m, far, far + 3, { codeDx: () => 20 }).length).toBe(1);
		void b;
	});

	test('closed fold: folded lines get no plates, the tail moves up', () => {
		const all = selectAll(m);
		const open = selectionRects(m, all, { clipEm: foldEndOf(m) });
		const closed = selectionRects(m, all, { clipEm: m.foldY + m.peekH });
		const folded = new Set(m.blocks.map((b, i) => (b.flags & 2 ? i : -1)).filter((i) => i >= 0));
		expect(open.some((r) => folded.has(r.block))).toBe(true);
		expect(closed.some((r) => folded.has(r.block))).toBe(false);
		const tail = m.blocks.length - 1;
		const tOpen = open.find((r) => r.block === tail)!, tClosed = closed.find((r) => r.block === tail)!;
		expect(tOpen.y0 - tClosed.y0).toBeCloseTo(foldEndOf(m) - (m.foldY + m.peekH));
	});

	test('note selection gives a plate in the margin', () => {
		const a = textOf(m, 'Side note');
		const r = rangeRects(m, a, a + 4);
		expect(r.length).toBe(1);
		expect(r[0].block).toBe(-1);
		expect(r[0].x0).toBeCloseTo(40);
	});
});

describe('copyText on the built articles', () => {
	for (const [slug, cls] of [['ifd', 'wide'], ['ifd', 'narrow'], ['hyperion', 'wide']] as const) {
		const m = loadBin(slug, cls);
		test.skipIf(!m)(`${slug} ${cls}: planted ranges equal the source, block copy equals the line-wise reconstruction`, () => {
			const mm = m!;
			const ix = textIndex(mm);
			// 200 seeded ranges between glyph boundaries of body lines (fold open)
			let seed = 12345;
			const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
			const body = Array.from(ix.bodyByY);
			let checked = 0;
			for (let t = 0; t < 200; t++) {
				const l0 = body[Math.floor(rnd() * body.length)], l1 = body[Math.floor(rnd() * body.length)];
				const j0 = Math.floor(rnd() * mm.lines[l0].glyphCount), j1 = Math.floor(rnd() * mm.lines[l1].glyphCount);
				const a = mm.glyphs[mm.lines[l0].firstGlyph + j0].charOffset, z = mm.glyphs[mm.lines[l1].firstGlyph + j1].charOffset;
				const lo = Math.min(a, z), hi = Math.max(a, z);
				if (ix.uiRanges.some(([u, v]) => lo < v && hi > u)) continue;
				const want = slice(mm, lo, hi);
				expect(copyText(mm, { anchor: lo, focus: hi }, { clipEm: foldEndOf(mm) })).toBe(want);
				if (hi - lo > 2) expect(copyText(mm, { anchor: lo + 1, focus: hi }, { clipEm: foldEndOf(mm) })).not.toBe(want);
				checked++;
			}
			expect(checked).toBeGreaterThan(100);
			// whole blocks: the text layer's own line-wise reconstruction (selectionText) must agree with the blob slice
			let compared = 0;
			mm.blocks.forEach((b, bi) => {
				const kinds: number[] = [BlockKind.para, BlockKind.heading, BlockKind.code, BlockKind.quote, BlockKind.hero, BlockKind.caption];
				if (!kinds.includes(b.kind) || b.lineCount === 0) return;
				const picked = Array.from({ length: b.lineCount }, (_, k) => {
					const L = mm.lines[b.firstLine + k];
					return { line: b.firstLine + k, text: slice(mm, L.textOff, L.textOff + L.textLen) };
				});
				const [a, z] = paraAt(mm, mm.glyphs[mm.lines[b.firstLine].firstGlyph].charOffset);
				if (b.kind === BlockKind.code) {
					const first = ix.lineStart[b.firstLine], last = ix.lineEnd[b.firstLine + b.lineCount - 1];
					expect(copyText(mm, { anchor: first, focus: last })).toBe(selectionText(mm, picked));
				} else {
					expect(copyText(mm, { anchor: a, focus: z }, { clipEm: foldEndOf(mm) })).toBe(selectionText(mm, picked));
					void bi;
				}
				compared++;
			});
			expect(compared).toBeGreaterThan(15);
		});
	}
});
