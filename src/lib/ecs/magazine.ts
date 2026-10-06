// Typed wrapper over the magazine exports of the Flecs wasm module (docs/MAGAZINE.md section 5), plus the
// spec the Rust side (world/src/reader.rs, owned by the ECS lane) implements. JS owns no runtime state:
// every gesture ends in one of these calls and the spring, turn and peel systems run in Flecs.
//
// ---- Components (plain #[repr(C)], f32/u32; on the Article entity, Figure entities are its children) ----
//   Spread   { f, target, vel, layer }          f: 0 = distilled, 1..N = full text spreads; layer: 0 | 1
//   Corner   { drag, open }                     the "Full text" peel, drag 0..1 of the sheet width, open 0 | 1
//   Turn     { progress, dir, grabbed }         leaf in motion, progress 0..1, dir -1 | 1, grabbed 0 | 1
//   Figure   { id, t, rate, mode, focus }       child of the Article; t in seconds, mode as FigureMode in format.ts
//   Overview { t }                              0 closed .. 1 lay-flat contact grid (spring)
//   Bounce   { x, pulse }                       rubber band on layer 0 and the tab pulse (both decay to 0)
//
// ---- Systems -------------------------------------------------------------------------------------------
//   SpreadSpring   critically damped, omega = 11 rad/s, toward Spread.target; while Turn.grabbed it is off
//                  and by() moves f directly. f is clamped to [lo, hi] with lo = layer 0 ? 0 : 1, hi = layer 0 ? 0 : N.
//   TurnProgress   Turn.progress = frac(f) (dir by sign of the last by()); clears grabbed on release
//   CornerSpring   when not dragging, Corner.drag springs to 0 (release below 25%) or to 1 then fires open_full
//   LayerSwitch    open_full(n) sets layer 1, target n and uploads layer-1 items on first open (JS side event),
//                  close_full() sets target 0 then layer 0 when the reversed turn lands
//   FigureClock    advances Figure.t only for figures on the current or turning spread; honours loop|once|scrub|static
//                  and reduced motion (mode forced to static, t = poster); focus pauses nothing
//   BounceDecay    Bounce.x and Bounce.pulse decay with half-life 120 ms
//
// ---- Wasm exports (C ABI) -----------------------------------------------------------------------------
//   spread_init(n_full: u32)                    N full text spreads of the resident article, resets Spread
//   spread_goto(n: u32)                         spring to spread n; n = 0 closes the full layer (same as close_full)
//   spread_by(df: f32)                          f += df (scrub while grabbed; else moves the target, clamped)
//   spread_grab(dir: i32)                       Turn.grabbed = 1, dir -1 | 1
//   spread_release(vel: f32)                    flick rule: |vel| > 1.2 spreads/s goes one spread in the flick direction
//                                               (floor(f)+1 or ceil(f)-1), else round(f); clamped; grabbed = 0
//   open_full(n: u32), close_full()
//   corner_drag(frac: f32), corner_release(open: u32)
//   bounce(), pulse_tab()
//   figure_focus(id: i32)                       -1 clears
//   figure_seek(id: u32, t: f32)
//   figure_define(id, spread, mode, duration, poster)   declare one figure of the resident article (call after spread_init)
//   set_reduced_motion(on)                      figures pin their poster time
//   overview_set(on: u32)
//   figure_clock_ptr() -> *const f32            Figure.t per figure index, as the channel evaluator reads them
//   magazine_state_ptr() -> *const f32          MAG_STATE_LEN floats, layout MagState below
//
// Events through event_poll() (existing queue, new kinds): SpreadChanged(n) = 5, LayerOpened = 6, LayerClosed = 7,
// FigureFocus(id) = 8, OverviewChanged(on) = 9.
import { parseHash, formatHash, type Place } from '../magazine/hit';
import type { BookSink, BookView } from '../magazine/input';
import type { FigureRec, LinkRec } from '../magazine/hit';

export const MAG_STATE_LEN = 16;
/** Float index of each field in magazine_state_ptr(). */
export const MagState = {
	f: 0, target: 1, vel: 2, layer: 3,
	cornerDrag: 4, cornerOpen: 5,
	turnProgress: 6, turnDir: 7, turnGrabbed: 8,
	overview: 9, focus: 10, // focus: figure id, -1 none
	bounceX: 11, tabPulse: 12,
	spreads: 13, // N
	hover: 15 // figure id under the pointer, -1 none
} as const;

export interface MagazineExports {
	memory: WebAssembly.Memory;
	spread_init(n: number): void;
	spread_goto(n: number): void;
	spread_by(df: number): void;
	spread_grab(dir: number): void;
	spread_release(vel: number): void;
	open_full(n: number): void;
	close_full(): void;
	corner_drag(frac: number): void;
	corner_release(open: number): void;
	bounce(): void;
	pulse_tab(): void;
	figure_focus(id: number): void;
	figure_seek(id: number, t: number): void;
	figure_hover(id: number): void;
	figure_scrub_begin(id: number): void;
	figure_scrub_by(id: number, dt: number): void;
	figure_scrub_end(id: number, vel: number): void;
	book_settled(on: number): void;
	figure_clock_len(): number;
	figure_define(id: number, spread: number, mode: number, duration: number, poster: number): void;
	set_reduced_motion(on: number): void;
	overview_set(on: number): void;
	figure_clock_ptr(): number;
	magazine_state_ptr(): number;
}

/** What the host supplies for things Flecs does not own. */
export interface MagazineHost {
	/** per-article data from the RDR2 binary, JS side */
	links(): readonly LinkRec[];
	figures(): readonly FigureRec[];
	narrow(): boolean;
	zoom(): number;
	pxPerEm(): number;
	overviewAt(nx: number, ny: number): number | null;
	follow(l: LinkRec): void;
	resetZoom(): void;
	panBy(dx: number, dy: number): void;
	/** reflect the place into the URL (history.replaceState), called on SpreadChanged and layer changes */
	setHash?(hash: string): void;
	/** laid-out text for selection, and the highlight sink */
	text?(): import('../magazine/select').TextModel | null;
	select?(s: import('../magazine/select').Sel | null): void;
}

export interface Magazine {
	sink: BookSink;
	view: () => BookView;
	/** read the Flecs state; re-derived each call because wasm memory growth detaches old views */
	state(): Float32Array;
	/** apply a deep link: `#s3`, `#full`, `#full/s3`. Returns false when the fragment does not name a spread. */
	applyHash(hash: string): boolean;
	/** call after SpreadChanged / LayerOpened / LayerClosed events */
	syncHash(): void;
	/** after loading an article: tell Flecs N */
	init(spreads: number): void;
}

export function createMagazine(x: MagazineExports, host: MagazineHost): Magazine {
	const state = () => new Float32Array(x.memory.buffer, x.magazine_state_ptr(), MAG_STATE_LEN);
	const place = (): Place => {
		const s = state();
		return { layer: s[MagState.layer] >= 1 ? 1 : 0, spread: Math.round(s[MagState.f]) };
	};
	const fig = () => new Float32Array(x.memory.buffer, x.figure_clock_ptr(), x.figure_clock_len());

	const sink: BookSink = {
		goto: (n) => x.spread_goto(n),
		by: (df) => x.spread_by(df),
		grab: (d) => x.spread_grab(d),
		release: (v) => x.spread_release(v),
		cornerDrag: (f) => x.corner_drag(f),
		cornerRelease: (o) => x.corner_release(o ? 1 : 0),
		openFull: (n) => x.open_full(n),
		closeFull: () => x.close_full(),
		bounce: () => x.bounce(),
		pulseTab: () => x.pulse_tab(),
		focusFigure: (id) => x.figure_focus(id ?? -1),
		seekFigure: (id, t) => x.figure_seek(id, t),
		figureHover: (id) => x.figure_hover(id ?? -1),
		figureScrubBegin: (id) => x.figure_scrub_begin(id),
		figureScrubBy: (id, dt) => x.figure_scrub_by(id, dt),
		figureScrubEnd: (id, vel) => x.figure_scrub_end(id, vel),
		overview: (on) => x.overview_set(on ? 1 : 0),
		follow: (l) => host.follow(l),
		resetZoom: () => host.resetZoom(),
		panBy: (dx, dy) => host.panBy(dx, dy),
		select: (s) => host.select?.(s)
	};

	const view = (): BookView => {
		const s = state();
		return {
			f: s[MagState.f],
			layer: s[MagState.layer] >= 1 ? 1 : 0,
			spreads: s[MagState.spreads] | 0,
			zoom: host.zoom(),
			narrow: host.narrow(),
			overview: s[MagState.overview] > 0.5,
			focus: s[MagState.focus] >= 0 ? s[MagState.focus] | 0 : null,
			pxPerEm: host.pxPerEm(),
			links: host.links(),
			figures: host.figures(),
			text: host.text?.() ?? null,
			overviewAt: host.overviewAt,
			figureTime: (id) => fig()[id] ?? 0
		};
	};

	return {
		sink,
		view,
		state,
		init: (n) => x.spread_init(n),
		applyHash(hash) {
			const p = parseHash(hash, state()[MagState.spreads] | 0);
			if (!p) return false;
			if (p.layer === 0) x.spread_goto(0);
			else x.open_full(p.spread);
			return true;
		},
		syncHash() {
			host.setHash?.(formatHash(place()));
		}
	};
}
