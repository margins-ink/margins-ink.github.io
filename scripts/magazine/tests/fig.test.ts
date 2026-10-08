import { describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as dsl from '../../../src/lib/magazine/dsl';
import { evalKeys, evalChannels, figureTime } from '../../../src/lib/magazine/chan';
import { compileFigure } from '../fig/compile';
import { lintFigure } from '../fig/lint';

const { figure, rrect, text, path, track } = dsl;
const ROOT = resolve(import.meta.dir, '../../..');

mock.module('$lib/magazine/dsl', () => dsl); // the SvelteKit alias does not exist under bun test

const base = (over: Partial<dsl.FigureSpec> = {}) =>
	figure({
		size: [20, 10], time: { duration: 4, mode: 'loop', poster: 3 },
		describe: 'A small test figure with a box that grows and a line that draws on.', alt: 'test',
		nodes: [rrect('a', { at: [2, 2], size: [4, 2], fill: 'accent', label: 'eval' }), text('hello', { id: 'h', at: [2, 8] })],
		paths: [path('p', 'M 2 6 L 12 6', { stroke: { w: 0.1, color: 'ink' } })],
		tracks: [track('a.size.x', [[0, 0], [2, 4]], 'outCubic'), track('p.trim.t1', [[0, 0], [2, 1]], 'linear')],
		...over
	});

describe('chan', () => {
	test('holds ends, interpolates, eases per segment, step holds', () => {
		const k = [{ t: 0, v: 0, ease: 'linear' as const }, { t: 2, v: 10, ease: 'linear' as const }, { t: 4, v: 20, ease: 'step' as const }];
		expect(evalKeys(k, -1)).toBe(0);
		expect(evalKeys(k, 1)).toBe(5);
		expect(evalKeys(k, 3)).toBe(10); // step: holds the previous value until t = 4
		expect(evalKeys(k, 9)).toBe(20);
		const out = new Float32Array(1);
		evalChannels([{ keys: k }], 1, out);
		expect(out[0]).toBe(5);
		expect(figureTime('loop', 13, 12, 9)).toBe(1);
		expect(figureTime('static', 3, 12, 9)).toBe(9);
	});
});

describe('compileFigure and lintFigure', () => {
	test('compiles, sweeps bounds and lints clean', () => {
		const f = compileFigure('t', base());
		expect(f.channels.map((c) => c.target)).toEqual(['a.size.x', 'p.trim.t1']);
		expect(f.channels[0].keys[1].ease).toBe('outCubic');
		const a = f.items.find((i) => i.id === 'a')!;
		expect(a.poster.x1 - a.poster.x0).toBeCloseTo(4);
		expect(a.swept.x1).toBeCloseTo(6);
		expect(lintFigure(f)).toEqual([]);
	});

	test('control: bad targets and mix channels are compile errors', () => {
		expect(() => compileFigure('t', base({ tracks: [track('nope.size.x', [[0, 0], [1, 1]])] }))).toThrow('names no node');
		expect(() => compileFigure('t', base({ tracks: [track('a.trim.t1', [[0, 0], [1, 1]])] }))).toThrow('no animatable property');
		expect(() => compileFigure('t', base({ nodes: [rrect('a', { at: [0, 0], size: [1, 1], fill: { mix: ['muted', 'accent'], chan: 'a.mix' } })] }))).toThrow('has no track');
		expect(() => compileFigure('t', base({ tracks: [track('a.size.x', [[0, 0], [9, 1]])] }))).toThrow('outside');
	});

	test('control: a label left of the box, or a swept leak, fails', () => {
		const out = compileFigure('t', base({ nodes: [text('hello', { id: 'h', at: [-3, 8] })], paths: [], tracks: [] }));
		expect(lintFigure(out).join('\n')).toContain('leaves the 20x10 em box');
		const leak = compileFigure('t', base({ nodes: [rrect('a', { at: [2, 2], size: [4, 2], fill: 'accent' })], paths: [], tracks: [track('a.at.x', [[0, 2], [2, 18]], 'linear')] }));
		expect(lintFigure(leak).join('\n')).toContain('during the timeline'); // 18 + 4 > 20
	});

	test('control: overlapping text, a too-wide label fail, hidden text is ignored', () => {
		const t = (id: string, x: number) => text('overlap', { id, at: [x, 5] });
		expect(lintFigure(compileFigure('t', base({ nodes: [t('x', 2), t('y', 3)], paths: [], tracks: [] }))).join('\n')).toContain('overlaps');
		const hidden = compileFigure('t', base({ nodes: [t('x', 2), t('y', 3)], paths: [], tracks: [track('x.opacity', [[0, 1], [2, 0]], 'linear')] }));
		expect(lintFigure(hidden).join('\n')).not.toContain('overlaps'); // a text that has faded by poster is not read
		const wide = compileFigure('t', base({ nodes: [rrect('a', { at: [2, 2], size: [1, 2], fill: 'accent', label: 'a very long label' })], paths: [], tracks: [] }));
		expect(lintFigure(wide).join('\n')).toContain('wider than its shape');
	});

	test('control: an undrawn stroke at poster and a decreasing draw-on fail', () => {
		const undrawn = compileFigure('t', base({ tracks: [track('p.trim.t1', [[0, 0], [4, 0.5]], 'linear')] }));
		expect(lintFigure(undrawn).join('\n')).toContain('not fully drawn at poster');
		const back = compileFigure('t', base({ tracks: [track('p.trim.t1', [[0, 1], [2, 0]], 'linear')] }));
		expect(lintFigure(back).join('\n')).toContain('must not decrease');
	});

	test('control: more than 48 items in one cell fails', () => {
		const many = Array.from({ length: 60 }, (_, i) => rrect(`r${i}`, { at: [1, 1], size: [1, 1], fill: 'ink' }));
		const f = compileFigure('t', base({ nodes: many, paths: [], tracks: [] }));
		expect(lintFigure(f).join('\n')).toContain('the cap is 48');
	});

	test('control: describe under 40 chars is rejected by the builder and by lint', () => {
		const f = compileFigure('t', base());
		expect(lintFigure({ ...f, describe: 'short' }).join('\n')).toContain('describe');
	});
});

// ---- figure colour contrast: every shape, stroke and label colour of every figure of every article, against what it is drawn on ----
import { readdirSync, existsSync } from 'node:fs';
import { figureContrast, SHAPE_MIN, TEXT_MIN } from '../fig/contrast';
import { paletteEntries } from '../palette';
import { contrast, fromRgb, ok, quant, toHex, NEUTRAL, TINT_HUE } from '../../../src/lib/reading/theme';

const thoughts = `${ROOT}/src/routes/(site)/thoughts`;
const all: [string, dsl.FigureSet][] = [];
for (const d of readdirSync(thoughts)) if (existsSync(`${thoughts}/${d}/exhibits/art.ts`)) all.push([d, (await import(`${thoughts}/${d}/exhibits/art.ts`)).default as dsl.FigureSet]);

describe('figure contrast', () => {
	test('every figure of every article clears the floors (shapes 1.5:1, strokes and text 4.5:1, labels on their fill 4.5:1)', () => {
		expect(all.length).toBeGreaterThan(0);
		for (const [slug, set] of all) for (const [id, spec] of Object.entries(set)) expect(figureContrast(`${slug}/${id}`, spec)).toEqual([]);
	});

	test('the figure neutrals are visible on the ground and carry ink', () => {
		const p = paletteEntries();
		for (const n of ['neutral1', 'neutral2', 'neutral3'] as const) expect(contrast(p[n], p.paper)).toBeGreaterThanOrEqual(SHAPE_MIN);
		for (const n of ['neutral1', 'neutral2'] as const) expect(contrast(p.ink, p[n])).toBeGreaterThanOrEqual(TEXT_MIN);
		expect(toHex(p.paper)).not.toBe('#000000');
	});

	// planted-bug control: the values the reader shipped with (neutral3 at the ground's own lightness, bright grey `muted` fills with paper labels
	// that read fine only by luck, linear colour on an sRGB canvas) must fail the same check
	test('control: the old invisible neutral and a ground-coloured fill fail', () => {
		const p = paletteEntries();
		const oldNeutral3 = quant(ok(0.15, NEUTRAL.C, TINT_HUE));
		const planted = { ...p, neutral3: oldNeutral3 };
		const spec = base({ nodes: [rrect('bar', { at: [2, 2], size: [6, 1], fill: 'neutral3' })], paths: [], tracks: [] });
		expect(figureContrast('ctl', spec, p).filter((m) => m.includes('bar fill'))).toHaveLength(0);
		expect(figureContrast('ctl', spec, planted).filter((m) => m.includes('bar fill'))).toHaveLength(1);
		// the screenshot's colours: linear values shown as sRGB turn ground L 0.15 into near black and the bars into the ground
		const dark: [number, number, number] = [0.012, 0.014, 0.02];
		expect(contrast(dark, [0, 0, 0])).toBeLessThan(SHAPE_MIN);
		// and a label colour that fails on its fill is caught
		const bad = base({ nodes: [rrect('b', { at: [2, 2], size: [6, 2], fill: 'neutral2', label: 'x' })], paths: [], tracks: [] });
		expect(figureContrast('ctl', bad, { ...p, ink: p.neutral2 }).some((m) => m.includes('label'))).toBe(true);
		void fromRgb;
	});
});
