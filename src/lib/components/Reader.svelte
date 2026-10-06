<script lang="ts">
	// The reader core (docs/READING.md, docs/READING_CONTRACT.md): a native scroller holding the transparent DOM text layer, a fixed
	// canvas behind it drawn by the page pass at scrollTop, and the Flecs ReadingModule (wasm) owning reading state.
	import { onMount, setContext, mount, unmount, untrack, type Component } from 'svelte';
	import { goto, pushState, replaceState } from '$app/navigation';
	import { page } from '$app/state';
	import { BlockKind, BlockFlag, type ReadingModel } from '$lib/magazine/format';
	import { evalKeys, figureTime } from '$lib/magazine/chan';
	import { INPUT, RD, MAX_FIG_STATE, type Reading, type ReadingEventKind } from '$lib/reading/abi';
	import type { Overlay, PageFrame, PagePass } from '$lib/reading/page-api';
	import { createPagePass } from '$lib/reading/page';
	import { loadReadingOnly } from '$lib/ecs/reading';
	import { loadArticle, type LoadedArticle } from '$lib/reading/load';
	import {
		accentSrgb, barPxFor, cubicBezier, docLeftPx, emPxFor, originXFor, snapScale, widthClassFor, DEFAULT_SCALE
	} from '$lib/reading/metrics';
	import {
		READER_FONT_FACES, buildTextLayer, createCalibrator, type Calibrator, type TextLayer
	} from '$lib/reading/textlayer';
	import {
		createScrollState, docToLayoutY, layoutToDocY, lineRangeForYSpan, noteRangesForYSpan, readHistoryState,
		type SavedState, type ScrollController
	} from '$lib/reading/scrollstate';
	import { READER_CTX, createReaderCtx, closeArticle } from '$lib/reading/ctx';

	let {
		slug,
		mode,
		fromWorld = false,
		reading: readingProp,
		onClose
	}: { slug: string; mode: 'only' | 'world'; fromWorld?: boolean; reading?: Reading; onClose?: () => void } = $props();

	// Chrome lane components are optional: the reader compiles and runs without them.
	const chromeMods = import.meta.glob('./reader/*.svelte', { eager: true }) as Record<string, { default: Component<any> }>;
	const chrome = (n: string): Component<any> | undefined => chromeMods[`./reader/${n}.svelte`]?.default;
	const Bar = chrome('Bar');
	const Toc = chrome('Toc');
	const AaMenu = chrome('AaMenu');
	const Toast = chrome('Toast');
	const Popover = chrome('Popover');
	const Lightbox = chrome('Lightbox');
	const FigureControls = chrome('FigureControls');
	const CopyButton = chrome('CopyButton');

	const ctx = createReaderCtx({ mode: untrack(() => mode), slug: untrack(() => slug), fromWorld: untrack(() => fromWorld) });
	setContext(READER_CTX, ctx);

	let root = $state<HTMLDivElement>();
	let scroller = $state<HTMLElement>();
	let doc = $state<HTMLDivElement>();
	let ready = $state(false);
	let loadRev = $state(0);
	let mounted = $state(false);
	let cls = $state(0);
	let hue = $state(265);
	let title = $state('');

	// ---- runtime (plain variables: nothing here drives the template) ----
	const dev = import.meta.env.DEV;
	const FIG_MODES = ['loop', 'once', 'scrub', 'static'] as const;
	const ENTER_MS = 480;
	const enterEase = cubicBezier(0.2, 0.7, 0.2, 1);
	let pass: PagePass | null = null;
	let reading: Reading | null = null;
	let art: LoadedArticle | null = null;
	let model: ReadingModel | null = null;
	let layer: TextLayer | null = null;
	let calibrator: Calibrator | null = null;
	let scrollSt: ScrollController | null = null;
	let viewW = 0, viewH = 0, dpr = 1, emPx = 18, originX = 0, barPx = 40;
	let scale = DEFAULT_SCALE;
	let foldExpanded = false;
	let reduced = false;
	let loadedOnce = false;
	let raf = 0, lastT = 0, genToken = 0, disposed = false;
	let lastDocH = -1, lastClip = -1, lastScrollTop = -1, lastCalibY = -1e9;
	let needDraw = true, firstDraw = true, restoredScroll = false;
	let lastProgress = -1, lastSection = -2, lastReadBlock = -2;
	const eventCbs = new Set<(k: ReadingEventKind, a: number) => void>();
	const disposers: (() => void)[] = [];
	let articleDisposers: (() => void)[] = [];
	const counters = { frames: 0, draws: 0, skipped: 0, lastDrawMs: 0 };

	// per-frame reusable state
	const chans = new Float32Array(256);
	const overlays: Overlay[] = [];
	const pool: Overlay[] = [];
	let poolN = 0;
	const blockAlpha = new Map<number, number>();
	const blockDy = new Map<number, number>();
	const blockDx = new Map<number, number>();
	const frame: PageFrame & { blockDx?: Map<number, number> } = {
		scrollPx: 0, emPx: 18, originX: 0, originY: 0, viewW: 0, viewH: 0, dpr: 1,
		visFirst: 0, visCount: 0, noteFirst: 0, noteCount: 0, foldClipEm: 0, foldFadeEm: 3.24, chans,
		groundA: 1, ground: { x0: 0, y0: 0, x1: 0, y1: 0, radius: 0 }, blockAlpha, blockDy, blockDx, overlays,
		hdrGain: 1, time: 0, hue: 265, dirty: true
	};
	let accent: [number, number, number] = [0.6, 0.6, 1];
	let enterState = new Uint8Array(0); // 0 waiting, 1 animating, 2 done
	let enterStart = new Float64Array(0);
	let enterBlocks: number[] = [];
	let codeBlocks: { i: number; el: HTMLElement }[] = [];
	let foldBlockIdx = -1;

	// pointer / focus targets, measured in doc px (y at scrollTop 0) so a scroll only subtracts scrollTop
	let hoverLink: HTMLElement | null = null;
	let hoverRect: { x: number; y: number; w: number } | null = null;
	let focusEl: HTMLElement | null = null;
	let focusRect: { x: number; y: number; w: number; h: number } | null = null;
	let hoverBlockSent = -1;
	let hdrGain = 1;

	const ov = (x: number, y: number, w: number, h: number, radius: number, r: number, g: number, b: number, a: number, hdr?: number): void => {
		let o = pool[poolN];
		if (!o) pool[poolN] = o = { x: 0, y: 0, w: 0, h: 0, radius: 0, r: 0, g: 0, b: 0, a: 0 };
		poolN++;
		o.x = x; o.y = y; o.w = w; o.h = h; o.radius = radius; o.r = r; o.g = g; o.b = b; o.a = a; o.hdr = hdr;
		overlays.push(o);
	};

	// ---- geometry ----

	function computeMetrics() {
		const m = model!;
		const docW = m.docX1 - m.docX0;
		emPx = emPxFor(viewW, cls, scale, docW, m.colW);
		originX = originXFor(viewW, emPx, m.docX0, m.docX1);
		barPx = barPxFor(cls);
	}

	function syncHeight() {
		if (!reading || !model || !doc) return;
		const st = reading.state();
		const clip = st[RD.foldClipEm];
		const h = (st[RD.docHeightEm] || model.docH) * emPx;
		if (Math.abs(h - lastDocH) > 0.4) {
			doc.style.height = `${h}px`;
			lastDocH = h;
		}
		if (clip !== lastClip) {
			lastClip = clip;
			layer?.setFoldClip(clip || model.foldY + model.foldH);
		}
	}

	function applyGeometry() {
		if (!root || !doc || !model) return;
		const m = model;
		root.style.setProperty('--em', `${emPx}px`);
		root.style.setProperty('--bar-h', `${barPx}px`);
		doc.style.left = `${docLeftPx(originX, emPx, m.docX0)}px`;
		doc.style.width = `${(m.docX1 - m.docX0) * emPx}px`;
		lastDocH = -1;
		syncHeight();
	}

	function currentClipEm(): number {
		return reading ? reading.state()[RD.foldClipEm] || (model ? model.foldY + model.foldH : 0) : 0;
	}

	function relayout(restoreKey: SavedState | null) {
		if (!model || !reading || !pass || !scroller) return;
		computeMetrics();
		reading.setViewport(viewW, viewH, dpr, emPx, cls);
		pass.resize(viewW, viewH, dpr);
		reading.tick(0);
		applyGeometry();
		if (restoreKey) scrollSt?.restore({ ...restoreKey, fold: false });
		layer?.invalidate();
		lastCalibY = -1e9;
		measureTargets();
		needDraw = true;
	}

	// ---- fold ----

	function setFold(open: boolean, instant = false) {
		if (!reading || !layer || !model) return;
		if (model.foldH <= 0 || foldExpanded === open) return;
		foldExpanded = open;
		layer.setFold(open);
		const inst = instant || reduced;
		reading.input(INPUT.foldSet, open ? 1 : 0, inst ? 1 : 0);
		ctx.foldExpanded.set(open);
		try { localStorage.setItem(`reader:fold:${slug}`, open ? '1' : '0'); } catch { /* private mode */ }
		if (inst) { reading.tick(0); syncHeight(); }
		if (!open) {
			const ae = document.activeElement as HTMLElement | null;
			if (ae && layer.foldRegion?.contains(ae)) layer.foldButton?.focus({ preventScroll: true });
			const k = scrollSt?.key();
			if (k && model.blocks[k.blockId] && (model.blocks[k.blockId].flags & BlockFlag.folded) && foldBlockIdx >= 0) scrollSt?.scrollToBlock(foldBlockIdx, false);
		}
		layer.invalidate();
		calibrator?.request();
		needDraw = true;
	}

	// ---- article lifecycle ----

	function teardownArticle() {
		for (const d of articleDisposers) d();
		articleDisposers = [];
		calibrator?.dispose();
		calibrator = null;
		scrollSt?.dispose();
		scrollSt = null;
		layer?.dispose();
		layer = null;
		codeBlocks = [];
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
		if (my !== genToken || disposed || !root || !doc || !scroller) return;
		try {
			if (!pass) {
				pass = await createPagePass(null, { alpha: mode === 'only' ? 'opaque' : 'premultiplied', debug: dev });
				if (my !== genToken || disposed) { pass.dispose(); pass = null; return; }
				pass.canvas.classList.add('page');
				pass.canvas.setAttribute('aria-hidden', 'true');
				root.insertBefore(pass.canvas, scroller);
			}
			reading = readingProp ?? (await loadReadingOnly());
			await pass.load(a.fonts, a.model, a.imageUrls);
		} catch (e) {
			console.error('reader: page pass failed', e);
			return;
		}
		if (my !== genToken || disposed || !pass || !reading || !root || !doc || !scroller) return;

		teardownArticle();
		art = a;
		model = a.model;
		cls = a.widthClass;
		hue = a.meta.hue;
		title = a.meta.title;
		accent = accentSrgb(hue);
		frame.hue = hue;
		loadedOnce = true;
		if (fresh) foldExpanded = readFoldPref(a);
		if (model.foldH <= 0) foldExpanded = true;
		root.style.setProperty('--hue', String(hue));
		foldBlockIdx = model.blocks.findIndex((b) => b.kind === BlockKind.fold);

		layer = buildTextLayer(model, doc, { foldExpanded });
		codeBlocks = [];
		enterBlocks = [];
		model.blocks.forEach((b, i) => {
			if (b.kind === BlockKind.code) codeBlocks.push({ i, el: layer!.blocks[i] });
			if (b.kind === BlockKind.figure || b.kind === BlockKind.image || b.kind === BlockKind.pullquote) enterBlocks.push(i);
		});
		enterState = new Uint8Array(model.blocks.length);
		enterStart = new Float64Array(model.blocks.length);
		for (const c of codeBlocks) {
			const onScroll = () => { needDraw = true; };
			c.el.addEventListener('scroll', onScroll, { passive: true });
			articleDisposers.push(() => c.el.removeEventListener('scroll', onScroll));
		}
		// a find match or an anchor inside the collapsed region: un-hide before the browser scrolls
		const region = layer.foldRegion;
		if (region) {
			const onBefore = () => setFold(true, true);
			region.addEventListener('beforematch', onBefore);
			articleDisposers.push(() => region.removeEventListener('beforematch', onBefore));
		}

		const L = layer;
		calibrator = createCalibrator(
			doc,
			() => {
				if (!model || !scroller) return [];
				const clip = currentClipEm();
				const y = scroller.scrollTop / emPx;
				const vp = viewH / emPx;
				const y0 = docToLayoutY(model, Math.max(0, y - 2 * vp), clip);
				const y1 = docToLayoutY(model, y + 3 * vp, clip);
				return [lineRangeForYSpan(model, y0, y1), ...noteRangesForYSpan(model, y0, y1)];
			},
			() => emPx
		);

		reading.load(model);
		computeMetrics();
		reading.setViewport(viewW, viewH, dpr, emPx, cls);
		reading.input(INPUT.reducedMotion, reduced ? 1 : 0);
		reading.input(INPUT.foldSet, foldExpanded ? 1 : 0, 1);
		reading.setScroll(0);
		reading.tick(0);
		pass.resize(viewW, viewH, dpr);
		applyGeometry();
		lastScrollTop = -1;
		lastProgress = -1; lastSection = -2; lastReadBlock = -2;

		scrollSt = createScrollState({
			scroller,
			getModel: () => model!,
			getEmPx: () => emPx,
			getClipEm: currentClipEm,
			getBarPx: () => barPx,
			isFoldExpanded: () => foldExpanded,
			setFold,
			syncLayout: () => { reading!.tick(0); syncHeight(); },
			reduced: () => reduced,
			blockEl: (i) => L.blocks[i],
			scale: () => scale,
			fromWorld: () => ctx.fromWorld,
			replaceHash: (h) => { try { replaceState(location.pathname + location.search + h, page.state); } catch { /* router not ready */ } },
			pushHash: (h) => { try { pushState(location.pathname + location.search + h, page.state); } catch { /* router not ready */ } }
		});

		// scroll position: an anchor from the previous class, history.state, the hash, else the top
		restoredScroll = false;
		if (key) restoredScroll = scrollSt.restore(key);
		else if (initial && scrollSt.restoreFromHistory()) restoredScroll = true;
		else if (initial && location.hash && scrollSt.goToHash(location.hash, { smooth: false })) restoredScroll = true;
		else scroller.scrollTop = 0;

		fillCtx();
		ctx.foldExpanded.set(foldExpanded);
		ready = true;
		loadRev++;
		firstDraw = true;
		needDraw = true;

		// copy buttons (chrome lane) mount into the slots the text layer leaves in each code block
		if (CopyButton) {
			for (const c of codeBlocks) {
				const slot = c.el.querySelector('.copy-slot');
				if (!slot) continue;
				const inst = mount(CopyButton, { target: slot, props: { block: c.i, source: L.codeSource(c.i) }, context: new Map([[READER_CTX, ctx]]) });
				articleDisposers.push(() => { void unmount(inst); });
			}
		}

		const faces = READER_FONT_FACES.map((f) => document.fonts.load(f).catch(() => []));
		void Promise.all(faces).then(() => document.fonts.ready).then(() => {
			if (my !== genToken || !layer) return;
			layer.invalidate();
			calibrator?.request();
		});
		calibrator.request();
	}

	function fillCtx() {
		ctx.reading = reading;
		ctx.model = model;
		ctx.meta = art?.meta ?? null;
		ctx.slug = slug;
		ctx.root = root ?? null;
		ctx.scroller = scroller ?? null;
		ctx.doc = doc ?? null;
		ctx.layer = layer;
		ctx.headings = layer?.headings ?? [];
	}

	// ---- scroll-to helpers exposed through ctx ----

	function setScale(s: number) {
		const v = snapScale(s);
		if (v === scale) return;
		const key = scrollSt?.key() ?? null;
		scale = v;
		ctx.scale.set(v);
		try { localStorage.setItem('reader:scale', String(v)); } catch { /* private mode */ }
		relayout(key);
	}

	// ---- input ----

	function onKey(e: KeyboardEvent) {
		if (e.defaultPrevented || !ready) return;
		const t = e.target as HTMLElement | null;
		if (t && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
		if (e.key === 'Escape') {
			for (let i = ctx.closeStack.length - 1; i >= 0; i--) {
				if (ctx.closeStack[i]()) { e.preventDefault(); return; }
			}
			e.preventDefault();
			if (onClose) onClose();
			else closeArticle();
			return;
		}
		if (e.metaKey || e.ctrlKey || e.altKey) return;
		switch (e.key.toLowerCase()) {
			case 'j': scrollSt?.jump(1); e.preventDefault(); break;
			case 'k': scrollSt?.jump(-1); e.preventDefault(); break;
			case 'e': setFold(!foldExpanded); e.preventDefault(); break;
			case 't': ctx.toggleContents?.(); e.preventDefault(); break;
		}
	}

	function onDocClick(e: MouseEvent) {
		const t = e.target as HTMLElement;
		const fold = t.closest('button.fold');
		if (fold) { setFold(!foldExpanded); return; }
		const img = t.closest<HTMLElement>('button.image-btn');
		if (img) {
			const b = img.closest<HTMLElement>('.b');
			if (b && ctx.openLightbox) ctx.openLightbox(Number(b.dataset.block));
			return;
		}
		const a = t.closest<HTMLAnchorElement>('a[href]');
		if (!a) return;
		if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
		const href = a.getAttribute('href') ?? '';
		if (href.startsWith('#')) {
			e.preventDefault();
			let id = href.slice(1);
			try { id = decodeURIComponent(id); } catch { /* raw */ }
			if (id === 'full') { setFold(true); return; }
			scrollSt?.goToAnchor(id, { smooth: true, push: true });
		} else if (href.startsWith('/')) {
			e.preventDefault();
			void goto(href);
		}
		// external: target=_blank rel=noopener set by the text layer
	}

	function lineHeightPx(el: HTMLElement): number {
		const span = el.closest<HTMLElement>('.ln') ?? el;
		return span.getBoundingClientRect().height;
	}

	function measureLinkRect(a: HTMLElement) {
		const r = a.getBoundingClientRect();
		const lh = lineHeightPx(a);
		const fs = parseFloat(getComputedStyle(a).fontSize) || emPx;
		// underline sits 0.18em under the baseline; baseline of a centred line box is about lh / 2 + 0.365 fs (Inter metrics)
		const lineTop = r.top + (r.height - lh) / 2;
		hoverRect = { x: r.left, y: lineTop + lh / 2 + 0.545 * fs - 1 + (scroller?.scrollTop ?? 0), w: r.width };
	}
	function measureFocusRect(el: HTMLElement) {
		const r = el.getBoundingClientRect();
		focusRect = { x: r.left, y: r.top + (scroller?.scrollTop ?? 0), w: r.width, h: r.height };
	}
	function measureTargets() {
		if (hoverLink && hoverLink.isConnected) measureLinkRect(hoverLink); else { hoverLink = null; hoverRect = null; }
		if (focusEl && focusEl.isConnected) measureFocusRect(focusEl); else { focusEl = null; focusRect = null; }
	}

	function onPointerMove(e: PointerEvent) {
		if (!reading) return;
		const t = e.target as HTMLElement | null;
		const a = (t?.closest('a[href]') as HTMLElement | null) ?? null;
		if (a !== hoverLink) {
			hoverLink = a;
			if (a) measureLinkRect(a); else hoverRect = null;
			needDraw = true;
		}
		const b = t?.closest('.b') as HTMLElement | null | undefined;
		const bi = b && b.dataset.block !== undefined ? Number(b.dataset.block) : -1;
		if (bi !== hoverBlockSent) {
			hoverBlockSent = bi;
			reading.input(INPUT.hoverBlock, bi);
			ctx.hoverBlock.set(bi);
			needDraw = true;
		}
	}
	function onPointerLeave() {
		if (hoverLink || hoverBlockSent !== -1) {
			hoverLink = null; hoverRect = null; hoverBlockSent = -1;
			reading?.input(INPUT.hoverBlock, -1);
			ctx.hoverBlock.set(-1);
			needDraw = true;
		}
	}
	function onFocusIn(e: FocusEvent) {
		const el = e.target as HTMLElement;
		if (!el || el === scroller || !doc?.contains(el)) return;
		let vis = true;
		try { vis = el.matches(':focus-visible'); } catch { /* old engines */ }
		if (!vis) return;
		focusEl = el;
		measureFocusRect(el);
		const b = el.closest<HTMLElement>('.b');
		const bi = b?.dataset.block !== undefined ? Number(b.dataset.block) : -1;
		reading?.input(INPUT.focusBlock, bi);
		ctx.focusBlock.set(bi);
		needDraw = true;
	}
	function onFocusOut(e: FocusEvent) {
		if (e.target === focusEl) {
			focusEl = null; focusRect = null;
			reading?.input(INPUT.focusBlock, -1);
			ctx.focusBlock.set(-1);
			needDraw = true;
		}
	}
	function onPopState() {
		// SvelteKit has already moved the entry; land on its saved anchor (or hash) after it settled
		setTimeout(() => {
			if (!scrollSt) return;
			if (!scrollSt.restoreFromHistory()) scrollSt.goToHash(location.hash, { smooth: true });
		}, 0);
	}

	// ---- rAF frame protocol (docs/READING_CONTRACT.md) ----

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
		const rd = reading, pg = pass, sc = scroller, m = model;
		if (!rd || !pg || !sc || !m || !ready) return;
		counters.frames++;
		const dt = Math.min(100, lastT ? now - lastT : 16.7);
		lastT = now;

		const y = sc.scrollTop;
		rd.setScroll(y);
		rd.tick(dt);
		const st = rd.state();

		let ev: { kind: ReadingEventKind; arg: number } | null;
		while ((ev = rd.poll())) {
			for (const cb of eventCbs) cb(ev.kind, ev.arg);
			if (ev.kind === 'foldExpand' && !foldExpanded) setFold(true, true);
			else if (ev.kind === 'open') ctx.openBlock.set(ev.arg);
		}
		if (st[RD.docHeightEm] * emPx !== lastDocH || st[RD.foldClipEm] !== lastClip) syncHeight();

		const sec = st[RD.section], rb = st[RD.readingBlock], prog = st[RD.progress];
		if (sec !== lastSection) { lastSection = sec; ctx.section.set(sec); }
		if (rb !== lastReadBlock) { lastReadBlock = rb; ctx.readingBlock.set(rb); scrollSt?.spy(rb); }
		if (Math.abs(prog - lastProgress) > 0.0005) { lastProgress = prog; ctx.progress.set(prog); }

		if (Math.abs(y - lastCalibY) > viewH * 0.5) { lastCalibY = y; calibrator?.request(); }
		if (st[RD.foldSettled] !== 1 && (hoverLink || focusEl)) measureTargets();

		// live figures: channels of every visible figure at its clock
		const nf = Math.min(m.figures.length, MAX_FIG_STATE);
		for (let i = 0; i < nf; i++) {
			if (st[RD.figBase + 2 * i + 1] === 0) continue;
			const f = m.figures[i];
			const t = figureTime(FIG_MODES[f.mode] ?? 'loop', st[RD.figBase + 2 * i], f.duration, f.poster);
			for (let c = 0; c < f.chanCount; c++) {
				const gi = f.firstChan + c;
				if (gi >= 256) break;
				const ch = m.chans[gi];
				chans[gi] = evalKeys(m.keys, t, ch.firstKey, ch.keyCount);
			}
		}

		const animating = updateEnter(now, y, st[RD.foldClipEm] || m.foldY + m.foldH);
		let overlayAnim = false;
		const dirty = st[RD.dirty] !== 0 || animating || needDraw || firstDraw || lastScrollTop !== y;
		lastScrollTop = y;
		if (!dirty) { counters.skipped++; return; }

		// ---- build the frame (the same object every time) ----
		overlays.length = 0;
		poolN = 0;
		blockDx.clear();
		const f = frame;
		f.scrollPx = y; f.emPx = emPx; f.originX = originX; f.originY = 0;
		f.viewW = viewW; f.viewH = viewH; f.dpr = dpr;
		f.visFirst = st[RD.visFirst]; f.visCount = st[RD.visCount]; f.noteFirst = st[RD.noteFirst]; f.noteCount = st[RD.noteCount];
		f.foldClipEm = st[RD.foldClipEm]; f.hdrGain = hdrGain;
		f.groundA = mode === 'only' ? 1 : 0.92;
		f.ground.x0 = 0; f.ground.y0 = 0; f.ground.x1 = viewW; f.ground.y1 = viewH; f.ground.radius = 0;
		f.clip = undefined; f.only = undefined;
		f.time = now / 1000; f.dirty = true;

		for (const c of codeBlocks) if (c.i >= f.visFirst - 1 && c.i <= f.visFirst + f.visCount) { const dx = c.el.scrollLeft; if (dx) blockDx.set(c.i, dx); }

		const [ar, ag, ab] = accent;
		const g = hdrGain > 1 ? hdrGain : undefined;
		if (hoverRect) ov(hoverRect.x, hoverRect.y - y, hoverRect.w, 2, 1, ar, ag, ab, 1, g);
		if (focusRect) {
			const o = 3, w = 2;
			const x = focusRect.x - o - w, yy = focusRect.y - y - o - w, ww = focusRect.w + 2 * (o + w), hh = focusRect.h + 2 * (o + w);
			ov(x, yy, ww, w, 1, ar, ag, ab, 1, g);
			ov(x, yy + hh - w, ww, w, 1, ar, ag, ab, 1, g);
			ov(x, yy + w, w, hh - 2 * w, 1, ar, ag, ab, 1, g);
			ov(x + ww - w, yy + w, w, hh - 2 * w, 1, ar, ag, ab, 1, g);
		}
		if (st[RD.scrollMaxEm] > 0.01) {
			ov(viewW - 2, 0, 2, viewH, 0, 1, 1, 1, 0.07);
			const hh = Math.max(28, Math.min(viewH * 0.25, (st[RD.viewportEm] / Math.max(1, st[RD.docHeightEm])) * viewH));
			ov(viewW - 2, prog * (viewH - hh), 2, hh, 1, ar, ag, ab, 1, g);
		}
		for (const p of ctx.overlayProviders) if (p(overlays, now, f)) overlayAnim = true;

		ctx.frameHook?.(f);
		const t0 = dev ? performance.now() : 0;
		pg.draw(f);
		if (dev) counters.lastDrawMs = performance.now() - t0;
		counters.draws++;
		rd.ackDirty();
		firstDraw = false;
		needDraw = animating || overlayAnim;
	}

	// ---- mount ----

	onMount(() => {
		const r = root!, sc = scroller!;
		viewW = r.clientWidth; viewH = r.clientHeight; dpr = window.devicePixelRatio || 1;
		try {
			const sv = parseFloat(localStorage.getItem('reader:scale') ?? '');
			if (Number.isFinite(sv)) scale = snapScale(sv);
		} catch { /* private mode */ }
		const hs = readHistoryState();
		if (hs && Number.isFinite(hs.scale)) scale = snapScale(hs.scale);
		if (hs?.fromWorld) ctx.fromWorld = true;
		ctx.scale.set(scale);
		const mqMotion = matchMedia('(prefers-reduced-motion: reduce)');
		const mqHdr = matchMedia('(dynamic-range: high)');
		const mqContrast = matchMedia('(prefers-contrast: more)');
		const motion = () => { reduced = mqMotion.matches; reading?.input(INPUT.reducedMotion, reduced ? 1 : 0); };
		const hdr = () => { hdrGain = mqHdr.matches && !mqContrast.matches ? 1.5 : 1; needDraw = true; };
		motion(); hdr();
		mqMotion.addEventListener('change', motion);
		mqHdr.addEventListener('change', hdr);
		mqContrast.addEventListener('change', hdr);

		Object.assign(ctx, {
			em: () => emPx, widthClass: () => cls, barPx: () => barPx, reduced: () => reduced,
			setScale,
			expandFold: (instant?: boolean) => setFold(true, !!instant),
			collapseFold: () => setFold(false),
			toggleFold: () => setFold(!foldExpanded),
			scrollToBlock: (i: number, smooth?: boolean) => scrollSt?.scrollToBlock(i, smooth),
			scrollToAnchor: (id: string, o?: { smooth?: boolean; push?: boolean }) => scrollSt?.goToAnchor(id, o) ?? false,
			input: (k: number, a: number, b?: number) => { reading?.input(k, a, b); needDraw = true; },
			requestDraw: () => { needDraw = true; },
			onEvent: (cb: (k: ReadingEventKind, a: number) => void) => { eventCbs.add(cb); return () => eventCbs.delete(cb); }
		});

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
		const onWinScroll = () => scrollSt?.scheduleSave();
		sc.addEventListener('scroll', onWinScroll, { passive: true });
		document.addEventListener('keydown', onKey);
		window.addEventListener('popstate', onPopState);
		const onFonts = () => { layer?.invalidate(); calibrator?.request(); };
		document.fonts.addEventListener('loadingdone', onFonts);
		const onHide = () => scrollSt?.save();
		window.addEventListener('pagehide', onHide);

		if (dev) {
			(window as unknown as { __reader: unknown }).__reader = {
				get state() { return reading ? Array.from(reading.state()) : []; },
				get model() { return model; },
				get layer() { return layer; },
				get reading() { return reading; },
				get pass() { return pass; },
				get frameObj() { return frame; },
				counters,
				get geometry() { return { viewW, viewH, dpr, emPx, originX, barPx, cls, scale, foldExpanded, reduced, hue }; },
				scrollTo: (id: string) => scrollSt?.goToAnchor(id, { smooth: false }),
				ctx
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
			sc.removeEventListener('scroll', onWinScroll);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('popstate', onPopState);
			window.removeEventListener('pagehide', onHide);
			document.fonts.removeEventListener('loadingdone', onFonts);
			mqMotion.removeEventListener('change', motion);
			mqHdr.removeEventListener('change', hdr);
			mqContrast.removeEventListener('change', hdr);
			scrollSt?.save();
			teardownArticle();
			for (const d of disposers) d();
			pass?.dispose();
			pass = null;
			if (dev) delete (window as unknown as { __reader?: unknown }).__reader;
		};
	});

	// (re)load when the slug changes after mount
	let openedSlug = '';
	$effect(() => {
		const s = slug;
		if (!mounted) return;
		untrack(() => {
			ctx.slug = s;
			if (s === openedSlug) return;
			openedSlug = s;
			void openArticle(widthClassFor(viewW), null);
		});
	});
</script>

<div class="reader" bind:this={root} data-mode={mode} data-class={cls} data-ready={ready} lang="en" style:--hue={hue}>
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<main
		class="scroller"
		bind:this={scroller}
		tabindex="0"
		aria-label={title || 'Article'}
	>
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div
			class="doc"
			bind:this={doc}
			onclick={onDocClick}
			onpointermove={onPointerMove}
			onpointerleave={onPointerLeave}
			onfocusin={onFocusIn}
			onfocusout={onFocusOut}
		></div>
	</main>
	{#if ready}
		{#key loadRev}
			{#if Bar}<Bar />{/if}
			{#if Toc}<Toc />{/if}
			{#if AaMenu}<AaMenu />{/if}
			{#if FigureControls}<FigureControls />{/if}
			{#if Popover}<Popover />{/if}
			{#if Lightbox}<Lightbox />{/if}
			{#if Toast}<Toast />{/if}
		{/key}
	{/if}
</div>
