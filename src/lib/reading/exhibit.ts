// The exhibit host (docs/MUSEUM.md "Built contract"): loads every exhibit of an article into the museum module of world.wasm, turns its per-frame draw list
// (exhibit-local em, XD items) into page-pass primitives, and routes pointer and key input. Everything here is a pure function or a closure over injected
// dependencies, so exhibit-draw.test.ts runs it without a GPU, a DOM or the wasm. reader.ts owns the DOM events and calls these.
import { BlockKind, ExhibitKind, stringAt, type ReadingModel } from '../magazine/format';
import { evalKeys, figureTime } from '../magazine/chan';
import { TONE_NAMES, XCURSOR, XFLAG, XKEY, XPOINTER, XRESULT, XS, XSHAPE, XD, type ExhibitApi, type ToneName } from './abi';
import type { ExhibitDraw, Overlay } from './page-api';
import { THEME } from './theme';
import type { Shaped, UiFont, UiGlyph } from './ui/types';
import { shapeUi, truncateUi } from './ui/text';

// ---- tones -----------------------------------------------------------------------------------------------------------------

type Rgba = readonly [number, number, number, number];
const rgba = (c: readonly number[], a = 1): Rgba => [c[0], c[1], c[2], a];

/** Tone name -> THEME slot (straight sRGB 0..1 like Overlay). The numeric tone of an item is the index in TONE_NAMES. */
export const TONES = {
	panel: rgba(THEME.surface.card),
	ink: rgba(THEME.text.primary),
	ink2: rgba(THEME.text.secondary),
	ink3: rgba(THEME.text.tertiary),
	accent: rgba(THEME.accent),
	accent2: rgba(THEME.accent2),
	rule: rgba(THEME.hairline.card),
	ground: rgba(THEME.surface.ground),
	accentTint: rgba(THEME.accentTint),
	panelHi: rgba(THEME.surface.popover),
	accentDim: rgba(THEME.accent, 0.45)
} as const satisfies Record<ToneName, Rgba>;

/** The colour of tone id `tone` (unknown ids draw as ink) */
export const toneColour = (tone: number): Rgba => TONES[TONE_NAMES[tone] ?? 'ink'];

// ---- exhibit-local space ---------------------------------------------------------------------------------------------------

/** px = origin + local em * k, per axis; k = px per local em = the exhibit record's `scale` (document em per local em) times the article's px per em. */
export interface Mapping { x: number; y: number; k: number }
export const mappingOf = (rect: { x: number; y: number }, scale: number, emPx: number): Mapping => ({ x: rect.x, y: rect.y, k: scale * emPx });
/** exhibit-local em of a canvas px point (the inverse of the draw conversion; `exhibit_pointer` takes this) */
export const toLocal = (m: Mapping, px: number, py: number): { x: number; y: number } => ({ x: (px - m.x) / m.k, y: (py - m.y) / m.k });

export interface Px { x0: number; y0: number; x1: number; y1: number }
/**
 * The scissor of one exhibit: its block rect, intersected with the viewport and the fold clip (px y below which folded content is hidden), or null when
 * nothing is left. Items never widen it: whatever an exhibit draws outside its frame is cut.
 */
export function exhibitClip(rect: { x: number; y: number; w: number; h: number }, viewW: number, viewH: number, foldClipY = Infinity): Px | null {
	const c = { x0: Math.max(rect.x, 0), y0: Math.max(rect.y, 0), x1: Math.min(rect.x + rect.w, viewW), y1: Math.min(rect.y + rect.h, viewH, foldClipY) };
	return c.x1 > c.x0 && c.y1 > c.y0 ? c : null;
}

// ---- draw list -> page-pass primitives -------------------------------------------------------------------------------------

/** Overlay shape kinds of the page shader (page.wgsl.ts fs_ovl) */
export const OVL_SHAPE = { rrect: 0, circle: 1, line: 2, arrow: 3, ring: 4, hatch: 6, spot: 7 } as const;
export const MAX_EXHIBIT_ITEMS = 400;
/** hatch pitch (em) when an item gives none */
const HATCH_PITCH_EM = 0.35;

export interface TextDeps {
	shape(text: string, font: UiFont, sizePx: number): Shaped;
	truncate(text: string, font: UiFont, sizePx: number, maxW: number): string;
}
export const UI_TEXT: TextDeps = { shape: shapeUi, truncate: truncateUi };

/** shaped strings keyed (string, size, font); cleared when it grows past `cap` */
export function cachedText(base: TextDeps, cap = 4096): TextDeps & { size(): number } {
	const shaped = new Map<string, Shaped>();
	const cut = new Map<string, string>();
	const key = (t: string, f: UiFont, s: number) => `${f === 'mono' ? 1 : 0}|${s.toFixed(2)}|${t}`;
	return {
		shape(t, f, s) {
			const k = key(t, f, s);
			let v = shaped.get(k);
			if (!v) { if (shaped.size >= cap) shaped.clear(); shaped.set(k, (v = base.shape(t, f, s))); }
			return v;
		},
		truncate(t, f, s, w) {
			const k = `${key(t, f, s)}|${w.toFixed(1)}`;
			let v = cut.get(k);
			if (v === undefined) { if (cut.size >= cap) cut.clear(); cut.set(k, (v = base.truncate(t, f, s, w))); }
			return v;
		},
		size: () => shaped.size
	};
}

/** Reused objects of one frame: nothing allocates per item after warm-up. */
export interface Pools { ovl: Overlay[]; ovlN: number; glyph: UiGlyph[]; glyphN: number }
export const newPools = (): Pools => ({ ovl: [], ovlN: 0, glyph: [], glyphN: 0 });

function pushOvl(p: Pools, out: Overlay[], x: number, y: number, w: number, h: number, radius: number, c: Rgba, a: number, shape: number, width: number) {
	let o = p.ovl[p.ovlN];
	if (!o) p.ovl[p.ovlN] = o = { x: 0, y: 0, w: 0, h: 0, radius: 0, r: 0, g: 0, b: 0, a: 0 };
	p.ovlN++;
	o.x = x; o.y = y; o.w = w; o.h = h; o.radius = radius; o.r = c[0]; o.g = c[1]; o.b = c[2]; o.a = c[3] * a; o.shape = shape; o.width = width;
	out.push(o);
}

/**
 * Convert `count` XD items of an exhibit into overlays and UI glyphs (appended to `out`). `m` maps local em to canvas px, `alpha` is the block's enter alpha.
 * Items with a non-finite coordinate or an unknown shape are skipped. Shapes: rrect (aux = radius em), circle and dot (the box's inscribed circle),
 * ring (rounded-rect outline inside the box, aux = corner radius em, stroke RING_STROKE_EM), line and arrow ((x, y) start, (w, h) delta, aux = stroke em), hatch (box, aux = stripe pitch em), label (x, y = baseline anchor,
 * h = size em, w = max width em or 0, aux = string index, alignment in flags bits 8..9).
 */
/** stroke of a ring item, em (its aux is the corner radius) */
export const RING_STROKE_EM = 0.12;
export function convertItems(items: Float32Array, count: number, str: (i: number) => string, m: Mapping, alpha: number, text: TextDeps, pools: Pools, out: { overlays: Overlay[]; uiText: UiGlyph[] }): void {
	const n = Math.min(count, MAX_EXHIBIT_ITEMS, Math.floor(items.length / XD.stride));
	for (let i = 0; i < n; i++) {
		const o = i * XD.stride;
		const x = items[o + XD.x], y = items[o + XD.y], w = items[o + XD.w], h = items[o + XD.h];
		const shape = items[o + XD.shape], flags = items[o + XD.flags] | 0, aux = items[o + XD.aux];
		if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) && Number.isFinite(aux))) continue;
		const c = toneColour(items[o + XD.tone]);
		const a = alpha * (flags & XFLAG.dim ? 0.4 : 1);
		if (!(a * c[3] > 0)) continue;
		const px = m.x + x * m.k, py = m.y + y * m.k, pw = w * m.k, ph = h * m.k;
		switch (shape) {
			case XSHAPE.rrect: pushOvl(pools, out.overlays, px, py, pw, ph, aux * m.k, c, a, OVL_SHAPE.rrect, 0); break;
			case XSHAPE.circle: case XSHAPE.dot: pushOvl(pools, out.overlays, px, py, pw, ph, 0, c, a, OVL_SHAPE.circle, 0); break;
			case XSHAPE.ring: pushOvl(pools, out.overlays, px, py, pw, ph, aux * m.k, c, a, OVL_SHAPE.ring, Math.max(1.5, RING_STROKE_EM * m.k)); break;
			case XSHAPE.line: pushOvl(pools, out.overlays, px, py, pw, ph, 0, c, a, OVL_SHAPE.line, Math.max(1, aux * m.k)); break;
			case XSHAPE.arrow: pushOvl(pools, out.overlays, px, py, pw, ph, 0, c, a, OVL_SHAPE.arrow, Math.max(1, aux * m.k)); break;
			case XSHAPE.hatch: pushOvl(pools, out.overlays, px, py, pw, ph, 0, c, a, OVL_SHAPE.hatch, Math.max(2, (aux > 0 ? aux : HATCH_PITCH_EM) * m.k)); break;
			case XSHAPE.label: {
				const sizePx = h * m.k;
				if (!(sizePx > 0.5)) break;
				const font: UiFont = flags & XFLAG.mono ? 'mono' : 'sans';
				let s = str(aux);
				if (!s) break;
				if (w > 0) s = text.truncate(s, font, sizePx, w * m.k);
				const sh = text.shape(s, font, sizePx);
				const align = (flags >> 8) & 3;
				const ox = px - (align === 1 ? sh.width / 2 : align === 2 ? sh.width : 0);
				for (const g of sh.glyphs) {
					let u = pools.glyph[pools.glyphN];
					if (!u) pools.glyph[pools.glyphN] = u = { x: 0, y: 0, glyphId: 0, font, size: 0, r: 0, g: 0, b: 0, a: 0 };
					pools.glyphN++;
					u.x = ox + g.dx; u.y = py; u.glyphId = g.glyphId; u.font = font; u.size = sizePx; u.r = c[0]; u.g = c[1]; u.b = c[2]; u.a = c[3] * a;
					out.uiText.push(u);
				}
				break;
			}
			default: break;
		}
	}
}

// ---- the per-frame draw ------------------------------------------------------------------------------------------------------

/** The set of an exhibit: a soft light pool behind it and a lit floor line under it (the plinth). `wake` 0..1 is how awake the exhibit is (see wakeOf in reader.ts). Pure; appends to `out`. */
export const SET = { poolAlpha: 0.09, floorAlpha: 0.2, lineAlpha: 0.12, poolHdr: 1.25 } as const;
export function setOverlays(rect: { x: number; y: number; w: number; h: number }, wake: number, alpha: number, pools: Pools, out: Overlay[]): void {
	const k = Math.max(0, Math.min(1, wake)) * alpha;
	if (!(k > 0.002)) return;
	const [r, g, b] = THEME.accent;
	pushOvl(pools, out, rect.x, rect.y, rect.w, rect.h, 0, [r, g, b, 1], SET.poolAlpha * k, OVL_SHAPE.spot, 0);
	out[out.length - 1].hdr = SET.poolHdr;
	// plinth: a half pool of light lying on the floor line, and the floor line itself (ink hairline, 70 percent of the width)
	const fh = rect.h * 0.16;
	pushOvl(pools, out, rect.x + rect.w * 0.12, rect.y + rect.h - fh * 0.5, rect.w * 0.76, fh, 0, [r, g, b, 1], SET.floorAlpha * k, OVL_SHAPE.spot, 0);
	const [ir, ig, ib] = THEME.text.primary;
	pushOvl(pools, out, rect.x + rect.w * 0.15, rect.y + rect.h - 2, rect.w * 0.7, 1.5, 0.75, [ir, ig, ib, 1], SET.lineAlpha * k, 0, 0);
}

export interface FrameInput {
	model: Pick<ReadingModel, 'blocks' | 'exhibits'>;
	api: Pick<ExhibitApi, 'pack' | 'str' | 'state'>;
	emPx: number; viewW: number; viewH: number;
	/** px y below which block `block` is hidden by the fold clip (Infinity when it is not clipped) */
	foldClipY(block: number): number;
	/** the block's rect in canvas px (before dy) or null when its layout is unknown */
	rectOf(block: number): { x: number; y: number; w: number; h: number } | null;
	alphaOf(block: number): number;
	dyOf(block: number): number;
	/** 0..1 how awake the exhibit's block is (scroll-linked light); omit for fully awake */
	wakeOf?(block: number): number;
	/** exhibits to consider: [first, first + count) */
	first: number; count: number;
}

/** At most this many exhibits draw in a frame (two are on screen in practice, docs/MUSEUM.md 3.2) */
export const MAX_EXHIBITS_ON_SCREEN = 3;

export function createExhibitDrawer(text: TextDeps = cachedText(UI_TEXT)) {
	const pools = newPools();
	const frames: ExhibitDraw[] = [];
	const list: ExhibitDraw[] = [];
	return {
		text,
		/** Build the exhibit draws of this frame: one {clip, overlays, uiText} per exhibit block that intersects the viewport and has loaded. The returned array is reused. */
		frame(f: FrameInput): ExhibitDraw[] {
			pools.ovlN = 0; pools.glyphN = 0;
			list.length = 0;
			const state = f.api.state();
			for (let i = Math.max(0, f.first); i < Math.min(f.model.exhibits.length, f.first + f.count) && list.length < MAX_EXHIBITS_ON_SCREEN; i++) {
				const rec = f.model.exhibits[i];
				const b = f.model.blocks[rec.block];
				if (!b || b.kind !== BlockKind.exhibit || state[i * XS.stride + XS.loaded] === 0) continue;
				const alpha = f.alphaOf(rec.block);
				if (alpha <= 0) continue;
				const r0 = f.rectOf(rec.block);
				if (!r0) continue;
				const dy = f.dyOf(rec.block);
				const rect = { x: r0.x, y: r0.y + dy, w: r0.w, h: r0.h };
				const clip = exhibitClip(rect, f.viewW, f.viewH, f.foldClipY(rec.block));
				if (!clip) continue;
				const slot = (frames[list.length] ??= { clip, overlays: [], uiText: [] });
				slot.clip = clip; slot.overlays.length = 0; slot.uiText.length = 0;
				const packed = f.api.pack(i);
				convertItems(packed.items, packed.count, f.api.str, mappingOf(rect, rec.scale, f.emPx), alpha, text, pools, slot);
				list.push(slot);
			}
			return list;
		}
	};
}

// ---- loading ---------------------------------------------------------------------------------------------------------------

/** The id of exhibit `i` (its directive id), or `ex<i>` */
export const exhibitId = (m: Pick<ReadingModel, 'exhibits' | 'strings'>, i: number): string => (m.exhibits[i]?.name ? stringAt(m.strings, m.exhibits[i].name) : '') || `ex${i}`;

const fmt = (v: number) => String(+v.toFixed(4));

/** The Flecs script of exhibit `i`: a script exhibit's own text, or a generated Timeline entity for a compiled timeline. */
export function exhibitSource(m: Pick<ReadingModel, 'exhibits' | 'strings'>, i: number): string {
	const e = m.exhibits[i];
	if (e.kind === ExhibitKind.script) return stringAt(m.strings, e.src);
	const safe = exhibitId(m, i).replace(/[^A-Za-z0-9_]/g, '_');
	// the clip (duration, mode, poster) comes from the load record (`Meta` in world/src/museum/mod.rs); a script needs no Clip of its own
	// the Extent is the block's frame (art + control strip): the prefab's own 36 x 14 would put the strip in the middle of a taller art
	if (!(e.frameW > 0 && e.frameH > 0)) return `fig_${safe} : Timeline {}`;
	return `fig_${safe} : Timeline {\n  Extent: {${fmt(e.frameW)}, ${fmt(e.frameH)}}\n}`;
}

export interface LoadReport { loaded: boolean[]; errors: string[] }

/** Load every exhibit of `model` (call after `reading.load(model)`). A failing exhibit is reported as `slug/id: <engine error>` and draws nothing. */
export function loadExhibits(api: Pick<ExhibitApi, 'load'>, model: Pick<ReadingModel, 'exhibits' | 'strings'>, slug: string): LoadReport {
	const loaded: boolean[] = [];
	const errors: string[] = [];
	for (let i = 0; i < model.exhibits.length; i++) {
		const err = api.load(i, exhibitSource(model, i));
		loaded.push(err === null);
		if (err !== null) errors.push(`${slug}/${exhibitId(model, i)}: ${err}`);
	}
	return { loaded, errors };
}

const FIG_MODES = ['loop', 'once', 'scrub', 'static'] as const;

/** Channels of the timeline exhibits in [first, first + count), evaluated at the clock the engine holds for each (XS.clock) into the page's channel table. */
export function evalTimelineChannels(model: Pick<ReadingModel, 'exhibits' | 'chans' | 'keys'>, api: Pick<ExhibitApi, 'state'>, first: number, count: number, chans: Float32Array): void {
	const st = api.state();
	for (let i = Math.max(0, first); i < Math.min(model.exhibits.length, first + count); i++) {
		const e = model.exhibits[i];
		if (e.kind !== ExhibitKind.timeline || st[i * XS.stride + XS.loaded] === 0) continue;
		const t = figureTime(FIG_MODES[e.mode] ?? 'loop', st[i * XS.stride + XS.clock], e.duration, e.poster);
		for (let c = 0; c < e.chanCount; c++) {
			const gi = e.firstChan + c;
			if (gi >= chans.length) break;
			const ch = model.chans[gi];
			chans[gi] = evalKeys(model.keys, t, ch.firstKey, ch.keyCount);
		}
	}
}

// ---- pointer routing (docs/MUSEUM.md 3.4) ---------------------------------------------------------------------------------------

export interface PtrEvent {
	type: 'down' | 'move' | 'up' | 'cancel' | 'leave';
	id: number;
	ptype: 'mouse' | 'touch' | 'pen';
	/** canvas px */
	x: number; y: number;
	buttons: number;
	mods: number;
	/** the original DOM event, handed back to `engineDown` */
	raw?: unknown;
}

export interface RouteResult {
	/** true: the page scroll engine must not see this event, and reader.ts starts no selection */
	swallow: boolean;
	/** pointer over an exhibit block (or captured by one) */
	inside: boolean;
	/** CSS cursor from the exhibit's result bits, null when the exhibit does not set one */
	cursor: string | null;
}

export interface RouterDeps {
	/** the exhibit index under a canvas px point (chrome and enter-hidden blocks excluded), -1 none */
	exhibitAt(x: number, y: number): number;
	/** exhibit-local em of a px point for exhibit `ex`, null when it is not placed */
	local(ex: number, x: number, y: number): { x: number; y: number } | null;
	/** `exhibit_pointer` */
	call(ex: number, kind: number, xEm: number, yEm: number, buttons: number, mods: number): number;
	/** `exhibit_focus` (-1 clears) */
	focus(ex: number): void;
	capture(id: number): void;
	release(id: number): void;
	/** replay a held touch/pen down into the scroll engine (the gesture turned out to be a scroll) */
	engineDown(raw: unknown): void;
}

/** px a touch or pen must travel before a held press is decided: capture by the exhibit, or page scroll */
export const DRAG_THRESHOLD = 8;

export const cursorOf = (r: number): string => XCURSOR[(r >> XRESULT.cursorShift) & 15] ?? 'default';

type Pending = { ex: number; id: number; x: number; y: number; axis: 'x' | 'any' | 'none'; ev: PtrEvent };

/**
 * The pointer state machine of exhibit routing. One instance per reader.
 *  - mouse down inside an exhibit: always swallowed (no selection, no page drag); `capture` bit starts pointer capture; the matching up goes to the same exhibit
 *  - touch / pen down on a part (result consumed or capture): the scroll engine is held until the pointer travels DRAG_THRESHOLD px. Mostly horizontal travel
 *    on a capturing part captures it (drag); anything else cancels the press (`leave`) and replays the down into the scroll engine (page scroll)
 *  - a captured pointer keeps routing to its exhibit, inside the block or not, until up or cancel
 *  - wheel is blocked only while a part is captured
 */
export function createRouter(d: RouterDeps) {
	let cap: { ex: number; id: number } | null = null;
	let down: { ex: number; id: number } | null = null;
	let pend: Pending | null = null;
	let hover = -1;
	let focus = -1;
	const NO: RouteResult = { swallow: false, inside: false, cursor: null };
	const send = (ex: number, kind: number, ev: PtrEvent): number => {
		const p = d.local(ex, ev.x, ev.y);
		return p ? d.call(ex, kind, p.x, p.y, ev.buttons, ev.mods) : 0;
	};
	const setFocus = (ex: number) => { if (focus !== ex) { focus = ex; d.focus(ex); } };

	return {
		get captured(): number { return cap ? cap.ex : -1; },
		get pending(): boolean { return pend !== null; },
		get focus(): number { return focus; },
		get hover(): number { return hover; },
		clearFocus() { setFocus(-1); },
		setFocus,
		/** wheel: true when the page must not scroll (an exhibit part is being dragged) */
		wheel(): boolean { return cap !== null; },
		event(ev: PtrEvent): RouteResult {
			switch (ev.type) {
				case 'down': {
					const ex = d.exhibitAt(ev.x, ev.y);
					if (ex < 0) { setFocus(-1); return NO; }
					setFocus(ex);
					if (hover >= 0 && hover !== ex) { send(hover, XPOINTER.leave, ev); hover = -1; }
					const r = send(ex, XPOINTER.down, ev);
					if (ev.ptype === 'mouse') {
						down = { ex, id: ev.id };
						if (r & XRESULT.capture) { cap = { ex, id: ev.id }; d.capture(ev.id); }
						return { swallow: true, inside: true, cursor: cursorOf(r) };
					}
					if (r & (XRESULT.consumed | XRESULT.capture)) {
						const cur = cursorOf(r);
						pend = { ex, id: ev.id, x: ev.x, y: ev.y, axis: r & XRESULT.capture ? (cur === 'ew-resize' ? 'x' : 'any') : 'none', ev };
						return { swallow: true, inside: true, cursor: null };
					}
					return { swallow: false, inside: true, cursor: null };
				}
				case 'move': {
					if (cap && cap.id === ev.id) {
						const r = send(cap.ex, XPOINTER.move, ev);
						return { swallow: true, inside: true, cursor: cursorOf(r) };
					}
					if (pend && pend.id === ev.id) {
						const dx = ev.x - pend.x, dy = ev.y - pend.y;
						if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return { swallow: true, inside: true, cursor: null };
						const p = pend;
						pend = null;
						if (p.axis !== 'none' && Math.abs(dx) >= Math.abs(dy)) {
							cap = { ex: p.ex, id: p.id };
							d.capture(p.id);
							const r = send(p.ex, XPOINTER.move, ev);
							return { swallow: true, inside: true, cursor: cursorOf(r) };
						}
						send(p.ex, XPOINTER.leave, ev); // cancel the press, the page scrolls
						d.engineDown(p.ev.raw);
						return { swallow: false, inside: false, cursor: null };
					}
					if (ev.ptype === 'touch' || (ev.buttons & 1) !== 0) return NO;
					const ex = d.exhibitAt(ev.x, ev.y);
					if (ex !== hover) { if (hover >= 0) send(hover, XPOINTER.leave, ev); hover = ex; }
					if (ex < 0) return NO;
					const r = send(ex, XPOINTER.move, ev);
					return { swallow: false, inside: true, cursor: cursorOf(r) };
				}
				case 'up': case 'cancel': {
					const kind = ev.type === 'up' ? XPOINTER.up : XPOINTER.leave;
					if (cap && cap.id === ev.id) {
						const c = cap;
						cap = null; down = null;
						const r = send(c.ex, kind, ev);
						d.release(ev.id);
						return { swallow: true, inside: true, cursor: cursorOf(r) };
					}
					if (pend && pend.id === ev.id) {
						const p = pend;
						pend = null;
						send(p.ex, kind, ev); // a tap
						return { swallow: true, inside: true, cursor: null };
					}
					if (down && down.id === ev.id) {
						const c = down;
						down = null;
						const r = send(c.ex, kind, ev);
						return { swallow: true, inside: true, cursor: cursorOf(r) };
					}
					return NO;
				}
				case 'leave': {
					if (hover >= 0 && !cap) { send(hover, XPOINTER.leave, ev); hover = -1; } // a captured drag keeps its press until up or cancel
					return NO;
				}
			}
		}
	};
}

// ---- keyboard ---------------------------------------------------------------------------------------------------------------

/** `exhibit_key` mods: 1 shift, 2 ctrl or meta, 4 alt */
export const keyMods = (e: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): number => (e.shiftKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.altKey ? 4 : 0);

const NAMED: Record<string, number> = {
	Enter: XKEY.enter, Escape: XKEY.escape, Tab: XKEY.tab, Backspace: XKEY.backspace, Delete: XKEY.delete,
	ArrowLeft: XKEY.left, ArrowRight: XKEY.right, ArrowUp: XKEY.up, ArrowDown: XKEY.down
};

/** The XKEY code of a keydown, or -1 when it is not for exhibits (Cmd/Ctrl combos, PageUp/Down, Home, End, F-keys, dead keys) */
export function xkeyOf(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): number {
	if (e.ctrlKey || e.metaKey) return -1;
	const n = NAMED[e.key];
	if (n !== undefined) return n;
	const cp = [...e.key];
	return cp.length === 1 ? cp[0].codePointAt(0)! : -1;
}

export interface KeyOutcome { handled: boolean; consumed: boolean }

/**
 * Keyboard routing while the exhibit with focus exists. `key` is `exhibit_key`. Esc the exhibit does not consume releases focus and is handled here
 * (it must not close the article); Tab the exhibit does not consume leaves the exhibit: focus is released and the page's own Tab runs.
 */
export function routeKey(focus: number, code: number, mods: number, key: (code: number, mods: number) => boolean, clearFocus: () => void): KeyOutcome {
	if (focus < 0 || code < 0) return { handled: false, consumed: false };
	if (key(code, mods)) return { handled: true, consumed: true };
	if (code === XKEY.escape) { clearFocus(); return { handled: true, consumed: false }; }
	if (code === XKEY.tab) { clearFocus(); return { handled: false, consumed: false }; }
	return { handled: false, consumed: false };
}
