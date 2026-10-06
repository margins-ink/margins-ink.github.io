import { describe, expect, test } from 'bun:test';
import { ItemType, NONE16, NO_CHAN, PAL2, PALETTE2_SIZE, ShapeKind, unpackMagazine, itemType, itemIndex, MAX_CELL_ITEMS } from '../../src/lib/magazine/format';
import { emitMagazine, appendFragment, newStore, placeFigure, templateId, type EmitContext, type Fragment, type SpreadContent } from './emit';
import { GlyphTableBuilder } from '../reader/fonts';

const mkBuilder = () => {
	const b = new GlyphTableBuilder();
	// one unit-square glyph (a closed quadratic contour with 4 corners as degenerate quads)
	const sq: number[][] = [[0, 0, 0.5, 0, 1, 0], [1, 0, 1, 0.5, 1, 1], [1, 1, 0.5, 1, 0, 1], [0, 1, 0, 0.5, 0, 0]];
	b.add('sq', [sq]);
	return b;
};

const ctx = (): EmitContext => ({
	widthClass: 0, sheetW: 40, marginOuter: 5, marginSpine: 4, gutter: 1.2, extra: mkBuilder(), union: mkBuilder(),
	text: new TextEncoder().encode('hi'), strings: new Uint8Array([0]), palette: Uint32Array.from({ length: 2 * PALETTE2_SIZE }, (_, i) => 0xff000000 | (i * 0x010101)), digitSets: []
});
const meta = (layer: 0 | 1) => ({ layer, template: 0, w: 80, h: 56, materialMask: 1, accentIdx: PAL2.accent });

// a figure: group g0 with a trim channel on a stroke, a dot riding the stroke, one rrect, 2 keys
const figure = (): Fragment => ({
	items: [{ type: ItemType.shape, index: 0, bounds: { x0: 0, y0: 0, x1: 10, y1: 4 } }, { type: ItemType.stroke, index: 0, bounds: { x0: 0, y0: 0, x1: 10, y1: 4 } }, { type: ItemType.shape, index: 1, bounds: { x0: 0, y0: 0, x1: 10, y1: 4 } }],
	shapes: [
		{ x0: 0, y0: 0, x1: 4, y1: 2, kind: ShapeKind.rrect, colour: 8, colour2: 8, flags: 0, radius: 0.3, param: 0, chan: NO_CHAN, mixChan: NO_CHAN, aux: 0 },
		{ x0: 0, y0: 0, x1: 1, y1: 1, kind: ShapeKind.dot, colour: 8, colour2: 8, flags: 1, radius: 0.2, param: 0, chan: 0, mixChan: NO_CHAN, aux: 0 }
	],
	strokes: [{ firstSeg: 0, segCount: 1, width: 0.2, flags: 0, colour: 8, dashOn: 0, dashOff: 0, phaseChan: NO_CHAN, trimT0Chan: NO_CHAN, trimT1Chan: 1, widthChan: NO_CHAN, colour2: 0, mixChan: NO_CHAN }],
	segs: [{ x0: 0, y0: 0, x1: 5, y1: 4, x2: 10, y2: 0, cum: 0, len: 12 }],
	groups: [{ parent: -1, txChan: NO_CHAN, tyChan: NO_CHAN, rotChan: NO_CHAN, scaleChan: 0, opacityChan: NO_CHAN, tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: 0, pivotY: 0 }],
	chans: [{ firstKey: 0, keyCount: 2 }, { firstKey: 2, keyCount: 2 }],
	keys: [{ t: 0, v: 0, ease: 0 }, { t: 1, v: 1, ease: 0 }, { t: 0, v: 0, ease: 0 }, { t: 1, v: 1, ease: 0 }],
	figures: [{ id: 0, firstChan: 0, chanCount: 2, mode: 0, duration: 1, poster: 1, alt: 0, describe: 0, x0: 0, y0: 0, x1: 10, y1: 4 }]
});

const textFrag = (): Fragment => ({
	items: [{ type: ItemType.glyph, index: 0 }, { type: ItemType.rect, index: 0 }],
	glyphs: [{ x: 5, y: 6, glyphId: 0, size: 1, colour: 0, flags: 0, charOffset: 0 }],
	rects: [{ x0: 5, y0: 8, x1: 20, y1: 8.1, colour: 4, kind: 0 }],
	lines: [{ yTop: 4.4, yBot: 6, x0: 5, x1: 6, firstGlyph: 0, glyphCount: 1, charOffset: 0 }],
	links: [{ x0: 5, y0: 4, x1: 6, y1: 6, kind: 0, offset: 0 }],
	anchors: [{ idOffset: 0, y: 4 }]
});

describe('appendFragment rebases every index', () => {
	test('two figures and a text fragment compose with correct bases', () => {
		const s = newStore();
		appendFragment(s, textFrag(), 0);
		const f0 = placeFigure(figure(), 3, 4);
		const b1 = appendFragment(s, f0, 0);
		const b2 = appendFragment(s, placeFigure(figure(), 30, 4), 1);
		expect(b1).toMatchObject({ glyph: 1, shape: 0, stroke: 0, seg: 0, group: 0, chan: 0, key: 0 });
		expect(b2).toMatchObject({ shape: 2, stroke: 1, seg: 1, group: 2, chan: 2, key: 4 });
		// second figure: stroke -> its own segs, trim chan -> its own chans, dot rides its own stroke
		expect(s.strokes[1].firstSeg).toBe(1);
		expect(s.strokes[1].trimT1Chan).toBe(3);
		expect(s.strokes[1].group).toBe(2); // placement root group
		expect(s.shapes[3].aux).toBe(1); // dot -> stroke 1
		expect(s.shapes[3].chan).toBe(2);
		expect(s.shapes[2].chan).toBe(NO_CHAN); // constant stays constant
		expect(s.groups[3]).toMatchObject({ parent: 2, scaleChan: 2 });
		expect(s.chans[3].firstKey).toBe(6);
		expect(s.figures[1]).toMatchObject({ firstChan: 2, spread: 1, x0: 30, y1: 8 });
		expect(s.links[0].spread).toBe(0);
		// glyphs of the text fragment are not in a group
		expect(s.glyphs[0].group).toBe(NONE16);
		expect(itemIndex(0)).toBe(0);
	});

	test('placeFigure translates through a root group and moves bounds', () => {
		const p = placeFigure(figure(), 7, 9);
		expect(p.groups![0]).toMatchObject({ parent: -1, tx: 7, ty: 9 });
		expect(p.groups![1].parent).toBe(0);
		expect(p.shapes![0].group).toBe(0); // ungrouped items join the root
		expect(p.items[0].bounds).toEqual({ x0: 7, y0: 9, x1: 17, y1: 13 });
		// input untouched
		expect(figure().groups).toHaveLength(1);
	});
});

describe('emitMagazine', () => {
	const spreads = (): SpreadContent[] => [
		{ meta: meta(0), frag: concat([textFrag(), placeFigure(figure(), 10, 20)]) },
		{ meta: meta(1), frag: textFrag() }
	];
	function concat(parts: Fragment[]): Fragment {
		const s = newStore();
		for (const p of parts) appendFragment(s, p, 0);
		return s as unknown as Fragment;
	}

	test('packs to a valid RDR2 that round-trips with layers, grid cells and rebased links', () => {
		const r = emitMagazine(spreads(), ctx(), 'test');
		const back = unpackMagazine(r.bytes);
		expect(back.spreads).toHaveLength(2);
		expect(r.spreadLayers).toEqual([0, 1]);
		expect(back.spreads[1].x).toBeCloseTo(82);
		expect(back.spreads[0].gridCols).toBe(14);
		expect(back.spreads[0].gridRows).toBe(35);
		expect(back.cells).toHaveLength(2 * 14 * 35);
		expect(back.links.map((l) => l.spread)).toEqual([0, 1]);
		expect(back.figures[0].spread).toBe(0);
		// the glyph at (5,6) with a unit box lands in cell (0, 3) and (0,4): x 4..5 and y 5..6 -> cell col 0, rows 3
		const c = back.spreads[0];
		const cellAt = (cx: number, cy: number) => back.cells[c.firstCell + cy * c.gridCols + cx];
		const items = (cx: number, cy: number) => { const k = cellAt(cx, cy); return back.items.slice(k.start, k.start + k.count); };
		expect(items(0, 3).some((w) => itemType(w) === ItemType.glyph)).toBe(true);
		expect(items(13, 34)).toEqual([]);
		// the animated figure items are listed in the cells they sweep
		expect(items(2, 12 + 0).some((w) => itemType(w) === ItemType.stroke)).toBe(true);
	});

	test('deterministic: two emits are byte identical', () => {
		expect(Buffer.from(emitMagazine(spreads(), ctx(), 't').bytes).equals(Buffer.from(emitMagazine(spreads(), ctx(), 't').bytes))).toBe(true);
	});

	test('control: an animated item without swept bounds fails closed', () => {
		const f = placeFigure(figure(), 0, 0);
		f.items = f.items.map((it) => ({ type: it.type, index: it.index })); // drop bounds, items sit in the root group
		expect(() => emitMagazine([{ meta: meta(0), frag: f }], ctx(), 'ctl')).toThrow(/swept bounds/);
	});

	test('control: more than 24 animated items in one cell fails the build', () => {
		const f: Fragment = { items: [], shapes: [] };
		for (let i = 0; i < MAX_CELL_ITEMS + 1; i++) {
			f.shapes!.push({ x0: 1, y0: 1, x1: 2, y1: 2, kind: ShapeKind.circle, colour: 8, colour2: 8, flags: 0, radius: 0.1, param: 0, chan: 0, mixChan: NO_CHAN, aux: 0, group: NONE16 });
			f.items.push({ type: ItemType.shape, index: i, bounds: { x0: 1, y0: 1, x1: 2, y1: 2 } });
		}
		f.chans = [{ firstKey: 0, keyCount: 1 }]; f.keys = [{ t: 0, v: 0, ease: 0 }];
		expect(() => emitMagazine([{ meta: meta(0), frag: f }], ctx(), 'ctl')).toThrow(/animated items/);
	});

	test('control: an item index past its table fails', () => {
		expect(() => emitMagazine([{ meta: meta(0), frag: { items: [{ type: ItemType.rect, index: 3 }] } }], ctx(), 'ctl')).toThrow(/does not exist/);
	});

	test('template ids', () => {
		expect(templateId('duo')).toBe(0);
		expect(templateId('text-n')).toBe(4);
		expect(() => templateId('essay')).toThrow();
	});
});
