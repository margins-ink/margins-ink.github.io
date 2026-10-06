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

export type SlotType = 'head' | 'deck' | 'body' | 'figure' | 'pullquote' | 'numeral' | 'aside' | 'caption' | 'code' | 'folio' | 'rule' | 'field';
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

export const TEMPLATE_NAMES = ['duo', 'solo', 'compare', 'numerals', 'text', 'text-code'] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
/** Layer of a spread: 0 distilled, 1 full text (MAGAZINE.md 1.6, 4.5). */
export const LAYER = { distilled: 0, full: 1 } as const;
export type Layer = (typeof LAYER)[keyof typeof LAYER];
export const DISTILLED_TEMPLATES = ['duo', 'solo', 'compare', 'numerals'] as const satisfies readonly TemplateName[];
export const FULL_TEMPLATES = ['text', 'text-code'] as const satisfies readonly TemplateName[];
/** Template id stored in `Spreads[].template`: index in TEMPLATE_NAMES, +TEMPLATE_NARROW_BASE for the `-n` narrow variant. */
export const TEMPLATE_NARROW_BASE = 16;
export const templateId = (name: TemplateName, narrow = false): number => TEMPLATE_NAMES.indexOf(name) + (narrow ? TEMPLATE_NARROW_BASE : 0);
export const templateLayer = (name: TemplateName): Layer => ((FULL_TEMPLATES as readonly string[]).includes(name) ? LAYER.full : LAYER.distilled);

// ---- voice, sidecar, distill ---------------------------------------------------------------------

/** Per-article art direction (scripts/magazine/voices.ts): accent hue plus the Instrument Sans display axes. */
export interface Voice { hue: number; wdth: number; wght: number }

/** spread.json next to the .svx (MAGAZINE.md 1.5). */
export interface SpreadSidecar {
	accentHue: number;
	display: { wdth: number; wght: number };
	hyphenExceptions?: string[];
}

export const DISTILL_TEMPLATES = DISTILLED_TEMPLATES;
export type DistillTemplate = (typeof DISTILLED_TEMPLATES)[number];

/** The `distill:` frontmatter block (MAGAZINE.md 1.7). Every string not listed in `synth` must be a verbatim substring of the post. */
export interface Distill {
	template: DistillTemplate;
	headline: string;
	definition?: string;
	deck?: string;
	/** 1 or 2 figure ids from figures.ts, in slot order */
	figures: string[];
	quote?: { text: string; from: string };
	/** at most 3 */
	captions: { fig: string; text: string }[];
	/** paths of strings that are NOT verbatim from the post, e.g. ["headline"] */
	synth: string[];
	/** absent until Andrew approves; post_sha is sha256 of the post body */
	review?: { by: string; at: string; post_sha: string };
}
export const DISTILL_LIMITS = { words: { min: 100, warn: 150, max: 250 }, captions: 3, figures: 2 } as const;

/** Parsed directive from the .svx (remark-directive); `line` is for error messages. Only what the full text layer needs. */
export type Directive =
	| { kind: 'fig'; id: string; place: 'auto' | 'inline'; line: number }
	| { kind: 'code-wide'; line: number };

/** Frame function: per-baseline interval available for text, after exclusions (MAGAZINE.md 1.4). */
export interface Frame {
	id: number;
	slot: string;
	rect: Rect;
	/** line index (0 = first baseline in the frame) -> available [x0, x1] in em, or null if blocked */
	interval(line: number): readonly [number, number] | null;
}
