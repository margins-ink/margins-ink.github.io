import { describe, expect, test } from 'bun:test';
import {
	ARTICLE2_MAGIC, ItemType, PALETTE2_SIZE, REC2, ShapeKind, NO_CHAN, NONE16, packItem, itemType, itemIndex,
	packMagazine, unpackMagazine, unpackContainer, roundF16, type MagazineModel
} from './format';
import { figure, rrect, track, text, path, compileFigure } from './dsl';

const model = (): MagazineModel => ({
	widthClass: 0, emPx0: 16, spreadW: 80, spreadH: 56, sheetW: 40, marginOuter: 4.5, marginSpine: 3.5, gutter: 1.2,
	cellW: 6, cellH: 1.6, plainTextBytes: 5,
	spreads: [{ x: 0, w: 80, h: 56, template: 3, gridCols: 14, gridRows: 35, firstItem: 0, itemCount: 4, firstCell: 0, tone565: 0xf79e, materialMask: 3, accentIdx: 8, firstLine: 0, lineCount: 1 }],
	cells: [{ start: 0, count: 4 }, { start: 4, count: 0 }],
	items: [packItem(ItemType.glyph, 0), packItem(ItemType.shape, 0), packItem(ItemType.stroke, 0), packItem(ItemType.group, 0)],
	glyphs: [{ x: 4.5, y: 4.8, glyphId: 0x80000001, size: 4.2, colour: 3, flags: 16, charOffset: 0, group: NONE16, frame: 2 }],
	rects: [], images: [],
	shapes: [{ x0: 8, y0: 3, x1: 18, y1: 7, kind: ShapeKind.rrect, colour: 8, colour2: 13, flags: 0, radius: 0.4, param: 0, group: 0, chan: 1, mixChan: NO_CHAN, aux: 0 }],
	paths: [],
	strokes: [{ firstSeg: 0, segCount: 1, width: 0.18, flags: 0, colour: 8, group: 0, dashOn: 0.6, dashOff: 0.4, phaseChan: 0, trimT0Chan: NO_CHAN, trimT1Chan: 2, widthChan: NO_CHAN, colour2: 0, mixChan: NO_CHAN }],
	segs: [{ x0: 18, y0: 1, x1: 18, y1: 6, x2: 18, y2: 12, cum: 0, len: 11 }],
	groups: [{ parent: -1, txChan: NO_CHAN, tyChan: NO_CHAN, rotChan: NO_CHAN, scaleChan: 3, opacityChan: NO_CHAN, tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: 9, pivotY: 5 }],
	numerals: [{ x: 60, y: 30, cellW: 6.5, size: 14, colour: 13, style: 1, digits: 3, digitSet: 0, chan: 4, group: NONE16 }],
	digitSets: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
	chans: [{ firstKey: 0, keyCount: 2 }],
	keys: [{ t: 0, v: 0, ease: 0 }, { t: 14, v: 72, ease: 5 }],
	figures: [{ id: 0, firstChan: 0, chanCount: 1, mode: 0, duration: 14, poster: 11, alt: 6, describe: 12, x0: 0, y0: 0, x1: 72, y1: 26, spread: 0 }],
	lines: [{ yTop: 4, yBot: 5.6, x0: 4.5, x1: 36, firstGlyph: 0, glyphCount: 1, charOffset: 0, frame: 2 }],
	links: [{ x0: 4.5, y0: 4, x1: 9, y1: 5.6, kind: 1, offset: 3, spread: 0 }],
	anchors: [{ idOffset: 0, spread: 0, y: 4 }],
	extra: { dir: new Uint32Array(8), curves: new Uint16Array(8), bands: new Uint32Array(2) },
	text: new TextEncoder().encode('Hello'), strings: new TextEncoder().encode('a\0b\0'),
	palette: Uint32Array.from({ length: 2 * PALETTE2_SIZE }, (_, i) => 0xff000000 | i)
});

describe('RDR2', () => {
	test('record sizes are 4-aligned and stable', () => {
		for (const [k, v] of Object.entries(REC2)) expect(v % 4, k).toBe(0);
		expect(REC2).toMatchObject({ spread: 40, glyph: 24, rect: 20, shape: 36, stroke: 32, seg: 32, group: 44, figure: 64, cell: 8 });
	});

	test('item word round trip', () => {
		const w = packItem(ItemType.numeral, 0x0abcdef);
		expect(itemType(w)).toBe(ItemType.numeral);
		expect(itemIndex(w)).toBe(0x0abcdef);
	});

	test('header and a figure round trip through bytes', () => {
		const m = model();
		const bytes = packMagazine(m);
		const c = unpackContainer(bytes);
		expect(c.magic).toBe(ARTICLE2_MAGIC);
		const back = unpackMagazine(bytes);
		expect(back.spreadW).toBe(80);
		expect(back.marginOuter).toBeCloseTo(4.5);
		expect(back.spreads).toEqual(m.spreads);
		expect(back.shapes[0].radius).toBe(roundF16(0.4));
		expect(back.strokes[0].trimT1Chan).toBe(2);
		expect(back.strokes[0].trimT0Chan).toBe(NO_CHAN);
		expect(back.glyphs[0]).toMatchObject({ glyphId: 0x80000001, size: roundF16(4.2), group: NONE16, frame: 2 });
		expect(back.figures[0]).toMatchObject({ duration: 14, poster: 11, x1: 72, y1: 26 });
		expect(back.keys.map((k) => [k.t, k.v, k.ease])).toEqual([[0, 0, 0], [14, 72, 5]]);
		expect(back.groups[0]).toMatchObject({ parent: -1, scaleChan: 3, pivotX: 9 });
		expect(back.numerals[0]).toMatchObject({ digits: 3, chan: 4, style: 1 });
		expect(back.digitSets[0]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		expect(back.items).toEqual(m.items);
		expect(back.cells.map((x) => [x.start, x.count])).toEqual([[0, 4], [4, 0]]);
		expect(new TextDecoder().decode(back.text)).toBe('Hello');
		expect(Array.from(back.palette)).toEqual(Array.from(m.palette));
	});

	test('control: a wrong magic is rejected, a corrupted field is detected', () => {
		const bytes = packMagazine(model());
		const bad = bytes.slice();
		bad[0] ^= 0xff;
		expect(() => unpackMagazine(bad)).toThrow();
		const m = model();
		const back = unpackMagazine(packMagazine({ ...m, shapes: [{ ...m.shapes[0], x1: 19 }] }));
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
		expect(() => compileFigure('x', f)).toThrow('not implemented');
	});
});
