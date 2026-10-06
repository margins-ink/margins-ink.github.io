// Shared authoring-side types for the magazine pipeline (docs/MAGAZINE.md). Types plus the pure
// `template()` builder; no node imports. Binary records live in ./format.ts, the figure DSL in ./dsl.ts.

import type { EaseName, PaletteName } from './format';

export type { EaseName, PaletteName };

export type Vec2 = readonly [number, number];
export interface Rect { x0: number; y0: number; x1: number; y1: number }

// ---- channels and figures (compiled form) --------------------------------------------------------

/** One keyframe: time in seconds, value, and the ease used from the previous key to this one. */
export interface Keyframe { t: number; v: number; ease: EaseName }

/** A named scalar over time. `target` is "<node id>.<property>", e.g. "e1.size.x", "wall.trim.t1". */
export interface Channel { id: number; target: string; keys: Keyframe[] }

export type FigureMode = 'loop' | 'once' | 'scrub' | 'static';

export interface FigureTime { duration: number; mode: FigureMode; poster: number }

/** A figure after compilation: what the writer in format.ts needs, plus lint inputs. */
export interface CompiledFigure {
	id: string;
	size: Vec2; // em
	time: FigureTime;
	describe: string;
	alt: string;
	channels: Channel[];
	/** swept bounds over the whole timeline, em, in figure space */
	bounds: Rect;
}

// ---- templates -----------------------------------------------------------------------------------

export type SlotType = 'head' | 'deck' | 'byline' | 'body' | 'figure' | 'pullquote' | 'numeral' | 'aside' | 'caption' | 'code' | 'folio' | 'rule' | 'field';
export type FontRole = 'body' | 'display' | 'pullquote' | 'numeral' | 'label' | 'code';
export type Side = 'top' | 'right' | 'bottom' | 'left';

export interface Slot {
	type: SlotType;
	font?: FontRole;
	size?: number; // em of body
	thread?: number; // body slots with the same thread are one flow, left to right, top to bottom
	align?: 'justify' | 'left' | 'center' | 'right';
	hyphenate?: boolean;
	dropcap?: { lines: number; style?: 'drop' | 'inline' | 'raised' };
	bleed?: Side[];
	/** run-around contour for neighbours */
	shape?: 'rect' | 'wrap';
	fill?: string[]; // underflow candidates (ids of authored pullquotes / numerals)
}

export interface FitRanges {
	leading?: [number, number];
	tracking: [number, number];
	maxStretch: number;
}

/** Track size: 'fr' shares the rest, 'fit' takes content height, '3b' is 3 baselines, '12em' is fixed em. */
export type TrackSize = string;

export interface TemplateDef {
	/** columns per sheet pair; 12 for a spread, 6 for a narrow single sheet */
	cols: number;
	rows: TrackSize[];
	/** character map over the cols x rows grid, whitespace separated; '|' marks the spine, '.' is empty */
	areas: string;
	slots: Record<string, Slot>;
	fit: FitRanges;
	/** narrow (portrait) variant, same slot names, different areas */
	narrow?: Pick<TemplateDef, 'cols' | 'rows' | 'areas'>;
}

export interface Template extends TemplateDef { name: string }

export const template = (name: string, def: TemplateDef): Template => {
	const letters = new Set(def.areas.split(/\s+/).filter((c) => c && c !== '|' && c !== '.'));
	for (const l of letters) if (!def.slots[l]) throw new Error(`template ${name}: area '${l}' has no slot`);
	return { name, ...def };
};

export const TEMPLATE_NAMES = [
	'opener', 'essay', 'feature', 'lead-figure', 'wide-figure', 'pullquote-break',
	'data-wall', 'code-spread', 'sidebar', 'split-compare', 'gallery', 'closer'
] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];

// ---- voices, rhythm, sidecar ---------------------------------------------------------------------

export type RhythmPreset = 'andante' | 'staccato' | 'crescendo' | 'essay' | 'auto';

export interface FrauncesAxes { wght: number; opsz: number; soft: number; wonk: 0 | 1; italic?: boolean }

/** Per-article art direction (scripts/magazine/voices.ts). */
export interface Voice {
	slug: string;
	hue: number; // OKLCH hue, degrees
	display: FrauncesAxes;
	scaleRatio: 1.25 | 1.333;
	rhythm: RhythmPreset;
	templates: TemplateName[]; // allowed set, first pick order is a hint to the planner
	handNotes?: boolean; // Caveat, mcp-not-enough only
}

/** spread.json next to the .svx. */
export interface SpreadSidecar {
	voice: string;
	rhythm: RhythmPreset;
	accentHue: number;
	plan?: { section: string; layout: TemplateName }[];
	hyphenExceptions?: string[];
}

/** Parsed directive from the .svx (remark-directive); `line` is for error messages. */
export type Directive =
	| { kind: 'spread'; layout: TemplateName; line: number }
	| { kind: 'fig'; id: string; place: 'auto' | 'wide' | 'column' | 'bleed'; line: number }
	| { kind: 'pullquote'; cite?: string; text: string; line: number }
	| { kind: 'numeral'; value: string; label: string; style: 'fill' | 'outline'; line: number }
	| { kind: 'aside'; anchor: string; text: string; line: number };

/** Frame function: per-baseline interval available for text, after exclusions (MAGAZINE.md 1.4). */
export interface Frame {
	id: number;
	slot: string;
	rect: Rect;
	/** line index (0 = first baseline in the frame) -> available [x0, x1] in em, or null if blocked */
	interval(line: number): readonly [number, number] | null;
}
