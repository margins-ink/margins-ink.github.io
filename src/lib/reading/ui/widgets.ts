// Immediate-mode GPU chrome (lane U2): `buildChrome` turns ChromeState + ChromeInput into overlays, UI glyphs and hit rects
// every dirty frame, back to front. No DOM, no Svelte. Text is shaped through the injected `deps.shapeUi`.
// Animation is exact and frame-rate independent (`v += (target - v) * (1 - exp(-dt / tau))`); `reduced` snaps.
//
// Actions the root dispatches (HitRect.onClick, and `actions` for keyboard-driven ones):
//   close, toggleAa, toc:toggle, toc:close, toc:<n> (heading index), aa:step:<i>, aa:full, aa:close,
//   cite:open:<ref>, lb:close, copy:<block>, fig:play:<fig>, fig:back:<fig>, fig:fwd:<fig>, fig:scrub:<fig> (capture),
//   find:field (click: caret via `caretIndexAt`), find:prev, find:next, find:close, find:query (text changed), sb:track, sb:thumb (capture)
import type { Overlay } from '../page-api';
import type { ScrollbarFrame, ScrollbarInput, ScrollbarState, Shaped, UiFont, UiGlyph } from './types';
import { hitChrome } from './hit';
import {
	BAR_H, BTN, createChromeAnim, ellipsize, layoutAa, layoutBar, layoutCite, layoutCodeCorner, layoutFigure, layoutFind,
	layoutLightbox, layoutToast, layoutToc, scrollbarHit, sectionLabel, tocSticky, widthClassOf,
	type ChromeInput, type ChromeState, type HitRect, type KeyEvent, type Measure, type Rect, type RGB
} from './layout';

export { createChromeAnim };

export interface ChromeDeps {
	shapeUi: (text: string, font: UiFont, sizePx: number) => Shaped;
	/** ui/scrollbar.ts `scrollbarFrame` (lane U1): returns the next state, its overlays and whether it animates */
	scrollbar?: (st: ScrollbarState, dtMs: number, inp: ScrollbarInput) => ScrollbarFrame;
}

export interface ChromeOut {
	overlays: Overlay[];
	uiText: UiGlyph[];
	hits: HitRect[];
	/** CSS cursor of the chrome rect under the pointer ('' when the pointer is not over chrome: the article decides) */
	cursor: string;
	animating: boolean;
	/** keyboard-driven actions (find field edits, Enter, Esc) */
	actions: string[];
	/** where the root draws the lightbox image (page pass), with its fade */
	lightbox: { rect: Rect; alpha: number } | null;
}

// ---- find field editing (pure) ----

const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;
const prevCp = (t: string, i: number) => (i <= 0 ? 0 : i >= 2 && isLow(t.charCodeAt(i - 1)) ? i - 2 : i - 1);
const nextCp = (t: string, i: number) => (i >= t.length ? t.length : t.charCodeAt(i) >= 0xd800 && t.charCodeAt(i) <= 0xdbff && i + 1 < t.length ? i + 2 : i + 1);

/** apply one key to the field; returns the new query, caret and whether the text changed (no selection model: caret only) */
export function editField(q: string, caret: number, k: KeyEvent): { query: string; caret: number; changed: boolean } | null {
	caret = Math.max(0, Math.min(q.length, caret));
	const same = { query: q, caret, changed: false };
	if (k.mod && k.key.toLowerCase() === 'v') {
		const p = (k.paste ?? '').replace(/[\r\n]+/g, ' ');
		if (!p) return same;
		return { query: q.slice(0, caret) + p + q.slice(caret), caret: caret + p.length, changed: true };
	}
	switch (k.key) {
		case 'Backspace': {
			if (caret === 0) return same;
			const i = prevCp(q, caret);
			return { query: q.slice(0, i) + q.slice(caret), caret: i, changed: true };
		}
		case 'Delete': {
			if (caret >= q.length) return same;
			const j = nextCp(q, caret);
			return { query: q.slice(0, caret) + q.slice(j), caret, changed: true };
		}
		case 'ArrowLeft': return { ...same, caret: k.mod ? 0 : prevCp(q, caret) };
		case 'ArrowRight': return { ...same, caret: k.mod ? q.length : nextCp(q, caret) };
		case 'Home': return { ...same, caret: 0 };
		case 'End': return { ...same, caret: q.length };
		default: break;
	}
	if (!k.mod && !k.alt && Array.from(k.key).length === 1 && k.key >= ' ') {
		return { query: q.slice(0, caret) + k.key + q.slice(caret), caret: caret + k.key.length, changed: true };
	}
	return null;
}

/** caret index (UTF-16) nearest to a click at local x (px from the start of the text) */
export function caretIndexAt(q: string, localX: number, m: Measure, size = 13): number {
	let best = 0, bestD = Math.abs(localX);
	for (let i = nextCp(q, 0); i <= q.length; i = nextCp(q, i)) {
		const d = Math.abs(localX - m(q.slice(0, i), 'sans', size));
		if (d < bestD) { best = i; bestD = d; }
		if (i >= q.length) break;
	}
	return best;
}

// ---- animation ----

const approach = (cur: number, target: number, dt: number, tau: number, reduced: boolean): number => {
	if (reduced) return target;
	const v = target + (cur - target) * Math.exp(-dt / tau);
	return Math.abs(v - target) < 0.004 ? target : v;
};

// ---- output builder ----

class Out {
	overlays: Overlay[] = [];
	uiText: UiGlyph[] = [];
	hits: HitRect[] = [];
	constructor(public deps: ChromeDeps, public m: Measure, public hdr: number) {}

	box(r: Rect, radius: number, c: RGB, a: number, hdr?: number): number {
		if (a < 0.004 || r.w <= 0 || r.h <= 0) return -1;
		const o: Overlay = { x: r.x, y: r.y, w: r.w, h: r.h, radius, r: c[0], g: c[1], b: c[2], a: Math.min(1, a) };
		if (hdr && hdr !== 1) o.hdr = hdr;
		this.overlays.push(o);
		return this.overlays.length - 1;
	}
	/** a 4-bar ring around r (outset o, thickness t) */
	ring(r: Rect, o: number, t: number, c: RGB, a: number, hdr?: number) {
		const x = r.x - o, y = r.y - o, w = r.w + 2 * o, h = r.h + 2 * o;
		this.box({ x, y, w, h: t }, 0, c, a, hdr);
		this.box({ x, y: y + h - t, w, h: t }, 0, c, a, hdr);
		this.box({ x, y: y + t, w: t, h: h - 2 * t }, 0, c, a, hdr);
		this.box({ x: x + w - t, y: y + t, w: t, h: h - 2 * t }, 0, c, a, hdr);
	}
	/** text with its vertical centre at cy; align 'c' centres on x. clip drops glyphs outside [x0, x1]. Returns the width. */
	text(str: string, x: number, cy: number, font: UiFont, size: number, c: RGB, a: number, o: { align?: 'l' | 'c' | 'r'; clip?: [number, number]; dy?: number; hdr?: number } = {}): number {
		if (!str || a < 0.004) return str ? this.m(str, font, size) : 0;
		const sh = this.deps.shapeUi(str, font, size);
		const x0 = o.align === 'c' ? x - sh.width / 2 : o.align === 'r' ? x - sh.width : x;
		const base = cy + size * 0.35 + (o.dy ?? 0);
		for (let i = 0; i < sh.glyphs.length; i++) {
			const g = sh.glyphs[i];
			const gx = x0 + g.dx;
			if (o.clip) {
				const end = x0 + (i + 1 < sh.glyphs.length ? sh.glyphs[i + 1].dx : sh.width);
				if (gx < o.clip[0] - 0.01 || end > o.clip[1] + 0.01) continue;
			}
			const u: UiGlyph = { x: gx, y: base, glyphId: g.glyphId, font, size, r: c[0], g: c[1], b: c[2], a: Math.min(1, a) };
			if (o.hdr && o.hdr !== 1) u.hdr = o.hdr;
			this.uiText.push(u);
		}
		return sh.width;
	}
	/** scale the alpha of glyphs already emitted (those below y0) by (1 - k): a scrim passes over them */
	dimText(k: number, y0 = -Infinity) {
		for (const g of this.uiText) if (g.y > y0) g.a *= 1 - k;
	}
	hit(id: string, r: Rect, cursor: string, ov: number, onClick?: string, capture?: boolean) {
		const h: HitRect = { id, x: r.x, y: r.y, w: r.w, h: r.h, cursor, ov };
		if (onClick) h.onClick = onClick;
		if (capture) h.capture = true;
		this.hits.push(h);
	}
}

// ---- main ----

export function buildChrome(s: ChromeState, input: ChromeInput, dtMs: number, deps: ChromeDeps): ChromeOut {
	const a = s.anim;
	const th = s.theme;
	const red = s.reduced;
	const m: Measure = (t, f, z) => deps.shapeUi(t, f, z).width;
	const out = new Out(deps, m, s.hdrGain);
	const actions: string[] = [];
	let animating = false;
	const track = (cur: number, target: number, tau: number) => {
		const v = approach(cur, target, dtMs, tau, red);
		if (v !== target) animating = true;
		return v;
	};

	// keyboard into the find field
	if (s.find.open) {
		for (const k of input.keys) {
			if (k.key === 'Escape') { actions.push('find:close'); continue; }
			if (k.key === 'Enter') { actions.push(k.shift ? 'find:prev' : 'find:next'); continue; }
			const r = editField(s.find.query, s.find.caret, k);
			if (r) { s.find.query = r.query; s.find.caret = r.caret; if (r.changed) actions.push('find:query'); }
		}
	}

	// hover id from the previous frame's hits (so upper layers occlude lower ones); captured id stays hot
	const prevTop = input.pointer ? hitChrome(a.prevHits, input.pointer.x, input.pointer.y) : null;
	const hoverId = input.captured ?? prevTop?.id ?? null;
	const pressed = input.down && hoverId !== null;
	const heat = (id: string): number => {
		const v = track(a.hover[id] ?? 0, hoverId === id ? 1 : 0, 70);
		if (v === 0 && hoverId !== id) delete a.hover[id]; else a.hover[id] = v;
		return v;
	};

	const cls = widthClassOf(s.view.w);
	const sticky = tocSticky(s);
	const label = sectionLabel(s);

	// progress of every layer
	if (s.popover) a.lastPop = s.popover;
	if (s.lightbox) a.lastLb = s.lightbox;
	a.aaT = track(a.aaT, s.aa.open ? 1 : 0, 80);
	a.tocT = track(a.tocT, s.tocOpen && !sticky ? 1 : 0, 110);
	a.popT = track(a.popT, s.popover ? 1 : 0, 70);
	a.lbT = track(a.lbT, s.lightbox ? 1 : 0, 100);
	a.findT = track(a.findT, s.find.open ? 1 : 0, 80);
	const linkOn = s.hoverLink ?? s.focusLink;
	if (linkOn) a.linkRects = linkOn;
	a.linkT = track(a.linkT, linkOn ? 1 : 0, 80);
	if (label !== a.secLabel) { a.secPrev = a.secLabel; a.secLabel = label; a.secT = red ? 1 : 0; }
	if (a.secT < 1) { a.secT = Math.min(1, a.secT + dtMs / 160); animating = a.secT < 1 || animating; }

	const hdr = s.hdrGain;

	// ---- scrollbar (below everything) ----
	const sbHit = scrollbarHit(s);
	if (deps.scrollbar) {
		const r = deps.scrollbar(s.scrollbar, dtMs, {
			viewW: s.view.w, viewH: s.view.h, docPx: s.docPx, scrollY: s.scrollY, pointer: input.pointer,
			dragging: input.captured === 'sb:thumb', ink: th.ink, accent: th.accent, insetTop: BAR_H, ticks: s.ticks
		});
		s.scrollbar = r.state;
		for (const o of r.overlays) out.overlays.push(o);
		if (r.animating) animating = true;
	}
	if (sbHit) {
		out.hit('sb:track', sbHit.track, 'default', -1, 'sb:track');
		out.hit('sb:thumb', sbHit.thumb, 'grab', -1, 'sb:thumb', true);
	}

	// ---- links: underline and focus ring ----
	if (a.linkT > 0.004) {
		for (const r of a.linkRects) {
			if (s.hoverLink) out.box({ x: r.x, y: r.y + r.h - 2, w: r.w, h: 1.5 }, 0.75, th.accent, 0.9 * a.linkT, hdr);
		}
		if (s.focusLink) for (const r of a.linkRects) out.ring(r, 2, 2, th.accent, 0.95 * a.linkT, hdr);
	}

	// ---- code copy buttons and language labels ----
	for (const b of s.codeBlocks) {
		if (b.rect.y + b.rect.h < BAR_H || b.rect.y > s.view.h) continue;
		const flashAge = b.block in s.copyFlash ? s.nowMs - s.copyFlash[b.block] : Infinity;
		const flashing = flashAge >= 0 && flashAge < 1200;
		const want = s.hoverCode === b.block || s.focusCode === b.block || s.touch || flashing || hoverId === `copy:${b.block}`;
		const t = (a.codeT[b.block] = track(a.codeT[b.block] ?? 0, want ? 1 : 0, 80));
		if (flashing) animating = true;
		if (t <= 0.004) { delete a.codeT[b.block]; continue; }
		const c = layoutCodeCorner(b, flashing, m);
		const id = `copy:${b.block}`;
		const hv = heat(id);
		const ov = out.box(c.button, 6, th.popover, 0.92 * t);
		out.box(c.button, 6, th.ink, (0.08 * hv + (pressed && hoverId === id ? 0.06 : 0)) * t);
		if (flashing) out.ring(c.button, 1.5, 1.5, th.accent, 0.9 * (1 - flashAge / 1200) * t, hdr);
		out.text(c.lang.text, c.lang.x, c.lang.y, 'mono', 11, th.ink3, t);
		out.text(c.label, c.button.x + c.button.w / 2, c.button.y + c.button.h / 2, 'sans', 12, flashing ? th.accent : th.ink2, t, { align: 'c' });
		if (t > 0.5) out.hit(id, c.button, 'pointer', ov, id);
	}

	// ---- figure controls ----
	for (const f of s.figures) {
		if (f.rect.y + f.rect.h < BAR_H || f.rect.y > s.view.h) continue;
		const want = s.hoverFig === f.fig || s.focusFig === f.fig || s.scrubFig === f.fig || s.touch || (hoverId?.startsWith(`fig:`) && hoverId.endsWith(`:${f.fig}`)) === true;
		const t = (a.figT[f.fig] = track(a.figT[f.fig] ?? 0, want ? 1 : 0, 80));
		if (t <= 0.004) { delete a.figT[f.fig]; continue; }
		const L = layoutFigure(f);
		const ovs = out.box(L.strip, 10, th.popover, 0.88 * t);
		if (t > 0.5) out.hit(`fig:strip:${f.fig}`, L.strip, 'default', ovs);
		const btn = (id: string, r: Rect, action: string, draw: (cx: number, cy: number) => void) => {
			const hv = heat(id);
			const ov = out.box(r, 8, th.ink, (0.1 * hv + (pressed && hoverId === id ? 0.06 : 0)) * t);
			draw(r.x + r.w / 2, r.y + r.h / 2);
			if (t > 0.5) out.hit(id, r, 'pointer', ov, action);
		};
		if (L.back) btn(`fig:back:${f.fig}`, L.back, `fig:back:${f.fig}`, (cx, cy) => out.text('‹', cx, cy, 'sans', 20, th.ink, t, { align: 'c' }));
		btn(`fig:play:${f.fig}`, L.play, `fig:play:${f.fig}`, (cx, cy) => {
			if (f.playing) {
				out.box({ x: cx - 5, y: cy - 6, w: 3.5, h: 12 }, 1, th.ink, t);
				out.box({ x: cx + 1.5, y: cy - 6, w: 3.5, h: 12 }, 1, th.ink, t);
			} else {
				const n = 8, hh = 12, ww = 10;
				for (let k = 0; k < n; k++) {
					const w = ww * (1 - Math.abs(((k + 0.5) / n) * 2 - 1));
					out.box({ x: cx - 3.5, y: cy - hh / 2 + (k * hh) / n, w: Math.max(1, w), h: hh / n + 0.4 }, 0, th.ink, t);
				}
			}
		});
		if (L.fwd) btn(`fig:fwd:${f.fig}`, L.fwd, `fig:fwd:${f.fig}`, (cx, cy) => out.text('›', cx, cy, 'sans', 20, th.ink, t, { align: 'c' }));
		if (L.track.w > 0) {
			out.box(L.track, 2, th.ink, 0.2 * t);
			const p = Math.max(0, Math.min(1, f.t));
			out.box({ x: L.track.x, y: L.track.y, w: L.track.w * p, h: L.track.h }, 2, th.accent, 0.95 * t, hdr);
			out.box({ x: L.track.x + L.track.w * p - 6, y: L.track.y + 2 - 6, w: 12, h: 12 }, 6, th.ink, t);
			if (t > 0.5) out.hit(`fig:scrub:${f.fig}`, L.scrub, 'ew-resize', -1, `fig:scrub:${f.fig}`, true);
		}
	}

	// ---- Aa outside-click catcher sits under the bar so the Aa button still toggles ----
	if (s.aa.open) out.hit('aa:dismiss', { x: 0, y: 0, w: s.view.w, h: s.view.h }, 'default', -1, 'aa:close');

	// ---- top bar ----
	const bar = layoutBar(s, label, m);
	{
		const ov = out.box(bar.bar, 0, th.ground, 1);
		out.box({ x: 0, y: BAR_H - 1, w: s.view.w, h: 1 }, 0, th.ink, 0.07);
		out.hit('bar', bar.bar, 'default', ov);
		const iconBtn = (id: string, r: Rect, action: string, on: boolean, draw: (cx: number, cy: number) => void) => {
			const hv = heat(id);
			const ov2 = on ? out.box(r, 8, th.accent, 0.16) : out.box(r, 8, th.ink, 0.09 * hv + (pressed && hoverId === id ? 0.06 : 0));
			draw(r.x + r.w / 2, r.y + r.h / 2);
			out.hit(id, r, 'pointer', ov2, action);
		};
		iconBtn('bar:close', bar.close, 'close', false, (cx, cy) =>
			s.meta.closeKind === 'back' ? out.text('‹', cx, cy, 'sans', 26, th.ink2, 1, { align: 'c' }) : out.text('×', cx, cy, 'sans', 22, th.ink2, 1, { align: 'c' }));
		iconBtn('bar:aa', bar.aa, 'toggleAa', s.aa.open, (cx, cy) => {
			const w1 = m('A', 'sans', 11), w2 = m('A', 'sans', 16);
			const x0 = cx - (w1 + w2 + 1) / 2;
			out.text('A', x0, cy + 2.5, 'sans', 11, s.aa.open ? th.accent : th.ink2, 1);
			out.text('A', x0 + w1 + 1, cy, 'sans', 16, s.aa.open ? th.accent : th.ink2, 1);
		});
		if (bar.contents) {
			iconBtn('bar:contents', bar.contents, 'toc:toggle', s.tocOpen, (cx, cy) => {
				for (const dy of [-5, 0, 5]) out.box({ x: cx - 7, y: cy + dy - 0.75, w: 14, h: 1.5 }, 0.75, s.tocOpen ? th.accent : th.ink2, 1);
			});
		}
		if (bar.time) out.text(bar.time.text, bar.time.x, BAR_H / 2, 'sans', 12, th.ink3, 1);
		if (bar.title) out.text(bar.title.text, bar.title.x, BAR_H / 2, 'sans', 13, th.ink2, 1);
		// current section crossfade (new rises in, old fades up)
		const secT = a.secT;
		if (bar.section) {
			out.text(bar.section.text, bar.section.x, BAR_H / 2, 'sans', 13, th.ink, secT, { dy: (1 - secT) * 6 });
		}
		if (secT < 1 && a.secPrev) {
			const old = layoutBar(s, a.secPrev, m);
			if (old.section) out.text(old.section.text, old.section.x, BAR_H / 2, 'sans', 13, th.ink, 1 - secT, { dy: -secT * 6 });
		}
		if (bar.section) {
			out.hit('bar:section', { x: bar.section.x - 6, y: 4, w: bar.section.w + 12, h: BAR_H - 8 }, 'pointer', -1, 'toc:toggle');
		}
	}

	// ---- contents ----
	if (s.meta.headings.length > 0 && (sticky || a.tocT > 0.004)) {
		const L = layoutToc(s, sticky ? 1 : a.tocT);
		const t = sticky ? 1 : a.tocT;
		if (!sticky) {
			out.box(L.scrim!, 0, th.ground, 0.55 * t);
			out.dimText(0.55 * t, BAR_H);
			if (s.tocOpen) out.hit('toc:scrim', L.scrim!, 'default', -1, 'toc:close');
			const p = { x: L.panel.x + L.slide.dx, y: L.panel.y + L.slide.dy, w: L.panel.w, h: L.panel.h };
			let ov: number;
			if (cls === 2) { ov = -1; out.box({ ...p, h: p.h + 16 }, 14, th.surface, 1); } else {
				ov = out.box(p, 0, th.surface, 1);
				out.box({ x: p.x + p.w, y: p.y, w: 1, h: p.h }, 0, th.ink, 0.1 * t);
			}
			if (s.tocOpen) out.hit('toc:panel', p, 'default', ov);
			L.close && out.hit('toc:close', { ...L.close, x: L.close.x + L.slide.dx, y: L.close.y + L.slide.dy }, 'pointer', -1, 'toc:close');
			if (L.close) out.text('×', L.close.x + L.slide.dx + BTN / 2, L.close.y + L.slide.dy + BTN / 2, 'sans', 22, th.ink2, t, { align: 'c' });
		}
		const dx = L.slide.dx, dy = L.slide.dy;
		out.text('Contents', L.head.x + dx, L.head.y + dy, 'sans', 11, th.ink3, t);
		for (const row of L.rows) {
			const id = `toc:${row.index}`;
			const r = { x: row.rect.x + dx, y: row.rect.y + dy, w: row.rect.w, h: row.rect.h };
			const hv = heat(id);
			const ov = out.box(r, 6, th.ink, 0.06 * hv * t);
			if (row.active) out.box({ x: r.x, y: r.y + (r.h - 14) / 2, w: 2, h: 14 }, 1, th.accent, t, hdr);
			const ink = row.active ? th.ink : th.ink2;
			let tx = r.x + 12;
			if (row.entry.level === 2) { out.text(String(row.num).padStart(2, '0'), tx, r.y + r.h / 2, 'mono', 11, th.ink3, t); tx += 26; } else tx += 36;
			const text = row.entry.text;
			const maxW = r.x + r.w - 8 - tx;
			out.text(maxW > 0 ? ellipsize(text, 'sans', 13, maxW, m) : '', tx, r.y + r.h / 2, 'sans', 13, ink, t);
			if (sticky || s.tocOpen) out.hit(id, r, 'pointer', ov, id);
		}
	}

	// ---- citation popover ----
	if (a.popT > 0.004 && a.lastPop) {
		const ref = s.meta.refs[a.lastPop.ref];
		if (ref) {
			const t = a.popT;
			const L = layoutCite(s, ref, a.lastPop.anchor, m);
			out.box({ x: L.card.x - 1, y: L.card.y - 1, w: L.card.w + 2, h: L.card.h + 2 }, 11, th.ink, 0.12 * t);
			const ov = out.box(L.card, 10, th.popover, t);
			L.titleLines.forEach((ln, i) => out.text(ln, L.card.x + 12, L.card.y + 10 + i * 18 + 9, 'sans', 13, th.ink, t));
			out.text(L.host, L.hostX, L.hostY, 'sans', 12, th.ink3, t);
			const id = `cite:open:${a.lastPop.ref}`;
			const hv = heat(id);
			const ovb = out.box(L.open, 6, th.accent, (0.14 + 0.1 * hv) * t);
			out.text('Open', L.open.x + L.open.w / 2, L.open.y + L.open.h / 2, 'sans', 12.5, th.accent, t, { align: 'c', hdr });
			if (s.popover) {
				out.hit('pop:card', L.card, 'default', ov);
				out.hit(id, L.open, 'pointer', ovb, id);
			}
		}
	}

	// ---- Aa popover ----
	if (a.aaT > 0.004) {
		const t = a.aaT;
		const L = layoutAa(s, bar);
		out.box({ x: L.panel.x - 1, y: L.panel.y - 1, w: L.panel.w + 2, h: L.panel.h + 2 }, 13, th.ink, 0.12 * t);
		const ov = out.box(L.panel, 12, th.popover, t);
		if (s.aa.open) out.hit('aa:panel', L.panel, 'default', ov);
		out.text('Text size', L.label.x, L.label.y, 'sans', 11, th.ink3, t);
		L.steps.forEach((r, i) => {
			const id = `aa:step:${i}`;
			const sel = i === s.aa.step;
			const hv = heat(id);
			const o2 = sel ? out.box(r, 8, th.accent, 0.18 * t) : out.box(r, 8, th.ink, 0.09 * hv * t);
			out.text('A', r.x + r.w / 2, r.y + r.h / 2, 'sans', 11 + i * 3, sel ? th.accent : th.ink2, t, { align: 'c' });
			if (s.aa.open) out.hit(id, r, 'pointer', o2, id);
		});
		if (L.check && L.box) {
			const hv = heat('aa:full');
			const o2 = out.box(L.check, 8, th.ink, 0.07 * hv * t);
			if (s.aa.alwaysFull) {
				out.box(L.box, 4, th.accent, t, hdr);
				out.box({ x: L.box.x + 5, y: L.box.y + 5, w: 6, h: 6 }, 2, th.popover, t);
			} else out.box(L.box, 4, th.ink, 0.18 * t);
			out.text('Always show full text', L.box.x + 26, L.box.y + 8, 'sans', 13, th.ink2, t);
			if (s.aa.open) out.hit('aa:full', L.check, 'pointer', o2, 'aa:full');
		}
	}

	// ---- find bar ----
	if (a.findT > 0.004) {
		const t = a.findT;
		const L = layoutFind(s, m);
		out.box({ x: L.panel.x - 1, y: L.panel.y - 1, w: L.panel.w + 2, h: L.panel.h + 2 }, 13, th.ink, 0.12 * t);
		const ov = out.box(L.panel, 12, th.popover, t);
		if (s.find.open) out.hit('find:panel', L.panel, 'default', ov);
		const ovf = out.box(L.field, 8, th.ink, 0.07 * t);
		if (s.find.open) out.hit('find:field', L.field, 'text', ovf, 'find:field');
		const q = s.find.query;
		const clip: [number, number] = [L.field.x + 6, L.field.x + L.field.w - 6];
		const caretX0 = m(q.slice(0, s.find.caret), 'sans', 13);
		const scrollX = Math.max(0, caretX0 - (L.field.w - 20));
		if (q) out.text(q, L.text.x - scrollX, L.text.y, 'sans', 13, th.ink, t, { clip });
		else out.text('Find', L.text.x, L.text.y, 'sans', 13, th.ink3, t);
		if (s.find.open) {
			animating = true;
			const on = red || Math.floor(s.nowMs / 530) % 2 === 0;
			if (on) out.box({ x: L.text.x - scrollX + caretX0, y: L.text.y - 8, w: 1.5, h: 16 }, 0.75, th.accent, t, hdr);
		}
		if (L.count.text) out.text(L.count.text, L.count.x, L.count.y, 'sans', 12, s.find.count === 0 ? th.ink3 : th.ink2, t);
		const fb = (id: string, r: Rect, glyph: string, size: number) => {
			const hv = heat(id);
			const o2 = out.box(r, 8, th.ink, 0.09 * hv * t);
			out.text(glyph, r.x + r.w / 2, r.y + r.h / 2, 'sans', size, th.ink2, t, { align: 'c' });
			if (s.find.open) out.hit(id, r, 'pointer', o2, id);
		};
		fb('find:prev', L.prev, '‹', 22);
		fb('find:next', L.next, '›', 22);
		fb('find:close', L.close, '×', 20);
	}

	// ---- toast (pointer-events none) ----
	for (let i = s.toasts.length - 1; i >= 0; i--) {
		const age = s.nowMs - s.toasts[i].atMs;
		if (age < 0 || age > 2200) continue;
		animating = true;
		const t = red ? 1 : age < 120 ? age / 120 : age < 1900 ? 1 : (2200 - age) / 300;
		const L = layoutToast(s, s.toasts[i].msg, m);
		out.box(L.pill, 16, th.popover, 0.96 * t);
		out.text(L.text.text, L.text.x, L.text.y, 'sans', 13, th.ink, t);
		break;
	}

	// ---- lightbox (covers everything) ----
	let lightbox: ChromeOut['lightbox'] = null;
	if (a.lbT > 0.004 && a.lastLb) {
		const t = a.lbT;
		const L = layoutLightbox(s, a.lastLb, m);
		out.dimText(0.9 * t);
		const ov = out.box(L.scrim, 0, th.ground, 0.94 * t);
		if (s.lightbox) {
			out.hit('lb:scrim', L.scrim, 'pointer', ov, 'lb:close');
			out.hit('lb:image', L.image, 'default', -1);
		}
		lightbox = { rect: L.image, alpha: t };
		L.caption.lines.forEach((ln, i) => out.text(ln, L.caption.x, L.caption.y + i * 18, 'sans', 13, th.ink2, t, { align: 'c' }));
		const hv = heat('lb:close');
		const o2 = out.box(L.close, 20, th.ink, 0.1 * hv * t);
		out.text('×', L.close.x + L.close.w / 2, L.close.y + L.close.h / 2, 'sans', 24, th.ink, t, { align: 'c' });
		if (s.lightbox) out.hit('lb:close', L.close, 'pointer', o2, 'lb:close');
	}

	a.prevHits = out.hits;
	let cursor = '';
	if (input.captured) cursor = out.hits.find((h) => h.id === input.captured)?.cursor ?? '';
	else if (input.pointer) cursor = hitChrome(out.hits, input.pointer.x, input.pointer.y)?.cursor ?? '';
	return { overlays: out.overlays, uiText: out.uiText, hits: out.hits, cursor, animating, actions, lightbox };
}
