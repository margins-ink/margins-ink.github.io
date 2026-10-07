// Geometry of the GPU chrome (lane U2): state/input types and the pure layout of every widget at the three width classes.
// No drawing here: widgets.ts turns these rects into overlays, glyphs and hit rects. All px are CSS px of the canvas.
import type { Overlay } from '../page-api';
import type { ScrollbarState, UiFont } from './types';

export interface Rect { x: number; y: number; w: number; h: number }
export type RGB = [number, number, number];
/** width of a string in px at a size; the root passes `(t, f, s) => shapeUi(t, f, s).width`, tests a stub */
export type Measure = (text: string, font: UiFont, size: number) => number;

/** 0 wide (>= 1180), 1 mid (720..1179), 2 narrow (< 720) */
export type WidthClass = 0 | 1 | 2;
export const widthClassOf = (w: number): WidthClass => (w >= 1180 ? 0 : w >= 720 ? 1 : 2);

export const BAR_H = 40;
export const BTN = 32;

/** straight sRGB 0..1 colours from the RDR palette (no hex literals anywhere in the chrome) */
export interface ChromeTheme {
	ground: RGB;
	/** code panel / sheet surface */
	surface: RGB;
	/** popover / menu / toast surface (the highest elevation) */
	popover: RGB;
	ink: RGB;
	ink2: RGB;
	ink3: RGB;
	accent: RGB;
}

export interface SectionInfo { name: string; /** doc px of the section start */ y: number }
export interface HeadingEntry { level: 2 | 3; text: string; id: string; /** doc px */ y: number }
export interface RefInfo { title: string; url: string }

export interface ChromeMeta {
	title: string;
	/** `back` draws a back chevron instead of the close cross (opened from the world) */
	closeKind: 'close' | 'back';
	wordsBrief: number;
	wordsFull: number;
	sections: SectionInfo[];
	headings: HeadingEntry[];
	refs: RefInfo[];
}

/** a code block (viewport-space rect = already scrolled, may extend off screen) */
export interface CodeBlockInfo { block: number; rect: Rect; lang: string }

export interface ChromeAnim {
	secLabel: string; secPrev: string; secT: number;
	aaT: number; tocT: number; popT: number; lbT: number; findT: number; linkT: number;
	/** last non-null link rects, kept while the underline fades out */
	linkRects: Rect[];
	hover: Record<string, number>;
	codeT: Record<number, number>;
	/** hits of the previous frame (hover is resolved against these, so occlusion by upper layers is honoured) */
	prevHits: HitRect[];
	/** last popover (kept while it fades out) */
	lastPop: { ref: number; anchor: Rect } | null;
	lastLb: { w: number; h: number; caption: string } | null;
}

export function createChromeAnim(): ChromeAnim {
	return {
		secLabel: '', secPrev: '', secT: 1, aaT: 0, tocT: 0, popT: 0, lbT: 0, findT: 0, linkT: 0, linkRects: [],
		hover: {}, codeT: {}, prevHits: [], lastPop: null, lastLb: null
	};
}

export interface FindState {
	open: boolean; query: string; /** caret as UTF-16 index */ caret: number;
	/** total matches and the current one (1-based, 0 = none) */
	count: number; index: number;
}

export interface ToastInfo { id: number; msg: string; atMs: number }

export interface ChromeState {
	theme: ChromeTheme;
	reduced: boolean;
	/** accent peak above 1 on extended-range canvases (hover underline, focus ring); 1 = SDR */
	hdrGain: number;
	nowMs: number;
	/** touch pointer: copy buttons are always visible */
	touch: boolean;
	view: { w: number; h: number };
	/** CSS px of the left edge of the reading column (room for the sticky contents on wide) */
	colLeft: number;
	meta: ChromeMeta;
	scrollY: number; docPx: number; progress: number;
	/** current section index into meta.sections, -1 none */
	section: number;
	foldExpanded: boolean;
	/** text-size step index into the scale steps and their count */
	aa: { open: boolean; step: number; steps: number; hasFold: boolean; alwaysFull: boolean };
	tocOpen: boolean;
	popover: { ref: number; anchor: Rect } | null;
	lightbox: { w: number; h: number; caption: string } | null;
	find: FindState;
	copyFlash: Record<number, number>;
	toasts: ToastInfo[];
	codeBlocks: CodeBlockInfo[];
	hoverCode: number; focusCode: number;
	/** viewport-space line rects of the hovered / keyboard-focused link */
	hoverLink: Rect[] | null; focusLink: Rect[] | null;
	scrollbar: ScrollbarState;
	/** section start ticks for the scrollbar (doc px) */
	ticks?: number[];
	anim: ChromeAnim;
}

export interface KeyEvent { key: string; shift?: boolean; mod?: boolean; alt?: boolean; /** clipboard text for mod+v */ paste?: string }

export interface ChromeInput {
	pointer: { x: number; y: number } | null;
	/** primary button is down */
	down: boolean;
	/** id of the hit that holds pointer capture (scrollbar thumb), else null */
	captured: string | null;
	keys: KeyEvent[];
}

export interface HitRect {
	id: string; x: number; y: number; w: number; h: number; cursor: string;
	/** action token the root dispatches on click */
	onClick?: string;
	/** pointer capture on press: the root routes moves to this id until release */
	capture?: boolean;
	/** index in the frame's overlays of the overlay drawn for exactly this rect, -1 when none (text only / invisible) */
	ov: number;
}

export type { Overlay };

// ---- text helpers ----

/** shorten with an ellipsis to fit maxW */
export function ellipsize(text: string, font: UiFont, size: number, maxW: number, m: Measure): string {
	if (maxW <= 0) return '';
	if (m(text, font, size) <= maxW) return text;
	const cps = Array.from(text);
	let lo = 0, hi = cps.length;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (m(cps.slice(0, mid).join('').trimEnd() + '…', font, size) <= maxW) lo = mid; else hi = mid - 1;
	}
	return lo === 0 ? '' : cps.slice(0, lo).join('').trimEnd() + '…';
}

/** greedy word wrap into at most maxLines lines; the last line is ellipsized */
export function wrapLines(text: string, font: UiFont, size: number, maxW: number, maxLines: number, m: Measure): string[] {
	const words = text.split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let cur = '';
	for (let i = 0; i < words.length; i++) {
		const next = cur ? cur + ' ' + words[i] : words[i];
		if (m(next, font, size) <= maxW || !cur) { cur = next; continue; }
		lines.push(cur);
		cur = words[i];
		if (lines.length === maxLines - 1) { cur = words.slice(i).join(' '); break; }
	}
	if (cur) lines.push(cur);
	if (lines.length > 0) lines[lines.length - 1] = ellipsize(lines[lines.length - 1], font, size, maxW, m);
	return lines.slice(0, maxLines);
}

export const pad2 = (n: number) => String(n).padStart(2, '0');

export const hostOf = (u: string): string => {
	try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; }
};

export function sectionLabel(s: ChromeState): string {
	const sec = s.meta.sections[s.section];
	return sec ? `${pad2(s.section + 1)} ${sec.name}` : '';
}

/** minutes left at 230 wpm; 0 on narrow or when unknown */
export function minutesLeft(s: ChromeState): number {
	if (widthClassOf(s.view.w) === 2) return 0;
	const m = s.meta;
	const words = (s.foldExpanded ? m.wordsFull : m.wordsBrief) || m.wordsFull || m.wordsBrief;
	if (!words) return 0;
	return Math.max(0, Math.ceil(((1 - s.progress) * words) / 230));
}

export const inRect = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
export const intersects = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ---- top bar ----

export interface BarLayout {
	bar: Rect; close: Rect; contents: Rect | null; aa: Rect;
	time: { x: number; text: string; w: number } | null;
	title: { x: number; w: number; text: string } | null;
	section: { x: number; w: number; text: string } | null;
}

/** is the contents list a sticky column left of the text (wide, with room), else a slide-over */
export function tocSticky(s: ChromeState): boolean {
	return widthClassOf(s.view.w) === 0 && Math.min(232, s.colLeft - 40) >= 150;
}

export function layoutBar(s: ChromeState, label: string, m: Measure): BarLayout {
	const vw = s.view.w;
	const cls = widthClassOf(vw);
	const bar = { x: 0, y: 0, w: vw, h: BAR_H };
	const close = { x: 8, y: (BAR_H - BTN) / 2, w: BTN, h: BTN };
	let right = vw - 8;
	let contents: Rect | null = null;
	if (!tocSticky(s) && s.meta.headings.length > 0) { right -= BTN; contents = { x: right, y: close.y, w: BTN, h: BTN }; }
	right -= BTN;
	const aa = { x: right, y: close.y, w: BTN, h: BTN };
	let time: BarLayout['time'] = null;
	const mins = minutesLeft(s);
	if (mins > 0) {
		const text = `${mins} min left`;
		const w = m(text, 'sans', 12);
		right -= 8 + w;
		time = { x: right, text, w };
	}
	const midStart = close.x + BTN + 12;
	const midEnd = right - 12;
	const avail = Math.max(0, midEnd - midStart);
	let title: BarLayout['title'] = null;
	let section: BarLayout['section'] = null;
	const title0 = s.meta.title;
	if (cls === 2) {
		// one slot: the section when there is one, else the title
		const text = label || title0;
		if (text) { const t = ellipsize(text, 'sans', 13, avail, m); section = label ? { x: midStart, w: m(t, 'sans', 13), text: t } : null; if (!label) title = { x: midStart, w: m(t, 'sans', 13), text: t }; }
	} else {
		const tw = Math.min(m(title0, 'sans', 13), avail * (label ? 0.42 : 1));
		const tt = ellipsize(title0, 'sans', 13, tw, m);
		title = tt ? { x: midStart, w: m(tt, 'sans', 13), text: tt } : null;
		if (label) {
			const sx = midStart + (title ? title.w + 24 : 0);
			const sw = midEnd - sx;
			if (sw > 40) { const t = ellipsize(label, 'sans', 13, sw, m); section = { x: sx, w: m(t, 'sans', 13), text: t }; }
		}
	}
	return { bar, close, contents, aa, time, title, section };
}

// ---- Aa popover ----

export interface AaLayout { panel: Rect; label: { x: number; y: number }; steps: Rect[]; check: Rect | null; box: Rect | null }

export function layoutAa(s: ChromeState, bar: BarLayout): AaLayout {
	const w = 232;
	const x = Math.max(12, Math.min(s.view.w - w - 12, bar.aa.x + bar.aa.w - w));
	const y = BAR_H + 4;
	const pad = 12;
	const n = s.aa.steps;
	const gap = 4;
	const sw = (w - 2 * pad - gap * (n - 1)) / n;
	const steps: Rect[] = [];
	const sy = y + pad + 20;
	for (let i = 0; i < n; i++) steps.push({ x: x + pad + i * (sw + gap), y: sy, w: sw, h: 36 });
	let h = pad + 20 + 36 + pad;
	let check: Rect | null = null, box: Rect | null = null;
	if (s.aa.hasFold) {
		check = { x: x + pad - 4, y: sy + 36 + 8, w: w - 2 * pad + 8, h: 32 };
		box = { x: x + pad, y: check.y + 8, w: 16, h: 16 };
		h += 8 + 32;
	}
	return { panel: { x, y, w, h }, label: { x: x + pad, y: y + pad + 12 }, steps, check, box };
}

// ---- contents ----

export interface TocRow { index: number; entry: HeadingEntry; num: number; rect: Rect; active: boolean }
export interface TocLayout {
	sticky: boolean; panel: Rect; scrim: Rect | null; head: { x: number; y: number }; close: Rect | null; rows: TocRow[];
	/** x offset of the slide: panel is drawn at panel.x + slide */
	slide: { dx: number; dy: number };
}

export const TOC_ROW = 28;

/** index of the active heading: the last one whose y is above 30 percent of the viewport */
export function activeHeading(s: ChromeState): number {
	let a = -1;
	const probe = s.scrollY + s.view.h * 0.3;
	s.meta.headings.forEach((h, i) => { if (h.y <= probe) a = i; });
	return a;
}

export function layoutToc(s: ChromeState, t: number): TocLayout {
	const cls = widthClassOf(s.view.w);
	const sticky = tocSticky(s);
	const hs = s.meta.headings;
	const active = activeHeading(s);
	let panel: Rect;
	let scrim: Rect | null = null;
	let close: Rect | null = null;
	let slide = { dx: 0, dy: 0 };
	if (sticky) {
		const room = Math.min(232, s.colLeft - 40);
		panel = { x: Math.max(16, s.colLeft - room - 24), y: BAR_H + 24, w: room, h: s.view.h - BAR_H - 24 - 24 };
	} else if (cls === 1) {
		const w = Math.min(320, s.view.w - 48);
		panel = { x: 0, y: BAR_H, w, h: s.view.h - BAR_H };
		slide = { dx: -(1 - t) * (w + 8), dy: 0 };
		scrim = { x: 0, y: BAR_H, w: s.view.w, h: s.view.h - BAR_H };
	} else {
		const rowsH = hs.length * TOC_ROW + 56 + 12;
		const h = Math.min(Math.round((s.view.h - BAR_H) * 0.7), rowsH);
		panel = { x: 0, y: s.view.h - h, w: s.view.w, h };
		slide = { dx: 0, dy: (1 - t) * (h + 8) };
		scrim = { x: 0, y: BAR_H, w: s.view.w, h: s.view.h - BAR_H };
	}
	const padX = sticky ? 0 : 20;
	const headH = sticky ? 28 : 48;
	const head = { x: panel.x + padX, y: panel.y + (sticky ? 14 : 30) };
	if (!sticky) close = { x: panel.x + panel.w - BTN - 8, y: panel.y + (headH - BTN) / 2 + 2, w: BTN, h: BTN };
	const top = panel.y + headH + (sticky ? 4 : 4);
	const cap = Math.max(1, Math.floor((panel.y + panel.h - top - 8) / TOC_ROW));
	let start = 0;
	if (hs.length > cap) start = Math.max(0, Math.min(hs.length - cap, active - Math.floor(cap / 2)));
	const rows: TocRow[] = [];
	const nums: number[] = [];
	let n2 = 0;
	for (const h of hs) nums.push(h.level === 2 ? ++n2 : 0);
	for (let i = start; i < Math.min(hs.length, start + cap); i++) {
		rows.push({ index: i, entry: hs[i], num: nums[i], rect: { x: panel.x + (sticky ? 0 : 8), y: top + (i - start) * TOC_ROW, w: panel.w - (sticky ? 0 : 16), h: TOC_ROW }, active: i === active });
	}
	return { sticky, panel, scrim, head, close, rows, slide };
}

// ---- citation popover ----

export interface CiteLayout { card: Rect; titleLines: string[]; host: string; hostX: number; hostY: number; open: Rect; below: boolean }

export function layoutCite(s: ChromeState, ref: RefInfo, anchor: Rect, m: Measure): CiteLayout {
	const w = Math.min(320, s.view.w - 24);
	const pad = 12;
	const lines = wrapLines(ref.title, 'sans', 13, w - 2 * pad, 3, m);
	const h = pad - 2 + lines.length * 18 + 8 + 24 + pad - 2;
	const x = Math.max(12, Math.min(s.view.w - w - 12, anchor.x + anchor.w / 2 - w / 2));
	const gap = 8;
	let below = true;
	let y = anchor.y + anchor.h + gap;
	if (y + h > s.view.h - 12) { below = false; y = anchor.y - gap - h; }
	if (y < BAR_H + 4) y = Math.max(BAR_H + 4, Math.min(y, s.view.h - 12 - h));
	const card = { x, y, w, h };
	const footY = y + h - pad + 2 - 24;
	const openW = m('Open', 'sans', 12.5) + 20;
	return {
		card, titleLines: lines, host: ellipsize(hostOf(ref.url), 'sans', 12, w - 2 * pad - openW - 12, m), hostX: x + pad, hostY: footY + 12,
		open: { x: x + w - pad - openW, y: footY, w: openW, h: 24 }, below
	};
}

// ---- lightbox ----

export interface LightboxLayout { scrim: Rect; image: Rect; caption: { lines: string[]; x: number; y: number }; close: Rect }

export function layoutLightbox(s: ChromeState, lb: { w: number; h: number; caption: string }, m: Measure): LightboxLayout {
	const vw = s.view.w, vh = s.view.h;
	const margin = vw < 720 ? 12 : 48;
	const capLines = lb.caption ? wrapLines(lb.caption, 'sans', 13, Math.min(640, vw - 2 * margin), 2, m) : [];
	const capH = capLines.length ? capLines.length * 18 + 16 : 0;
	const maxW = vw - 2 * margin;
	const maxH = vh - BAR_H - margin - capH - 8;
	const k = Math.min(maxW / lb.w, maxH / lb.h);
	const w = Math.max(1, lb.w * k), h = Math.max(1, lb.h * k);
	const x = (vw - w) / 2;
	const y = BAR_H + (maxH - h) / 2;
	return {
		scrim: { x: 0, y: 0, w: vw, h: vh }, image: { x, y, w, h },
		caption: { lines: capLines, x: vw / 2, y: y + h + 24 }, close: { x: vw - 8 - 40, y: 4, w: 40, h: 40 }
	};
}

// ---- code copy ----

export interface CodeCornerLayout { corner: Rect; lang: { x: number; y: number; text: string }; button: Rect; label: string }

/** the reserved top-right corner of a code block: language label then the copy button; typesetting must keep text out of it */
export function layoutCodeCorner(b: CodeBlockInfo, copied: boolean, m: Measure): CodeCornerLayout {
	const label = copied ? 'Copied' : 'Copy';
	const bw = m('Copied', 'sans', 12) + 20;
	const bh = 24;
	const lw = b.lang ? m(b.lang, 'mono', 11) : 0;
	const gap = lw ? 8 : 0;
	const cw = bw + gap + lw + 12;
	const button = { x: b.rect.x + b.rect.w - 8 - bw, y: b.rect.y + 8, w: bw, h: bh };
	const corner = { x: b.rect.x + b.rect.w - 8 - cw + 6, y: b.rect.y + 4, w: cw + 2, h: bh + 8 };
	return { corner, lang: { x: button.x - gap - lw, y: button.y + bh / 2, text: b.lang }, button, label };
}

// ---- find bar ----

export interface FindLayout { panel: Rect; field: Rect; text: { x: number; y: number }; count: { x: number; y: number; text: string; w: number }; prev: Rect; next: Rect; close: Rect }

export function layoutFind(s: ChromeState, m: Measure): FindLayout {
	const w = Math.min(400, s.view.w - 24);
	const h = 40;
	const x = s.view.w - 12 - w;
	const y = BAR_H + 8;
	const panel = { x, y, w, h };
	const close = { x: x + w - 4 - 32, y: y + 4, w: 32, h: 32 };
	const next = { x: close.x - 32, y: y + 4, w: 32, h: 32 };
	const prev = { x: next.x - 32, y: y + 4, w: 32, h: 32 };
	const q = s.find.query;
	const ct = q ? (s.find.count === 0 ? 'No results' : `${s.find.index} of ${s.find.count}`) : '';
	const cw = m(ct || 'No results', 'sans', 12);
	const count = { x: prev.x - 8 - cw, y: y + h / 2, text: ct, w: cw };
	const field = { x: x + 12, y: y + 6, w: Math.max(40, count.x - 8 - (x + 12)), h: 28 };
	return { panel, field, text: { x: field.x + 8, y: y + h / 2 }, count, prev, next, close };
}

// ---- toast ----

export interface ToastLayout { pill: Rect; text: { x: number; y: number; text: string } }

export function layoutToast(s: ChromeState, msg: string, m: Measure): ToastLayout {
	const tw = m(msg, 'sans', 13);
	const w = Math.min(s.view.w - 24, tw + 28);
	const h = 32;
	const x = (s.view.w - w) / 2;
	const y = s.view.h - 24 - h;
	return { pill: { x, y, w, h }, text: { x: x + (w - tw) / 2, y: y + h / 2, text: msg } };
}

// ---- scrollbar (hit geometry only; drawing is ui/scrollbar.ts) ----

export function scrollbarHit(s: ChromeState): { track: Rect; thumb: Rect } | null {
	const vh = s.view.h;
	if (s.docPx <= vh + 1) return null;
	const trackH = vh - BAR_H;
	const thumbH = Math.min(trackH, Math.max(40, (vh * vh) / s.docPx));
	const range = s.docPx - vh;
	const f = Math.max(0, Math.min(1, s.scrollY / range));
	return {
		track: { x: s.view.w - 14, y: BAR_H, w: 14, h: trackH },
		thumb: { x: s.view.w - 14, y: BAR_H + f * (trackH - thumbH), w: 14, h: thumbH }
	};
}
