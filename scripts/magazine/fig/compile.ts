// Figure compiler (docs/MAGAZINE.md 2.4): FigureSpec -> CompiledFigure (channels, swept bounds) plus the
// per-item geometry the lint needs. Pure and deterministic. Geometry is conservative (control-point hulls,
// an average-advance text estimate): the real glyph widths come from harfbuzz in the build, not here.
//
// Track semantics (the contract the shader and figure-cpu follow):
//   at.x at.y        absolute position of a node's `at`          size.x size.y   absolute size
//   x y              translation offset added to a path, dots or group
//   scale rot        about the node centre (groups: about `pivot`)    opacity     0..1
//   trim.t0 trim.t1  stroke draw-on, 0..1 of arc length        phase  dash phase (em)    width  stroke width (em)
//   mix              0..1 blend of a `{mix:[a,b], chan}` colour        value  numeral value      u   dot position along its path, 0..1

import type { ColorRef, FigNode, FigureSpec, GroupSpec, PathSpec } from '../../../src/lib/magazine/dsl';
import { evalKeys } from '../../../src/lib/magazine/chan';
import type { Channel, CompiledFigure, Keyframe, Rect } from '../../../src/lib/magazine/types';

export const PROPS = ['at.x', 'at.y', 'size.x', 'size.y', 'scale', 'rot', 'opacity', 'trim.t0', 'trim.t1', 'phase', 'width', 'mix', 'value', 'u', 'x', 'y'] as const;
const KIND_PROPS: Record<string, readonly string[]> = {
	rrect: ['at.x', 'at.y', 'size.x', 'size.y', 'scale', 'rot', 'opacity', 'phase', 'width', 'mix'],
	circle: ['at.x', 'at.y', 'scale', 'opacity', 'width', 'mix'],
	text: ['at.x', 'at.y', 'scale', 'opacity', 'mix'],
	arrow: ['x', 'y', 'opacity', 'trim.t0', 'trim.t1', 'phase', 'width', 'mix'],
	dots: ['u', 'opacity', 'mix', 'x', 'y'],
	numeral: ['at.x', 'at.y', 'value', 'opacity', 'mix'],
	path: ['x', 'y', 'scale', 'rot', 'opacity', 'trim.t0', 'trim.t1', 'phase', 'width', 'mix'],
	group: ['x', 'y', 'scale', 'rot', 'opacity']
};

/** Average advance of the body face in em per em of size; labels use it for width estimates only. */
export const CHAR_W = 0.56;

export interface LintItem {
	id: string;
	kind: string;
	text?: string; // text node string, or the label of a shape
	glyphs: number; // glyph items this node contributes to a cell
	fontSize: number;
	poster: Rect; // geometry at the poster time
	swept: Rect; // union over the whole timeline
	base: Rect; // geometry with every track property at its static value, groups ignored (the emitter's reference for swept margins)
	labelRect?: Rect; // estimated label box at poster (shape labels)
	opacityAtPoster: number;
	trimAtPoster: [number, number] | null;
}

export interface CompiledFigureX extends CompiledFigure {
	items: LintItem[];
	/** channel id by target, for the writer (shape records reference channels by index) */
	chanOf: Record<string, number>;
}

const EMPTY: Rect = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
export const union = (a: Rect, b: Rect): Rect => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
const pad = (r: Rect, d: number): Rect => ({ x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d });

/** Hull of the control points of an absolute-command path (M L Q C Z). */
export function pathBounds(d: string, where = 'path'): Rect {
	const tokens = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
	if (!tokens) throw new Error(`${where}: empty path`);
	let r = EMPTY;
	let need = 0;
	let nums: number[] = [];
	for (const tk of tokens) {
		if (/^[MLQCZ]$/.test(tk)) {
			if (need && nums.length % need) throw new Error(`${where}: bad arity in "${d}"`);
			need = { M: 2, L: 2, Q: 4, C: 6, Z: 0 }[tk]!;
			continue;
		}
		if (/^[A-Za-z]$/.test(tk)) throw new Error(`${where}: unsupported command ${tk} (absolute M L Q C Z only)`);
		nums.push(Number(tk));
		if (nums.length % 2 === 0) r = union(r, { x0: nums[nums.length - 2], y0: nums[nums.length - 1], x1: nums[nums.length - 2], y1: nums[nums.length - 1] });
	}
	if (!Number.isFinite(r.x0)) throw new Error(`${where}: no points in "${d}"`);
	return r;
}

type Get = (prop: string, dflt: number) => number;

function textRect(s: string, size: number, x: number, y: number, align: 'left' | 'center' | 'right'): Rect {
	const w = [...s].length * size * CHAR_W;
	const x0 = align === 'left' ? x : align === 'center' ? x - w / 2 : x - w;
	return { x0, y0: y - size * 0.8, x1: x0 + w, y1: y + size * 0.25 };
}

function strokeW(n: { stroke?: { w: number } }, get: Get): number {
	return get('width', n.stroke?.w ?? 0);
}

/** Axis-aligned bounds of a node when every track property has the value given by `get`. */
function rectAt(n: FigNode | PathSpec, paths: Map<string, Rect>, get: Get): Rect {
	let r: Rect;
	if (!('kind' in n)) {
		const b = pathBounds(n.d, `path ${n.id}`);
		const dx = get('x', 0), dy = get('y', 0);
		r = pad({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }, strokeW(n, get) / 2);
	} else {
		switch (n.kind) {
			case 'rrect': {
				const x = get('at.x', n.at[0]), y = get('at.y', n.at[1]);
				r = pad({ x0: x, y0: y, x1: x + get('size.x', n.size[0]), y1: y + get('size.y', n.size[1]) }, strokeW(n, get) / 2);
				break;
			}
			case 'circle': {
				const x = get('at.x', n.at[0]), y = get('at.y', n.at[1]);
				r = pad({ x0: x - n.r, y0: y - n.r, x1: x + n.r, y1: y + n.r }, strokeW(n, get) / 2);
				break;
			}
			case 'text': r = textRect(n.text, n.size, get('at.x', n.at[0]), get('at.y', n.at[1]), n.align); break;
			case 'arrow': {
				const b = pathBounds(n.path, `arrow ${n.id}`);
				const dx = get('x', 0), dy = get('y', 0);
				r = pad({ x0: b.x0 + dx, y0: b.y0 + dy, x1: b.x1 + dx, y1: b.y1 + dy }, strokeW(n, get) / 2 + (n.head ? n.stroke.w * 5 : 0));
				break;
			}
			case 'dots': {
				const b = n.scatter ? { x0: n.scatter.rect[0], y0: n.scatter.rect[1], x1: n.scatter.rect[2], y1: n.scatter.rect[3] } : n.along ? paths.get(n.along) : undefined;
				if (!b) throw new Error(`dots ${n.id}: needs along (a path or arrow id) or scatter`);
				r = pad({ x0: b.x0 + get('x', 0), y0: b.y0 + get('y', 0), x1: b.x1 + get('x', 0), y1: b.y1 + get('y', 0) }, n.r);
				break;
			}
			case 'numeral': {
				const x = get('at.x', n.at[0]), y = get('at.y', n.at[1]);
				r = { x0: x, y0: y - n.size * 0.8, x1: x + n.digits * n.size * 0.6, y1: y + n.size * 0.2 };
				break;
			}
		}
	}
	const s = get('scale', 1);
	const rot = get('rot', 0);
	if (s !== 1 || rot !== 0) {
		const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
		let hw = ((r.x1 - r.x0) / 2) * Math.abs(s), hh = ((r.y1 - r.y0) / 2) * Math.abs(s);
		if (rot !== 0) hw = hh = Math.hypot(hw, hh); // circumscribed: conservative
		r = { x0: cx - hw, y0: cy - hh, x1: cx + hw, y1: cy + hh };
	}
	return r;
}

function colorChans(c: ColorRef | undefined, out: string[]) {
	if (c && typeof c === 'object') out.push(c.chan);
}

export function compileFigure(id: string, spec: FigureSpec): CompiledFigureX {
	if (spec.layout) throw new Error(`figure ${id}: layout.engine '${spec.layout.engine}' is not available in this build (hand-place coordinates)`);
	const [fw, fh] = spec.size;
	if (!(fw > 0 && fh > 0)) throw new Error(`figure ${id}: size must be positive`);
	if (!(spec.time.duration > 0)) throw new Error(`figure ${id}: duration must be positive`);

	// element table: nodes, paths, groups by id
	const kindOf = new Map<string, string>();
	const nodeById = new Map<string, FigNode | PathSpec>();
	for (const n of spec.nodes) { kindOf.set(n.id, n.kind); nodeById.set(n.id, n); }
	for (const p of spec.paths ?? []) { kindOf.set(p.id, 'path'); nodeById.set(p.id, p); }
	const groups = new Map<string, GroupSpec>();
	for (const g of spec.groups ?? []) {
		if (kindOf.has(g.id)) throw new Error(`figure ${id}: group id ${g.id} collides with a node`);
		kindOf.set(g.id, 'group');
		groups.set(g.id, g);
	}

	// channels: one per track
	const channels: Channel[] = [];
	const chanOf: Record<string, number> = {};
	const byOwner = new Map<string, Map<string, Channel>>();
	for (const t of spec.tracks ?? []) {
		const owner = [...kindOf.keys()].filter((k) => t.target.startsWith(k + '.')).sort((a, b) => b.length - a.length)[0];
		if (!owner) throw new Error(`figure ${id}: track target '${t.target}' names no node, path or group`);
		const prop = t.target.slice(owner.length + 1);
		if (!KIND_PROPS[kindOf.get(owner)!].includes(prop)) throw new Error(`figure ${id}: '${owner}' (${kindOf.get(owner)}) has no animatable property '${prop}' (allowed: ${KIND_PROPS[kindOf.get(owner)!].join(' ')})`);
		if (chanOf[t.target] !== undefined) throw new Error(`figure ${id}: duplicate track for '${t.target}'`);
		const keys: Keyframe[] = t.keys.map(([tt, v], i) => ({
			t: tt, v,
			ease: i === 0 ? 'linear' : Array.isArray(t.ease) ? (t.ease as readonly string[])[i - 1] as Keyframe['ease'] : (t.ease as Keyframe['ease'])
		}));
		for (const k of keys) {
			if (!Number.isFinite(k.t) || !Number.isFinite(k.v)) throw new Error(`figure ${id}: non-finite key in '${t.target}'`);
			if (k.t < 0 || k.t > spec.time.duration + 1e-9) throw new Error(`figure ${id}: key time ${k.t} of '${t.target}' lies outside 0..${spec.time.duration}`);
		}
		const ch: Channel = { id: channels.length, target: t.target, keys };
		channels.push(ch);
		chanOf[t.target] = ch.id;
		if (!byOwner.has(owner)) byOwner.set(owner, new Map());
		byOwner.get(owner)!.set(prop, ch);
	}

	// mix colours must name an existing channel
	const wanted: string[] = [];
	for (const n of spec.nodes) {
		if ('fill' in n && n.fill !== 'none') colorChans(n.fill, wanted);
		if ('color' in n) colorChans(n.color, wanted);
		if ('stroke' in n) colorChans(n.stroke?.color, wanted);
		if (n.kind === 'arrow') colorChans(n.stroke.color, wanted);
	}
	for (const p of spec.paths ?? []) { colorChans(p.fill, wanted); colorChans(p.stroke?.color, wanted); }
	for (const w of wanted) if (chanOf[w] === undefined) throw new Error(`figure ${id}: colour mix channel '${w}' has no track`);

	// geometry
	const pathRects = new Map<string, Rect>();
	for (const p of spec.paths ?? []) pathRects.set(p.id, pathBounds(p.d, `path ${p.id}`));
	for (const n of spec.nodes) if (n.kind === 'arrow') pathRects.set(n.id, pathBounds(n.path, `arrow ${n.id}`));

	const dur = spec.time.duration;
	const poster = spec.time.poster;
	const getter = (owner: string, t: number): Get => (prop, dflt) => {
		let v = dflt;
		const c = byOwner.get(owner)?.get(prop);
		if (c) v = evalKeys(c.keys, t);
		return v;
	};
	// group transform (translate x,y; scale about pivot) applied to members
	const groupApply = (r: Rect, gid: string | undefined, t: number): Rect => {
		for (let g = gid ? groups.get(gid) : undefined; g; g = g.parent ? groups.get(g.parent) : undefined) {
			const get = getter(g.id, t);
			const s = get('scale', 1);
			const [px, py] = g.pivot ?? [0, 0];
			let o = s === 1 ? r : { x0: px + (r.x0 - px) * s, y0: py + (r.y0 - py) * s, x1: px + (r.x1 - px) * s, y1: py + (r.y1 - py) * s };
			if (get('rot', 0) !== 0) {
				const rad = Math.max(Math.hypot(o.x0 - px, o.y0 - py), Math.hypot(o.x1 - px, o.y0 - py), Math.hypot(o.x0 - px, o.y1 - py), Math.hypot(o.x1 - px, o.y1 - py));
				o = { x0: px - rad, y0: py - rad, x1: px + rad, y1: py + rad };
			}
			const dx = get('x', 0), dy = get('y', 0);
			r = { x0: Math.min(o.x0, o.x1) + dx, y0: Math.min(o.y0, o.y1) + dy, x1: Math.max(o.x0, o.x1) + dx, y1: Math.max(o.y0, o.y1) + dy };
		}
		return r;
	};
	const groupOpacity = (gid: string | undefined, t: number): number => {
		let o = 1;
		for (let g = gid ? groups.get(gid) : undefined; g; g = g.parent ? groups.get(g.parent) : undefined) o *= getter(g.id, t)('opacity', 1);
		return o;
	};
	const groupChans = (gid: string | undefined): Channel[] => {
		const out: Channel[] = [];
		for (let g = gid ? groups.get(gid) : undefined; g; g = g.parent ? groups.get(g.parent) : undefined) out.push(...(byOwner.get(g.id)?.values() ?? []));
		return out;
	};

	const sampleTimes = (chs: Channel[]): number[] => {
		const ts = new Set<number>([0, dur, poster]);
		for (const c of chs) {
			for (let i = 0; i < c.keys.length; i++) {
				ts.add(c.keys[i].t);
				if (i) for (const f of [0.25, 0.5, 0.75]) ts.add(c.keys[i - 1].t + (c.keys[i].t - c.keys[i - 1].t) * f);
			}
		}
		return [...ts].sort((a, b) => a - b);
	};

	const items: LintItem[] = [];
	let bounds = EMPTY;
	for (const n of nodeById.values()) {
		const kind = 'kind' in n ? n.kind : 'path';
		const gid = n.group;
		const own = [...(byOwner.get(n.id)?.values() ?? [])];
		const times = sampleTimes([...own, ...groupChans(gid)]);
		let swept = EMPTY;
		for (const t of times) swept = union(swept, groupApply(rectAt(n, pathRects, getter(n.id, t)), gid, t));
		const gp = getter(n.id, poster);
		const posterRect = groupApply(rectAt(n, pathRects, gp), gid, poster);
		const nodeLabel = 'label' in n ? n.label : undefined;
		const text = kind === 'text' ? (n as { text: string }).text : nodeLabel;
		const fontSize = kind === 'text' ? (n as { size: number }).size : 0.78;
		let labelRect: Rect | undefined;
		if (kind !== 'text' && nodeLabel && 'kind' in n) {
			const cx = (posterRect.x0 + posterRect.x1) / 2, cy = (posterRect.y0 + posterRect.y1) / 2;
			const w = [...nodeLabel].length * fontSize * CHAR_W;
			labelRect = { x0: cx - w / 2, y0: cy - fontSize * 0.5, x1: cx + w / 2, y1: cy + fontSize * 0.5 };
		}
		const hasTrim = kind === 'arrow' || (kind === 'path' && !!(n as PathSpec).stroke);
		items.push({
			id: n.id, kind, text, glyphs: text ? [...text].length : 0, fontSize,
			poster: posterRect, swept, base: rectAt(n, pathRects, (_p, d) => d), labelRect,
			opacityAtPoster: gp('opacity', 1) * groupOpacity(gid, poster),
			trimAtPoster: hasTrim ? [gp('trim.t0', 0), gp('trim.t1', 1)] : null
		});
		bounds = union(bounds, swept);
		if (labelRect) bounds = union(bounds, labelRect);
	}
	if (!Number.isFinite(bounds.x0)) bounds = { x0: 0, y0: 0, x1: fw, y1: fh };

	return { id, size: spec.size, time: spec.time, describe: spec.describe, alt: spec.alt, channels, bounds, items, chanOf };
}
