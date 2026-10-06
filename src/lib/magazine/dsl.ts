// Figure DSL (docs/MAGAZINE.md 2.4): pure builders that return plain data. Authors write
// `figures.ts` against these; the `fig` lane compiles the result (scripts/magazine/fig/) to the RDR2
// item kinds. Builders only normalise and validate shape; they do no geometry.

import type { EaseName, FigureTime, PaletteName, Vec2 } from './types';

export type { PaletteName };

export type ColorRef = PaletteName | { mix: [PaletteName, PaletteName]; chan: string };

export interface StrokeSpec {
	w: number; // em
	color: ColorRef;
	dash?: readonly [number, number]; // on, off in em
	cap?: 'round' | 'butt' | 'square';
	join?: 'round' | 'bevel';
}

interface Base {
	id: string;
	group?: string;
	label?: string;
}

export interface RRectNode extends Base { kind: 'rrect'; at: Vec2; size: Vec2; radius: number; fill: ColorRef | 'none'; stroke?: StrokeSpec; hatch?: boolean }
export interface CircleNode extends Base { kind: 'circle'; at: Vec2; r: number; fill: ColorRef | 'none'; stroke?: StrokeSpec }
export interface TextNode extends Base { kind: 'text'; text: string; at: Vec2; font: 'body' | 'label' | 'code' | 'display'; size: number; color: ColorRef; align: 'left' | 'center' | 'right' }
export interface ArrowNode extends Base { kind: 'arrow'; path: string; stroke: StrokeSpec; head: boolean }
export interface DotsNode extends Base { kind: 'dots'; along?: string; count: number; stagger: number; r: number; color: ColorRef; seed?: number; scatter?: { rect: [number, number, number, number]; seed: number } }
export interface NumeralNode extends Base { kind: 'numeral'; at: Vec2; digits: number; size: number; color: ColorRef; style: 'fill' | 'outline' }
export type FigNode = RRectNode | CircleNode | TextNode | ArrowNode | DotsNode | NumeralNode;

export interface PathSpec { id: string; d: string; fill?: ColorRef; stroke?: StrokeSpec; evenOdd?: boolean; group?: string }
export interface GroupSpec { id: string; parent?: string; pivot?: Vec2 }

/** Target is "<id>.<prop>" with prop in at.x at.y size.x size.y scale rot opacity trim.t0 trim.t1 phase width mix value u x y. */
export interface Track { target: string; keys: readonly (readonly [number, number])[]; ease: EaseName | readonly EaseName[] }

export interface DagreLayout { engine: 'dagre'; rankdir: 'LR' | 'TB' | 'RL' | 'BT'; ranksep: number; nodesep: number }

export interface FigureSpec {
	size: Vec2;
	time: FigureTime;
	describe: string; // >= 40 chars, required
	alt: string; // required
	palette?: Record<string, PaletteName>;
	layout?: DagreLayout;
	nodes: FigNode[];
	paths?: PathSpec[];
	groups?: GroupSpec[];
	tracks?: Track[];
}

export type FigureSet = Record<string, FigureSpec>;

// ---- builders ------------------------------------------------------------------------------------

type Opt<T extends Base> = Partial<Omit<T, 'kind' | 'id'>>;

export const rrect = (id: string, o: { at: Vec2; size: Vec2; fill: ColorRef | 'none' } & Opt<RRectNode>): RRectNode =>
	({ kind: 'rrect', id, radius: 0.4, ...o });

export const circle = (id: string, o: { at: Vec2; r: number; fill: ColorRef | 'none' } & Opt<CircleNode>): CircleNode =>
	({ kind: 'circle', id, ...o });

export const text = (s: string, o: { at: Vec2; id?: string } & Opt<TextNode>): TextNode =>
	({ kind: 'text', id: o.id ?? `t:${s}`, text: s, font: 'label', size: 0.78, color: 'ink', align: 'left', ...o });

export const arrow = (id: string, d: string, stroke: StrokeSpec, o: Opt<ArrowNode> = {}): ArrowNode =>
	({ kind: 'arrow', id, path: d, stroke, head: true, ...o });

export const dots = (id: string, o: { count: number; r: number; color: ColorRef } & Opt<DotsNode>): DotsNode => {
	if (o.count < 1 || o.count > 32 * 64) throw new Error(`dots ${id}: count out of range`);
	return { kind: 'dots', id, stagger: 0, ...o };
};

export const numeral = (id: string, o: { at: Vec2; digits: number; size: number; color: ColorRef } & Opt<NumeralNode>): NumeralNode =>
	({ kind: 'numeral', id, style: 'fill', ...o });

export const path = (id: string, d: string, o: Omit<PathSpec, 'id' | 'd'> = {}): PathSpec => ({ id, d, ...o });

export const group = (id: string, o: Omit<GroupSpec, 'id'> = {}): GroupSpec => ({ id, ...o });

export function track(target: string, keys: Track['keys'], ease: Track['ease'] = 'linear'): Track {
	if (keys.length < 2) throw new Error(`track ${target}: needs at least 2 keys`);
	for (let i = 1; i < keys.length; i++) if (keys[i][0] < keys[i - 1][0]) throw new Error(`track ${target}: key times must not decrease`);
	if (Array.isArray(ease) && ease.length !== keys.length - 1) throw new Error(`track ${target}: one ease per segment`);
	return { target, keys, ease };
}

/** Identity with the lint the builders can do without geometry. */
export function figure(spec: FigureSpec): FigureSpec {
	if (spec.describe.length < 40) throw new Error('figure: describe must be at least 40 characters');
	if (!spec.alt) throw new Error('figure: alt is required');
	if (spec.time.poster < 0 || spec.time.poster > spec.time.duration) throw new Error('figure: poster must lie within the duration');
	const ids = new Set<string>();
	for (const n of [...spec.nodes, ...(spec.paths ?? [])]) {
		if (ids.has(n.id)) throw new Error(`figure: duplicate id ${n.id}`);
		ids.add(n.id);
	}
	return spec;
}

/** Seeded rng for figures.ts (the build provides no Math.random or Date there). mulberry32. */
export function rng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ---- compiler (scripts/magazine/fig/) ------------------------------------------------------------
// Re-exported so `$lib/magazine/dsl` is the one import figures.ts and tests need. Node-side only: the browser never
// imports this file (figures.ts is read by the build).
export { compileFigure } from '../../../scripts/magazine/fig/compile';
export { lintFigure } from '../../../scripts/magazine/fig/lint';
