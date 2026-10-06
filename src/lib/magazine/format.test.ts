import { describe, expect, test } from 'bun:test';
import {
	ARTICLE2_MAGIC, ItemType, REC2, NO_CHAN, NONE16, packItem, itemType, itemIndex,
	packReading, unpackReading, unpackContainer, roundF16, sampleReading
} from './format';
import { figure, rrect, track, text, path } from './dsl';

describe('RDR3', () => {
	test('record sizes are 4-aligned and stable', () => {
		for (const [k, v] of Object.entries(REC2)) expect(v % 4, k).toBe(0);
		expect(REC2).toMatchObject({ glyph: 24, seg: 32, cell: 8 });
	});

	test('item word round trip', () => {
		const w = packItem(ItemType.numeral, 0x0abcdef);
		expect(itemType(w)).toBe(ItemType.numeral);
		expect(itemIndex(w)).toBe(0x0abcdef);
	});

	test('header, blocks, notes and a figure round trip through bytes', () => {
		const m = sampleReading();
		const bytes = packReading(m);
		expect(unpackContainer(bytes).magic).toBe(ARTICLE2_MAGIC);
		const back = unpackReading(bytes);
		expect(back.colW).toBe(34);
		expect(back.docX0).toBe(-3);
		expect(back.docH).toBe(40);
		m.blocks.forEach((r, i) => expect(back.blocks[i]).toMatchObject(r));
		expect(back.blocks.length).toBe(m.blocks.length);
		m.notes.forEach((r, i) => expect(back.notes[i]).toMatchObject(r));
		expect(back.notes.length).toBe(m.notes.length);
		m.lines.forEach((r, i) => expect(back.lines[i]).toMatchObject({ ...r, size: roundF16(r.size) }));
		expect(back.lines.length).toBe(m.lines.length);
		m.links.forEach((r, i) => expect(back.links[i]).toMatchObject(r));
		expect(back.links.length).toBe(m.links.length);
		expect(back.shapes[0].radius).toBe(roundF16(0.4));
		expect(back.strokes[0].trimT0Chan).toBe(NO_CHAN);
		expect(back.glyphs[0]).toMatchObject({ glyphId: 0x80000001, size: roundF16(4.2), group: NONE16 });
		expect(back.figures[0]).toMatchObject({ duration: 14, poster: 11, x1: 49, y1: 38 });
		expect(back.items).toEqual(m.items);
		expect(new TextDecoder().decode(back.text)).toBe('Hello');
		expect(Array.from(back.palette)).toEqual(Array.from(m.palette));
	});

	test('control: a wrong magic is rejected, a corrupted field is detected', () => {
		const bytes = packReading(sampleReading());
		const bad = bytes.slice();
		bad[0] ^= 0xff;
		expect(() => unpackReading(bad)).toThrow();
		const m = sampleReading();
		const back = unpackReading(packReading({ ...m, shapes: [{ ...m.shapes[0], x1: 19 }] }));
		expect(back.shapes[0].x1).not.toBe(m.shapes[0].x1);
	});
});

describe('figure DSL', () => {
	test('builds and validates', () => {
		const f = figure({
			size: [72, 26], time: { duration: 14, mode: 'loop', poster: 11 },
			describe: 'Two timelines of one build. CppNix stops evaluating while a derivation builds.',
			alt: 'Gantt chart.',
			nodes: [text('CppNix', { at: [0, 5] }), rrect('e1', { at: [8, 3], size: [10, 4], fill: 'ink' })],
			paths: [path('wall', 'M 18 1 L 18 12', { stroke: { w: 0.18, color: 'accent', dash: [0.6, 0.4] } })],
			tracks: [track('e1.size.x', [[0, 0], [1.2, 10]], 'outCubic')]
		});
		expect(f.nodes.length).toBe(2);
		expect(() => figure({ ...f, describe: 'short' })).toThrow();
		expect(() => track('x', [[1, 0], [0, 1]])).toThrow();
	});
});
