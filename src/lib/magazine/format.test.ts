import { describe, expect, test } from 'bun:test';
import {
	ARTICLE2_MAGIC, ItemType, PALETTE2_SIZE, REC2, ShapeKind, NO_CHAN, NONE16, packItem, itemType, itemIndex,
	packMagazine, unpackMagazine, unpackContainer, roundF16, sampleMagazine
} from './format';
import { TEMPLATE_NAMES, templateId, templateLayer, LAYER, DISTILL_LIMITS, type Distill } from './types';
import { figure, rrect, track, text, path, compileFigure } from './dsl';

const model = sampleMagazine;

describe('RDR2', () => {
	test('record sizes are 4-aligned and stable', () => {
		for (const [k, v] of Object.entries(REC2)) expect(v % 4, k).toBe(0);
		expect(REC2).toMatchObject({ spread: 44, glyph: 24, rect: 20, shape: 36, stroke: 32, seg: 32, group: 44, figure: 64, cell: 8 });
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
		expect(back.spreads.map((s) => s.layer)).toEqual([0, 1]);
		expect(back.spreads.map((s) => s.template)).toEqual([templateId('duo'), templateId('text')]);
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
		expect(back.cells.map((x) => [x.start, x.count])).toEqual([[0, 4], [4, 0], [4, 0], [4, 0]]);
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

describe('templates and distill contract', () => {
	test('six names, layers, narrow ids', () => {
		expect([...TEMPLATE_NAMES]).toEqual(['duo', 'solo', 'compare', 'numerals', 'text', 'text-code']);
		expect(templateLayer('duo')).toBe(LAYER.distilled);
		expect(templateLayer('text-code')).toBe(LAYER.full);
		expect(templateId('text', true)).toBe(templateId('text') + 16);
		expect(DISTILL_LIMITS.captions).toBe(3);
	});
	test('Distill is the 1.7 shape', () => {
		const d: Distill = { template: 'duo', headline: 'IFD is fine', figures: ['eval-timeline', 'eval-graph'], captions: [], synth: [] };
		expect(d.review).toBeUndefined();
	});
	test('control: a layer-less spread record packs as distilled, a full one survives', () => {
		const m = sampleMagazine();
		const { layer: _l, ...rest } = m.spreads[1];
		const back = unpackMagazine(packMagazine({ ...m, spreads: [m.spreads[0], rest as typeof m.spreads[0]] }));
		expect(back.spreads[1].layer).toBe(0);
		expect(unpackMagazine(packMagazine(m)).spreads[1].layer).toBe(1);
	});
});
