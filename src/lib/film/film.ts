// The film host (docs/NARRATED.md "Built contract"): owns the film clock (slaved to the voice file when there is one), the gates that hold it for
// the viewer, the exhibit mounts, the GPU captions with word highlight, the transcript and the transport. The reader (reading/reader.ts) mounts it as a
// mode of the article and draws what `frame()` returns. Everything the film draws is the page pass's overlays and UI glyphs: no DOM.
import { XPOINTER, type ExhibitApi } from '../reading/abi';
import { convertItems, createRouter, mappingOf, newPools, toLocal, type Mapping, type Pools, type TextDeps } from '../reading/exhibit';
import type { ExhibitDraw, Overlay } from '../reading/page-api';
import { THEME } from '../reading/theme';
import type { UiGlyph } from '../reading/ui/types';
import type { ReadingModel } from '../magazine/format';
import { STAGE, type FilmApi, type FilmFrame, type FilmInfo, type MountRow, type SayInfo } from './abi';
import { createVoice, fetchAlign, loadSaved, save, type AlignFile, type Voice } from './audio';
import { activeWord, captionPage, fmtTime, gatesOf, leaveGate, newTransport, sayAt, sceneIndexAt, seekTo, SPEEDS, stepTransport, wrapWords, type Gate, type Transport, type TransportEvent } from './core';

export interface FilmHost {
	slug: string;
	film: FilmApi;
	exhibit: ExhibitApi;
	model: ReadingModel;
	/** exhibit ids of the article by index (reading/exhibit.ts exhibitId) */
	exIds: string[];
	text: TextDeps;
	/** (re)load exhibit `ex` from its source: its state returns to the script's start */
	resetExhibit(ex: number): void;
	call(ex: number, kind: number, xEm: number, yEm: number, buttons: number, mods: number): number;
	focus(ex: number): void;
	capture(id: number): void;
	release(id: number): void;
	/** wake the render loop */
	wake(): void;
	toast(msg: string): void;
	/** leave the film for the reader (`to: 'reader'`) or the article (`'close'`) */
	leave(to: 'reader' | 'close'): void;
	/** exercise hooks for tests */
	now?: () => number;
}

export interface FilmOut { overlays: Overlay[]; uiText: UiGlyph[]; exhibits: ExhibitDraw[]; cursor: string | null; animating: boolean }

interface Hit { id: string; x: number; y: number; w: number; h: number; cursor?: string }

const VERB: Record<string, number> = { load: 0, step: 1, run: 2, reset: 3, toggle: 4 };
const rgb = (c: readonly number[]): [number, number, number] => [c[0], c[1], c[2]];
const INK = rgb(THEME.text.primary), INK2 = rgb(THEME.text.secondary), INK3 = rgb(THEME.text.tertiary), ACC = rgb(THEME.accent), GROUND = rgb(THEME.surface.ground);
const RULE = rgb(THEME.hairline.card);

/** layout numbers in CSS px that scale with the viewport */
export function metrics(viewW: number, viewH: number) {
	const u = Math.max(0.8, Math.min(1.5, Math.min(viewW / 1100, viewH / 650)));
	return { u, bar: Math.round(46 * u), pad: Math.round(16 * u), cap: Math.round(Math.max(15, Math.min(34, viewH * 0.034))), small: Math.round(13 * u) };
}

export function createFilm(host: FilmHost) {
	const now = host.now ?? (() => performance.now());
	const { film } = host;
	let info!: FilmInfo;
	let gates: Gate[] = [];
	let tr: Transport = newTransport();
	let voice: Voice | null = null;
	let align: AlignFile | null = null;
	let voiceFailed = false;
	let cc = true;
	let transcript = false;
	let transcriptY = 0;
	let transcriptFollow = true;
	let ctrlUntil = 0;
	let hover: string | null = null;
	let drag: 'scrub' | null = null;
	let ptr: { x: number; y: number } | null = null;
	let lastScene = -1;
	let lastCmdT = 0;
	let needSync = true;
	let lastSave = 0;
	let viewW = 0, viewH = 0;
	let hits: Hit[] = [];
	let lastFrame: FilmFrame | null = null;
	let stageMap: Mapping = { x: 0, y: 0, k: 1 };
	let mountRects = new Map<number, { x: number; y: number; w: number; h: number; map: Mapping; grab: boolean }>();
	let grabbed = false;
	let disposed = false;
	const pools: Pools = newPools();
	const exOut: ExhibitDraw[] = [];
	const stagePool = { overlays: [] as Overlay[], uiText: [] as UiGlyph[] };
	const ovPool: Overlay[] = [];
	const glPool: UiGlyph[] = [];
	let ovN = 0, glN = 0;
	let outRef: FilmOut | null = null;
	const ev: TransportEvent[] = [];

	// ---- primitives ----
	const ov = (x: number, y: number, w: number, h: number, radius: number, c: readonly number[], a: number, shape = 0, width = 0) => {
		if (!(a > 0.002)) return;
		let o = ovPool[ovN];
		if (!o) ovPool[ovN] = o = { x: 0, y: 0, w: 0, h: 0, radius: 0, r: 0, g: 0, b: 0, a: 0 };
		ovN++;
		o.x = x; o.y = y; o.w = w; o.h = h; o.radius = radius; o.r = c[0]; o.g = c[1]; o.b = c[2]; o.a = a; o.shape = shape; o.width = width;
		outRef!.overlays.push(o);
	};
	const txt = (s: string, x: number, base: number, size: number, c: readonly number[], a: number, font: 'sans' | 'mono' = 'sans', align: 0 | 1 | 2 = 0): number => {
		if (!s || !(a > 0.002)) return 0;
		const sh = host.text.shape(s, font, size);
		const ox = x - (align === 1 ? sh.width / 2 : align === 2 ? sh.width : 0);
		for (const g of sh.glyphs) {
			let u = glPool[glN];
			if (!u) glPool[glN] = u = { x: 0, y: 0, glyphId: 0, font, size: 0, r: 0, g: 0, b: 0, a: 0 };
			glN++;
			u.x = ox + g.dx; u.y = base; u.glyphId = g.glyphId; u.font = font; u.size = size; u.r = c[0]; u.g = c[1]; u.b = c[2]; u.a = a;
			outRef!.uiText.push(u);
		}
		return sh.width;
	};
	const width = (s: string, size: number, font: 'sans' | 'mono' = 'sans') => host.text.shape(s, font, size).width;

	// ---- loading ----
	async function load(src: string): Promise<string | null> {
		const err = host.film.load(src);
		if (err) return err;
		info = host.film.info();
		gates = gatesOf(info);
		align = await fetchAlign(host.slug);
		if (disposed) return null;
		if (align) {
			const e = host.film.align(JSON.stringify(align));
			if (e) { host.toast(`voice file ignored: ${e.split('\n')[0].slice(0, 70)}`); align = null; } else info = host.film.info();
			gates = gatesOf(info);
			if (align) {
				voice = createVoice(host.slug, align, host.wake);
				if (!voice) voiceFailed = true;
			}
		}
		const sv = loadSaved(host.slug, info.total);
		cc = sv.cc;
		tr = newTransport(sv.speed);
		seekTo(tr, gates, sv.t, info.total);
		voice?.rate(tr.speed);
		voice?.seek(tr.t);
		needSync = true;
		setupMediaSession();
		return null;
	}

	/** dev hot reload of the script: keeps the time */
	function reload(src: string): string | null {
		const err = host.film.reload(src);
		if (err) return err;
		const t = tr.t;
		info = host.film.info();
		gates = gatesOf(info);
		if (align) { host.film.align(JSON.stringify(align)); info = host.film.info(); gates = gatesOf(info); }
		seekTo(tr, gates, t, info.total);
		needSync = true;
		host.wake();
		return null;
	}

	// ---- transport actions ----
	const audioOn = () => !!voice && voice.ready;
	function play() {
		if (tr.ended || tr.t >= info.total - 0.05) seekTo(tr, gates, 0, info.total);
		tr.playing = true;
		grabbed = false;
		if (!tr.gate && audioOn()) { voice!.seek(tr.t); void voice!.play(); }
		touchCtrl();
		host.wake();
	}
	function pause() {
		tr.playing = false;
		voice?.pause();
		persist(true);
		touchCtrl();
		host.wake();
	}
	const toggle = () => (tr.playing ? pause() : play());
	function seek(t: number) {
		seekTo(tr, gates, t, info.total);
		needSync = true;
		if (voice) { voice.seek(tr.t); if (!tr.playing) voice.pause(); }
		touchCtrl();
		host.wake();
	}
	const seekScene = (d: number) => {
		const i = sceneIndexAt(info, tr.t);
		const within = tr.t - info.scenes[i].start;
		const j = d < 0 && within > 2 ? i : Math.max(0, Math.min(info.scenes.length - 1, i + d));
		seek(info.scenes[j].start + 0.001);
	};
	function setSpeed(s: number) {
		tr.speed = s;
		voice?.rate(s);
		persist(true);
		host.wake();
	}
	const cycleSpeed = (dir = 1) => {
		const i = SPEEDS.findIndex((v) => v === tr.speed);
		setSpeed(SPEEDS[((i < 0 ? 1 : i) + dir + SPEEDS.length) % SPEEDS.length]);
	};
	function continueGate() {
		if (!tr.gate) return;
		leaveGate(tr, ev);
		afterEvents();
	}
	function touchCtrl() { ctrlUntil = now() + 2800; }
	function persist(force = false) {
		const n = now();
		if (!force && n - lastSave < 2000) return;
		lastSave = n;
		save(host.slug, { t: tr.t, speed: tr.speed, cc });
	}

	function afterEvents() {
		for (const e of ev) {
			if (e.kind === 'enter') voice?.pause();
			else if (e.kind === 'leave') { if (voice && tr.playing) { voice.seek(tr.t); void voice.play(); } }
			else if (e.kind === 'ended') { voice?.pause(); persist(true); }
		}
		ev.length = 0;
		updateMediaSession();
	}

	// ---- Media Session ----
	function setupMediaSession() {
		if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
		const ms = navigator.mediaSession;
		try {
			ms.metadata = new MediaMetadata({ title: info.title || info.name, artist: 'Andrew Gazelka', album: 'Narrated film (draft narration, synthetic voice)' });
			ms.setActionHandler('play', () => play());
			ms.setActionHandler('pause', () => pause());
			ms.setActionHandler('seekto', (d) => { if (typeof d.seekTime === 'number') seek(d.seekTime); });
			ms.setActionHandler('seekbackward', () => seek(tr.t - 10));
			ms.setActionHandler('seekforward', () => seek(tr.t + 10));
			ms.setActionHandler('previoustrack', () => seekScene(-1));
			ms.setActionHandler('nexttrack', () => seekScene(1));
		} catch { /* an action the browser does not know */ }
	}
	let lastMs = 0;
	function updateMediaSession() {
		if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
		const n = now();
		if (n - lastMs < 1000) return;
		lastMs = n;
		try {
			navigator.mediaSession.playbackState = tr.playing ? 'playing' : 'paused';
			navigator.mediaSession.setPositionState({ duration: info.total, position: Math.min(tr.t, info.total), playbackRate: tr.speed });
			const sc = info.scenes[sceneIndexAt(info, tr.t)];
			if (navigator.mediaSession.metadata) navigator.mediaSession.metadata.title = `${sc.heading} (${info.title})`;
		} catch { /* not supported */ }
	}

	// ---- exhibits ----
	const exOf = (id: string): number => host.exIds.indexOf(id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id);
	/** rebuild exhibit state to film time t: reset each mounted exhibit of the scene and replay its commands up to t */
	function syncExhibits(scene: number, t: number) {
		const sc = info.scenes[scene];
		for (const m of sc.mounts) {
			const ex = exOf(m.id);
			if (ex < 0) continue;
			host.resetExhibit(ex);
			for (const c of sc.cmds) if (c.mount === m.prop && c.t <= t) drive(ex, c.verb, c.n);
		}
		lastCmdT = t;
	}
	function drive(ex: number, verb: string, n: number) {
		const v = VERB[verb];
		if (v !== undefined) host.film.drive(ex, v, n);
	}
	function runCommands(scene: number, t0: number, t1: number) {
		const sc = info.scenes[scene];
		for (const c of sc.cmds) {
			if (c.t <= t0 || c.t > t1) continue;
			const m = sc.mounts.find((q) => q.prop === c.mount);
			const ex = m ? exOf(m.id) : -1;
			if (ex >= 0) drive(ex, c.verb, c.n);
		}
	}

	// ---- the frame ----
	function frame(nowMs: number, dtMs: number, vw: number, vh: number, out: FilmOut): void {
		viewW = vw; viewH = vh;
		out.overlays.length = 0; out.uiText.length = 0; out.exhibits = exOut; exOut.length = 0; out.cursor = null;
		outRef = out; ovN = 0; glN = 0; pools.ovlN = 0; pools.glyphN = 0;
		hits = [];
		const dt = Math.min(0.1, dtMs / 1000);
		// clock
		const wasT = tr.t;
		stepTransport(tr, gates, info.total, dt, tr.playing && !tr.gate && audioOn() && !voice!.paused && !voice!.ended ? voice!.time() : null, ev);
		if (tr.playing && !tr.gate && audioOn() && !voice!.paused && voice!.ended) { tr.t = Math.min(info.total, Math.max(tr.t, voice!.time())); }
		afterEvents();
		if (drag === null && tr.playing && !tr.gate && audioOn() && !voice!.paused && Math.abs(voice!.time() - tr.t) > 0.35 && !voice!.ended) voice!.seek(tr.t);
		const scene = sceneIndexAt(info, tr.t);
		if (needSync || scene !== lastScene) { syncExhibits(scene, tr.t); needSync = false; lastScene = scene; }
		else if (tr.t > wasT) { runCommands(scene, lastCmdT, tr.t); lastCmdT = tr.t; }
		else lastCmdT = Math.min(lastCmdT, tr.t);
		persist();

		const f = host.film.pack(tr.t);
		lastFrame = f;
		const sk = Math.min(vw / STAGE.w, vh / STAGE.h);
		stageMap = { x: (vw - STAGE.w * sk) / 2, y: (vh - STAGE.h * sk) / 2, k: sk };
		// the stage: letterbox bars are the ground (the page ground already fills the canvas)
		stagePool.overlays = out.overlays; stagePool.uiText = out.uiText;
		convertItems(f.items, f.count, f.str, stageMap, 1, host.text, pools, stagePool);
		// exhibits fitted into their docks
		mountRects = new Map();
		const state = host.exhibit.state();
		for (const m of f.mounts) {
			const ex = exOf(m.id);
			const rec = host.model.exhibits[ex];
			if (!rec || state[ex * 8] === 0) continue;
			const r = { x: stageMap.x + m.x * sk, y: stageMap.y + m.y * sk, w: m.w * sk, h: m.h * sk };
			const k = Math.min(r.w / rec.frameW, r.h / rec.frameH);
			const map: Mapping = { x: r.x + (r.w - rec.frameW * k) / 2, y: r.y + (r.h - rec.frameH * k) / 2, k };
			const slot = (exSlots[exOut.length] ??= { clip: { x0: 0, y0: 0, x1: 0, y1: 0 }, overlays: [], uiText: [] });
			slot.clip = { x0: Math.max(0, r.x), y0: Math.max(0, r.y), x1: Math.min(vw, r.x + r.w), y1: Math.min(vh, r.y + r.h) };
			slot.overlays.length = 0; slot.uiText.length = 0;
			const packed = host.exhibit.pack(ex);
			convertItems(packed.items, packed.count, host.exhibit.str, map, m.alpha, host.text, pools, slot);
			exOut.push(slot);
			mountRects.set(ex, { ...r, map, grab: m.grabbable || (tr.gate?.mount === m.prop) });
		}
		// captions, gate prompt, transport, transcript
		const mt = metrics(vw, vh);
		const idle = nowMs > ctrlUntil && tr.playing && !tr.gate && !drag && !hover;
		const ctrlA = idle ? Math.max(0, 1 - (nowMs - ctrlUntil) / 400) : 1;
		const scn = info.scenes[scene];
		if (cc && !transcript) drawCaptions(scn.says, mt, ctrlA);
		if (tr.gate) drawGate(mt);
		if (ctrlA > 0) drawBar(mt, ctrlA, scene);
		if (transcript) drawTranscript(mt);
		if (info.scenes[scene].placeholders.length || scn.says.some((s) => s.placeholder)) drawNotice(mt);
		out.animating = tr.playing || !!tr.gate || drag !== null || ctrlA > 0 && ctrlA < 1;
		updateMediaSession();
	}
	const exSlots: ExhibitDraw[] = [];

	// ---- captions ----
	let capKey = '';
	let capLines: number[][] = [];
	let capWidths: number[] = [];
	let capSize = 0, capMaxW = 0;
	function drawCaptions(says: SayInfo[], mt: ReturnType<typeof metrics>, ctrlA: number) {
		const i = sayAt(says, tr.t);
		if (i < 0) return;
		const s = says[i];
		const words = s.text.split(/\s+/).filter(Boolean);
		const size = mt.cap;
		const maxW = Math.min(viewW - 2 * mt.pad, Math.round(mt.cap * 34));
		const key = `${s.key}|${size}|${maxW}`;
		if (key !== capKey) {
			capKey = key;
			capWidths = words.map((w) => width(w, size));
			capLines = wrapWords(capWidths, width(' ', size), maxW);
			capSize = size; capMaxW = maxW;
		}
		const cw = s.cw.length === words.length ? s.cw : words.map((_, k) => [s.start + (s.dur * k) / words.length, s.start + (s.dur * (k + 1)) / words.length] as [number, number]);
		const act = activeWord(cw, tr.t);
		const rows = 2;
		const page = captionPage(capLines, act, rows);
		const shown = capLines.slice(page, page + rows);
		const lh = Math.round(size * 1.38);
		const space = width(' ', size);
		const bottom = viewH - (ctrlA > 0 ? mt.bar + mt.pad * 2.4 : mt.pad * 2.4);
		const fade = Math.min(1, (tr.t - s.start + 0.12) / 0.2, (s.start + s.dur + 0.6 - tr.t) / 0.4);
		const a = Math.max(0, fade);
		const top = bottom - shown.length * lh;
		const wMax = Math.max(...shown.map((l) => l.reduce((acc, w, k) => acc + capWidths[w] + (k ? space : 0), 0)), 0);
		ov(viewW / 2 - wMax / 2 - mt.pad, top - mt.pad * 0.5, wMax + 2 * mt.pad, shown.length * lh + mt.pad * 0.9, mt.pad * 0.6, GROUND, 0.88 * a);
		shown.forEach((line, li) => {
			const lw = line.reduce((acc, w, k) => acc + capWidths[w] + (k ? space : 0), 0);
			let x = viewW / 2 - lw / 2;
			for (const wi of line) {
				const state = act < 0 || tr.t < cw[wi][0] ? 0 : tr.t < cw[wi][1] && wi === act ? 2 : 1;
				txt(words[wi], x, top + li * lh + Math.round(size * 1.05), size, state === 2 ? ACC : state === 1 ? INK : INK3, a);
				x += capWidths[wi] + space;
			}
		});
		void capSize; void capMaxW;
	}

	// ---- the draft notice (placeholders are labelled, nothing fakes an exhibit) ----
	function drawNotice(mt: ReturnType<typeof metrics>) {
		txt('Draft film: placeholder narration and exhibits marked', mt.pad, mt.pad + mt.small, mt.small, INK3, 0.8);
	}

	// ---- gate prompt ----
	function drawGate(mt: ReturnType<typeof metrics>) {
		const g = tr.gate!;
		const left = Math.max(0, g.hold - tr.held);
		const label = `Continue  ${Math.ceil(left)}s`;
		const w = width(label, mt.cap * 0.8) + mt.pad * 2.4, h = mt.bar * 0.9;
		const x = viewW / 2 - w / 2, y = viewH - mt.bar - mt.pad * 1.8 - h - mt.cap * 3.2;
		const hov = hover === 'continue';
		ov(x, y, w, h, h / 2, GROUND, 0.82);
		ov(x, y, w, h, h / 2, ACC, hov ? 0.9 : 0.55, 4, 1.5);
		ov(x + h / 2, y + h - 3, (w - h) * (left / g.hold), 2, 1, ACC, 0.9);
		txt(label, viewW / 2, y + h / 2 + mt.cap * 0.28, mt.cap * 0.8, hov ? ACC : INK, 1, 'sans', 1);
		hits.push({ id: 'continue', x, y, w, h, cursor: 'pointer' });
	}

	// ---- the transport bar ----
	let barGeom = { sx: 0, sw: 0, sy: 0 };
	function drawBar(mt: ReturnType<typeof metrics>, a: number, scene: number) {
		const y0 = viewH - mt.bar - mt.pad, h = mt.bar, x0 = mt.pad, x1 = viewW - mt.pad;
		ov(x0, y0, x1 - x0, h, h * 0.3, GROUND, 0.78 * a);
		ov(x0, y0, x1 - x0, h, h * 0.3, RULE, 0.9 * a, 4, 1);
		const size = mt.small + 1;
		const base = y0 + h / 2 + size * 0.34;
		let x = x0 + mt.pad * 0.6;
		const button = (id: string, label: string, minW: number, on = false): number => {
			const w = Math.max(minW, width(label, size) + mt.pad * 1.2);
			const hov = hover === id;
			if (hov) ov(x, y0 + h * 0.14, w, h * 0.72, h * 0.2, INK, 0.1 * a);
			txt(label, x + w / 2, base, size, on || hov ? ACC : INK, a, 'sans', 1);
			hits.push({ id, x, y: y0, w, h, cursor: 'pointer' });
			x += w + mt.pad * 0.2;
			return w;
		};
		button('play', tr.playing ? 'Pause' : tr.ended ? 'Replay' : 'Play', size * 4.6);
		const time = `${fmtTime(tr.t)} / ${fmtTime(info.total)}`;
		const tw = width(time, size, 'mono');
		txt(time, x, base, size, INK2, a, 'mono');
		x += tw + mt.pad;
		// right side first (measure), scrubber takes the rest
		const rights: [string, string, number, boolean][] = [
			['speed', `${tr.speed}x`, size * 3, tr.speed !== 1],
			['cc', 'CC', size * 2.6, cc],
			['transcript', 'Text', size * 3.4, transcript],
			['reader', 'Read', size * 3.4, false]
		];
		const rw = rights.reduce((acc, r) => acc + Math.max(r[2], width(r[1], size) + mt.pad * 1.2) + mt.pad * 0.2, 0);
		const sx = x, sw = Math.max(40, x1 - mt.pad * 0.6 - rw - sx - mt.pad);
		const cy = y0 + h / 2;
		barGeom = { sx, sw, sy: cy };
		ov(sx, cy - 2, sw, 4, 2, INK3, 0.55 * a);
		const frac = tr.t / info.total;
		ov(sx, cy - 2, sw * frac, 4, 2, ACC, a);
		for (const s of info.scenes) ov(sx + (s.start / info.total) * sw - 1, cy - 7, 2, 14, 1, s === info.scenes[scene] ? ACC : INK2, 0.75 * a);
		const hovS = hover === 'scrub' || drag === 'scrub';
		ov(sx + sw * frac - (hovS ? 7 : 5), cy - (hovS ? 7 : 5), hovS ? 14 : 10, hovS ? 14 : 10, 7, ACC, a, 1);
		hits.push({ id: 'scrub', x: sx - 6, y: y0, w: sw + 12, h, cursor: 'pointer' });
		if (hovS && ptr) {
			const tt = Math.max(0, Math.min(info.total, ((ptr.x - sx) / sw) * info.total));
			const sc = info.scenes[sceneIndexAt(info, tt)];
			const label = `${fmtTime(tt)}  ${sc.heading}`;
			const lw = width(label, size) + mt.pad;
			const lx = Math.max(mt.pad, Math.min(viewW - mt.pad - lw, ptr.x - lw / 2));
			ov(lx, y0 - size * 2.3, lw, size * 1.8, size * 0.4, GROUND, 0.92);
			txt(label, lx + lw / 2, y0 - size * 1.0, size, INK, 1, 'sans', 1);
		}
		x = sx + sw + mt.pad;
		for (const [id, label, minW, on] of rights) button(id, label, minW, on);
	}

	// ---- transcript ----
	let tLayout: { y: number; h: number; t: number; scene: number }[] = [];
	function drawTranscript(mt: ReturnType<typeof metrics>) {
		ov(0, 0, viewW, viewH, 0, GROUND, 0.9);
		const colW = Math.min(viewW - 2 * mt.pad, Math.round(mt.cap * 30));
		const x = viewW / 2 - colW / 2;
		const size = Math.round(mt.cap * 0.62);
		const lh = Math.round(size * 1.5);
		const top = mt.pad * 3, bottom = viewH - mt.bar - mt.pad * 2.4;
		const cur = sayAt(info.scenes.flatMap((s) => s.says), tr.t, 1.2);
		let y = top - transcriptY;
		let flat = 0;
		tLayout = [];
		txt('Transcript (draft narration, spoken by a text-to-speech preset)', x, Math.max(mt.pad * 1.5, mt.pad + size), size * 0.9, INK3, 1);
		const total = { h: 0 };
		for (let si = 0; si < info.scenes.length; si++) {
			const sc = info.scenes[si];
			y += lh * 0.6;
			if (y > -lh && y < bottom) { txt(`${si + 1}  ${sc.heading}`, x, y + size, size * 1.05, ACC, 1); }
			y += lh * 1.2;
			for (const s of sc.says) {
				const words = s.text.split(/\s+/).filter(Boolean);
				const lines = wrapWords(words.map((w) => width(w, size)), width(' ', size), colW - mt.pad * 1.4);
				const hh = lines.length * lh;
				const isCur = flat === cur;
				if (y + hh > 0 && y < bottom) {
					if (isCur) ov(x - mt.pad * 0.7, y - 2, 3, hh, 1.5, ACC, 1);
					lines.forEach((ln, li) => {
						let px = x;
						for (const wi of ln) {
							const done = tr.t >= (s.cw[wi]?.[0] ?? s.start);
							txt(words[wi], px, y + li * lh + size, size, isCur ? (done ? INK : INK2) : INK2, 1);
							px += width(words[wi], size) + width(' ', size);
						}
					});
					hits.push({ id: `tr:${s.start}`, x, y, w: colW, h: hh, cursor: 'pointer' });
					if (s.placeholder) txt('placeholder', x + colW, y + size, size * 0.8, INK3, 1, 'sans', 2);
				}
				tLayout.push({ y: y + transcriptY, h: hh, t: s.start, scene: si });
				if (isCur && transcriptFollow) {
					const want = y + transcriptY - (viewH - mt.bar) * 0.35;
					transcriptY += (want - transcriptY) * 0.15;
				}
				y += hh + lh * 0.55;
				flat++;
			}
			total.h = y + transcriptY;
		}
		transcriptMax = Math.max(0, total.h - bottom + mt.pad);
		transcriptY = Math.max(0, Math.min(transcriptMax, transcriptY));
	}
	let transcriptMax = 0;

	// ---- input ----
	const router = createRouter({
		exhibitAt(x, y) {
			for (const [ex, r] of mountRects) if (r.grab && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return ex;
			return -1;
		},
		local: (ex, x, y) => { const r = mountRects.get(ex); return r ? toLocal(r.map, x, y) : null; },
		call: (ex, kind, xe, ye, b, m) => host.call(ex, kind, xe, ye, b, m),
		focus: (ex) => host.focus(ex),
		capture: (id) => host.capture(id),
		release: (id) => host.release(id),
		engineDown: () => { /* the film has no page scroll */ }
	});

	const hitAt = (x: number, y: number): Hit | null => { for (let i = hits.length - 1; i >= 0; i--) { const h = hits[i]; if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h; } return null; };

	function scrubTo(x: number) {
		const t = ((x - barGeom.sx) / barGeom.sw) * info.total;
		seek(Math.max(0, Math.min(info.total, t)));
	}

	function click(h: Hit) {
		if (h.id === 'play') toggle();
		else if (h.id === 'speed') cycleSpeed(1);
		else if (h.id === 'cc') { cc = !cc; persist(true); host.wake(); }
		else if (h.id === 'transcript') { transcript = !transcript; transcriptFollow = true; host.wake(); }
		else if (h.id === 'reader') host.leave('reader');
		else if (h.id === 'continue') continueGate();
		else if (h.id.startsWith('tr:')) { seek(Number(h.id.slice(3))); transcriptFollow = true; }
	}

	/** pointer from the canvas (CSS px of the canvas). `swallow` always true in film mode: the page never scrolls under a film. */
	function pointer(type: 'down' | 'move' | 'up' | 'cancel' | 'leave', x: number, y: number, e: { pointerId: number; pointerType: string; buttons: number; button?: number; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): { cursor: string | null } {
		ptr = { x, y };
		touchCtrl();
		const mods = (e.shiftKey ? 1 : 0) | (e.ctrlKey || e.metaKey ? 2 : 0) | (e.altKey ? 4 : 0);
		const ptype = e.pointerType === 'touch' ? 'touch' : e.pointerType === 'pen' ? 'pen' : 'mouse';
		if (type === 'leave') { hover = null; router.event({ type: 'leave', id: 0, ptype: 'mouse', x, y, buttons: 0, mods: 0 }); host.wake(); return { cursor: null }; }
		if (drag === 'scrub') {
			if (type === 'move') scrubTo(x);
			if (type === 'up' || type === 'cancel') { drag = null; host.release(e.pointerId); if (tr.playing && audioOn() && !tr.gate) { voice!.seek(tr.t); void voice!.play(); } }
			host.wake();
			return { cursor: 'pointer' };
		}
		const h = hitAt(x, y);
		hover = h ? h.id : null;
		if (type === 'down' && (e.button ?? 0) === 0) {
			if (h?.id === 'scrub') { drag = 'scrub'; host.capture(e.pointerId); if (tr.playing) voice?.pause(); scrubTo(x); host.wake(); return { cursor: 'pointer' }; }
			if (h) { click(h); host.wake(); return { cursor: h.cursor ?? null }; }
		}
		// exhibits: a grabbed mount (gate or grabbable) takes pointer events
		const r = router.event({ type, id: e.pointerId, ptype, x, y, buttons: e.buttons, mods });
		if (type === 'down' && r.inside) {
			// playing with the exhibit holds the film (a gate hold gets a little longer too)
			if (tr.gate) tr.held = Math.min(tr.held, Math.max(0, tr.gate.hold - 12));
			else if (tr.playing) { pause(); grabbed = true; }
			host.wake();
		}
		host.wake();
		return { cursor: r.cursor ?? (h?.cursor ?? null) };
	}

	function wheel(dy: number): boolean {
		if (!transcript) return false;
		transcriptFollow = false;
		transcriptY = Math.max(0, Math.min(transcriptMax, transcriptY + dy));
		host.wake();
		return true;
	}

	/** keyboard; true when handled */
	function key(e: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean }): boolean {
		if (e.ctrlKey || e.metaKey || e.altKey) return false;
		touchCtrl();
		const k = e.key;
		if (router.focus >= 0 && !tr.gate && k !== 'Escape') { /* an exhibit holds the keys */ }
		switch (k) {
			case ' ': case 'k': case 'K': if (tr.gate) continueGate(); else toggle(); break;
			case 'Enter': if (tr.gate) continueGate(); else return false; break;
			case 'ArrowLeft': e.shiftKey ? seekScene(-1) : seek(tr.t - 5); break;
			case 'ArrowRight': e.shiftKey ? seekScene(1) : seek(tr.t + 5); break;
			case 'j': case 'J': seek(tr.t - 10); break;
			case 'l': case 'L': seek(tr.t + 10); break;
			case '[': seekScene(-1); break;
			case ']': seekScene(1); break;
			case 'Home': seek(0); break;
			case 'End': seek(info.total - 0.1); break;
			case 'c': case 'C': cc = !cc; persist(true); break;
			case 't': case 'T': transcript = !transcript; transcriptFollow = true; break;
			case 'r': case 'R': host.leave('reader'); break;
			case '>': case '.': cycleSpeed(1); break;
			case '<': case ',': cycleSpeed(-1); break;
			case 'Escape': if (transcript) transcript = false; else host.leave('close'); break;
			default: return false;
		}
		host.wake();
		return true;
	}

	function dispose() {
		disposed = true;
		persist(true);
		voice?.dispose();
		voice = null;
		if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
			for (const a of ['play', 'pause', 'seekto', 'seekbackward', 'seekforward', 'previoustrack', 'nexttrack'] as const) { try { navigator.mediaSession.setActionHandler(a, null); } catch { /* ignore */ } }
			try { navigator.mediaSession.metadata = null; } catch { /* ignore */ }
		}
	}

	return {
		load, reload, frame, pointer, wheel, key, dispose, play, pause, toggle, seek, seekScene, setSpeed, continueGate,
		get info() { return info; },
		get transport() { return tr; },
		get gates() { return gates; },
		get hasVoice() { return audioOn(); },
		get voiceFailed() { return voiceFailed; },
		get aligned() { return !!align; },
		get transcriptOpen() { return transcript; },
		get captionsOn() { return cc; },
		get grabbed() { return grabbed; },
		get dragging() { return drag !== null; },
		get mounts() { return mountRects; },
		get lastFrame(): FilmFrame | null { return lastFrame; },
		stage: () => stageMap,
		hits: () => hits
	};
}

export type Film = ReturnType<typeof createFilm>;
export type { MountRow };
