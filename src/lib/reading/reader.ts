
// The reader core (docs/READING_GPU.md): one fixed canvas drawn by the page pass, the Flecs ReadingModule (wasm) owning reading
// state AND scrolling, GPU-drawn chrome, in-engine selection / find / links. No DOM page content (docs/READING.md).
// No scrolling DOM, no DOM text layer, no DOM chrome.
import './reader.css';
import { goto, pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { BlockKind, BlockFlag, LinkKind, stringAt, type ReadingModel } from '$lib/magazine/format';
import { INPUT, POINTER_KIND, RD, SCROLL_MODE, XS, type Reading, type ReadingEventKind } from './abi';
import type { Overlay, PageFrame, PagePass } from './page-api';
import { createPagePass } from './page';
import { loadReadingOnly } from '$lib/ecs/reading';
import { loadArticle, type LoadedArticle } from './load';
import { barPxFor, cubicBezier, emPxFor, originXFor, scaleSteps, snapScale, widthClassFor, DEFAULT_SCALE } from './metrics';
import { createScrollState, layoutToDocY, readHistoryState, type SavedState, type ScrollController } from './scrollstate';
import { attachScroll, pointerWord } from './input';
import { createExhibitDrawer, createRouter, evalTimelineChannels, exhibitId, exhibitSource, keyMods, loadExhibits, mappingOf, routeKey, toLocal, xkeyOf, type RouteResult } from './exhibit';
import { fromBlob, keepExhibitFragment, parseExhibitFragment, setExhibitFragment, toBlob } from './exhibit-fragment';
import { THEME, SYNTAX_ORDER } from './theme';
import { codeText, imageAlt } from './modeltext';
import { hitTest, caretAt, type Hit, type ViewOpts } from './hit';
import { joinRows, shapeRows, sweepWidth, PULSE_MS, SELECTION_RGB, type Row } from './selshape';
import { press, dragTo, selectAll, selectionRects, copyText, selEmpty, selLo, selHi, type Gesture, type Sel } from './select';
import { findInModel, nextHit, prevHit, hitFrom, rangesToRects, type FindHit } from './find';
import { buildChrome, createChromeAnim } from './ui/widgets';
import { DUR } from './ui/motion';
import { hitChrome } from './ui/hit';
import { linkTipContent } from './linktip';
import { codeTipOf, codeTipInfo, codeTokenAt, type CodeToken } from './codetip';
import type { ChromeState, ChromeInput, HitRect, KeyEvent, Rect, FindState, CodeBlockInfo, ToastInfo } from './ui/layout';
import { newScrollbar, scrollbarFrame, scrollbarDragStart, scrollbarDragTo, scrollbarTrackClick } from './ui/scrollbar';
import { loadUiTables, setUiTables, shapeUi } from './ui/text';
import type { ScrollbarInput, UiGlyph } from './ui/types';
import { createFilm, type Film, type FilmOut } from '$lib/film/film';
import { attachFilmHot, filmSource, hasFilm } from '$lib/film/source';


/** The reader controller (docs/READING_GPU.md): plain TypeScript, no framework. A Svelte component only mounts it. */
export interface ReaderInit { slug: string; mode: 'only' | 'world'; fromWorld?: boolean; reading?: Reading; onClose?: () => void }
export interface ReaderHandle { setSlug(slug: string): void; dispose(): void }

function closeArticle(): void {
	if (typeof history !== 'undefined' && (history.state as { fromWorld?: boolean } | null)?.fromWorld) history.back();
	else void goto('/');
}

export function createReader(rootEl: HTMLElement, init: ReaderInit): ReaderHandle {

	let slug = init.slug;
	const mode = init.mode;
	let fromWorld = init.fromWorld ?? false;
	const readingProp = init.reading;
	const onClose = init.onClose;
	const root: HTMLElement | null = rootEl;
	let ready = false;
	let mounted = false;
	let cls = 0;
	let title = '';
	/** the root element's attributes mirror the reader's state (tests and CSS read them) */
	function publish() {
		rootEl.dataset.mode = mode;
		rootEl.dataset.class = String(cls);
		rootEl.dataset.ready = String(ready);
	}

	// ---- runtime (plain variables: nothing here drives the template) ----
	const dev = import.meta.env.DEV;
	const ENTER_MS = 480;
	const enterEase = cubicBezier(0.2, 0.7, 0.2, 1);
	const PARALLAX_PX = 7;
	let pass: PagePass | null = null;
	let reading: Reading | null = null;
	let art: LoadedArticle | null = null;
	let model: ReadingModel | null = null;
	let scrollSt: ScrollController | null = null;
	let viewW = 0, viewH = 0, dpr = 1, emPx = 18, originX = 0, barPx = 40;
	let scale = DEFAULT_SCALE;
	let foldExpanded = false;
	let reduced = false;
	let loadedOnce = false;
	let raf = 0, lastT = 0, genToken = 0, disposed = false;
	let lastY = -1e9, lastClip = -1;
	let needDraw = true, firstDraw = true, restoredScroll = false;
	let lastSection = -2, lastReadBlock = -2;
	let hdrGain = 1;
	const theme = THEME;
	const accent = THEME.accent as unknown as [number, number, number];
	const eventCbs = new Set<(k: ReadingEventKind, a: number) => void>();
	let articleDisposers: (() => void)[] = [];
	const devHook = { frame: null as null | ((f: PageFrame) => void) };
	const counters = { frames: 0, draws: 0, skipped: 0, lastDrawMs: 0 };

	// per-frame reusable state
	const chans = new Float32Array(256);
	const overlays: Overlay[] = [];
	const pool: Overlay[] = [];
	let poolN = 0;
	const blockAlpha = new Map<number, number>();
	const blockDy = new Map<number, number>();
	const blockDx = new Map<number, number>();
	const frame: PageFrame = {
		scrollPx: 0, emPx: 18, originX: 0, originY: 0, viewW: 0, viewH: 0, dpr: 1,
		visFirst: 0, visCount: 0, noteFirst: 0, noteCount: 0, foldClipEm: 0, foldFadeEm: 3.24, chans,
		groundA: 1, ground: { x0: 0, y0: 0, x1: 0, y1: 0, radius: 0 }, blockAlpha, blockDy, blockDx, overlays,
		hdrGain: 1, time: 0, dirty: true
	};
	let enterState = new Uint8Array(0); // 0 waiting, 1 animating, 2 done
	let enterStart = new Float64Array(0);
	let enterBlocks: number[] = [];
	let foldBlockIdx = -1;
	let codeBlocks: number[] = [];
	const codeDx = new Map<number, number>();

	// ---- interaction state ----
	let ptr: { x: number; y: number } | null = null;
	let ptrType = 'mouse';
	let primaryDown = false;
	let captured: string | null = null;
	let dragKind: 'select' | 'thumb' | null = null;
	let thumbGrab = 0;
	let gesture: Gesture | null = null;
	let sel: Sel | null = null;
	let downAt: { x: number; y: number; hit: Hit; chrome: HitRect | null; moved: boolean } | null = null;
	let lastClickT = 0, clickCount = 0;
	let hoverHit: Hit | null = null;
	let hoverBlockSent = -1;
	let focusLinkIdx = -1;
	let washBlock = -1, washT0 = 0;
	let aaOpen = false;
	let popover: { ref: number; link: number } | null = null;
	let popTimer: ReturnType<typeof setTimeout> | undefined;
	/** link preview card: the link shown (after a 150 ms delay), -1 hidden */
	let tipLink = -1;
	/** code hover: the token under the pointer (wash at once), and whether its tip is out (after the intent pause; once one is out, hops retarget at once) */
	let codeTok: CodeToken | null = null;
	let codeTipOn = false;
	let codeTipTimer: ReturnType<typeof setTimeout> | undefined;
	const sameTok = (a: CodeToken | null, b: CodeToken | null) => a === b || (!!a && !!b && a.line === b.line && a.g0 === b.g0);
	function setCodeTok(t: CodeToken | null) {
		if (sameTok(t, codeTok)) return;
		codeTok = t;
		clearTimeout(codeTipTimer);
		const tipped = !!t && codeTipOf(t) !== null;
		if (!tipped) codeTipOn = false;
		else if (!codeTipOn) codeTipTimer = setTimeout(() => { codeTipOn = true; needDraw = true; }, DUR.codeIntent);
		needDraw = true;
	}
	let tipTimer: ReturnType<typeof setTimeout> | undefined;
	function setTip(li: number, delay: number = DUR.linkIntent) {
		clearTimeout(tipTimer);
		if (li === tipLink) return;
		if (li < 0) { tipLink = -1; needDraw = true; return; }
		tipLink = -1;
		tipTimer = setTimeout(() => { tipLink = li; needDraw = true; }, delay);
		needDraw = true;
	}
	let lightbox: { block: number; imageId: number; w: number; h: number; caption: string; em: { x0: number; y0: number; x1: number; y1: number } } | null = null;
	const find: FindState = { open: false, query: '', caret: 0, count: 0, index: 0 };
	let findHits: FindHit[] = [];
	let findCur = -1;
	const toasts: ToastInfo[] = [];
	let toastId = 0;
	const copyFlash: Record<number, number> = {};
	/** the copy acknowledgment in progress (ix copy-flash): the selection it covers and when it started */
	let flash: { t0: number; lo: number; hi: number } | null = null;
	let pendingKeys: KeyEvent[] = [];
	let lastChromeHits: HitRect[] = [];
	let chromeCursor = '';
	let chromeAnimating = false;
	let cs: ChromeState | null = null;
	const sbState = { v: newScrollbar() };
	let sbInput: ScrollbarInput | null = null;
	let canvasEl: HTMLCanvasElement | null = null;
	// exhibits (exhibit.ts): the draw builder, the pointer state machine, the OS cursor they asked for, and the URL fragment debounce
	const exDrawer = createExhibitDrawer();
	const exDirty = new Set<number>();
	let exTimer: ReturnType<typeof setTimeout> | undefined;
	let exCursor: string | null = null;
	let exIds: string[] = [];
	let routed: { e: Event; r: RouteResult } | null = null;
	let hotOff: (() => void) | null = null;
	// the narrated film (src/lib/film): a mode of the article; the reader is one key away (R), the film comes back with F
	let filmCtl: Film | null = null;
	let filmMode = false;
	let filmCursor: string | null = null;
	let filmHotOff: (() => void) | null = null;
	let filmGen = 0;
	const filmOut: FilmOut = { overlays, uiText: [] as UiGlyph[], exhibits: [], cursor: null, animating: false };
	const swallowed = (e: Event): boolean => routed !== null && routed.e === e && routed.r.swallow;

	const ov = (x: number, y: number, w: number, h: number, radius: number, r: number, g: number, b: number, a: number, hdr?: number): Overlay => {
		let o = pool[poolN];
		if (!o) pool[poolN] = o = { x: 0, y: 0, w: 0, h: 0, radius: 0, r: 0, g: 0, b: 0, a: 0 };
		poolN++;
		o.x = x; o.y = y; o.w = w; o.h = h; o.radius = radius; o.r = r; o.g = g; o.b = b; o.a = a; o.hdr = hdr;
		overlays.push(o);
		return o;
	};

	// ---- geometry ----

	const curY = () => (reading ? reading.state()[RD.scrollY] : 0);
	const clipEm = () => (reading ? reading.state()[RD.foldClipEm] || (model ? model.foldY + model.foldH : 0) : 0);
	const viewOpts = (): ViewOpts => ({ clipEm: clipEm(), codeDx: (b) => codeDx.get(b) ?? 0 });
	/** displayed-document em point of a viewport point */
	const toDocX = (px: number) => (px - originX) / emPx;
	const toDocY = (py: number) => (py + curY()) / emPx;
	const docXPx = (xEm: number) => originX + xEm * emPx;
	const layoutYPx = (yEm: number) => layoutToDocY(model!, yEm, clipEm()) * emPx - curY();

	function computeMetrics() {
		const m = model!;
		const docW = m.docX1 - m.docX0;
		emPx = emPxFor(viewW, cls, scale, docW, m.colW);
		originX = originXFor(viewW, emPx, m.docX0, m.docX1);
		barPx = barPxFor(cls);
	}

	function relayout(restoreKey: SavedState | null) {
		if (!model || !reading || !pass) return;
		computeMetrics();
		reading.setViewport(viewW, viewH, dpr, emPx, cls);
		pass.resize(viewW, viewH, dpr);
		reading.tick(0);
		if (restoreKey) scrollSt?.restore({ ...restoreKey, fold: false });
		needDraw = true;
	}

	// ---- fold ----

	function setFold(open: boolean, instant = false) {
		if (!reading || !model) return;
		if (model.foldH <= 0 || foldExpanded === open) return;
		foldExpanded = open;
		const inst = instant || reduced;
		reading.input(INPUT.foldSet, open ? 1 : 0, inst ? 1 : 0);
		try { localStorage.setItem(`reader:fold:${slug}`, open ? '1' : '0'); } catch { /* private mode */ }
		if (inst) reading.tick(0);
		if (!open) {
			const k = scrollSt?.key();
			if (k && model.blocks[k.blockId] && (model.blocks[k.blockId].flags & BlockFlag.folded) && foldBlockIdx >= 0) scrollSt?.scrollToBlock(foldBlockIdx, false);
		}
		// the find hits depend on what is reachable
		needDraw = true;
	}

	// ---- article lifecycle ----

	function teardownArticle() {
		for (const d of articleDisposers) d();
		articleDisposers = [];
		scrollSt?.dispose();
		scrollSt = null;
		sel = null; gesture = null; popover = null; tipLink = -1; clearTimeout(tipTimer); codeTok = null; codeTipOn = false; clearTimeout(codeTipTimer); lightbox = null; findHits = []; findCur = -1;
		find.open = false; aaOpen = false; focusLinkIdx = -1;
		clearTimeout(exTimer); exDirty.clear(); exCursor = null; routed = null; router.clearFocus();
		stopFilm();
	}

	function readFoldPref(a: LoadedArticle): boolean {
		const hs = readHistoryState();
		if (hs) return hs.fold;
		if (location.hash === '#full') return true;
		try {
			if (localStorage.getItem('reader:fold:all') === '1') return true;
			const v = localStorage.getItem(`reader:fold:${slug}`);
			if (v !== null) return v === '1';
		} catch { /* private mode */ }
		return a.meta.opensFull || a.model.foldH <= 0;
	}

	async function openArticle(target: number, key: SavedState | null) {
		const my = ++genToken;
		const fresh = key === null;
		const initial = !loadedOnce;
		const wantSlug = slug;
		let a: LoadedArticle;
		try {
			a = await loadArticle(wantSlug, target);
		} catch (e) {
			console.error('reader: load failed', e);
			return;
		}
		if (my !== genToken || disposed || !root) return;
		try {
			if (!pass) {
				pass = await createPagePass(null, { alpha: mode === 'only' ? 'opaque' : 'premultiplied', debug: dev });
				if (my !== genToken || disposed) { pass.dispose(); pass = null; return; }
				canvasEl = pass.canvas;
				canvasEl.classList.add('page');
				canvasEl.style.pointerEvents = 'auto';
				canvasEl.setAttribute('aria-hidden', 'true');
				root.prepend(canvasEl);
				attachCanvasInput(canvasEl);
			}
			reading = readingProp ?? (await loadReadingOnly());
			await pass.load(a.fonts, a.model, a.imageUrls);
			setUiTables(loadUiTables(a.fonts));
		} catch (e) {
			console.error('reader: page pass failed', e);
			window.__gpuError?.();
			return;
		}
		if (my !== genToken || disposed || !pass || !reading || !root) return;

		const carry = key && model ? snapshotExhibits() : null; // a width-class reload keeps each exhibit's state
		teardownArticle();
		art = a;
		model = a.model;
		cls = a.widthClass;
		title = a.meta.title;
		loadedOnce = true;
		if (fresh) foldExpanded = readFoldPref(a);
		if (model.foldH <= 0) foldExpanded = true;
		foldBlockIdx = model.blocks.findIndex((b) => b.kind === BlockKind.fold);

		codeBlocks = [];
		enterBlocks = [];
		model.blocks.forEach((b, i) => {
			if (b.kind === BlockKind.code) codeBlocks.push(i);
			if (b.kind === BlockKind.exhibit || b.kind === BlockKind.image || b.kind === BlockKind.pullquote || b.kind === BlockKind.label) enterBlocks.push(i);
		});
		enterState = new Uint8Array(model.blocks.length);
		enterStart = new Float64Array(model.blocks.length);
		codeDx.clear();

		reading.load(model);
		loadAndRestoreExhibits(carry);
		computeMetrics();
		reading.setViewport(viewW, viewH, dpr, emPx, cls);
		reading.input(INPUT.reducedMotion, reduced ? 1 : 0);
		reading.input(INPUT.foldSet, foldExpanded ? 1 : 0, 1);
		reading.scroll.scrollTo(0, false);
		reading.tick(0);
		pass.resize(viewW, viewH, dpr);
		lastY = -1e9;
		lastSection = -2; lastReadBlock = -2;

		scrollSt = createScrollState({
			getScrollY: curY,
			scrollTo: (top, smooth) => { reading!.scroll.scrollTo(top, smooth && !reduced); needDraw = true; },
			wash: (b) => { washBlock = b; washT0 = performance.now(); needDraw = true; },
			getModel: () => model!,
			getEmPx: () => emPx,
			getClipEm: clipEm,
			getBarPx: () => barPx,
			isFoldExpanded: () => foldExpanded,
			setFold,
			syncLayout: () => { reading!.tick(0); },
			reduced: () => reduced,
			scale: () => scale,
			fromWorld: () => fromWorld,
			replaceHash: (h) => { try { replaceState(location.pathname + location.search + keepExhibitFragment(h, location.hash), page.state); } catch { /* router not ready */ } },
			pushHash: (h) => { try { pushState(location.pathname + location.search + keepExhibitFragment(h, location.hash), page.state); } catch { /* router not ready */ } }
		});

		restoredScroll = false;
		if (key) restoredScroll = scrollSt.restore(key);
		else if (initial && scrollSt.restoreFromHistory()) restoredScroll = true;
		else if (initial && location.hash && scrollSt.goToHash(location.hash, { smooth: false })) restoredScroll = true;

		ready = true;
		publish();
		firstDraw = true;
		needDraw = true;
		if (find.query) runFind(false);
		void startFilm(my);
	}

	// ---- the narrated film ----

	const wantsReader = (): boolean => new URLSearchParams(location.search).has('read');
	function setReadParam(on: boolean) {
		const u = new URL(location.href);
		if (on) u.searchParams.set('read', '1'); else u.searchParams.delete('read');
		try { replaceState(u.pathname + u.search + u.hash, page.state); } catch { /* router not ready */ }
	}
	function stopFilm() {
		filmGen++;
		filmHotOff?.(); filmHotOff = null;
		filmCtl?.dispose(); filmCtl = null;
		filmMode = false;
		filmCursor = null;
	}
	async function startFilm(my: number) {
		if (!hasFilm(slug) || !reading || !model) return;
		const gen = ++filmGen;
		const src = await filmSource(slug);
		if (!src || gen !== filmGen || my !== genToken || disposed || !reading || !model) return;
		const rd = reading, m = model;
		const f = createFilm({
			slug, film: rd.film, exhibit: rd.exhibit, model: m, exIds, text: exDrawer.text,
			resetExhibit(ex) { const e = rd.exhibit.load(ex, exhibitSource(m, ex)); if (e) reportExhibitError(`${slug}/${exIds[ex]}: ${e}`); },
			call(ex, kind, xe, ye, b, mods) { needDraw = true; return rd.exhibit.pointer(ex, kind, xe, ye, b, mods); },
			focus(ex) { rd.exhibit.focus(ex); needDraw = true; },
			capture(id) { try { canvasEl?.setPointerCapture(id); } catch { /* the pointer is gone */ } },
			release(id) { try { canvasEl?.releasePointerCapture(id); } catch { /* not captured */ } },
			wake() { needDraw = true; },
			toast,
			leave(to) { if (to === 'reader') showReader(); else closeOrBack(); }
		});
		const err = await f.load(src);
		if (err !== null || gen !== filmGen || disposed) { if (err !== null) reportExhibitError(`${slug}/film.flecs: ${err}`); f.dispose(); return; }
		filmCtl = f;
		filmMode = !wantsReader();
		if (dev) filmHotOff = attachFilmHot(() => slug, (t) => filmCtl?.reload(t) ?? 'no film', reportExhibitError);
		needDraw = true; firstDraw = true;
	}
	function showReader() {
		if (!filmMode) return;
		filmCtl?.pause();
		filmMode = false;
		filmCursor = null;
		setReadParam(true);
		toast('Reader: F returns to the film');
		needDraw = true; firstDraw = true;
	}
	function showFilm() {
		if (!filmCtl || filmMode) return;
		filmMode = true;
		setReadParam(false);
		needDraw = true; firstDraw = true;
	}

	// ---- chrome data ----

	const toRgb = (c: readonly number[]): [number, number, number] => [c[0], c[1], c[2]];
	const TEXT_DEC = new TextDecoder();
	const textOf = (off: number, len: number) => (model ? TEXT_DEC.decode(model.text.subarray(off, off + len)) : '');

	/** the heading's own line(s): a block's text range can run on into following content (References) */
	function headingText(b: ReadingModel['blocks'][number]): string {
		// consecutive lines of one heading share its y band: stop at the first line below the block's heading height
		let out = '';
		const y1 = b.y0 + 4;
		for (let li = b.firstLine; li < b.firstLine + b.lineCount; li++) {
			const L = model!.lines[li];
			if (li > b.firstLine && L.yTop > y1) break;
			out += (out ? ' ' : '') + textOf(L.textOff, L.textLen).trim();
		}
		return (out || textOf(b.textOff, Math.min(b.textLen, 120))).split('\n')[0];
	}
	function headingList() {
		const m = model!;
		const out: { level: 2 | 3; text: string; id: string; y: number; block: number }[] = [];
		const clip = clipEm();
		m.blocks.forEach((b, i) => {
			if (b.kind !== BlockKind.heading) return;
			const lv = (b.level || 2) <= 2 ? 2 : 3;
			if ((b.flags & BlockFlag.folded) && !foldExpanded) return;
			out.push({ level: lv, text: headingText(b).trim(), id: b.anchor ? stringAt(m.strings, b.anchor) : '', y: layoutToDocY(m, b.y0, clip) * emPx, block: i });
		});
		return out;
	}

	let metaCache: { model: ReadingModel; fold: boolean; em: number; heads: ReturnType<typeof headingList>; sections: { name: string; y: number }[] } | null = null;
	function chromeMetaParts() {
		if (!metaCache || metaCache.model !== model || metaCache.fold !== foldExpanded || metaCache.em !== emPx || Math.abs((reading?.state()[RD.foldClipEm] ?? 0) - lastClip) > 0.01) {
			const heads = headingList();
			metaCache = { model: model!, fold: foldExpanded, em: emPx, heads, sections: heads.filter((h) => h.level === 2).map((h) => ({ name: h.text, y: h.y })) };
		}
		return metaCache;
	}

	function linkViewRects(li: number): Rect[] {
		const m = model!;
		const l = m.links[li];
		if (!l) return [];
		const out: Rect[] = [];
		const x0 = docXPx(l.x0), x1 = docXPx(l.x1), y0 = layoutYPx(l.y0), y1 = layoutYPx(l.y1);
		out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
		return out;
	}

	function viewRectOfBlock(i: number): Rect {
		const b = model!.blocks[i];
		const x0 = docXPx(b.x0), x1 = docXPx(b.x1), y0 = layoutYPx(b.y0), y1 = layoutYPx(b.y1);
		return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	}

	function refIndexOfLink(li: number): number {
		const m = model!;
		const l = m.links[li];
		if (!l || l.kind !== LinkKind.ref) return -1;
		const id = decodeURIComponent(stringAt(m.strings, l.offset).replace(/^#/, ''));
		const bare = id.replace(/^ref-/, '');
		return (art?.meta.refs ?? []).findIndex((r) => r.id === id || r.id === bare);
	}

	function buildChromeState(now: number, st: Float32Array): ChromeState {
		const m = model!;
		const parts = chromeMetaParts();
		const y = st[RD.scrollY];
		const docPx = st[RD.docHeightEm] * emPx;
		const codeInfos: CodeBlockInfo[] = [];
		for (const i of codeBlocks) {
			if (i < st[RD.visFirst] - 1 || i > st[RD.visFirst] + st[RD.visCount]) continue;
			const r = viewRectOfBlock(i);
			if (r.y + r.h < 0 || r.y > viewH) continue;
			codeInfos.push({ block: i, rect: r, lang: codeLang(i) });
		}
		const hoverCode = hoverHit && hoverHit.kind === 'code' ? hoverHit.block : -1;
		const lbSrc = lightbox ? { w: lightbox.w, h: lightbox.h, caption: lightbox.caption } : null;
		const popAnchor = popover ? linkViewRects(popover.link)[0] : null;
		const secIdx = (() => { let a = -1; const probe = y + viewH * 0.3; parts.sections.forEach((s, i) => { if (s.y <= probe) a = i; }); return a; })();
		const hoverLink = hoverHit && (hoverHit.kind === 'link' || hoverHit.kind === 'cite') && hoverHit.link >= 0 ? linkViewRects(hoverHit.link) : null;
		const focusLinkR = focusLinkIdx >= 0 ? linkViewRects(focusLinkIdx) : null;
		const tipContent = tipLink >= 0 ? linkTipContent(m, art?.meta.links ?? {}, tipLink, typeof location !== 'undefined' ? location.host : '') : null;
		const tipRect = tipContent ? linkViewRects(tipLink)[0] : null;
		const codeRect = ((): Rect | null => {
			const t = codeTok;
			if (!t) return null;
			const dx = codeDx.get(t.block) ?? 0;
			const x0 = docXPx(t.x0 - dx), x1 = docXPx(t.x1 - dx);
			const y0 = layoutYPx(t.base - 0.95 * t.size), y1 = layoutYPx(t.base + 0.3 * t.size);
			return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
		})();
		const codeTipInfo_ = codeTok && codeTipOn ? codeTipInfo(codeTok) : null;
		const col = originX + m.docX0 * emPx;
		const state: ChromeState = {
			theme: { ground: toRgb(theme.surface.ground), surface: toRgb(theme.surface.code), card: toRgb(theme.surface.card), popover: toRgb(theme.surface.popover), ink: toRgb(theme.text.primary), ink2: toRgb(theme.text.secondary), ink3: toRgb(theme.text.tertiary), ink4: toRgb(theme.ink4), accent: toRgb(theme.accent) },
			reduced, hdrGain, nowMs: now, touch: ptrType === 'touch',
			view: { w: viewW, h: viewH }, colLeft: col,
			meta: {
				title, closeKind: fromWorld ? 'back' : 'close', wordsBrief: art?.meta.wordsBrief ?? 0, wordsFull: art?.meta.wordsFull ?? 0,
				sections: parts.sections,
				refs: (art?.meta.refs ?? []).map((r) => ({ title: r.title, url: r.url }))
			},
			scrollY: y, docPx, progress: st[RD.progress], section: secIdx,
			foldExpanded,
			aa: { open: aaOpen, step: Math.max(0, scaleSteps.findIndex((s) => s === scale)), steps: scaleSteps.length, hasFold: m.foldH > 0, alwaysFull: false },
			popover: popover && popAnchor ? { ref: popover.ref, anchor: popAnchor } : null,
			linkTip: tipContent && tipRect ? { anchor: tipRect, ...tipContent } : null,
			codeWash: codeRect, codeTip: codeRect && codeTipInfo_ ? { anchor: codeRect, kind: codeTipInfo_.kind, label: codeTipInfo_.label, token: codeTipInfo_.token, body: codeTipInfo_.body, tint: toRgb(theme.syntax[SYNTAX_ORDER[codeTipInfo_.colour - 20] ?? 'variable']) } : null,
			lightbox: lbSrc,
			find,
			copyFlash, toasts,
			codeBlocks: codeInfos,
			hoverCode, focusCode: -1,
			hoverLink, focusLink: focusLinkR,
			scrollbar: sbState.v,
			ticks: parts.sections.map((s) => s.y),
			anim: chromeAnim
		};
		return state;
	}
	const chromeAnim = createChromeAnim();

	/** the model carries no code language */
	const codeLang = (_i: number): string => '';

	// ---- actions (chrome clicks, keyboard-driven) ----

	function toast(msg: string) {
		toasts.push({ id: ++toastId, msg, atMs: performance.now() });
		if (toasts.length > 3) toasts.shift();
		needDraw = true;
	}

	async function copyToClipboard(text: string): Promise<boolean> {
		try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
		try {
			const ta = document.createElement('textarea');
			ta.value = text;
			ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
			document.body.append(ta);
			ta.select();
			const ok = document.execCommand('copy');
			ta.remove();
			return ok;
		} catch { return false; }
	}

	function codeSource(i: number): string {
		return codeText(model!, i);
	}

	function copySelection() {
		if (!model || selEmpty(sel)) return false;
		const text = copyText(model, sel!, { clipEm: clipEm() });
		if (!reduced) { flash = { t0: performance.now(), lo: selLo(sel!), hi: selHi(sel!) }; needDraw = true; }
		void copyToClipboard(text).then((ok) => toast(ok ? 'Copied' : 'Copy failed'));
		return true;
	}

	function openLightbox(block: number) {
		const m = model!;
		const b = m.blocks[block];
		if (!b) return;
		// the image item of the block
		let imageId = -1, w = 0, h = 0;
		let em = { x0: 0, y0: 0, x1: 1, y1: 1 };
		for (let k = b.firstItem; k < b.firstItem + b.itemCount; k++) {
			const wd = m.items[k];
			if (wd >>> 28 === 2) { const im = m.images[wd & 0x0fffffff]; if (im) { imageId = im.imageId; w = im.x1 - im.x0; h = im.y1 - im.y0; em = { x0: im.x0, y0: im.y0, x1: im.x1, y1: im.y1 }; break; } }
		}
		if (imageId < 0) return;
		const alt = imageAlt(m, block);
		lightbox = { block, imageId, w, h, caption: alt, em };
		reading?.input(INPUT.open, block);
		needDraw = true;
	}
	function closeLightbox(): boolean {
		if (!lightbox) return false;
		lightbox = null;
		reading?.input(INPUT.open, -1);
		needDraw = true;
		return true;
	}

	function showPopover(li: number) {
		const ref = refIndexOfLink(li);
		if (ref < 0) return;
		popover = { ref, link: li };
		reading?.input(INPUT.open, model!.links[li] ? model!.lines[model!.links[li].line]?.block ?? -1 : -1);
		needDraw = true;
	}
	function closePopover(): boolean {
		clearTimeout(popTimer);
		if (!popover) return false;
		popover = null;
		reading?.input(INPUT.open, -1);
		needDraw = true;
		return true;
	}

	function setScale(s: number) {
		const v = snapScale(s);
		if (v === scale) return;
		const key = scrollSt?.key() ?? null;
		scale = v;
		try { localStorage.setItem('reader:scale', String(v)); } catch { /* private mode */ }
		relayout(key);
	}

	function runFind(jump = true) {
		if (!model) return;
		findHits = find.query ? findInModel(model, find.query) : [];
		find.count = findHits.length;
		if (!findHits.length) { findCur = -1; find.index = 0; needDraw = true; return; }
		const from = findCur >= 0 && findHits[findCur] ? findHits[findCur].lo : sel ? selLo(sel) : 0;
		findCur = hitFrom(findHits, from);
		find.index = findCur + 1;
		if (jump) gotoFind();
		needDraw = true;
	}
	function gotoFind() {
		if (!model || findCur < 0) return;
		const h = findHits[findCur];
		if (!h) return;
		if (h.inFold && !foldExpanded) { setFold(true, true); }
		reading?.tick(0);
		const b = model.blocks[h.block];
		const rects = rangesToRects(model, [h], viewOpts());
		const r = rects[0];
		let target = 0;
		if (r) target = r.y0 * emPx - viewH * 0.4;
		else if (b) target = layoutToDocY(model, b.y0, clipEm()) * emPx - viewH * 0.4;
		reading?.scroll.scrollTo(Math.max(0, target), !reduced);
		needDraw = true;
	}
	function stepFind(dir: 1 | -1) {
		if (!findHits.length) return;
		findCur = dir === 1 ? nextHit(findHits, findCur) : prevHit(findHits, findCur);
		find.index = findCur + 1;
		gotoFind();
	}
	function openFind() {
		find.open = true;
		find.caret = find.query.length;
		if (find.query) runFind(false);
		needDraw = true;
	}
	function closeFind(): boolean {
		if (!find.open) return false;
		find.open = false;
		needDraw = true;
		return true;
	}

	function act(a: string, x = 0, y = 0) {
		if (!model || !reading) return;
		const [k, p, q] = a.split(':');
		switch (k) {
			case 'close': closeOrBack(); break;
			case 'toggleAa': aaOpen = !aaOpen; break;
			case 'aa':
				if (p === 'step') setScale(scaleSteps[Math.max(0, Math.min(scaleSteps.length - 1, Number(q)))]);
				else if (p === 'full') setFold(!foldExpanded);
				else aaOpen = false;
				break;
			case 'cite': if (p === 'open') { const r = art?.meta.refs[Number(q)]; if (r?.url) window.open(r.url, '_blank', 'noopener,noreferrer'); } break;
			case 'lb': closeLightbox(); break;
			case 'copy': {
				const b = Number(p);
				void copyToClipboard(codeSource(b)).then((ok) => { copyFlash[b] = performance.now(); toast(ok ? 'Copied' : 'Copy failed'); });
				break;
			}
			case 'find':
				if (p === 'close') closeFind();
				else if (p === 'next') stepFind(1);
				else if (p === 'prev') stepFind(-1);
				else if (p === 'query') { findCur = -1; runFind(true); }
				break;
			default: break;
		}
		needDraw = true;
		void x; void y;
	}

	function closeOrBack() {
		if (onClose) onClose(); else closeArticle();
	}

	// ---- article click / link activation ----

	function activateLink(li: number) {
		const m = model!;
		const l = m.links[li];
		if (!l) return;
		const target = stringAt(m.strings, l.offset);
		if (l.kind === LinkKind.ref) { showPopover(li); return; }
		if (l.kind === LinkKind.anchor) {
			let id = target.replace(/^#/, '');
			try { id = decodeURIComponent(id); } catch { /* raw */ }
			if (id === 'full') { setFold(true); return; }
			scrollSt?.goToAnchor(id, { smooth: true, push: true });
		} else if (l.kind === LinkKind.article) void goto(target.startsWith('/') ? target : `/thoughts/${target}`);
		else if (target.startsWith('/')) void goto(target);
		else window.open(target, '_blank', 'noopener,noreferrer');
	}

	function articleClick(hit: Hit) {
		switch (hit.kind) {
			case 'link': case 'cite': if (hit.link >= 0) activateLink(hit.link); break;
			case 'fold': setFold(!foldExpanded); break;
			case 'image': openLightbox(hit.block); break;
			default: break;
		}
	}

	function cursorFor(h: Hit | null): string {
		if (!h) return 'default';
		switch (h.kind) {
			case 'link': case 'cite': case 'fold': return 'pointer';
			case 'image': return 'zoom-in';
			case 'text': case 'code': return 'text';
			case 'exhibit': return exCursor ?? 'default';
			default: return 'default';
		}
	}

	// ---- pointer, wheel, touch ----

	function localPoint(e: PointerEvent | MouseEvent) {
		const r = canvasEl!.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}

	function sbIn(): ScrollbarInput {
		const st = reading!.state();
		return { viewW, viewH, docPx: st[RD.docHeightEm] * emPx, scrollY: st[RD.scrollY], pointer: ptr, dragging: dragKind === 'thumb', ink: toRgb(theme.text.primary), accent: toRgb(theme.accent), insetTop: barPx, ticks: undefined };
	}

	function chromeAt(x: number, y: number): HitRect | null {
		const h = hitChrome(lastChromeHits, x, y);
		return h ? (lastChromeHits.find((r) => r.id === h.id) ?? null) : null;
	}

	function updateHover(x: number, y: number) {
		if (!model || !reading) return;
		const ch = chromeAt(x, y);
		const hit = ch ? null : hitTest(model, toDocX(x), toDocY(y), viewOpts());
		hoverHit = hit;
		const bi = hit && hit.block >= 0 ? hit.block : -1;
		if (bi !== hoverBlockSent) { hoverBlockSent = bi; reading.input(INPUT.hoverBlock, bi); }
		// code token wash and tip (mouse only)
		if (ptrType === 'mouse' && hit && (hit.kind === 'text' || hit.kind === 'code') && hit.glyph >= 0) {
			const dx = codeDx.get(hit.block) ?? 0;
			setCodeTok(codeTokenAt(model, hit.line, hit.glyph, toDocX(x) + dx));
		} else setCodeTok(null);
		// link preview intent (mouse only; keyboard focus has its own path in focusLink)
		if (ptrType === 'mouse') setTip(hit && hit.kind === 'link' && hit.link >= 0 ? hit.link : focusLinkIdx);
		// citation hover intent
		if (hit && hit.kind === 'cite' && hit.link >= 0 && ptrType === 'mouse') {
			const want = hit.link;
			if (!popover || popover.link !== want) { clearTimeout(popTimer); popTimer = setTimeout(() => showPopover(want), 120); }
			else clearTimeout(popTimer);
		} else if (popover && !(ch && ch.id.startsWith('pop'))) {
			clearTimeout(popTimer);
			popTimer = setTimeout(() => { closePopover(); }, 160);
		}
		needDraw = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!model || !reading || filmMode) return;
		const p = localPoint(e);
		ptr = p; ptrType = e.pointerType;
		if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) downAt.moved = true;
		if (swallowed(e)) { needDraw = true; return; } // an exhibit part holds this pointer
		if (dragKind === 'thumb') {
			reading.scroll.scrollTo(scrollbarDragTo(sbIn(), thumbGrab, p.y), false);
			needDraw = true;
			return;
		}
		if (dragKind === 'select' && gesture && e.pointerType !== 'touch') {
			const c = caretAt(model, toDocX(p.x), toDocY(p.y), { ...viewOpts(), domain: gesture.domain });
			if (c) { gesture = dragTo(model, gesture, c); sel = gesture.sel; }
			// edge autoscroll
			needDraw = true;
			return;
		}
		if (e.pointerType === 'touch') return;
		updateHover(p.x, p.y);
	}

	function onPointerDown(e: PointerEvent) {
		if (!model || !reading) return;
		if (filmMode) { canvasEl?.focus?.(); return; }
		const p = localPoint(e);
		ptr = p; ptrType = e.pointerType;
		canvasEl?.focus?.();
		if (e.button !== 0) return;
		if (swallowed(e)) { needDraw = true; return; } // a press inside an exhibit starts no selection and no page drag
		primaryDown = true;
		const ch = chromeAt(p.x, p.y);
		const hit = ch ? NONE : hitTest(model, toDocX(p.x), toDocY(p.y), viewOpts());
		downAt = { x: p.x, y: p.y, hit, chrome: ch, moved: false };
		if (ch) {
			if (ch.capture) {
				captured = ch.id;
				canvasEl?.setPointerCapture(e.pointerId);
				if (ch.id === 'sb:thumb') { dragKind = 'thumb'; thumbGrab = scrollbarDragStart(sbIn(), p.y); }
			}
			needDraw = true;
			return;
		}
		if (e.pointerType === 'touch') return; // the engine owns the drag; a tap resolves on pointerup
		// begin a selection when pressing on text; otherwise just remember the click
		const now = performance.now();
		clickCount = now - lastClickT < 450 && Math.hypot(p.x - (downAt?.x ?? 0), p.y - (downAt?.y ?? 0)) < 6 ? clickCount + 1 : 1;
		lastClickT = now;
		if (hit.kind === 'text' || hit.kind === 'code' || hit.kind === 'link' || hit.kind === 'cite') {
			const c = caretAt(model, toDocX(p.x), toDocY(p.y), viewOpts());
			if (c) {
				gesture = press(model, c, Math.min(3, clickCount), sel, e.shiftKey);
				sel = gesture.sel;
				dragKind = 'select';
				canvasEl?.setPointerCapture(e.pointerId);
			}
		} else { sel = null; gesture = null; }
		needDraw = true;
	}

	function onPointerUp(e: PointerEvent) {
		if (!model || !reading || filmMode) return;
		const p = localPoint(e);
		primaryDown = false;
		if (swallowed(e)) { downAt = null; dragKind = null; needDraw = true; return; }
		const d = downAt;
		downAt = null;
		const wasDrag = dragKind;
		dragKind = null;
		captured = null;
		try { canvasEl?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
		if (!d || e.button !== 0) return;
		if (wasDrag === 'thumb') return;
		if (d.moved && e.pointerType !== 'touch') {
			// a selection drag ended; clear a collapsed selection
			if (selEmpty(sel)) sel = null;
			return;
		}
		if (e.pointerType === 'touch' && d.moved) return; // it was a scroll
		// a click or tap
		const ch = chromeAt(p.x, p.y);
		if (ch && d.chrome && ch.id === d.chrome.id) {
			if (ch.onClick === 'sb:track') { reading.scroll.scrollTo(scrollbarTrackClick(sbIn(), p.y), true); return; }
			if (ch.onClick && ch.onClick !== 'sb:thumb') {
				if (ch.onClick === 'find:field') { /* caret placement is a no-op here */ return; }
				act(ch.onClick, p.x, p.y);
			}
			return;
		}
		if (ch) return;
		const hit = hitTest(model, toDocX(p.x), toDocY(p.y), viewOpts());
		if (clickCount < 2 || e.pointerType === 'touch') {
			if (selEmpty(sel) || e.pointerType === 'touch') { sel = null; gesture = null; }
			articleClick(hit);
		}
		if (aaOpen) { aaOpen = false; }
		needDraw = true;
	}

	function onPointerLeave() {
		if (filmMode && filmCtl) { filmCtl.pointer('leave', 0, 0, { pointerId: 0, pointerType: 'mouse', buttons: 0 }); filmCursor = null; needDraw = true; return; }
		ptr = null;
		hoverHit = null;
		setTip(focusLinkIdx);
		setCodeTok(null);
		if (hoverBlockSent !== -1) { hoverBlockSent = -1; reading?.input(INPUT.hoverBlock, -1); }
		if (canvasEl) router.event({ type: 'leave', id: 0, ptype: 'mouse', x: 0, y: 0, buttons: 0, mods: 0 });
		exCursor = null;
		needDraw = true;
	}

	function attachCanvasInput(c: HTMLCanvasElement) {
		c.tabIndex = 0;
		c.style.touchAction = 'none';
		c.style.outline = 'none';
		// horizontal wheel (trackpad sideways, or shift + wheel) over an overflowing code block scrolls that block, not the page
		const onCodeWheel = (e: WheelEvent) => {
			if (!model || e.ctrlKey) return;
			const p = localPoint(e);
			if (chromeAt(p.x, p.y)) return;
			const h = hitTest(model, toDocX(p.x), toDocY(p.y), viewOpts());
			if (h.block < 0 || model.blocks[h.block]?.kind !== BlockKind.code) return;
			const b = model.blocks[h.block];
			let right = b.x1;
			for (let li = b.firstLine; li < b.firstLine + b.lineCount; li++) right = Math.max(right, model.lines[li].x1);
			const maxDx = Math.max(0, right + 0.95 - b.x1);
			if (maxDx <= 0) return;
			const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
			if (!dx) return;
			const cur = codeDx.get(h.block) ?? 0;
			const next = Math.max(0, Math.min(maxDx, cur + (dx * (e.deltaMode === 1 ? 16 : 1)) / emPx));
			if (next !== cur) { codeDx.set(h.block, next); needDraw = true; }
			e.preventDefault();
			e.stopImmediatePropagation();
		};
		c.addEventListener('wheel', onCodeWheel, { passive: false });
		const noKeys = { addEventListener() {}, removeEventListener() {} } as unknown as Parameters<typeof attachScroll>[2];
		// exhibit routing sits in front of the scroll engine: it swallows what an exhibit part owns (docs/MUSEUM.md 3.4)
		const filter = (kind: 'wheel' | 'down' | 'move' | 'up' | 'cancel', e: WheelEvent | PointerEvent): boolean => {
			if (!model || !reading || !ready) return false;
			if (filmMode && filmCtl) {
				if (kind === 'wheel') { filmCtl.wheel((e as WheelEvent).deltaY * ((e as WheelEvent).deltaMode === 1 ? 16 : 1)); return true; }
				const fe = e as PointerEvent;
				if (fe.pointerType === 'mouse' && fe.button > 0 && kind !== 'move') return true;
				const fp = localPoint(fe);
				filmCursor = filmCtl.pointer(kind, fp.x, fp.y, fe).cursor;
				needDraw = true;
				return true;
			}
			if (kind === 'wheel') return router.wheel();
			const pe = e as PointerEvent;
			if (pe.pointerType === 'mouse' && pe.button > 0 && kind !== 'move') return false;
			const p = localPoint(pe);
			const r = router.event({ type: kind, id: pe.pointerId, ptype: pe.pointerType === 'touch' ? 'touch' : pe.pointerType === 'pen' ? 'pen' : 'mouse', x: p.x, y: p.y, buttons: pe.buttons, mods: keyMods(pe), raw: pe });
			routed = { e, r };
			if (kind === 'move') exCursor = r.inside ? r.cursor : null;
			else if (r.cursor !== null) exCursor = r.cursor;
			if (r.swallow || r.inside) needDraw = true;
			return r.swallow;
		};
		const detach = attachScroll(c as never, { wheel: (...a) => reading!.scroll.wheel(...a), pointer: (...a) => reading!.scroll.pointer(...a), key: () => false, scrollTo: (...a) => reading!.scroll.scrollTo(...a) }, noKeys, { filter });
		c.addEventListener('pointermove', onPointerMove);
		c.addEventListener('pointerdown', onPointerDown);
		c.addEventListener('pointerup', onPointerUp);
		c.addEventListener('pointercancel', onPointerUp);
		c.addEventListener('pointerleave', onPointerLeave);
		const onDbl = (e: MouseEvent) => e.preventDefault();
		c.addEventListener('dblclick', onDbl);
		c.addEventListener('contextmenu', (e) => { if (!selEmpty(sel)) return; });
		articleDisposers.length = 0;
		disposersAlways.push(() => {
			detach();
			c.removeEventListener('wheel', onCodeWheel);
			c.removeEventListener('pointermove', onPointerMove);
			c.removeEventListener('pointerdown', onPointerDown);
			c.removeEventListener('pointerup', onPointerUp);
			c.removeEventListener('pointercancel', onPointerUp);
			c.removeEventListener('pointerleave', onPointerLeave);
			c.removeEventListener('dblclick', onDbl);
		});
	}
	const disposersAlways: (() => void)[] = [];
	const NONE: Hit = { kind: 'none', block: -1, line: -1, glyph: -1, link: -1, ex: -1, note: -1, off: -1 };

	// ---- exhibits ----

	const exLoaded = (ex: number): boolean => !!reading && reading.exhibit.state()[ex * XS.stride + XS.loaded] !== 0;

	const router = createRouter({
		exhibitAt(x, y) {
			if (!model || !reading || chromeAt(x, y)) return -1;
			const h = hitTest(model, toDocX(x), toDocY(y), viewOpts());
			if (h.kind !== 'exhibit' || h.ex < 0 || (blockAlpha.get(h.block) ?? 1) <= 0) return -1;
			return exLoaded(h.ex) ? h.ex : -1;
		},
		local(ex, x, y) {
			const rec = model?.exhibits[ex];
			if (!rec) return null;
			const r = viewRectOfBlock(rec.block);
			return toLocal(mappingOf({ x: r.x, y: r.y + (blockDy.get(rec.block) ?? 0) }, rec.scale, emPx), x, y);
		},
		call(ex, kind, xEm, yEm, buttons, mods) {
			needDraw = true;
			return reading ? reading.exhibit.pointer(ex, kind, xEm, yEm, buttons, mods) : 0;
		},
		focus(ex) { reading?.exhibit.focus(ex); needDraw = true; },
		capture(id) { try { canvasEl?.setPointerCapture(id); } catch { /* the pointer is gone */ } },
		release(id) { try { canvasEl?.releasePointerCapture(id); } catch { /* not captured */ } },
		engineDown(raw) {
			const e = raw as PointerEvent;
			if (reading?.scroll.pointer(POINTER_KIND.down, pointerWord(e), e.clientX, e.clientY, e.timeStamp)) { try { canvasEl?.setPointerCapture(e.pointerId); } catch { /* gone */ } }
		}
	});

	/** load failure or hot-reload error: a toast and the dev overlay (the exhibit keeps drawing what it had, or nothing) */
	function reportExhibitError(msg: string) {
		console.error(msg);
		toast(msg.split('\n')[0].slice(0, 90));
		try { (globalThis as { reportError?: (e: unknown) => void }).reportError?.(new Error(msg)); } catch { /* no overlay */ }
	}

	/** snapshot text of every exhibit of the current article by id (state that survives a reload of the same article) */
	function snapshotExhibits(): Map<string, string> {
		const out = new Map<string, string>();
		if (!reading || !model) return out;
		for (let i = 0; i < model.exhibits.length; i++) {
			const t = reading.exhibit.snapshot(i);
			if (t !== null) out.set(exhibitId(model, i), t);
		}
		return out;
	}

	/** after `reading.load`: run every exhibit script, then restore state (carried over a reload, else the URL fragment) */
	function loadAndRestoreExhibits(carry: Map<string, string> | null) {
		if (!reading || !model) return;
		const rep = loadExhibits(reading.exhibit, model, slug);
		for (const msg of rep.errors) reportExhibitError(msg);
		exIds = model.exhibits.map((_, i) => exhibitId(model!, i));
		const want = new Map<string, string | null>();
		for (const { id, blob } of parseExhibitFragment(location.hash)) want.set(id, fromBlob(blob));
		exIds.forEach((id, i) => {
			if (!rep.loaded[i]) return;
			const text = carry?.get(id) ?? (want.has(id) ? want.get(id) : undefined);
			if (text === undefined) return;
			if (text === null || !reading!.exhibit.restore(i, text)) toast('exhibit state out of date');
		});
	}

	/** an exhibit changed its state: write the fragment once things settle (replaceState, never pushState) */
	function scheduleFragment(ex: number) {
		exDirty.add(ex);
		clearTimeout(exTimer);
		exTimer = setTimeout(flushFragment, 300);
	}
	function flushFragment() {
		if (!reading || !model) return;
		let hash = location.hash;
		for (const ex of exDirty) {
			const snap = reading.exhibit.snapshot(ex);
			hash = setExhibitFragment(hash, exhibitId(model, ex), snap === null ? null : toBlob(snap));
		}
		exDirty.clear();
		if (hash === location.hash) return;
		try { replaceState(location.pathname + location.search + hash, page.state); } catch { /* router not ready */ }
	}

	/** dev hot reload of one exhibit script: null when applied (the exhibit keeps its state), else the error text */
	function reloadExhibit(id: string, src: string): string | null {
		if (!reading) return 'reader not ready';
		const ex = exIds.indexOf(id);
		if (ex < 0) return `no exhibit "${id}" in this article`;
		const err = reading.exhibit.reload(ex, src);
		needDraw = true;
		return err;
	}

	// ---- keyboard ----

	function visibleLinks(): number[] {
		const m = model!;
		const out: number[] = [];
		m.links.forEach((l, i) => {
			const y = layoutYPx(l.y0);
			const blk = m.lines[l.line]?.block ?? 0;
			if (!foldExpanded && (blk & 0x80000000) === 0 && (m.blocks[blk]?.flags ?? 0) & BlockFlag.folded) return;
			out.push(i);
			void y;
		});
		return out;
	}

	function focusLink(i: number) {
		focusLinkIdx = i;
		setTip(i);
		if (i >= 0) {
			const l = model!.links[i];
			const y = layoutYPx(l.y0);
			if (y < barPx + 20 || y > viewH - 40) reading?.scroll.scrollTo(Math.max(0, curY() + y - viewH * 0.4), !reduced);
		}
		needDraw = true;
	}

	function onKey(e: KeyboardEvent) {
		if (e.defaultPrevented || !ready || !model || !reading) return;
		const t = e.target as HTMLElement | null;
		if (t && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
		if (filmMode && filmCtl) { if (filmCtl.key(e)) { e.preventDefault(); needDraw = true; } return; }
		const mod = e.metaKey || e.ctrlKey;
		if (!mod && !e.altKey && !find.open && filmCtl && e.key.toLowerCase() === 'f') { e.preventDefault(); showFilm(); return; }
		// find bar owns the keyboard while open
		if (find.open) {
			if (e.key === 'Escape') { closeFind(); e.preventDefault(); return; }
			if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); return; }
			if (mod && e.key.toLowerCase() === 'g') { stepFind(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
			if (mod && e.key.toLowerCase() === 'v') return; // handled by the paste event
			if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); return; }
			if (mod || e.altKey) return;
			if (e.key.length === 1 || ['Backspace', 'Delete', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'Enter'].includes(e.key)) {
				pendingKeys.push({ key: e.key, shift: e.shiftKey, mod: false });
				e.preventDefault();
				needDraw = true;
				return;
			}
			if (['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(e.key)) { /* fall through to scrolling */ } else return;
		}
		if (mod && e.key.toLowerCase() === 'f') { openFind(); e.preventDefault(); return; }
		if (mod && e.key.toLowerCase() === 'g' && findHits.length) { stepFind(e.shiftKey ? -1 : 1); e.preventDefault(); return; }
		if (mod && e.key.toLowerCase() === 'c') { if (copySelection()) e.preventDefault(); return; }
		if (mod && e.key.toLowerCase() === 'a') { sel = selectAll(model); gesture = null; needDraw = true; e.preventDefault(); return; }
		// an exhibit with keyboard focus is offered the key first (never a Cmd/Ctrl combo); Esc it leaves unconsumed only releases the focus
		if (router.focus >= 0 && !mod) {
			const out = routeKey(router.focus, xkeyOf(e), keyMods(e), (c, m) => reading!.exhibit.key(c, m), () => router.clearFocus());
			if (out.consumed || out.handled) { e.preventDefault(); needDraw = true; return; }
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			if (closeLightbox() || closePopover() || (aaOpen && (aaOpen = false, true))) { needDraw = true; return; }
			if (!selEmpty(sel)) { sel = null; gesture = null; needDraw = true; return; }
			closeOrBack();
			return;
		}
		if (mod || e.altKey) return;
		const k = e.key.toLowerCase();
		if (e.key === '/' ) { openFind(); e.preventDefault(); return; }
		if (e.key === 'Tab') {
			const ls = visibleLinks();
			if (!ls.length) return;
			const at = ls.indexOf(focusLinkIdx);
			const next = e.shiftKey ? (at <= 0 ? -1 : ls[at - 1]) : (at < 0 ? ls[0] : at + 1 < ls.length ? ls[at + 1] : -1);
			if (next < 0) { focusLink(-1); return; }
			e.preventDefault();
			focusLink(next);
			return;
		}
		if (e.key === 'Enter' && focusLinkIdx >= 0) { e.preventDefault(); activateLink(focusLinkIdx); return; }
		if (k === 'j') { scrollSt?.jump(1); e.preventDefault(); return; }
		if (k === 'k') { scrollSt?.jump(-1); e.preventDefault(); return; }
		if (k === 'e') { setFold(!foldExpanded); e.preventDefault(); return; }
		const code = ({ Space: 1, PageDown: 2, PageUp: 3, Home: 4, End: 5, ArrowDown: 6, ArrowUp: 7 } as Record<string, number>)[e.code];
		if (code && reading.scroll.key(code, e.shiftKey)) e.preventDefault();
	}

	function onPaste(e: ClipboardEvent) {
		if (!find.open) return;
		const text = e.clipboardData?.getData('text') ?? '';
		if (text) { pendingKeys.push({ key: 'v', mod: true, paste: text }); e.preventDefault(); needDraw = true; }
	}

	function onPopState() {
		setTimeout(() => {
			if (!scrollSt) return;
			if (!scrollSt.restoreFromHistory()) scrollSt.goToHash(location.hash, { smooth: true });
		}, 0);
	}

	// ---- rAF frame protocol ----

	function visibleFraction(b: { y0: number; y1: number }, topPx: number, clip: number): number {
		const t = layoutToDocY(model!, b.y0, clip) * emPx - topPx;
		const h = (b.y1 - b.y0) * emPx;
		if (h <= 0) return 0;
		const vis = Math.min(t + h, viewH) - Math.max(t, 0);
		return vis <= 0 ? 0 : vis / h;
	}

	function updateEnter(now: number, topPx: number, clip: number): boolean {
		if (!model) return false;
		blockAlpha.clear();
		blockDy.clear();
		let animating = false;
		let started = 0;
		for (const i of enterBlocks) {
			const s = enterState[i];
			if (s === 2) continue;
			const b = model.blocks[i];
			if (s === 0) {
				if (visibleFraction(b, topPx, clip) >= 0.15) {
					if (reduced || (firstDraw && restoredScroll)) { enterState[i] = 2; continue; }
					enterState[i] = 1;
					enterStart[i] = now + Math.min(started++, 2) * 40;
				} else { blockAlpha.set(i, 0); continue; }
			}
			const p = (now - enterStart[i]) / ENTER_MS;
			if (p >= 1) { enterState[i] = 2; continue; }
			const k = p <= 0 ? 0 : enterEase(p);
			blockAlpha.set(i, k);
			blockDy.set(i, (1 - k) * 12);
			animating = true;
		}
		return animating;
	}

	/** 0..1 how awake an exhibit is: 1 with its centre near the middle of the viewport, falling to 0 as the block leaves (smooth, scroll-linked, stateless). Reduced motion: awake whenever drawn. */
	function wakeOf(block: number): number {
		if (reduced) return 1;
		const r = viewRectOfBlock(block);
		const mid = (barPx + viewH) / 2;
		const d = Math.abs(r.y + r.h / 2 - mid) / (viewH / 2 + r.h / 2);
		const t = Math.max(0, Math.min(1, (1 - d) * 1.6));
		return t * t * (3 - 2 * t);
	}

	/** a film frame: the page pass draws no page (visCount 0), only the stage items, exhibits, captions and transport of the film */
	function filmFrameLoop(now: number, dt: number, rd: Reading, pg: PagePass) {
		const fc = filmCtl!;
		if (!(fc.transport.playing || fc.transport.gate || fc.dragging || needDraw || firstDraw || filmOut.animating)) { counters.skipped++; return; }
		const f = frame;
		fc.frame(now, dt, viewW, viewH, filmOut);
		f.overlays = filmOut.overlays;
		f.scrollPx = 0; f.emPx = emPx; f.originX = 0; f.originY = 0;
		f.viewW = viewW; f.viewH = viewH; f.dpr = dpr;
		f.visFirst = 0; f.visCount = 0; f.noteFirst = 0; f.noteCount = 0; f.foldClipEm = 0; f.hdrGain = hdrGain;
		f.groundA = 1;
		f.ground.x0 = 0; f.ground.y0 = 0; f.ground.x1 = viewW; f.ground.y1 = viewH; f.ground.radius = 0;
		f.clip = undefined; f.only = undefined; f.lightbox = undefined;
		f.exhibits = filmOut.exhibits;
		f.uiText = filmOut.uiText;
		f.time = now / 1000; f.dirty = true;
		blockAlpha.clear(); blockDy.clear(); blockDx.clear();
		if (canvasEl) canvasEl.style.cursor = filmCursor ?? 'default';
		if (dev && devHook.frame) devHook.frame(f);
		pg.draw(f);
		counters.draws++;
		rd.ackDirty();
		firstDraw = false;
		needDraw = filmOut.animating;
	}

	function frameLoop(now: number) {
		raf = requestAnimationFrame(frameLoop);
		const rd = reading, pg = pass, m = model;
		if (!rd || !pg || !m || !ready) return;
		counters.frames++;
		const dt = Math.min(100, lastT ? now - lastT : 16.7);
		lastT = now;

		rd.tick(dt);
		if (filmMode && filmCtl) { filmFrameLoop(now, dt, rd, pg); return; }
		const st = rd.state();
		const y = st[RD.scrollY];

		let ev: { kind: ReadingEventKind; arg: number } | null;
		while ((ev = rd.poll())) {
			for (const cb of eventCbs) cb(ev.kind, ev.arg);
			if (ev.kind === 'foldExpand' && !foldExpanded) setFold(true, true);
			else if (ev.kind === 'exhibitState') scheduleFragment(ev.arg);
			else if (ev.kind === 'exhibitVisible' || ev.kind === 'exhibitHidden' || ev.kind === 'exhibitHalted') needDraw = true;
		}
		const fclip = st[RD.foldClipEm];
		if (fclip !== lastClip) lastClip = fclip;

		const sec = st[RD.section], rb = st[RD.readingBlock];
		if (sec !== lastSection) lastSection = sec;
		if (rb !== lastReadBlock) { lastReadBlock = rb; scrollSt?.spy(rb); }
		if (y !== lastY && y >= 0) scrollSt?.scheduleSave();

		// timeline exhibits: channels of every nearby exhibit at the clock the engine holds for it
		evalTimelineChannels(m, rd.exhibit, st[RD.exVisFirst], st[RD.exVisCount], chans);

		const animating = updateEnter(now, y, fclip || m.foldY + m.foldH);
		const scrolling = st[RD.scrollMode] !== SCROLL_MODE.idle;
		const washing = washBlock >= 0 && now - washT0 < 1200;
		if (!washing) washBlock = -1;
		const dirty = st[RD.dirty] !== 0 || animating || needDraw || firstDraw || lastY !== y || scrolling || chromeAnimating || washing || flash !== null || toasts.length > 0;
		lastY = y;
		if (!dirty) { counters.skipped++; return; }

		// ---- build the frame (the same object every time) ----
		overlays.length = 0;
		poolN = 0;
		blockDx.clear();
		const f = frame;
		f.overlays = overlays;
		f.scrollPx = y; f.emPx = emPx; f.originX = originX; f.originY = 0;
		f.viewW = viewW; f.viewH = viewH; f.dpr = dpr;
		f.visFirst = st[RD.visFirst]; f.visCount = st[RD.visCount]; f.noteFirst = st[RD.noteFirst]; f.noteCount = st[RD.noteCount];
		f.foldClipEm = fclip; f.hdrGain = hdrGain;
		f.groundA = mode === 'only' ? 1 : 0.92;
		f.ground.x0 = 0; f.ground.y0 = 0; f.ground.x1 = viewW; f.ground.y1 = viewH; f.ground.radius = 0;
		f.clip = undefined; f.only = undefined; f.exhibits = undefined; f.flash = undefined;
		f.time = now / 1000; f.dirty = true;
		for (const b of codeBlocks) { const dx = codeDx.get(b); if (dx) blockDx.set(b, dx * emPx); }

		const [ar, ag, ab] = accent;
		const g = hdrGain > 1 ? hdrGain : undefined;
		const vo = viewOpts();

		// selection shape: one continuous rounded shape (rows joined, corners facing a neighbour square), at rest and during the copy flash
		if (sel && !selEmpty(sel)) {
			const frags: Row[] = [];
			let g0 = Infinity, g1 = -1;
			const lo = selLo(sel), hi = selHi(sel);
			for (const r of selectionRects(m, sel, vo)) {
				const x0 = docXPx(r.x0), y0 = r.y0 * emPx - y, x1 = docXPx(r.x1), y1 = r.y1 * emPx - y;
				if (y1 < 0 || y0 > viewH) continue;
				frags.push({ left: x0, top: y0, right: x1, bottom: y1 });
				const L = m.lines[r.line];
				for (let gi = L.firstGlyph; gi < L.firstGlyph + L.glyphCount; gi++) {
					const co = m.glyphs[gi].charOffset;
					if (co >= lo && co < hi) { g0 = Math.min(g0, gi); g1 = Math.max(g1, gi); }
				}
			}
			const rowH = frags.length ? frags[0].bottom - frags[0].top : 0;
			const rows = joinRows(frags, rowH * 0.35, dpr);
			const ms = flash && flash.lo === lo && flash.hi === hi ? now - flash.t0 : -1;
			if (flash && (ms < 0 || ms >= PULSE_MS || reduced)) flash = null;
			const shape = shapeRows(rows, ms, reduced);
			for (const s of shape.rows) {
				const o = ov(s.x, s.y, s.w, s.h, s.radius, SELECTION_RGB[0], SELECTION_RGB[1], SELECTION_RGB[2], s.alpha);
				o.shape = s.sweep ? 10 : 9;
				o.width = s.sweep ? sweepWidth(s.mask, s.phase) : s.mask;
			}
			if (shape.scale !== 1 && g1 >= 0) {
				f.flash = { first: g0, end: g1 + 1, cx: (shape.bounds.cx - originX) / emPx, cy: (shape.bounds.cy + y) / emPx, scale: shape.scale };
			}
		} else flash = null;
		// find plates
		if (find.open && findHits.length) {
			const vis = findHits.map((h, i) => ({ h, i })).filter(({ h }) => !h.inFold || foldExpanded);
			for (const { h, i } of vis) {
				const cur = i === findCur;
				for (const r of rangesToRects(m, [h], vo)) {
					const x0 = docXPx(r.x0), y0 = r.y0 * emPx - y, x1 = docXPx(r.x1), y1 = r.y1 * emPx - y;
					if (y1 < 0 || y0 > viewH) continue;
					ov(x0, y0, x1 - x0, y1 - y0, 2, ar, ag, ab, cur ? 0.55 : 0.28, cur ? g : undefined);
				}
			}
		}
		// arrival wash
		if (washing) {
			const b = m.blocks[washBlock];
			if (b) {
				const k = 1 - (now - washT0) / 1200;
				const r = viewRectOfBlock(washBlock);
				ov(r.x - 8, r.y - 4, r.w + 16, r.h + 8, 6, ar, ag, ab, 0.14 * k);
			}
		}
		// link hover underline and keyboard focus ring are drawn by the chrome (hoverLink / focusLink)

		// chrome
		const state = buildChromeState(now, st);
		cs = state;
		const keys = pendingKeys; pendingKeys = [];
		const cin: ChromeInput = { pointer: ptr, down: primaryDown, captured, keys };
		sbInput = sbIn();
		const out = buildChrome(state, cin, dt, { shapeUi, scrollbar: scrollbarFrame });
		sbState.v = state.scrollbar;
		lastChromeHits = out.hits;
		chromeCursor = out.cursor;
		chromeAnimating = out.animating;
		for (const o of out.overlays) overlays.push(o);
		f.uiText = out.uiText;
		// exhibits: scissored to their block, under the chrome overlays
		f.exhibits = exDrawer.frame({
			model: m, api: rd.exhibit, emPx, viewW, viewH,
			foldClipY: (block) => (m.blocks[block].flags & BlockFlag.folded ? (fclip || m.foldY + m.foldH) * emPx - y : Infinity),
			rectOf: viewRectOfBlock, wakeOf, alphaOf: (b) => blockAlpha.get(b) ?? 1, dyOf: (b) => blockDy.get(b) ?? 0,
			first: st[RD.exVisFirst], count: st[RD.exVisCount]
		});
		for (const a of out.actions) act(a);
		if (out.lightbox && lightbox) f.lightbox = { block: lightbox.block, em: lightbox.em, rect: out.lightbox.rect, alpha: out.lightbox.alpha };
		else f.lightbox = undefined;
		// toasts age out
		for (let i = toasts.length - 1; i >= 0; i--) if (now - toasts[i].atMs > 2400) toasts.splice(i, 1);

		if (canvasEl) canvasEl.style.cursor = dragKind === 'select' ? 'text' : router.captured >= 0 ? (exCursor ?? 'grabbing') : chromeCursor || cursorFor(ptr ? hoverHit : null);

		if (dev && devHook.frame) devHook.frame(f);
		const t0 = dev ? performance.now() : 0;
		pg.draw(f);
		if (dev) counters.lastDrawMs = performance.now() - t0;
		counters.draws++;
		rd.ackDirty();
		firstDraw = false;
		needDraw = animating || chromeAnimating || washing || flash !== null;
	}

	// ---- mount ----

	function mount(): () => void {
		const r = rootEl;
		viewW = r.clientWidth; viewH = r.clientHeight; dpr = window.devicePixelRatio || 1;
		try {
			const sv = parseFloat(localStorage.getItem('reader:scale') ?? '');
			if (Number.isFinite(sv)) scale = snapScale(sv);
		} catch { /* private mode */ }
		const hs = readHistoryState();
		if (hs && Number.isFinite(hs.scale)) scale = snapScale(hs.scale);
		if (hs?.fromWorld) fromWorld = true;
		const mqMotion = matchMedia('(prefers-reduced-motion: reduce)');
		const mqHdr = matchMedia('(dynamic-range: high)');
		const mqContrast = matchMedia('(prefers-contrast: more)');
		const motion = () => { reduced = mqMotion.matches; reading?.input(INPUT.reducedMotion, reduced ? 1 : 0); };
		const hdr = () => { hdrGain = mqHdr.matches && !mqContrast.matches ? 1.5 : 1; needDraw = true; };
		motion(); hdr();
		mqMotion.addEventListener('change', motion);
		mqHdr.addEventListener('change', hdr);
		mqContrast.addEventListener('change', hdr);

		let ro: ResizeObserver | null = new ResizeObserver(() => {
			const w = r.clientWidth, h = r.clientHeight, d = window.devicePixelRatio || 1;
			if (w === viewW && h === viewH && d === dpr) return;
			const widthChanged = w !== viewW;
			viewW = w; viewH = h; dpr = d;
			if (!model || !ready) return;
			const nc = widthClassFor(viewW);
			const key = scrollSt?.key() ?? null;
			if (nc !== cls) { void openArticle(nc, key); return; }
			relayout(widthChanged ? key : null);
		});
		ro.observe(r);
		if (dev) {
			void import('./exhibit-hot').then(({ attachExhibitHot }) => {
				if (!disposed) hotOff = attachExhibitHot({ slug: () => slug, reload: reloadExhibit, report: reportExhibitError });
			});
		}
		document.addEventListener('keydown', onKey);
		document.addEventListener('paste', onPaste);
		window.addEventListener('popstate', onPopState);
		const onHide = () => scrollSt?.save();
		window.addEventListener('pagehide', onHide);

		if (dev) {
			(window as unknown as { __reader: unknown }).__reader = {
				get state() { return reading ? Array.from(reading.state()) : []; },
				get model() { return model; },
				get reading() { return reading; },
				get pass() { return pass; },
				get frameObj() { return frame; },
				get chrome() { return cs; },
				get hits() { return lastChromeHits; },
				get selection() { return sel; },
				get find() { return { ...find, hits: findHits.length }; },
				counters,
				get geometry() { return { viewW, viewH, dpr, emPx, originX, barPx, cls, scale, foldExpanded, reduced }; },
				scrollTo: (id: string) => scrollSt?.goToAnchor(id, { smooth: false }),
				act: (a: string) => act(a),
				copySelection,
				get exhibits() { return { ids: exIds, focus: router.focus, captured: router.captured, hover: router.hover, cursor: exCursor, pending: router.pending }; },
				flushFragment,
				get film() { return filmCtl; },
				get filmMode() { return filmMode; },
				hook: devHook
			};
		}
		raf = requestAnimationFrame(frameLoop);
		mounted = true;

		return () => {
			disposed = true;
			genToken++;
			cancelAnimationFrame(raf);
			ro?.disconnect();
			ro = null;
			document.removeEventListener('keydown', onKey);
			document.removeEventListener('paste', onPaste);
			window.removeEventListener('popstate', onPopState);
			window.removeEventListener('pagehide', onHide);
			mqMotion.removeEventListener('change', motion);
			mqHdr.removeEventListener('change', hdr);
			mqContrast.removeEventListener('change', hdr);
			scrollSt?.save();
			teardownArticle();
			for (const d of disposersAlways) d();
			clearTimeout(popTimer);
			clearTimeout(exTimer);
			hotOff?.();
			stopFilm();
			pass?.dispose();
			pass = null;
			if (dev) delete (window as unknown as { __reader?: unknown }).__reader;
		};
	}


	let openedSlug = '';
	rootEl.classList.add('reader');
	rootEl.lang = 'en';
	const unmount = mount();
	const handle: ReaderHandle = {
		setSlug(s: string) {
			slug = s;
			if (!mounted || s === openedSlug) return;
			openedSlug = s;
			void openArticle(widthClassFor(viewW), null);
		},
		dispose: unmount
	};
	publish();
	handle.setSlug(init.slug);
	return handle;
}
