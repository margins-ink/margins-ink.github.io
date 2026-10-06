
// The reader core (docs/READING_GPU.md): one fixed canvas drawn by the page pass, the Flecs ReadingModule (wasm) owning reading
// state AND scrolling, GPU-drawn chrome, in-engine selection / find / links, and one hidden semantic mirror for assistive tech and SEO.
// No scrolling DOM, no DOM text layer, no DOM chrome.
import './mirror.css';
import './reader.css';
import { goto, pushState, replaceState } from '$app/navigation';
import { page } from '$app/state';
import { BlockKind, BlockFlag, LinkKind, FigureMode, stringAt, type ReadingModel } from '$lib/magazine/format';
import { evalKeys, figureTime } from '$lib/magazine/chan';
import { INPUT, RD, MAX_FIG_STATE, SCROLL_MODE, type Reading, type ReadingEventKind } from './abi';
import type { Overlay, PageFrame, PagePass } from './page-api';
import { createPagePass } from './page';
import { loadReadingOnly } from '$lib/ecs/reading';
import { loadArticle, type LoadedArticle } from './load';
import { accentSrgb, barPxFor, cubicBezier, emPxFor, originXFor, scaleSteps, snapScale, widthClassFor, DEFAULT_SCALE } from './metrics';
import { createScrollState, layoutToDocY, readHistoryState, type SavedState, type ScrollController } from './scrollstate';
import { attachScroll } from './input';
import { themeFor } from './theme';
import { buildMirror, type Mirror } from './mirror';
import { hitTest, caretAt, type Hit, type ViewOpts } from './hit';
import { press, dragTo, selectAll, selectionRects, copyText, selEmpty, selLo, selHi, type Gesture, type Sel } from './select';
import { findInModel, nextHit, prevHit, hitFrom, rangesToRects, type FindHit } from './find';
import { buildChrome, createChromeAnim } from './ui/widgets';
import { hitChrome } from './ui/hit';
import type { ChromeState, ChromeInput, HitRect, KeyEvent, Rect, FindState, CodeBlockInfo, FigureInfo, ToastInfo } from './ui/layout';
import { newScrollbar, scrollbarFrame, scrollbarDragStart, scrollbarDragTo, scrollbarTrackClick } from './ui/scrollbar';
import { loadUiTables, setUiTables, shapeUi } from './ui/text';
import type { ScrollbarInput } from './ui/types';


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
	let hue = 265;
	let title = '';
	/** the root element's attributes mirror the reader's state (tests and CSS read them) */
	function publish() {
		rootEl.dataset.mode = mode;
		rootEl.dataset.class = String(cls);
		rootEl.dataset.ready = String(ready);
		rootEl.style.setProperty('--hue', String(hue));
		rootEl.setAttribute('aria-label', title || 'Article');
	}

	// ---- runtime (plain variables: nothing here drives the template) ----
	const dev = import.meta.env.DEV;
	const FIG_MODES = ['loop', 'once', 'scrub', 'static'] as const;
	const ENTER_MS = 480;
	const enterEase = cubicBezier(0.2, 0.7, 0.2, 1);
	let pass: PagePass | null = null;
	let reading: Reading | null = null;
	let art: LoadedArticle | null = null;
	let model: ReadingModel | null = null;
	let mirror: Mirror | null = null;
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
	let theme = themeFor(265);
	let accent: [number, number, number] = [0.6, 0.6, 1];
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
		hdrGain: 1, time: 0, hue: 265, dirty: true
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
	let dragKind: 'select' | 'thumb' | 'fig' | null = null;
	let thumbGrab = 0;
	let gesture: Gesture | null = null;
	let sel: Sel | null = null;
	let downAt: { x: number; y: number; hit: Hit; chrome: HitRect | null; moved: boolean } | null = null;
	let lastClickT = 0, clickCount = 0;
	let hoverHit: Hit | null = null;
	let hoverBlockSent = -1;
	let focusLinkIdx = -1;
	let focusFig = -1; // block index in figure focus mode
	let washBlock = -1, washT0 = 0;
	let tocOpen = false, aaOpen = false;
	let popover: { ref: number; link: number } | null = null;
	let popTimer: ReturnType<typeof setTimeout> | undefined;
	let lightbox: { block: number; imageId: number; w: number; h: number; caption: string; em: { x0: number; y0: number; x1: number; y1: number } } | null = null;
	const find: FindState = { open: false, query: '', caret: 0, count: 0, index: 0 };
	let findHits: FindHit[] = [];
	let findCur = -1;
	const toasts: ToastInfo[] = [];
	let toastId = 0;
	const copyFlash: Record<number, number> = {};
	let pendingKeys: KeyEvent[] = [];
	let lastChromeHits: HitRect[] = [];
	let chromeCursor = '';
	let chromeAnimating = false;
	let cs: ChromeState | null = null;
	const sbState = { v: newScrollbar() };
	let sbInput: ScrollbarInput | null = null;
	let canvasEl: HTMLCanvasElement | null = null;
	let scrubbing = new Set<number>();
	let scrubTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let figPlaying: boolean[] = [];
	let figT: number[] = [];
	const prevFigClock: number[] = [];

	const ov = (x: number, y: number, w: number, h: number, radius: number, r: number, g: number, b: number, a: number, hdr?: number): void => {
		let o = pool[poolN];
		if (!o) pool[poolN] = o = { x: 0, y: 0, w: 0, h: 0, radius: 0, r: 0, g: 0, b: 0, a: 0 };
		poolN++;
		o.x = x; o.y = y; o.w = w; o.h = h; o.radius = radius; o.r = r; o.g = g; o.b = b; o.a = a; o.hdr = hdr;
		overlays.push(o);
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
		mirror?.setExpanded(open);
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
		mirror?.root.remove();
		mirror = null;
		sel = null; gesture = null; popover = null; lightbox = null; findHits = []; findCur = -1;
		find.open = false; tocOpen = false; aaOpen = false; focusLinkIdx = -1; focusFig = -1;
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
			return;
		}
		if (my !== genToken || disposed || !pass || !reading || !root) return;

		teardownArticle();
		art = a;
		model = a.model;
		cls = a.widthClass;
		hue = a.meta.hue;
		title = a.meta.title;
		accent = accentSrgb(hue);
		theme = themeFor(hue);
		frame.hue = hue;
		loadedOnce = true;
		if (fresh) foldExpanded = readFoldPref(a);
		if (model.foldH <= 0) foldExpanded = true;
		foldBlockIdx = model.blocks.findIndex((b) => b.kind === BlockKind.fold);

		mirror = buildMirror(model, { foldExpanded: true });
		root.append(mirror.root);
		codeBlocks = [];
		enterBlocks = [];
		model.blocks.forEach((b, i) => {
			if (b.kind === BlockKind.code) codeBlocks.push(i);
			if (b.kind === BlockKind.figure || b.kind === BlockKind.image || b.kind === BlockKind.pullquote) enterBlocks.push(i);
		});
		enterState = new Uint8Array(model.blocks.length);
		enterStart = new Float64Array(model.blocks.length);
		codeDx.clear();
		figPlaying = []; figT = [];

		reading.load(model);
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
			replaceHash: (h) => { try { replaceState(location.pathname + location.search + h, page.state); } catch { /* router not ready */ } },
			pushHash: (h) => { try { pushState(location.pathname + location.search + h, page.state); } catch { /* router not ready */ } }
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
		const heads = parts.heads;
		const codeInfos: CodeBlockInfo[] = [];
		for (const i of codeBlocks) {
			if (i < st[RD.visFirst] - 1 || i > st[RD.visFirst] + st[RD.visCount]) continue;
			const r = viewRectOfBlock(i);
			if (r.y + r.h < 0 || r.y > viewH) continue;
			codeInfos.push({ block: i, rect: r, lang: codeLang(i) });
		}
		const figInfos: FigureInfo[] = [];
		m.figures.forEach((f, i) => {
			if (i >= MAX_FIG_STATE || f.mode === FigureMode.static) return;
			if (st[RD.figBase + 2 * i + 1] === 0) return;
			const b = m.blocks[f.block];
			if (!b) return;
			const r = viewRectOfBlock(f.block);
			if (r.y + r.h < 0 || r.y > viewH) return;
			figInfos.push({ fig: i, rect: r, playing: !!figPlaying[i], t: f.duration > 0 ? Math.min(1, (figT[i] ?? 0) / f.duration) : 0, steppable: true });
		});
		const hoverFig = hoverHit && hoverHit.kind === 'figure' ? hoverHit.fig : -1;
		const hoverCode = hoverHit && hoverHit.kind === 'code' ? hoverHit.block : -1;
		const lbSrc = lightbox ? { w: lightbox.w, h: lightbox.h, caption: lightbox.caption } : null;
		const popAnchor = popover ? linkViewRects(popover.link)[0] : null;
		const secIdx = (() => { let a = -1; const probe = y + viewH * 0.3; parts.sections.forEach((s, i) => { if (s.y <= probe) a = i; }); return a; })();
		const hoverLink = hoverHit && (hoverHit.kind === 'link' || hoverHit.kind === 'cite') && hoverHit.link >= 0 ? linkViewRects(hoverHit.link) : null;
		const focusLinkR = focusLinkIdx >= 0 ? linkViewRects(focusLinkIdx) : null;
		const col = originX + m.docX0 * emPx;
		const state: ChromeState = {
			theme: { ground: toRgb(theme.surface.ground), surface: toRgb(theme.surface.code), popover: toRgb(theme.surface.popover), ink: toRgb(theme.text.primary), ink2: toRgb(theme.text.secondary), ink3: toRgb(theme.text.tertiary), accent: toRgb(theme.accent) },
			reduced, hdrGain, nowMs: now, touch: ptrType === 'touch',
			view: { w: viewW, h: viewH }, colLeft: col,
			meta: {
				title, closeKind: fromWorld ? 'back' : 'close', wordsBrief: art?.meta.wordsBrief ?? 0, wordsFull: art?.meta.wordsFull ?? 0,
				sections: parts.sections, headings: heads.map((h) => ({ level: h.level, text: h.text, id: h.id, y: h.y })),
				refs: (art?.meta.refs ?? []).map((r) => ({ title: r.title, url: r.url }))
			},
			scrollY: y, docPx, progress: st[RD.progress], section: secIdx,
			foldExpanded,
			aa: { open: aaOpen, step: Math.max(0, scaleSteps.findIndex((s) => s === scale)), steps: scaleSteps.length, hasFold: m.foldH > 0, alwaysFull: false },
			tocOpen,
			popover: popover && popAnchor ? { ref: popover.ref, anchor: popAnchor } : null,
			lightbox: lbSrc,
			find,
			copyFlash, toasts,
			codeBlocks: codeInfos, figures: figInfos,
			hoverCode, focusCode: -1, hoverFig, focusFig: focusFig >= 0 ? m.figures.findIndex((f) => f.block === focusFig) : -1, scrubFig: st[RD.scrubFig],
			hoverLink, focusLink: focusLinkR,
			scrollbar: sbState.v,
			ticks: parts.sections.map((s) => s.y),
			anim: chromeAnim
		};
		return state;
	}
	const chromeAnim = createChromeAnim();

	function codeLang(i: number): string {
		const el = mirror?.blockEls[i];
		const lab = el?.getAttribute('aria-label') ?? '';
		const mt = /\(([^)]+)\)/.exec(lab);
		return mt ? mt[1] : '';
	}

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
		const el = mirror?.blockEls[i];
		return (el?.querySelector('code')?.textContent ?? el?.textContent ?? '').replace(/\n$/, '');
	}

	function copySelection() {
		if (!model || selEmpty(sel)) return false;
		const text = copyText(model, sel!, { clipEm: clipEm() });
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
		const alt = mirror?.blockEls[block]?.querySelector('img')?.getAttribute('alt') ?? '';
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

	function figFor(f: number) { return model!.figures[f]; }
	function figSet(i: number, v: number) { reading?.input(INPUT.scrubTo, i, Math.max(0, Math.min(figFor(i).duration, v))); }
	function beginScrub(i: number) { if (!scrubbing.has(i)) { scrubbing.add(i); reading?.input(INPUT.scrubBegin, i); } }
	function endScrub(i: number) {
		clearTimeout(scrubTimers.get(i));
		if (scrubbing.delete(i)) reading?.input(INPUT.scrubEnd, i, 0);
	}

	function act(a: string, x = 0, y = 0) {
		if (!model || !reading) return;
		const [k, p, q] = a.split(':');
		switch (k) {
			case 'close': closeOrBack(); break;
			case 'toggleAa': aaOpen = !aaOpen; if (aaOpen) tocOpen = tocOpen && cls === 0; break;
			case 'aa':
				if (p === 'step') setScale(scaleSteps[Math.max(0, Math.min(scaleSteps.length - 1, Number(q)))]);
				else if (p === 'full') setFold(!foldExpanded);
				else aaOpen = false;
				break;
			case 'toc':
				if (p === 'toggle') { tocOpen = !tocOpen; if (tocOpen) aaOpen = false; }
				else if (p === 'close') tocOpen = false;
				else {
					const h = chromeMetaParts().heads[Number(p)];
					if (h) { scrollSt?.scrollToBlock(h.block, true); if (cls !== 0) tocOpen = false; }
				}
				break;
			case 'cite': if (p === 'open') { const r = art?.meta.refs[Number(q)]; if (r?.url) window.open(r.url, '_blank', 'noopener,noreferrer'); } break;
			case 'lb': closeLightbox(); break;
			case 'copy': {
				const b = Number(p);
				void copyToClipboard(codeSource(b)).then((ok) => { copyFlash[b] = performance.now(); toast(ok ? 'Copied' : 'Copy failed'); });
				break;
			}
			case 'fig': {
				const i = Number(q), f = model.figures[i];
				if (!f) break;
				if (p === 'play') {
					if (f.mode === FigureMode.once && !figPlaying[i] && (figT[i] ?? 0) >= f.duration - 0.02) { reading.input(INPUT.figureHome, i); reading.input(INPUT.figurePlay, i, 1); }
					else reading.input(INPUT.figurePlay, i, figPlaying[i] ? 0 : 1);
				} else if (p === 'back') reading.input(INPUT.figureStep, i, -0.25);
				else if (p === 'fwd') reading.input(INPUT.figureStep, i, 0.25);
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
			case 'figure': {
				const f = hit.fig >= 0 ? model!.figures[hit.fig] : null;
				if (f && f.mode !== FigureMode.static && f.mode !== FigureMode.scrub) act(`fig:play:${hit.fig}`);
				break;
			}
			default: break;
		}
	}

	function cursorFor(h: Hit | null): string {
		if (!h) return 'default';
		switch (h.kind) {
			case 'link': case 'cite': case 'fold': return 'pointer';
			case 'image': return 'zoom-in';
			case 'text': case 'code': return 'text';
			case 'figure': return h.fig >= 0 && model!.figures[h.fig]?.mode === FigureMode.scrub ? 'ew-resize' : 'default';
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
		// citation hover intent
		if (hit && hit.kind === 'cite' && hit.link >= 0 && ptrType === 'mouse') {
			const want = hit.link;
			if (!popover || popover.link !== want) { clearTimeout(popTimer); popTimer = setTimeout(() => showPopover(want), 120); }
			else clearTimeout(popTimer);
		} else if (popover && !(ch && ch.id.startsWith('pop'))) {
			clearTimeout(popTimer);
			popTimer = setTimeout(() => { closePopover(); }, 160);
		}
		// scrub-mode figures follow the pointer
		if (hit && hit.kind === 'figure' && hit.fig >= 0 && ptrType === 'mouse' && !ch) {
			const f = model.figures[hit.fig];
			if (f && f.mode === FigureMode.scrub) {
				const b = model.blocks[f.block];
				const fr = Math.max(0, Math.min(1, (toDocX(x) - b.x0) / Math.max(1e-6, b.x1 - b.x0)));
				beginScrub(hit.fig); figSet(hit.fig, fr * f.duration);
				clearTimeout(scrubTimers.get(hit.fig));
				if (dragKind !== 'fig') scrubTimers.set(hit.fig, setTimeout(() => endScrub(hit.fig), 320));
			}
		}
		needDraw = true;
	}

	function onPointerMove(e: PointerEvent) {
		if (!model || !reading) return;
		const p = localPoint(e);
		ptr = p; ptrType = e.pointerType;
		if (downAt && Math.hypot(p.x - downAt.x, p.y - downAt.y) > 4) downAt.moved = true;
		if (dragKind === 'thumb') {
			reading.scroll.scrollTo(scrollbarDragTo(sbIn(), thumbGrab, p.y), false);
			needDraw = true;
			return;
		}
		if (dragKind === 'fig' && captured) {
			const i = Number(captured.split(':')[2]);
			const hit = lastChromeHits.find((r) => r.id === captured);
			const f = model.figures[i];
			if (hit && f) { const fr = Math.max(0, Math.min(1, (p.x - hit.x) / Math.max(1, hit.w))); beginScrub(i); figSet(i, fr * f.duration); }
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
		const p = localPoint(e);
		ptr = p; ptrType = e.pointerType;
		canvasEl?.focus?.();
		if (e.button !== 0) return;
		primaryDown = true;
		const ch = chromeAt(p.x, p.y);
		const hit = ch ? NONE : hitTest(model, toDocX(p.x), toDocY(p.y), viewOpts());
		downAt = { x: p.x, y: p.y, hit, chrome: ch, moved: false };
		if (ch) {
			if (ch.capture) {
				captured = ch.id;
				canvasEl?.setPointerCapture(e.pointerId);
				if (ch.id === 'sb:thumb') { dragKind = 'thumb'; thumbGrab = scrollbarDragStart(sbIn(), p.y); }
				else if (ch.id.startsWith('fig:scrub')) { dragKind = 'fig'; const i = Number(ch.id.split(':')[2]); beginScrub(i); const f = model.figures[i]; if (f) figSet(i, Math.max(0, Math.min(1, (p.x - ch.x) / Math.max(1, ch.w))) * f.duration); }
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
		if (aaOpen || tocOpen) { /* outside clicks are handled by chrome dismiss hits */ }
		needDraw = true;
	}

	function onPointerUp(e: PointerEvent) {
		if (!model || !reading) return;
		const p = localPoint(e);
		primaryDown = false;
		const d = downAt;
		downAt = null;
		const wasDrag = dragKind;
		dragKind = null;
		if (captured) { const id = captured; captured = null; if (id.startsWith('fig:scrub')) endScrub(Number(id.split(':')[2])); }
		try { canvasEl?.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
		if (!d || e.button !== 0) return;
		if (wasDrag === 'thumb' || wasDrag === 'fig') return;
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
		ptr = null;
		hoverHit = null;
		if (hoverBlockSent !== -1) { hoverBlockSent = -1; reading?.input(INPUT.hoverBlock, -1); }
		for (const i of [...scrubbing]) if (dragKind !== 'fig') endScrub(i);
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
		const detach = attachScroll(c as never, { wheel: (...a) => reading!.scroll.wheel(...a), pointer: (...a) => reading!.scroll.pointer(...a), key: () => false, scrollTo: (...a) => reading!.scroll.scrollTo(...a) }, noKeys);
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
	const NONE: Hit = { kind: 'none', block: -1, line: -1, glyph: -1, link: -1, fig: -1, note: -1, off: -1 };

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
		if (i >= 0) {
			mirror?.focusLink(i);
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
		const mod = e.metaKey || e.ctrlKey;
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
		if (e.key === 'Escape') {
			e.preventDefault();
			if (closeLightbox() || closePopover() || (aaOpen && (aaOpen = false, true)) || (tocOpen && (tocOpen = false, true)) || (focusFig >= 0 && (focusFig = -1, reading.input(INPUT.open, -1), true))) { needDraw = true; return; }
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
		if (k === 't') { act('toc:toggle'); e.preventDefault(); return; }
		if (k === 'f') {
			const fi = hoverHit && hoverHit.fig >= 0 ? hoverHit.fig : -1;
			if (focusFig >= 0) { focusFig = -1; reading.input(INPUT.open, -1); }
			else if (fi >= 0) { focusFig = model.figures[fi].block; reading.input(INPUT.open, focusFig); scrollSt?.scrollToBlock(focusFig, true); }
			e.preventDefault();
			return;
		}
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

	function frameLoop(now: number) {
		raf = requestAnimationFrame(frameLoop);
		const rd = reading, pg = pass, m = model;
		if (!rd || !pg || !m || !ready) return;
		counters.frames++;
		const dt = Math.min(100, lastT ? now - lastT : 16.7);
		lastT = now;

		rd.tick(dt);
		const st = rd.state();
		const y = st[RD.scrollY];

		let ev: { kind: ReadingEventKind; arg: number } | null;
		while ((ev = rd.poll())) {
			for (const cb of eventCbs) cb(ev.kind, ev.arg);
			if (ev.kind === 'foldExpand' && !foldExpanded) setFold(true, true);
		}
		const fclip = st[RD.foldClipEm];
		if (fclip !== lastClip) lastClip = fclip;

		const sec = st[RD.section], rb = st[RD.readingBlock];
		if (sec !== lastSection) lastSection = sec;
		if (rb !== lastReadBlock) { lastReadBlock = rb; scrollSt?.spy(rb); }
		if (y !== lastY && y >= 0) scrollSt?.scheduleSave();

		// live figures: channels of every visible figure at its clock
		const nf = Math.min(m.figures.length, MAX_FIG_STATE);
		for (let i = 0; i < nf; i++) {
			if (st[RD.figBase + 2 * i + 1] === 0) continue;
			const f = m.figures[i];
			const clock = st[RD.figBase + 2 * i];
			const moved = Math.abs(clock - (prevFigClock[i] ?? clock)) > 1e-4;
			prevFigClock[i] = clock;
			figT[i] = clock; figPlaying[i] = moved;
			const t = figureTime(FIG_MODES[f.mode] ?? 'loop', clock, f.duration, f.poster);
			for (let c = 0; c < f.chanCount; c++) {
				const gi = f.firstChan + c;
				if (gi >= 256) break;
				const ch = m.chans[gi];
				chans[gi] = evalKeys(m.keys, t, ch.firstKey, ch.keyCount);
			}
		}

		const animating = updateEnter(now, y, fclip || m.foldY + m.foldH);
		const scrolling = st[RD.scrollMode] !== SCROLL_MODE.idle;
		const washing = washBlock >= 0 && now - washT0 < 1200;
		if (!washing) washBlock = -1;
		const dirty = st[RD.dirty] !== 0 || animating || needDraw || firstDraw || lastY !== y || scrolling || chromeAnimating || washing || toasts.length > 0;
		lastY = y;
		if (!dirty) { counters.skipped++; return; }

		// ---- build the frame (the same object every time) ----
		overlays.length = 0;
		poolN = 0;
		blockDx.clear();
		const f = frame;
		f.scrollPx = y; f.emPx = emPx; f.originX = originX; f.originY = 0;
		f.viewW = viewW; f.viewH = viewH; f.dpr = dpr;
		f.visFirst = st[RD.visFirst]; f.visCount = st[RD.visCount]; f.noteFirst = st[RD.noteFirst]; f.noteCount = st[RD.noteCount];
		f.foldClipEm = fclip; f.hdrGain = hdrGain;
		f.groundA = mode === 'only' ? 1 : 0.92;
		f.ground.x0 = 0; f.ground.y0 = 0; f.ground.x1 = viewW; f.ground.y1 = viewH; f.ground.radius = 0;
		f.clip = undefined; f.only = undefined;
		f.time = now / 1000; f.dirty = true;
		for (const b of codeBlocks) { const dx = codeDx.get(b); if (dx) blockDx.set(b, dx * emPx); }

		const [ar, ag, ab] = accent;
		const g = hdrGain > 1 ? hdrGain : undefined;
		const vo = viewOpts();

		// selection plates
		if (sel && !selEmpty(sel)) {
			const sc = theme.selection;
			for (const r of selectionRects(m, sel, vo)) {
				const x0 = docXPx(r.x0), y0 = r.y0 * emPx - y, x1 = docXPx(r.x1), y1 = r.y1 * emPx - y;
				if (y1 < 0 || y0 > viewH) continue;
				ov(x0, y0, x1 - x0, y1 - y0, 2, ar, ag, ab, 0.30);
				void sc;
			}
		}
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
		for (const a of out.actions) act(a);
		if (out.lightbox && lightbox) f.lightbox = { block: lightbox.block, em: lightbox.em, rect: out.lightbox.rect, alpha: out.lightbox.alpha };
		else f.lightbox = undefined;
		// toasts age out
		for (let i = toasts.length - 1; i >= 0; i--) if (now - toasts[i].atMs > 2400) toasts.splice(i, 1);

		if (canvasEl) canvasEl.style.cursor = dragKind === 'select' ? 'text' : chromeCursor || cursorFor(ptr ? hoverHit : null);

		if (dev && devHook.frame) devHook.frame(f);
		const t0 = dev ? performance.now() : 0;
		pg.draw(f);
		if (dev) counters.lastDrawMs = performance.now() - t0;
		counters.draws++;
		rd.ackDirty();
		firstDraw = false;
		needDraw = animating || chromeAnimating || washing;
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
		document.addEventListener('keydown', onKey);
		document.addEventListener('paste', onPaste);
		window.addEventListener('popstate', onPopState);
		const onHide = () => scrollSt?.save();
		window.addEventListener('pagehide', onHide);

		if (dev) {
			(window as unknown as { __reader: unknown }).__reader = {
				get state() { return reading ? Array.from(reading.state()) : []; },
				get model() { return model; },
				get mirror() { return mirror; },
				get reading() { return reading; },
				get pass() { return pass; },
				get frameObj() { return frame; },
				get chrome() { return cs; },
				get hits() { return lastChromeHits; },
				get selection() { return sel; },
				get find() { return { ...find, hits: findHits.length }; },
				counters,
				get geometry() { return { viewW, viewH, dpr, emPx, originX, barPx, cls, scale, foldExpanded, reduced, hue }; },
				scrollTo: (id: string) => scrollSt?.goToAnchor(id, { smooth: false }),
				act: (a: string) => act(a),
				copySelection,
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
			pass?.dispose();
			pass = null;
			if (dev) delete (window as unknown as { __reader?: unknown }).__reader;
		};
	}


	let openedSlug = '';
	rootEl.classList.add('reader');
	rootEl.lang = 'en';
	rootEl.setAttribute('role', 'document');
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
