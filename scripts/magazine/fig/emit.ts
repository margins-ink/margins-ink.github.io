// Figure emitter: a compiled figure (fig/compile.ts) -> a Fragment of RDR2 records in figure-local em (origin top-left of
// the figure). The compiler's channels are keyed by authoring semantics ("e1.at.x" is a position); the shader's channels
// have per-record semantics (a group translation, a reveal fraction, a stroke trim), so this file re-expresses every track as
// the channel the record wants and puts animated nodes in a group of their own (translate/scale/rotate/opacity).
//
// Mapping (docs/MAGAZINE.md 2.2; shader semantics in src/lib/gpu/room/magazine.wgsl.ts, header comment):
//   rrect   shape rrect; size.x track -> chan (reveal fraction = v / size.x); phase track -> pad chan (hatch phase, periods);
//           stroke -> inside ring (solid: shapes carry no dash); label -> centred glyphs
//   circle  shape circle; stroke -> inside ring; label as rrect
//   text    glyphs (label font by default); at.x/at.y/scale/opacity tracks via the node group
//   arrow   stroke (+ arrowHead shape aux = stroke index); trim, phase, width tracks -> stroke chans
//   path    stroke and/or filled path item (extra glyph table); same chans
//   dots    shape dot along the stroke of `along` (count in flags, stagger in param, u track -> chan)
//   numeral numeral record (digit set of the display font), value track -> chan
import {
	Ease, ItemType, NONE16, NO_CHAN, PAL2, FigureMode, ExhibitKind, TIMELINE_STRIP, ShapeFlag, ShapeKind, StrokeFlag,
	type ChanRec, type GroupRec, type KeyRec, type PaletteName
} from '../../../src/lib/magazine/format';
import type { ColorRef, FigNode, FigureSpec, PathSpec, StrokeSpec } from '../../../src/lib/magazine/dsl';
import type { CompiledFigure, Keyframe, Rect } from '../../../src/lib/magazine/types';
import { F, type FontSet, type GlyphTableBuilder } from '../../reader/fonts';
import { parseSvgPath, transformContours } from '../../reader/geom';
import type { StringSink } from '../typeset';
import type { Fragment, FItem } from '../emit';
import { compileFigure, LABEL_SIZE, type CompiledFigureX, type LintItem } from './compile';
import { lintFigure } from './lint';
import { figureContrast, labelColour as labelName } from './contrast';

export interface FigureArt { id: string; fragment: Fragment; size: [number, number]; /** em of the Timeline control strip under the art (0 for a static figure) */ strip: number; compiled: CompiledFigure }

export interface FigEnv {
	fonts: FontSet;
	union: GlyphTableBuilder;
	extra: GlyphTableBuilder;
	strings: StringSink;
	digitSets: number[][];
	missing: Set<string>;
}

const FONT_OF = { body: F.body, label: F.sans, code: F.code, display: F.display } as const;
const DURATION_EPS = 1e-9;

type Seg = { x0: number; y0: number; x1: number; y1: number; x2: number; y2: number; cum: number; len: number };

/** Absolute M L Q C Z path to quadratic sub-paths; a line is a quad with its control at the midpoint, a cubic splits in two quads (tolerance is far below a pixel for figure-sized curves). */
function strokeSubpaths(d: string): { segs: Seg[]; closed: boolean }[] {
	const toks = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? [];
	const out: { segs: Seg[]; closed: boolean }[] = [];
	let cur: Seg[] | null = null;
	let x = 0, y = 0, sx = 0, sy = 0;
	let i = 0;
	const num = () => Number(toks[i++]);
	const finish = (closed: boolean) => {
		if (cur && cur.length) {
			let cum = 0;
			for (const s of cur) { s.len = quadLen(s); s.cum = cum; cum += s.len; }
			out.push({ segs: cur, closed });
		}
		cur = null;
	};
	const quad = (cx: number, cy: number, ex: number, ey: number) => {
		(cur ??= []).push({ x0: x, y0: y, x1: cx, y1: cy, x2: ex, y2: ey, cum: 0, len: 0 });
		x = ex; y = ey;
	};
	while (i < toks.length) {
		const cmd = toks[i++].toUpperCase();
		if (cmd === 'M') { finish(false); x = sx = num(); y = sy = num(); }
		else if (cmd === 'L') { const ex = num(), ey = num(); quad((x + ex) / 2, (y + ey) / 2, ex, ey); }
		else if (cmd === 'Q') { const cx = num(), cy = num(), ex = num(), ey = num(); quad(cx, cy, ex, ey); }
		else if (cmd === 'C') {
			// four equal parameter pieces, each a single quad with control (3 (c1 + c2) - (p0 + p3)) / 4: error far below a pixel at figure scale
			const c1x = num(), c1y = num(), c2x = num(), c2y = num(), ex = num(), ey = num();
			let q: number[] = [x, y, c1x, c1y, c2x, c2y, ex, ey];
			for (let k = 4; k >= 1; k--) {
				const t = 1 / k;
				const lerp = (a: number, b: number) => a + (b - a) * t;
				const x01 = lerp(q[0], q[2]), y01 = lerp(q[1], q[3]), x12 = lerp(q[2], q[4]), y12 = lerp(q[3], q[5]), x23 = lerp(q[4], q[6]), y23 = lerp(q[5], q[7]);
				const x012 = lerp(x01, x12), y012 = lerp(y01, y12), x123 = lerp(x12, x23), y123 = lerp(y12, y23);
				const xm = lerp(x012, x123), ym = lerp(y012, y123);
				// first piece: p0, x01, x012, m
				quad((3 * (x01 + x012) - q[0] - xm) / 4, (3 * (y01 + y012) - q[1] - ym) / 4, xm, ym);
				q = [xm, ym, x123, y123, x23, y23, q[6], q[7]];
			}
		} else if (cmd === 'Z') {
			if (cur && (x !== sx || y !== sy)) quad((x + sx) / 2, (y + sy) / 2, sx, sy);
			finish(true);
		}
	}
	finish(false);
	return out;
}

function quadLen(s: Seg): number {
	let len = 0, px = s.x0, py = s.y0;
	for (let k = 1; k <= 16; k++) {
		const t = k / 16, u = 1 - t;
		const x = u * u * s.x0 + 2 * u * t * s.x1 + t * t * s.x2, y = u * u * s.y0 + 2 * u * t * s.y1 + t * t * s.y2;
		len += Math.hypot(x - px, y - py);
		px = x; py = y;
	}
	return len;
}

const palOf = (c: ColorRef | 'none' | undefined, fallback: PaletteName = 'ink'): { a: number; b: number; mix?: string } => {
	if (!c || c === 'none') return { a: PAL2[fallback], b: PAL2[fallback] };
	if (typeof c === 'string') return { a: PAL2[c], b: PAL2[c] };
	return { a: PAL2[c.mix[0]], b: PAL2[c.mix[1]], mix: c.chan };
};

export function emitFigure(env: FigEnv, figId: string, spec: FigureSpec, cf: CompiledFigureX): FigureArt {
	const items: FItem[] = [];
	const frag: Required<Pick<Fragment, 'glyphs' | 'shapes' | 'paths' | 'strokes' | 'segs' | 'groups' | 'numerals' | 'chans' | 'keys' | 'figures'>> = {
		glyphs: [], shapes: [], paths: [], strokes: [], segs: [], groups: [], numerals: [], chans: [], keys: [], figures: []
	};
	const lint = new Map<string, LintItem>(cf.items.map((x) => [x.id, x]));
	const trackOf = (target: string) => cf.channels[cf.chanOf[target]] as { keys: Keyframe[] } | undefined;

	// ---- channels re-expressed per record semantics ----
	const chanCache = new Map<string, number>();
	/** channel for track `target`, values mapped by `f`; NO_CHAN when there is no such track */
	const chan = (target: string, f: (v: number) => number = (v) => v, tag = ''): number => {
		const tr = trackOf(target);
		if (!tr) return NO_CHAN;
		const ck = `${target}|${tag}`;
		const hit = chanCache.get(ck);
		if (hit !== undefined) return hit;
		const first = frag.keys.length;
		for (const k of tr.keys) frag.keys.push({ t: k.t, v: f(k.v), ease: Ease[k.ease] } as KeyRec);
		frag.chans.push({ firstKey: first, keyCount: tr.keys.length } as ChanRec);
		const idx = frag.chans.length - 1;
		chanCache.set(ck, idx);
		return idx;
	};

	// ---- groups ----
	const groupIdx = new Map<string, number>();
	const specGroups = spec.groups ?? [];
	for (const g of specGroups) groupIdx.set(g.id, frag.groups.length + groupIdx.size);
	specGroups.forEach((g) => {
		const rec: GroupRec = {
			parent: g.parent ? groupIdx.get(g.parent) ?? -1 : -1,
			txChan: chan(`${g.id}.x`), tyChan: chan(`${g.id}.y`), rotChan: chan(`${g.id}.rot`), scaleChan: chan(`${g.id}.scale`), opacityChan: chan(`${g.id}.opacity`),
			tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: g.pivot?.[0] ?? 0, pivotY: g.pivot?.[1] ?? 0
		};
		frag.groups.push(rec);
	});
	/** group index for a node: its own animation group (parented to its user group), else the user group, else NONE16 */
	const groupFor = (n: FigNode | PathSpec, base: Rect | undefined): number => {
		const user = n.group ? groupIdx.get(n.group) : undefined;
		if (n.group && user === undefined) throw new Error(`figure ${figId}: ${n.id} names unknown group ${n.group}`);
		const at = 'at' in n ? n.at : [0, 0];
		const pick = (a: number, b: number) => (a !== NO_CHAN ? a : b);
		const tx = pick(chan(`${n.id}.at.x`, (v) => v - at[0]), chan(`${n.id}.x`));
		const ty = pick(chan(`${n.id}.at.y`, (v) => v - at[1]), chan(`${n.id}.y`));
		const sc = chan(`${n.id}.scale`), rot = chan(`${n.id}.rot`), op = chan(`${n.id}.opacity`);
		if (tx === NO_CHAN && ty === NO_CHAN && sc === NO_CHAN && rot === NO_CHAN && op === NO_CHAN) return user ?? NONE16;
		const cx = base ? (base.x0 + base.x1) / 2 : 0, cy = base ? (base.y0 + base.y1) / 2 : 0;
		frag.groups.push({ parent: user ?? -1, txChan: tx, tyChan: ty, rotChan: rot, scaleChan: sc, opacityChan: op, tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: cx, pivotY: cy });
		return frag.groups.length - 1;
	};

	/** A group that only fades: opacity 0 until the last quarter of the final growth segment of `target`, then 1. NO reveal track: the parent group. */
	const labelGroup = (parent: number, target: string, full: number): number => {
		const tr = trackOf(target);
		if (!tr) return parent;
		const ks = tr.keys;
		const keys: KeyRec[] = [];
		ks.forEach((k, i) => {
			const done = k.v >= full * 0.999;
			if (done && i > 0 && ks[i - 1].v < full * 0.999) keys.push({ t: ks[i - 1].t + (k.t - ks[i - 1].t) * 0.75, v: 0, ease: Ease.linear } as KeyRec);
			keys.push({ t: k.t, v: done ? 1 : 0, ease: Ease[k.ease] } as KeyRec);
		});
		const first = frag.keys.length;
		frag.keys.push(...keys);
		frag.chans.push({ firstKey: first, keyCount: keys.length } as ChanRec);
		frag.groups.push({
			parent: parent !== NONE16 ? parent : -1, txChan: NO_CHAN, tyChan: NO_CHAN, rotChan: NO_CHAN, scaleChan: NO_CHAN, opacityChan: frag.chans.length - 1,
			tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: 0, pivotY: 0
		});
		return frag.groups.length - 1;
	};

	const push = (type: number, index: number, group: number, li: LintItem | undefined) => {
		const it: FItem = { type, index };
		if (group !== NONE16 && li) it.bounds = { ...li.swept };
		items.push(it);
	};

	// ---- text ----
	const glyphIndex = (fi: number, gid: number): number | null => {
		const cs = env.fonts.fonts[fi].outline(gid);
		return cs.length ? env.union.add(`${fi}:${gid}`, cs, [fi, gid]) : null;
	};
	const shapeText = (fi: number, text: string, size: number, where: string) => {
		const font = env.fonts.fonts[fi];
		const out: { gid: number; fi: number; x: number; y: number }[] = [];
		let w = 0;
		for (const g of font.shapeCode(text)) {
			let gid = g.gid, f = fi, adv = g.xAdvance * size;
			if (gid === 0 && text[g.cluster] !== ' ') {
				const cp = text.codePointAt(g.cluster)!;
				const fb = env.fonts.fallback(cp);
				if (fb) { gid = fb.gid; f = fb.font; adv = fb.adv * size; }
				else env.missing.add(`figure ${where}: U+${cp.toString(16).toUpperCase()} "${String.fromCodePoint(cp)}"`);
			}
			out.push({ gid, fi: f, x: w + g.xOffset * size, y: -g.yOffset * size });
			w += adv;
		}
		return { glyphs: out, width: w };
	};
	const emitText = (text: string, fi: number, size: number, x: number, y: number, align: 'left' | 'center' | 'right', colour: number, group: number, li: LintItem | undefined, where: string) => {
		const { glyphs, width } = shapeText(fi, text, size, where);
		const x0 = align === 'left' ? x : align === 'center' ? x - width / 2 : x - width;
		for (const g of glyphs) {
			const gi = glyphIndex(g.fi, g.gid);
			if (gi === null) continue;
			frag.glyphs.push({ x: x0 + g.x, y: y + g.y, glyphId: gi, size, colour, flags: 0, charOffset: 0xffffffff, group, frame: NONE16 });
			push(ItemType.glyph, frag.glyphs.length - 1, group, li);
		}
	};
	const labelColour = (fill: ColorRef | 'none'): number => PAL2[labelName(fill)];

	// ---- strokes (arrows and stroked paths) ----
	const strokeOf = new Map<string, number>();
	const emitStroke = (id: string, d: string, st: StrokeSpec, group: number, li: LintItem | undefined, head: boolean): void => {
		const subs = strokeSubpaths(d);
		const col = palOf(st.color);
		let lastStroke = -1;
		for (const sp of subs) {
			const firstSeg = frag.segs.length;
			for (const s of sp.segs) frag.segs.push(s);
			const flags = (st.cap === 'butt' ? StrokeFlag.capButt : st.cap === 'square' ? StrokeFlag.capSquare : StrokeFlag.capRound) | (st.join === 'bevel' ? StrokeFlag.joinBevel : StrokeFlag.joinRound) | (sp.closed ? StrokeFlag.closed : 0);
			frag.strokes.push({
				firstSeg, segCount: sp.segs.length, width: st.w, flags, colour: col.a, group,
				dashOn: st.dash?.[0] ?? 0, dashOff: st.dash?.[1] ?? 0,
				phaseChan: chan(`${id}.phase`), trimT0Chan: chan(`${id}.trim.t0`), trimT1Chan: chan(`${id}.trim.t1`), widthChan: chan(`${id}.width`),
				colour2: col.b, mixChan: col.mix ? chan(col.mix) : NO_CHAN
			});
			lastStroke = frag.strokes.length - 1;
			push(ItemType.stroke, lastStroke, group, li);
		}
		if (lastStroke < 0) throw new Error(`figure ${figId}: ${id} has an empty path`);
		strokeOf.set(id, lastStroke);
		if (head && li) {
			const w = st.w;
			frag.shapes.push({
				x0: li.swept.x0, y0: li.swept.y0, x1: li.swept.x1, y1: li.swept.y1, kind: ShapeKind.arrowHead, colour: col.a, colour2: col.b, flags: 0,
				radius: w * 5, param: w * 2.2, group, chan: NO_CHAN, mixChan: col.mix ? chan(col.mix) : NO_CHAN, aux: lastStroke
			});
			push(ItemType.shape, frag.shapes.length - 1, group, li);
		}
	};

	const digitSetFor = (fi: number): number => {
		const set: number[] = [];
		for (let k = 0; k < 10; k++) {
			const g = env.fonts.fonts[fi].shape(String(k))[0];
			const gi = glyphIndex(fi, g.gid);
			if (gi === null) throw new Error(`figure ${figId}: font ${fi} has no digit ${k}`);
			set.push(gi);
		}
		const hit = env.digitSets.findIndex((s) => s.join() === set.join());
		if (hit >= 0) return hit;
		env.digitSets.push(set);
		return env.digitSets.length - 1;
	};

	// ---- nodes (arrows and paths first so dots can find their stroke) ----
	const order = [...spec.nodes].sort((a, b) => Number(b.kind === 'arrow') - Number(a.kind === 'arrow'));
	for (const p of spec.paths ?? []) {
		const li = lint.get(p.id);
		const group = groupFor(p, li?.base);
		if (p.fill) {
			const col = palOf(p.fill);
			const cs = transformContours(parseSvgPath(p.d), [1, 0, 0, -1, 0, 0]);
			const gi = env.extra.add(`fig:${figId}:${p.id}`, cs);
			frag.paths.push({ x: 0, y: 0, scale: 1, glyphIdx: gi, colour: col.a, flags: p.evenOdd ? 1 : 0, group });
			push(ItemType.path, frag.paths.length - 1, group, li);
		}
		if (p.stroke) emitStroke(p.id, p.d, p.stroke, group, li, false);
		else if (!p.fill) throw new Error(`figure ${figId}: path ${p.id} has neither fill nor stroke`);
	}
	for (const n of order) {
		const li = lint.get(n.id);
		const where = `${figId}.${n.id}`;
		switch (n.kind) {
			case 'arrow': {
				const group = groupFor(n, li?.base);
				emitStroke(n.id, n.path, n.stroke, group, li, n.head);
				break;
			}
			case 'rrect':
			case 'circle': {
				const group = groupFor(n, li?.base);
				const fill = palOf(n.fill);
				const st = n.stroke ? palOf(n.stroke.color) : undefined;
				const [x0, y0, x1, y1] = n.kind === 'rrect' ? [n.at[0], n.at[1], n.at[0] + n.size[0], n.at[1] + n.size[1]] : [n.at[0] - n.r, n.at[1] - n.r, n.at[0] + n.r, n.at[1] + n.r];
				const hatch = n.kind === 'rrect' && n.hatch;
				const hatchCol = st ?? palOf('muted');
				const reveal = n.kind === 'rrect' ? chan(`${n.id}.size.x`, (v) => v / n.size[0]) : NO_CHAN;
				frag.shapes.push({
					x0, y0, x1, y1, kind: n.kind === 'rrect' ? ShapeKind.rrect : ShapeKind.circle, colour: fill.a, colour2: st ? st.a : hatch ? hatchCol.a : fill.b,
					flags: (n.stroke ? ShapeFlag.stroke : 0) | (n.fill === 'none' ? ShapeFlag.fillNone : 0) | (hatch ? ShapeFlag.hatch : 0),
					radius: n.kind === 'rrect' ? n.radius : 0, param: n.stroke?.w ?? 0, group, chan: reveal, mixChan: n.stroke ? NO_CHAN : fill.mix ? chan(fill.mix) : NO_CHAN,
					pad: hatch ? chan(`${n.id}.phase`, (v) => v / 0.7) : NO_CHAN, aux: 0
				});
				// a mixed fill with a stroke uses colour2 for the ring, so the mix channel only applies without one
				push(ItemType.shape, frag.shapes.length - 1, group, li);
				if (n.label) {
					const size = LABEL_SIZE;
					const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
					// a label appears with its box: opacity ramps over the last quarter of the box's reveal
					const lg = n.kind === 'rrect' ? labelGroup(group, `${n.id}.size.x`, n.size[0]) : group;
					if (hatch) {
						// the hatch crawls under the label: a solid plate keeps the word readable in both schemes
						const pw = [...n.label].length * size * 0.56 + 0.8, ph = size * 1.5;
						frag.shapes.push({
							x0: cx - pw / 2, y0: cy - ph / 2, x1: cx + pw / 2, y1: cy + ph / 2, kind: ShapeKind.rrect, colour: fill.a, colour2: fill.a, flags: 0,
							radius: 0.25, param: 0, group: lg, chan: NO_CHAN, mixChan: NO_CHAN, pad: NO_CHAN, aux: 0
						});
						push(ItemType.shape, frag.shapes.length - 1, lg, li);
					}
					emitText(n.label, F.sans, size, cx, cy + size * 0.36, 'center', labelColour(n.fill), lg, li, where);
				}
				break;
			}
			case 'text': {
				const group = groupFor(n, li?.base);
				emitText(n.text, FONT_OF[n.font], n.size, n.at[0], n.at[1], n.align, palOf(n.color).a, group, li, where);
				break;
			}
			case 'dots': {
				const group = groupFor(n, li?.base);
				if (n.scatter || !n.along) throw new Error(`figure ${figId}: dots ${n.id}: only dots along a path or arrow are supported by the emitter`);
				const si = strokeOf.get(n.along);
				if (si === undefined) throw new Error(`figure ${figId}: dots ${n.id}: along "${n.along}" has no stroke`);
				if (n.count > 32) throw new Error(`figure ${figId}: dots ${n.id}: at most 32 dots per stroke`);
				const col = palOf(n.color);
				const b = li?.swept ?? { x0: 0, y0: 0, x1: spec.size[0], y1: spec.size[1] };
				frag.shapes.push({
					x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1, kind: ShapeKind.dot, colour: col.a, colour2: col.b, flags: n.count,
					radius: n.r, param: n.stagger, group, chan: chan(`${n.id}.u`), mixChan: col.mix ? chan(col.mix) : NO_CHAN, aux: si
				});
				push(ItemType.shape, frag.shapes.length - 1, group, li);
				break;
			}
			case 'numeral': {
				const group = groupFor(n, li?.base);
				const fi = F.display;
				frag.numerals.push({
					x: n.at[0], y: n.at[1], cellW: n.size * 0.6, size: n.size, colour: palOf(n.color).a, style: n.style === 'outline' ? 1 : 0, digits: n.digits,
					digitSet: digitSetFor(fi), chan: chan(`${n.id}.value`), group
				});
				push(ItemType.numeral, frag.numerals.length - 1, group, li);
				break;
			}
		}
	}

	const mode = spec.time.mode;
	// the Timeline exhibit frame: the art plus the 2.4 em control strip below it (a static figure has no strip)
	const strip = mode === 'static' ? 0 : TIMELINE_STRIP;
	const exhibit = {
		id: 0, kind: ExhibitKind.timeline, firstChan: 0, chanCount: frag.chans.length, mode: FigureMode[mode], duration: spec.time.duration, poster: spec.time.poster,
		alt: env.strings.add(spec.alt), describe: env.strings.add(spec.describe), name: env.strings.add(figId), src: 0, title: 0, claim: 0, caption: 0,
		frameW: spec.size[0], frameH: spec.size[1] + strip, x0: 0, y0: 0, x1: spec.size[0], y1: spec.size[1] + strip
	};
	if (Math.abs(spec.time.poster) > spec.time.duration + DURATION_EPS) throw new Error(`figure ${figId}: poster outside the timeline`);
	const fragment: Fragment = { items, ...frag, exhibits: [exhibit] };
	return { id: figId, fragment, size: [spec.size[0], spec.size[1]], strip, compiled: cf };
}

/** Compile, lint (fail closed) and emit every figure of a exhibits/art.ts default export. */
export function buildFigures(env: FigEnv, set: Record<string, FigureSpec>, where: string): Map<string, FigureArt> {
	const out = new Map<string, FigureArt>();
	const errors: string[] = [];
	for (const [id, spec] of Object.entries(set)) {
		try {
			const cf = compileFigure(id, spec);
			const msgs = [...lintFigure(cf), ...figureContrast(id, spec)];
			if (msgs.length) { errors.push(...msgs); continue; }
			out.set(id, emitFigure(env, id, spec, cf));
		} catch (e) {
			errors.push((e as Error).message);
		}
	}
	if (errors.length) throw new Error(`${where}: exhibit art errors:\n    ${errors.join('\n    ')}`);
	return out;
}

/** The `fig` lane entry the build calls: import the article's exhibits/art.ts (default export: Record<id, FigureSpec>). */
export async function loadFigures(file: string, env: FigEnv): Promise<Map<string, FigureArt>> {
	const mod = await import(file);
	const set = mod.default as Record<string, FigureSpec> | undefined;
	if (!set || typeof set !== 'object') throw new Error(`${file}: art.ts must default-export a record of figures (exhibits/art.ts)`);
	return buildFigures(env, set, file);
}
