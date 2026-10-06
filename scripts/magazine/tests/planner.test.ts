import { describe, expect, test } from 'bun:test';
import { template } from '../../../src/lib/magazine/types';
import { GEOMETRY, HALF, LINE_H, lintSolved, parseTrack, solveRows, solveTemplate } from '../grid';
import { buildFrames, makeFrame, threads, locate, threadCapacity } from '../frames';
import { planFullText, planWithCopyfit, validatePlan, type FlowBlock, type Measurer, type Plan } from '../planner';
import { TEMPLATES, TEMPLATE_IDS } from '../templates';

const on = (v: number, step: number) => Math.abs(v / step - Math.round(v / step)) < 1e-6;

describe('track solver', () => {
	test('track syntax', () => {
		expect(parseTrack('3b')).toEqual({ kind: 'fixed', em: 4.8 });
		expect(parseTrack('12em')).toEqual({ kind: 'fixed', em: 12 });
		expect(parseTrack('2fr')).toEqual({ kind: 'fr', n: 2 });
		expect(parseTrack('fit')).toEqual({ kind: 'fit' });
		expect(() => parseTrack('3x')).toThrow();
	});
	test('fixed first, fr shares the rest on half baselines, rows sum to the sheet', () => {
		const h = solveRows(['3b', 'fr', '2fr', '4b'], 56);
		expect(h.reduce((a, b) => a + b, 0)).toBeCloseTo(56, 6);
		for (const v of h) expect(on(v, HALF)).toBe(true);
		expect(h[2]).toBeGreaterThan(h[1]);
	});
	test('fit takes content height; an unfilled sum is an error', () => {
		expect(solveRows(['3b', 'fit', 'fr'], 56, [0, 8])[1]).toBe(8);
		expect(() => solveRows(['3b', '4b'], 56)).toThrow();
		expect(() => solveRows(['40b'], 56)).toThrow();
	});
	test('column edges: 6 columns per sheet, live width 32, spine gap 7 em', () => {
		const g = GEOMETRY.wide;
		const s = solveTemplate(TEMPLATES.text, 'wide');
		expect(s.colX).toHaveLength(12);
		expect(s.colX[0][0]).toBeCloseTo(4.5, 6);
		expect(s.colX[5][1]).toBeCloseTo(36.5, 6);
		expect(s.colX[6][0]).toBeCloseTo(43.5, 6);
		expect(s.colX[11][1]).toBeCloseTo(75.5, 6);
		expect(s.colX[1][0] - s.colX[0][1]).toBeCloseTo(g.gutter, 6);
		expect(s.colX[2][1] - s.colX[0][0]).toBeCloseTo(15.4, 1); // 3 columns
	});
});

describe('templates', () => {
	for (const id of TEMPLATE_IDS) for (const cls of ['wide', 'narrow'] as const) {
		test(`${id}/${cls} solves and lints clean`, () => {
			const s = solveTemplate(TEMPLATES[id], cls);
			expect(lintSolved(s)).toEqual([]);
			expect(s.rowY[s.rowY.length - 1][1]).toBeCloseTo(56, 6);
			expect(Object.keys(s.areas).length).toBeGreaterThanOrEqual(3);
		});
	}
	test('duo geometry: headline left, deck right, figures bleed to the edges', () => {
		const s = solveTemplate(TEMPLATES.duo, 'wide');
		expect(s.areas.H.rect.x1).toBeLessThan(40);
		expect(s.areas.D.rect.x0).toBeGreaterThan(40);
		expect(s.areas.A.rect.x0).toBe(0);
		expect(s.areas.B.rect.x1).toBe(80);
		expect(s.areas.Q.rect.x0).toBeGreaterThan(40);
	});
	test('solo figure is a full-bleed underlay', () => {
		const s = solveTemplate(TEMPLATES.solo, 'wide');
		expect(s.areas.Z.underlay).toBe(true);
		expect(s.areas.Z.rect).toEqual({ x0: 0, y0: 0, x1: 80, y1: 56 });
	});
	test('control: overlapping areas, spine-crossing captions and non-rectangles fail', () => {
		const slot = { type: 'caption' as const };
		const bad = template('bad', { cols: 12, rows: ['3b', 'fr'], areas: `. . . . . . | . . . . . .\n a a a a a a | a a a a a a`, slots: { a: slot }, fit: { tracking: [0, 0], maxStretch: 1 } });
		expect(lintSolved(solveTemplate(bad, 'wide')).join()).toContain('crosses the spine');
		const hole = template('hole', { cols: 12, rows: ['3b', 'fr'], areas: `a a a a a a | . . . . . .\n a . a a a a | . . . . . .`, slots: { a: { type: 'body' } }, fit: { tracking: [0, 0], maxStretch: 1 } });
		expect(() => solveTemplate(hole, 'wide')).toThrow('not a rectangle');
		const over = template('over', {
			cols: 12, rows: ['3b', 'fr'], areas: `a a a a a a | . . . . . .\n a a a a a a | . . . . . .`,
			slots: { a: { type: 'body', bleed: ['right'] } }, fit: { tracking: [0, 0], maxStretch: 1 }
		});
		const o = solveTemplate(over, 'wide');
		o.areas.b = { ...o.areas.a, letter: 'b' };
		o.order.push('b');
		expect(lintSolved(o).join()).toContain('overlap');
		const spine = template('spine', { cols: 12, rows: ['3b', 'fr'], areas: `a a a a a a a | . . . . .\n .`, slots: { a: { type: 'body' } }, fit: { tracking: [0, 0], maxStretch: 1 } });
		expect(() => solveTemplate(spine, 'wide')).toThrow();
	});
});

describe('frames', () => {
	test('every baseline of every frame is a multiple of 1.6 em', () => {
		for (const id of ['text', 'text-code'] as const) for (const cls of ['wide', 'narrow'] as const) {
			for (const f of buildFrames(solveTemplate(TEMPLATES[id], cls))) {
				expect(f.lines).toBeGreaterThan(8);
				for (let i = 0; i < f.lines; i++) expect(on(f.baseline(i), LINE_H)).toBe(true);
				expect(f.baseline(f.lines - 1) + 0.4).toBeLessThanOrEqual(f.rect.y1 + 1e-6);
				expect(f.baseline(f.lines) + 0.4).toBeGreaterThan(f.rect.y1);
			}
		}
	});
	test('control: a shifted baseline fails the grid test', () => {
		expect(on(makeFrame(0, 'x', { x0: 0, y0: 5, x1: 10, y1: 50 }, 0, 0).baseline(3) + 0.3, LINE_H)).toBe(false);
	});
	test('text threads read A B C D left to right; text-code has prose and code threads', () => {
		const t = threads(buildFrames(solveTemplate(TEMPLATES.text, 'wide')));
		expect(t.get(0)!.map((f) => f.slot)).toEqual(['A', 'B', 'C', 'D']);
		const tc = threads(buildFrames(solveTemplate(TEMPLATES['text-code'], 'wide')));
		expect(tc.get(0)!.map((f) => f.slot)).toEqual(['A', 'B']);
		expect(tc.get(1)!.map((f) => f.slot)).toEqual(['C', 'D']);
		const th = t.get(0)!;
		expect(locate(th, th[0].lines)!.frame.slot).toBe('B');
		expect(locate(th, threadCapacity(th))).toBeNull();
	});
	test('interval: exclusions carve the line from the left, right or the larger side; blocked lines are null', () => {
		const f = makeFrame(0, 'A', { x0: 4.5, y0: 4.8, x1: 19.9, y1: 49.6 }, 0, 0);
		expect(f.interval(0)).toEqual([4.5, 19.9]);
		f.exclude({ x0: 4.5, x1: 9.5, y0: 0, y1: f.baseline(2) });
		expect(f.interval(0)![0]).toBeCloseTo(10, 6);
		expect(f.interval(3)).toEqual([4.5, 19.9]);
		f.exclude({ x0: 18, x1: 30, y0: f.baseline(5) - 1, y1: f.baseline(5) });
		expect(f.interval(5)![1]).toBeCloseTo(17.5, 6);
		f.exclude({ x0: 0, x1: 40, y0: f.baseline(8) - 1, y1: f.baseline(8) });
		expect(f.interval(8)).toBeNull();
		expect(f.interval(-1)).toBeNull();
		expect(f.interval(f.lines)).toBeNull();
	});
});

// ---- planner -------------------------------------------------------------------------------------

const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };

const codes = new Map<string, number>();
function article(seed: number, n: number, withCode: boolean): { blocks: FlowBlock[]; chars: Map<string, number> } {
	const r = rng(seed);
	const blocks: FlowBlock[] = [];
	const chars = new Map<string, number>();
	for (let i = 0; i < n; i++) {
		if (i % 7 === 0) { const id = `h${i}`; blocks.push({ id, kind: 'heading' }); chars.set(id, 40); continue; }
		if (withCode && i % 9 === 4) { const id = `c${i}`; blocks.push({ id, kind: 'code' }); codes.set(id, 6 + Math.floor(r() * 20)); continue; }
		if (i % 11 === 5) { blocks.push({ id: `f${i}`, kind: 'figure', place: i % 2 ? 'wide' : 'column', w: 36, h: 20, captionLines: 2, ref: i - 1 }); continue; }
		const id = `p${i}`; blocks.push({ id, kind: 'para' }); chars.set(id, 200 + Math.floor(r() * 900));
	}
	return { blocks, chars };
}
const measurer = (chars: Map<string, number>): Measurer => (b, w, o) => {
	if (b.kind === 'code') return codes.get(b.id) ?? 6;
	const c = chars.get(b.id) ?? 100;
	return Math.max(1, Math.ceil((c * (1 + o.tracking)) / (w * 2.1)) + o.looseness);
};

describe('planner', () => {
	for (const cls of ['wide', 'narrow'] as const) {
		test(`${cls}: a 60-block article with code and figures plans with no violations, deterministically`, () => {
			const { blocks, chars } = article(7, 60, true);
			const plan = planFullText(blocks, { cls, measure: measurer(chars) });
			expect(validatePlan(plan, blocks)).toEqual([]);
			const again = planFullText(blocks, { cls, measure: measurer(chars) });
			expect(JSON.stringify(plan.spreads.map((s) => [s.template, s.placements]))).toBe(JSON.stringify(again.spreads.map((s) => [s.template, s.placements])));
			expect(plan.spreads[0].index).toBe(1);
			if (cls === 'wide') expect(plan.spreads.some((s) => s.template === 'text-code')).toBe(true);
			for (const s of plan.spreads) if (s.template === 'text') expect(s.placements.every((p) => p.kind !== 'code' || p.lineCount < 4)).toBe(true);
		});
	}
	test('plain prose uses only text spreads and every paragraph line is placed', () => {
		const { blocks, chars } = article(3, 40, false);
		const m = measurer(chars);
		const plan = planFullText(blocks.filter((b) => b.kind !== 'figure'), { cls: 'wide', measure: m });
		expect(plan.spreads.every((s) => s.template === 'text')).toBe(true);
		const w = plan.spreads[0].frames[0].width;
		const placed = new Map<string, number>();
		for (const s of plan.spreads) for (const p of s.placements) placed.set(p.block, (placed.get(p.block) ?? 0) + p.lineCount);
		for (const b of blocks) if (b.kind === 'para') expect(placed.get(b.id)).toBe(m(b, w, { tracking: 0, looseness: 0 }));
	});
	test('wide figure reserves lines in both frames of a sheet via exclusions', () => {
		const blocks: FlowBlock[] = [
			{ id: 'f', kind: 'figure', place: 'wide', w: 36, h: 20, captionLines: 2 },
			{ id: 'p', kind: 'para' }
		];
		const plan = planFullText(blocks, { cls: 'wide', measure: () => 60 });
		const s = plan.spreads[0];
		const fig = s.placements.find((p) => p.kind === 'figure')!;
		expect(fig.rect!.x1 - fig.rect!.x0).toBeGreaterThan(30);
		expect(s.frames[0].interval(0)).toBeNull();
		expect(s.frames[1].interval(0)).toBeNull();
		expect(s.frames[1].interval(fig.lineCount + 1)).not.toBeNull();
		expect(validatePlan(plan, blocks)).toEqual([]);
	});
	test('a figure that does not fit floats to the next frame top and the text flows on', () => {
		const blocks: FlowBlock[] = [
			{ id: 'p1', kind: 'para' },
			{ id: 'fig', kind: 'figure', place: 'column', w: 10, h: 10, captionLines: 2 },
			{ id: 'p2', kind: 'para' }
		];
		// p1 leaves 3 lines in frame A, the figure needs more
		const lines = (b: FlowBlock) => (b.id === 'p1' ? 24 : 12);
		const plan = planFullText(blocks, { cls: 'wide', measure: (b) => lines(b) });
		const ps = plan.spreads[0].placements;
		const f = ps.find((p) => p.kind === 'figure')!;
		expect(f.startLine).toBe(0);
		expect(f.frame).toBe(plan.spreads[0].frames[1].id);
		expect(ps.find((p) => p.block === 'p2')!.blockIndex).toBe(2);
	});
	test('control: widow, orphan, heading-at-bottom and a missing block are caught by validatePlan', () => {
		const { blocks, chars } = article(9, 30, false);
		const plan = planFullText(blocks, { cls: 'wide', measure: measurer(chars) });
		expect(validatePlan(plan, blocks)).toEqual([]);
		const bad: Plan = JSON.parse(JSON.stringify({ ...plan, spreads: plan.spreads.map((s) => ({ ...s, frames: s.frames, solved: s.solved })) }));
		// restore frame functions (JSON drops them)
		bad.spreads.forEach((s, i) => { s.frames = plan.spreads[i].frames; s.solved = plan.spreads[i].solved; });
		// widow: shrink the last piece of the first split paragraph to 1 line
		const split = bad.spreads.flatMap((s) => s.placements).filter((p) => p.kind === 'para');
		const byBlock = new Map<number, typeof split>();
		for (const p of split) byBlock.set(p.blockIndex, [...(byBlock.get(p.blockIndex) ?? []), p]);
		const multi = [...byBlock.values()].find((v) => v.length > 1)!;
		expect(multi).toBeTruthy();
		multi[multi.length - 1].lineCount = 1;
		expect(validatePlan(bad, blocks).join()).toContain('widow');
		multi[multi.length - 1].lineCount = 5;
		multi[0].lineCount = 1;
		expect(validatePlan(bad, blocks).join()).toContain('orphan');
		bad.spreads[0].placements = bad.spreads[0].placements.slice(1);
		expect(validatePlan(bad, blocks).join()).toContain('never placed');
		const h = plan.spreads[0].placements.find((p) => p.kind === 'heading')!;
		const hb: Plan = { ...plan, spreads: [{ ...plan.spreads[0], placements: plan.spreads[0].placements.map((p) => (p === h ? { ...p, startLine: plan.spreads[0].frames.find((f) => f.id === p.frame)!.lines - 1 } : p)) }, ...plan.spreads.slice(1)] };
		expect(validatePlan(hb, blocks).join()).toContain('heading');
	});
	test('control: a figure placed two spreads from its reference is reported', () => {
		const blocks: FlowBlock[] = [{ id: 'p0', kind: 'para' }];
		for (let i = 1; i < 12; i++) blocks.push({ id: `p${i}`, kind: 'para' });
		blocks.push({ id: 'fig', kind: 'figure', place: 'column', w: 10, h: 10, captionLines: 1, ref: 0 });
		const plan = planFullText(blocks, { cls: 'wide', measure: () => 40 });
		expect(plan.violations.join()).toContain('spreads after its first reference');
	});
	test('copyfit pulls a nearly empty last spread back by tightening tracking', () => {
		// 4 frames * 27 lines = 108 lines per spread. Tune the total to overflow by 2 lines at neutral tracking.
		const blocks: FlowBlock[] = [];
		for (let i = 0; i < 12; i++) blocks.push({ id: `p${i}`, kind: 'para' });
		const m: Measurer = (_b, _w, o) => Math.ceil(9.1 * (1 + o.tracking * 80));
		const plain = planFullText(blocks, { cls: 'wide', measure: m });
		expect(plain.spreads).toHaveLength(2);
		expect(plain.underflow).toBe(true);
		const fitted = planWithCopyfit(blocks, { cls: 'wide', measure: m });
		expect(fitted.spreads).toHaveLength(1);
		expect(fitted.fit.tracking).toBeLessThan(0);
		expect(validatePlan(fitted, blocks)).toEqual([]);
	});
});
