import { describe, expect, test } from 'bun:test';
import { MagazineInput, type BookSink, type BookView, type PointerIn } from './input';
import { buildTextModel, caretAt, extend, lineNear, selectionRects, textOf, wordRange, type Sel } from './select';

// Two lines, 1 em per glyph. Text "hello world => x" then "second line". The "=>" is two glyphs (calt ligature, clusters 1:1);
// line 1 ends in a synthetic hyphen glyph (offset 0) that must not be addressable.
const TEXT = new TextEncoder().encode('hello world => x second line');
const line1 = { yTop: 0, yBot: 2, x0: 10, x1: 27, firstGlyph: 0, glyphCount: 17, charOffset: 0, frame: 0 };
const g1 = Array.from({ length: 16 }, (_, i) => ({ x: 10 + i, charOffset: i })); // "hello world => x " minus trailing
g1.push({ x: 26, charOffset: 0 }); // synthetic hyphen
const line2 = { yTop: 2, yBot: 4, x0: 10, x1: 21, firstGlyph: 17, glyphCount: 11, charOffset: 17, frame: 0 };
const g2 = Array.from({ length: 11 }, (_, i) => ({ x: 10 + i, charOffset: 17 + i }));
const model = buildTextModel([line1, line2], [...g1, ...g2], TEXT, [{ firstLine: 0, lineCount: 2 }]);

describe('text model', () => {
	test('a synthetic glyph keeps the previous boundary', () => {
		expect(Array.from(model.spreads[0][0].go).slice(14)).toEqual([14, 15, 15]);
		expect(model.spreads[0][0].end).toBe(16);
	});
	test('caretAt picks the nearer character boundary, whole line outside', () => {
		expect(caretAt(model, 0, 12.3, 1)?.offset).toBe(2); // before glyph 2 (x 12..13, mid 12.5)
		expect(caretAt(model, 0, 12.7, 1)?.offset).toBe(3);
		expect(caretAt(model, 0, 0, 1)?.offset).toBe(0); // left of the line: its start
		expect(caretAt(model, 0, 99, 3)?.offset).toBe(28); // right of line 2: its end
		expect(lineNear(model, 0, 12, 30, 0.6)).toBeNull(); // far from any text is not text
	});
	test('ligature clusters: each glyph of "=>" is its own boundary and copy slices exact characters', () => {
		const eq = caretAt(model, 0, 22.2, 1)!.offset, gt = caretAt(model, 0, 23.2, 1)!.offset;
		expect(textOf(model, eq, gt + 1)).toBe('=>');
	});
	test('words: letters, digits and underscore; punctuation runs; spaces', () => {
		expect(wordRange(model, 8)).toEqual([6, 11]);
		expect(wordRange(model, 12)).toEqual([12, 14]); // "=>" is one punctuation run
		expect(wordRange(model, 11)).toEqual([11, 12]); // on the space
	});
	test('selectionRects: a range inside one line, then across both', () => {
		expect(selectionRects(model, { spread: 0, lo: 2, hi: 5 })).toEqual([12, 0, 15, 2]);
		const r = selectionRects(model, { spread: 0, lo: 12, hi: 20 });
		expect(r).toEqual([22, 0, 27, 2, 10, 2, 13, 4]); // line 1 filled to its edge (hyphen included), line 2 to glyph 3
	});
	test('copy is the exact plain text, no hyphen and no layout', () => {
		expect(textOf(model, 6, 11)).toBe('world');
		expect(textOf(model, 12, 20)).toBe('=> x sec');
	});
	test('word drag extends by whole words on both sides', () => {
		const d = { spread: 0, unit: 'word' as const, a0: 6, a1: 11 };
		expect(extend(model, d, 2, null)).toEqual({ spread: 0, lo: 0, hi: 11 });
		expect(extend(model, d, 13, null)).toEqual({ spread: 0, lo: 6, hi: 14 });
	});
});

const mkView = (o: Partial<BookView> = {}): BookView => ({
	f: 1, layer: 1, spreads: 5, zoom: 1, narrow: false, overview: false, focus: null, pxPerEm: 10,
	links: [], figures: [], overviewAt: () => null, figureTime: () => 0, text: model, ...o
});
function harness(o: Partial<BookView> = {}) {
	const sels: (Sel | null)[] = [];
	const calls: string[] = [];
	const v = mkView(o);
	const sink = new Proxy({} as BookSink, {
		get: (_, k: string) => (...a: unknown[]) => void (k === 'select' ? sels.push(a[0] as Sel | null) : calls.push(k))
	});
	return { sels, calls, inp: new MagazineInput(sink, () => v) };
}
const P = (x: number, y: number, t: number, over: Partial<PointerIn> = {}): PointerIn => ({ id: 1, x: x * 10, y: y * 10, t, type: 'mouse', spreadPoint: { spread: 0, x, y }, ...over });

describe('mouse drag selects text', () => {
	test('drag across both lines selects, copy text is exact, and nothing pans, turns or scrubs', () => {
		const { sels, calls, inp } = harness();
		expect(inp.pointerDown(P(16.2, 1, 0))).toBe('handled');
		expect(inp.pointerMove(P(18, 1, 20))).toBe('handled');
		inp.pointerMove(P(14, 3, 40));
		expect(inp.pointerUp(P(14, 3, 60))).toBe('handled');
		expect(inp.selection).toEqual({ spread: 0, lo: 6, hi: 21 });
		expect(inp.selectedText()).toBe('world => x seco');
		expect(calls.filter((c) => c !== 'follow')).toEqual([]);
		expect(sels[sels.length - 1]).toEqual({ spread: 0, lo: 6, hi: 21 });
	});
	test('a press elsewhere clears; Escape clears first; a click on text only clears', () => {
		const { sels, inp } = harness();
		inp.pointerDown(P(11.2, 1, 0)); inp.pointerMove(P(15, 1, 20)); inp.pointerUp(P(15, 1, 30));
		expect(inp.selection).not.toBeNull();
		expect(inp.keyIn({ key: 'Escape', shift: false, mod: false, t: 100 })).toBe('handled');
		expect(inp.selection).toBeNull();
		inp.pointerDown(P(11.2, 1, 200)); inp.pointerMove(P(15, 1, 220)); inp.pointerUp(P(15, 1, 230));
		inp.pointerDown(P(70, 50, 600)); // off text
		expect(inp.selection).toBeNull();
		expect(sels[sels.length - 1]).toBeNull();
	});
	test('double click selects the word, triple click the line; touch never selects', () => {
		const { inp } = harness();
		inp.pointerDown(P(16.2, 1, 0)); inp.pointerUp(P(16.2, 1, 40));
		inp.pointerDown(P(16.2, 1, 120));
		expect(inp.selectedText()).toBe('world');
		inp.pointerUp(P(16.2, 1, 150));
		inp.pointerDown(P(16.2, 1, 230));
		expect(inp.selectedText()).toBe('hello world => x');
		inp.pointerUp(P(16.2, 1, 260));
		const t = harness();
		t.inp.pointerDown(P(16.2, 1, 0, { type: 'touch' })); t.inp.pointerMove(P(20, 1, 30, { type: 'touch' })); t.inp.pointerUp(P(20, 1, 60, { type: 'touch' }));
		expect(t.inp.selection).toBeNull();
	});
	test('a margin drag still grabs the leaf (the book handle keeps drag)', () => {
		const { calls, inp } = harness({ layer: 1, f: 2 });
		inp.pointerDown(P(2, 30, 0)); inp.pointerMove(P(-3, 30, 30)); inp.pointerMove(P(-8, 30, 60));
		expect(calls).toContain('grab');
	});
});
