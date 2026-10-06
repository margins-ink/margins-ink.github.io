// Reading input for the book of spreads (docs/MAGAZINE.md 4.1, 4.2, 4.5). A DOM-free controller: the
// host (World.svelte) feeds it plain event records plus a pick function, and it drives a `BookSink`
// (the Flecs wrapper in src/lib/ecs/magazine.ts). All state that outlives a gesture lives in Flecs
// (`Spread`, `Corner`, `Turn`); this class only holds the gesture in progress.
import {
	edgeAt, figureAt, folioAt, geom, linkAt, marginSide, peelFrac, scrubbable, tabAt, PEEL_OPEN,
	type FigureRec, type Geom, type LinkRec
} from './hit';
import { caretAt, extend, lineRange, textOf, wordRange, type Sel, type SelDrag, type TextModel } from './select';

export const FLICK = 1.2; // spreads/s
export const WHEEL_PX = 900; // px of vertical wheel per spread
export const ZOOM_PAN = 1.15; // above this the wheel pans, turning is by key or edge click
export const CLICK_PX = 6;
export const WHEEL_IDLE_MS = 140;
export const VEL_WINDOW_MS = 80;
export const FIGURE_STEP_S = 0.25;

/** What the controller reads each event. `f` is Spread.f; layer 0 is the distilled spread. */
export interface BookView {
	f: number;
	layer: 0 | 1;
	/** number of full text spreads N: valid full-layer indices are 1..N */
	spreads: number;
	zoom: number;
	narrow: boolean;
	overview: boolean;
	/** id of the focused figure, or null */
	focus: number | null;
	/** screen px per spread-em at the current pose, for wheel-to-f of horizontal swipes */
	pxPerEm: number;
	links: readonly LinkRec[];
	figures: readonly FigureRec[];
	/** laid-out text of the resident article (selection), or null */
	text?: TextModel | null;
	/** overview cell under a viewport point (0..1, y down), or null */
	overviewAt(nx: number, ny: number): number | null;
	/** current time of a figure (for stepping) */
	figureTime(id: number): number;
}

/** Commands out. The ECS wrapper maps these onto the wasm exports (section 5) plus a few JS-side effects. */
export interface BookSink {
	goto(spread: number): void; // spread_goto: spring to an integer spread (0 closes the full layer)
	by(df: number): void; // spread_by: add to f (scrub while grabbed)
	grab(dir: -1 | 1): void; // spread_grab: start a leaf turn, f follows by()
	release(vel: number): void; // spread_release: magnet with flick rule, vel in spreads/s
	cornerDrag(frac: number): void; // peel the full-text tab, 0..1 of the sheet width
	cornerRelease(open: boolean): void;
	openFull(spread: number): void; // layer 0 -> 1 at that spread
	closeFull(): void; // layer 1 -> 0, page-turn reversed
	bounce(): void; // rubber band on the distilled spread
	pulseTab(): void;
	focusFigure(id: number | null): void;
	seekFigure(id: number, t: number): void;
	figureHover(id: number | null): void; // (Hover, figure): highlight and ew-resize cursor
	figureScrubBegin(id: number): void; // (Scrubbing, figure): autoplay and momentum stop
	figureScrubBy(id: number, dt: number): void; // timeline seconds
	figureScrubEnd(id: number, vel: number): void; // timeline s per s: momentum, then autoplay after ~2 s idle
	overview(on: boolean): void;
	follow(link: LinkRec): void; // external url, anchor, ref or article
	resetZoom(): void;
	panBy(dx: number, dy: number): void; // normalised device units, as Room.panBy
	select?(s: Sel | null): void; // highlight range of the text selection (null clears)
}

/** Result of an event: what the host should still do. */
export type Outcome = 'handled' | 'ignore' | 'zoom';

export interface WheelIn { dx: number; dy: number; mode: 0 | 1 | 2; ctrl: boolean; t: number; pageH: number; ndcDx?: number; ndcDy?: number }
export interface PointerIn { id: number; x: number; y: number; t: number; type: 'mouse' | 'touch' | 'pen'; spreadPoint: { spread: number; x: number; y: number } | null; vx?: number }
export interface KeyIn { key: string; shift: boolean; mod: boolean; t: number }

/** Flick rule (4.1): above FLICK one spread in the flick direction, else nearest. Clamped to [lo, hi]. */
export function releaseTarget(f: number, vel: number, lo: number, hi: number): number {
	let n: number;
	if (Math.abs(vel) > FLICK) n = vel > 0 ? Math.floor(f) + 1 : Math.ceil(f) - 1;
	else n = Math.round(f);
	return Math.min(hi, Math.max(lo, n));
}

/** Velocity (spreads/s) from samples inside the last VEL_WINDOW_MS. */
export function velocity(samples: readonly { t: number; f: number }[]): number {
	if (samples.length < 2) return 0;
	const last = samples[samples.length - 1];
	const first = samples.find((s) => last.t - s.t <= VEL_WINDOW_MS) ?? last;
	return last.t > first.t ? ((last.f - first.f) / (last.t - first.t)) * 1000 : 0;
}

export type KeyAction =
	| { a: 'openFull' } | { a: 'closeFull' } | { a: 'goto'; n: number } | { a: 'by'; n: number }
	| { a: 'overview'; on: boolean } | { a: 'focusFigure' } | { a: 'unfocus' } | { a: 'seek'; dt: number }
	| { a: 'resetZoom' } | { a: 'pulse' } | { a: 'none' };

/** Pure key map (4.1, 4.2, 4.5). */
export function keyAction(k: KeyIn, v: BookView): KeyAction {
	if (k.mod) return { a: 'none' };
	const key = k.key;
	if (key === 'Escape') {
		if (v.focus !== null) return { a: 'unfocus' };
		if (v.overview) return { a: 'overview', on: false };
		if (v.layer === 1) return { a: 'closeFull' };
		return { a: 'none' }; // the host closes the article
	}
	if (v.overview) return key === 'o' || key === 'O' ? { a: 'overview', on: false } : { a: 'none' };
	if (key === 'o' || key === 'O') return { a: 'overview', on: true };
	if (key === '0') return { a: 'resetZoom' };
	if (key === 'f' || key === 'F') return { a: 'focusFigure' };
	if (v.focus !== null) {
		if (key === 'ArrowRight') return { a: 'seek', dt: FIGURE_STEP_S };
		if (key === 'ArrowLeft') return { a: 'seek', dt: -FIGURE_STEP_S };
		return { a: 'none' };
	}
	if (key === 't' || key === 'T') return v.layer === 0 ? { a: 'openFull' } : { a: 'closeFull' };
	if (v.layer === 0) {
		if (key === 'Enter') return { a: 'openFull' };
		// arrows, space and paging never open the full text
		if (['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', ' ', 'PageDown', 'PageUp', 'End'].includes(key)) return { a: 'pulse' };
		return { a: 'none' };
	}
	switch (key) {
		case 'ArrowRight': case 'ArrowDown': case 'PageDown': return { a: 'by', n: 1 };
		case 'ArrowLeft': case 'ArrowUp': case 'PageUp': return { a: 'by', n: -1 };
		case ' ': return { a: 'by', n: k.shift ? -1 : 1 };
		case 'Home': return { a: 'closeFull' };
		case 'End': return { a: 'goto', n: v.spreads };
	}
	return { a: 'none' };
}

type Gesture =
	| { k: 'none' }
	| { k: 'peel'; startX: number; frac: number }
	| { k: 'scrub'; side: -1 | 1; x0: number; y0: number; f0: number; df: number; samples: { t: number; f: number }[] }
	| { k: 'figure'; id: number; w: number; dur: number; lastX: number; t: number; started: boolean; samples: { t: number; f: number }[] }
	| { k: 'select'; drag: SelDrag; started: boolean; n: number }
	| { k: 'tap' };

/** One controller per canvas. */
export class MagazineInput {
	private g: Gesture = { k: 'none' };
	private down: { id: number; x: number; y: number; moved: number; pt: PointerIn['spreadPoint'] } | null = null;
	// wheel scrub in progress (grabbed until idle)
	private wheel: { f: number; lastT: number; samples: { t: number; f: number }[] } | null = null;
	private lastClick = { t: -1e9, x: 0, y: 0 };
	private hovered: number | null = null;
	private hoverFig: number | null = null;
	/** the text selection (also held by the room for drawing) and the last press, for double and triple click */
	private sel: Sel | null = null;
	private press = { t: -1e9, x: 0, y: 0, n: 0 };

	constructor(private sink: BookSink, private view: () => BookView) {}

	get geometry(): Geom {
		return geom(this.view().narrow);
	}

	// ---- wheel / swipe ----

	wheelIn(w: WheelIn): Outcome {
		const v = this.view();
		if (w.ctrl) return 'zoom';
		if (v.overview) return 'handled';
		const k = w.mode === 1 ? 16 : w.mode === 2 ? w.pageH : 1;
		const dx = w.dx * k;
		const dy = w.dy * k;
		if (v.zoom > ZOOM_PAN) {
			this.sink.panBy(-(w.ndcDx ?? 0), w.ndcDy ?? 0);
			return 'handled';
		}
		if (v.layer === 0) {
			// a stray scroll never opens the full text: bounce and pulse once per gesture
			if (!this.wheel) {
				this.sink.bounce();
				this.sink.pulseTab();
				this.wheel = { f: 0, lastT: w.t, samples: [] };
			}
			this.wheel.lastT = w.t;
			return 'handled';
		}
		const horiz = Math.abs(dx) > Math.abs(dy);
		const df = horiz ? dx / Math.max(1, v.pxPerEm * geom(v.narrow).sheetW) : dy / WHEEL_PX;
		if (!this.wheel) {
			this.sink.grab(df >= 0 ? 1 : -1);
			this.wheel = { f: v.f, lastT: w.t, samples: [{ t: w.t, f: v.f }] };
		}
		this.wheel.f += df;
		this.wheel.lastT = w.t;
		this.wheel.samples.push({ t: w.t, f: this.wheel.f });
		this.wheel.samples = this.wheel.samples.filter((s) => w.t - s.t <= 4 * VEL_WINDOW_MS);
		this.sink.by(df);
		return 'handled';
	}

	/** Call once per frame: releases an idle wheel scrub. */
	tick(now: number) {
		const w = this.wheel;
		if (!w || now - w.lastT < WHEEL_IDLE_MS) return;
		this.wheel = null;
		const v = this.view();
		if (v.layer === 0) return;
		this.sink.release(velocity(w.samples.filter((s) => w.lastT - s.t <= VEL_WINDOW_MS)));
	}

	// ---- pointer ----

	pointerDown(p: PointerIn): Outcome {
		const v = this.view();
		this.down = { id: p.id, x: p.x, y: p.y, moved: 0, pt: p.spreadPoint };
		const sp = p.spreadPoint;
		this.g = { k: 'tap' };
		this.setSel(null);
		const near = p.t - this.press.t < 320 && Math.hypot(p.x - this.press.x, p.y - this.press.y) < 10;
		this.press = { t: p.t, x: p.x, y: p.y, n: near ? Math.min(3, this.press.n + 1) : 1 };
		if (!sp || v.overview || v.zoom > ZOOM_PAN) return 'ignore';
		const g = geom(v.narrow);
		if (v.layer === 0 && tabAt(g, sp.x, sp.y)) {
			this.g = { k: 'peel', startX: sp.x, frac: 0 };
			return 'handled';
		}
		// a horizontal drag inside a scrubbable figure scrubs its animation (pointer capture, momentum on release)
		const fig = v.focus === null ? figureAt(v.figures, sp.spread, sp.x, sp.y) : null;
		if (fig && scrubbable(fig) && !linkAt(v.links, sp.spread, sp.x, sp.y)) {
			this.g = { k: 'figure', id: fig.id, w: fig.x1 - fig.x0, dur: fig.duration, lastX: sp.x, t: v.figureTime(fig.id), started: false, samples: [{ t: p.t, f: 0 }] };
			return 'handled';
		}
		if (v.layer === 1) {
			const side = v.narrow ? 1 : marginSide(g, sp.x);
			if (side !== 0 && !linkAt(v.links, sp.spread, sp.x, sp.y)) {
				this.g = { k: 'scrub', side: side as -1 | 1, x0: sp.x, y0: sp.y, f0: v.f, df: 0, samples: [{ t: p.t, f: v.f }] };
			}
		}
		// a mouse or pen press on text starts a selection (a touch press keeps panning and turning); a plain click still follows links
		if (this.g.k === 'tap' && p.type !== 'touch' && v.text && v.focus === null) {
			const c = caretAt(v.text, sp.spread, sp.x, sp.y, 0.05);
			if (c) {
				const n = this.press.n;
				const [a0, a1] = n >= 3 ? lineRange(c.line) : n === 2 ? wordRange(v.text, c.offset) : [c.offset, c.offset];
				const drag: SelDrag = { spread: sp.spread, unit: n >= 3 ? 'line' : n === 2 ? 'word' : 'char', a0, a1 };
				this.g = { k: 'select', drag, started: n >= 2, n };
				if (n >= 2) this.setSel({ spread: sp.spread, lo: a0, hi: a1 });
				return 'handled';
			}
		}
		return 'ignore';
	}

	private setSel(s: Sel | null) {
		if (!s && !this.sel) return;
		this.sel = s && s.hi > s.lo ? s : null;
		this.sink.select?.(this.sel);
	}

	/** Drop the selection (a turn, Escape, a click elsewhere). */
	clearSelection() {
		this.setSel(null);
	}

	/** Exact plain text of the selection ('' when none). */
	selectedText(): string {
		const m = this.view().text;
		return this.sel && m ? textOf(m, this.sel.lo, this.sel.hi) : '';
	}

	get selection(): Sel | null {
		return this.sel;
	}

	pointerMove(p: PointerIn): Outcome {
		const v = this.view();
		const d = this.down;
		const sp = p.spreadPoint;
		if (!d || d.id !== p.id) {
			this.hovered = sp ? (linkAt(v.links, sp.spread, sp.x, sp.y)?.kind ?? null) : null;
			const hf = sp && !v.overview && v.focus === null && v.zoom <= ZOOM_PAN ? figureAt(v.figures, sp.spread, sp.x, sp.y) : null;
			const id = hf && scrubbable(hf) ? hf.id : null;
			if (id !== this.hoverFig) this.sink.figureHover((this.hoverFig = id));
			return 'ignore';
		}
		d.moved += Math.abs(p.x - d.x) + Math.abs(p.y - d.y);
		d.x = p.x;
		d.y = p.y;
		const g = geom(v.narrow);
		if (this.g.k === 'select') {
			const s = this.g;
			if (!s.started && d.moved <= CLICK_PX) return 'handled';
			s.started = true;
			if (sp && sp.spread === s.drag.spread && v.text) {
				// while dragging the nearest line wins, so the pointer may leave the text and the selection follows
				const c = caretAt(v.text, sp.spread, sp.x, sp.y);
				if (c) this.setSel(extend(v.text, s.drag, c.offset, c.line));
			}
			return 'handled';
		}
		if (this.g.k === 'figure') {
			const s = this.g;
			if (!sp || (!s.started && d.moved <= CLICK_PX)) return 'handled';
			if (!s.started) {
				s.started = true;
				this.sink.figureScrubBegin(s.id);
			}
			// dragging across the figure's width scrubs the whole timeline
			const dt = ((sp.x - s.lastX) / Math.max(1e-3, s.w)) * s.dur;
			s.lastX = sp.x;
			s.t += dt;
			s.samples.push({ t: p.t, f: s.t });
			this.sink.figureScrubBy(s.id, dt);
			return 'handled';
		}
		if (this.g.k === 'peel' && sp) {
			this.g.frac = peelFrac(g, this.g.startX, sp.x);
			this.sink.cornerDrag(this.g.frac);
			return 'handled';
		}
		if (this.g.k === 'scrub' && sp && d.moved > CLICK_PX) {
			const s = this.g;
			if (s.samples.length === 1) this.sink.grab(v.narrow ? 1 : s.side);
			// narrow: vertical swipe over the sheet height; wide: horizontal drag from the outer margin over the sheet width
			const raw = v.narrow ? (s.y0 - sp.y) / g.h : ((s.side === 1 ? s.x0 - sp.x : sp.x - s.x0) / g.sheetW);
			const df = raw - s.df;
			s.df = raw;
			s.samples.push({ t: p.t, f: s.f0 + raw });
			this.sink.by(df);
			return 'handled';
		}
		return 'ignore';
	}

	/** `cancel` for pointercancel. Returns what to do; clicks resolve to commands here. */
	pointerUp(p: PointerIn, cancel = false): Outcome {
		const v = this.view();
		const d = this.down;
		const g = this.g;
		this.down = null;
		this.g = { k: 'none' };
		if (!d || d.id !== p.id) return 'ignore';
		const sp = p.spreadPoint;
		const click = !cancel && d.moved <= CLICK_PX;
		if (g.k === 'select') {
			if (g.started || cancel) return 'handled';
			// a click without a drag: the selection was cleared on press; links and the rest resolve as clicks
			if (!sp) return 'ignore';
			return this.click(v, sp, p.t, p.x, p.y);
		}
		if (g.k === 'figure' && g.started) {
			this.sink.figureScrubEnd(g.id, cancel ? 0 : velocity(g.samples));
			return 'handled';
		}
		if (g.k === 'peel') {
			if (click && sp && tabAt(geom(v.narrow), sp.x, sp.y)) {
				this.sink.cornerRelease(false);
				this.sink.openFull(1);
			} else this.sink.cornerRelease(!cancel && g.frac >= PEEL_OPEN);
			return 'handled';
		}
		if (g.k === 'scrub' && g.samples.length > 1) {
			this.sink.release(cancel ? 0 : velocity(g.samples));
			return 'handled';
		}
		if (!click || !sp) return 'ignore';
		return this.click(v, sp, p.t, p.x, p.y);
	}

	private click(v: BookView, sp: { spread: number; x: number; y: number }, t: number, cx: number, cy: number): Outcome {
		const g = geom(v.narrow);
		const dbl = t - this.lastClick.t < 320 && Math.hypot(cx - this.lastClick.x, cy - this.lastClick.y) < 10;
		this.lastClick = { t, x: cx, y: cy };
		if (v.focus !== null) {
			if (dbl) this.sink.focusFigure(null);
			return 'handled';
		}
		const link = linkAt(v.links, sp.spread, sp.x, sp.y);
		if (link) {
			this.sink.follow(link);
			return 'handled';
		}
		const fig = figureAt(v.figures, sp.spread, sp.x, sp.y);
		if (fig && dbl) {
			this.sink.focusFigure(fig.id);
			return 'handled';
		}
		if (v.layer === 1 && tabAt(g, sp.x, sp.y) && Math.round(v.f) === 1) {
			this.sink.closeFull();
			return 'handled';
		}
		if (folioAt(g, sp.x, sp.y)) {
			this.sink.overview(true);
			return 'handled';
		}
		if (v.layer === 1) {
			const e = edgeAt(g, sp.x, sp.y);
			if (e !== 0) {
				this.sink.goto(Math.min(v.spreads, Math.max(1, Math.round(v.f) + e)));
				return 'handled';
			}
		}
		if (dbl) {
			this.sink.resetZoom();
			return 'handled';
		}
		return 'ignore';
	}

	/** Click in the overview, normalised viewport coordinates. */
	overviewClick(nx: number, ny: number): Outcome {
		const v = this.view();
		const s = v.overviewAt(nx, ny);
		this.sink.overview(false);
		if (s === null) return 'handled';
		if (s === 0) this.sink.goto(0);
		else this.sink.openFull(s);
		return 'handled';
	}

	// ---- keys ----

	keyIn(k: KeyIn): Outcome {
		const v = this.view();
		if (k.key === 'Escape' && this.sel) return (this.setSel(null), 'handled');
		const a = keyAction(k, v);
		switch (a.a) {
			case 'openFull': this.sink.openFull(1); break;
			case 'closeFull': this.sink.closeFull(); break;
			case 'goto': this.sink.goto(a.n); break;
			case 'by': this.sink.goto(Math.min(v.spreads, Math.max(1, Math.round(v.f) + a.n))); break;
			case 'overview': this.sink.overview(a.on); break;
			case 'focusFigure': {
				const id = this.hovered !== null && v.figures.some((f) => f.id === this.hovered) ? this.hovered : v.figures.find((f) => f.spread === Math.round(v.f))?.id;
				if (id !== undefined) this.sink.focusFigure(id);
				break;
			}
			case 'unfocus': this.sink.focusFigure(null); break;
			case 'seek': if (v.focus !== null) this.sink.seekFigure(v.focus, Math.max(0, v.figureTime(v.focus) + a.dt)); break;
			case 'resetZoom': this.sink.resetZoom(); break;
			case 'pulse': this.sink.bounce(); this.sink.pulseTab(); break;
			case 'none': return 'ignore';
		}
		return 'handled';
	}

	/** Double-click handler for hosts that get a native dblclick: figure focus, else reset zoom. */
	doubleClick(sp: { spread: number; x: number; y: number } | null): Outcome {
		const v = this.view();
		if (v.focus !== null) return (this.sink.focusFigure(null), 'handled');
		const fig = sp && figureAt(v.figures, sp.spread, sp.x, sp.y);
		if (fig) return (this.sink.focusFigure(fig.id), 'handled');
		this.sink.resetZoom();
		return 'handled';
	}
}
