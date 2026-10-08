import { describe, expect, test } from 'bun:test';
import type { Shaped, UiFont } from './types';
import { buildChrome, caretIndexAt, createChromeAnim, editField, type ChromeDeps, type ChromeOut } from './widgets';
import { hitById, hitChrome, fractionIn, thumbScrollY } from './hit';
import { BAR_H, TIP, intersects, layoutCite, layoutCodeCorner, layoutLinkTip, widthClassOf, type ChromeInput, type ChromeState, type Rect } from './layout';

// stub shaper: fixed advances so widths are exact and independent of lane U1
const shapeUi = (text: string, font: UiFont, size: number): Shaped => {
	const adv = size * (font === 'mono' ? 0.6 : 0.5);
	const glyphs = Array.from(text).map((c, i) => ({ dx: i * adv, glyphId: c.codePointAt(0)! }));
	return { glyphs, width: glyphs.length * adv };
};
const deps: ChromeDeps = { shapeUi };
const m = (t: string, f: UiFont, s: number) => shapeUi(t, f, s).width;

const col = (r: number, g: number, b: number): [number, number, number] => [r, g, b];
function state(w: number, h: number, over: Partial<ChromeState> = {}): ChromeState {
	return {
		theme: { ground: col(0.05, 0.05, 0.07), surface: col(0.09, 0.09, 0.11), card: col(0.11, 0.11, 0.13), popover: col(0.13, 0.13, 0.16), ink4: col(0.35, 0.35, 0.38), ink: col(0.93, 0.93, 0.95), ink2: col(0.75, 0.75, 0.8), ink3: col(0.55, 0.55, 0.6), accent: col(0.5, 0.7, 1) },
		reduced: true, hdrGain: 1, nowMs: 10_000, touch: false,
		view: { w, h }, colLeft: Math.max(0, (w - 680) / 2),
		meta: {
			title: 'A fairly long article title that must be truncated on small screens', closeKind: 'close', wordsBrief: 2300, wordsFull: 4600,
			sections: [{ name: 'Intro', y: 0 }, { name: 'The second section has a long name', y: 2000 }, { name: 'End', y: 5000 }],
			refs: [{ title: 'IEEE Std 1003.1-2017 (POSIX) the very long reference title for wrapping', url: 'https://www.example.com/posix' }]
		},
		scrollY: 2100, docPx: 6000, progress: 0.4, section: 1, foldExpanded: false,
		aa: { open: false, step: 1, steps: 5, hasFold: true, alwaysFull: false },
		popover: null, lightbox: null,
		find: { open: false, query: '', caret: 0, count: 0, index: 0 },
		copyFlash: {}, toasts: [],
		codeBlocks: [{ block: 3, rect: { x: w * 0.1, y: 200, w: w * 0.8, h: 160 }, lang: 'rust' }],
		hoverCode: 3, focusCode: -1, hoverLink: null, focusLink: null,
		scrollbar: { opacity: 1, width: 6, widthVel: 0, idleMs: 0, lastScrollY: 0, hover: false },
		anim: createChromeAnim(), ...over
	};
}
const idle: ChromeInput = { pointer: null, down: false, captured: null, keys: [] };
const frame = (s: ChromeState, input: ChromeInput = idle, dt = 16) => buildChrome(s, input, dt, deps);
/** run until animations settle (reduced snaps in one frame; two frames settle hover resolution) */
const settle = (s: ChromeState, input: ChromeInput = idle) => { frame(s, input); return frame(s, input); };

/** every hit with an overlay must sit exactly on that overlay; returns the offending ids */
function drawHitMismatches(o: ChromeOut): string[] {
	const bad: string[] = [];
	for (const h of o.hits) {
		if (h.ov < 0) continue;
		const v = o.overlays[h.ov];
		if (!v || Math.abs(v.x - h.x) > 1e-6 || Math.abs(v.y - h.y) > 1e-6 || Math.abs(v.w - h.w) > 1e-6 || Math.abs(v.h - h.h) > 1e-6) bad.push(h.id);
	}
	return bad;
}

const SIZES: [number, number][] = [[1440, 900], [900, 800], [390, 700]];

function everything(w: number, h: number): ChromeState {
	return state(w, h, {
		aa: { open: true, step: 2, steps: 5, hasFold: true, alwaysFull: true },
		popover: { ref: 0, anchor: { x: w * 0.4, y: 300, w: 20, h: 18 } },
		find: { open: true, query: 'needle', caret: 6, count: 12, index: 3 },
		toasts: [{ id: 1, msg: 'Copied', atMs: 9_800 }], copyFlash: { 3: 9_900 }
	});
}

describe('layout at the three width classes', () => {
	test('classes', () => {
		expect([widthClassOf(1440), widthClassOf(1180), widthClassOf(1179), widthClassOf(720), widthClassOf(719)]).toEqual([0, 0, 1, 1, 2]);
	});

	for (const [w, h] of SIZES) {
		test(`${w}x${h}: all hits and glyphs inside the viewport, draw equals hit`, () => {
			for (const s of [state(w, h), everything(w, h)]) {
				const o = settle(s);
				expect(o.hits.length).toBeGreaterThan(3);
				for (const hit of o.hits) {
					expect(hit.x).toBeGreaterThanOrEqual(-1e-6);
					expect(hit.y).toBeGreaterThanOrEqual(-1e-6);
					expect(hit.x + hit.w).toBeLessThanOrEqual(w + 1e-6);
					expect(hit.y + hit.h).toBeLessThanOrEqual(h + 1e-6);
				}
				for (const g of o.uiText) {
					expect(g.x).toBeGreaterThanOrEqual(-1e-6);
					expect(g.x).toBeLessThanOrEqual(w);
					expect(g.y).toBeLessThanOrEqual(h + 4);
				}
				expect(drawHitMismatches(o)).toEqual([]);
			}
		});

		test(`${w}x${h}: top bar controls do not overlap`, () => {
			const o = settle(state(w, h));
			const ids = ['bar:close', 'bar:aa'];
			const rs = ids.map((id) => hitById(o.hits, id)).filter((x) => x !== null) as Rect[];
			for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) expect(intersects(rs[i], rs[j])).toBe(false);
			// bar text stays inside the bar band
			for (const g of o.uiText) if (g.y < BAR_H + 2) expect(g.y).toBeLessThanOrEqual(BAR_H);
		});

		test(`${w}x${h}: popovers do not overlap the bar and the Aa panel sits under Aa`, () => {
			const s = state(w, h, { aa: { open: true, step: 0, steps: 5, hasFold: true, alwaysFull: false } });
			const o = settle(s);
			const panel = hitById(o.hits, 'aa:panel')!;
			expect(panel.y).toBeGreaterThanOrEqual(BAR_H);
			const aaBtn = hitById(o.hits, 'bar:aa')!;
			expect(panel.x + panel.w).toBeGreaterThanOrEqual(Math.min(aaBtn.x + aaBtn.w, w - 12) - 1);
			const c = state(w, h, { popover: { ref: 0, anchor: { x: w / 2, y: 300, w: 30, h: 18 } } });
			const oc = settle(c);
			const card = hitById(oc.hits, 'pop:card')!;
			expect(card.y).toBeGreaterThanOrEqual(BAR_H);
			expect(card.x).toBeGreaterThanOrEqual(12 - 1e-6);
			expect(card.x + card.w).toBeLessThanOrEqual(w - 12 + 1e-6);
		});
	}

	test('there is no table of contents: no contents button, section label or toc hits at any width', () => {
		for (const [w, h] of SIZES) {
			const o = settle(everything(w, h));
			for (const h2 of o.hits) expect(h2.id.startsWith('toc:') || h2.id === 'bar:contents' || h2.id === 'bar:section').toBe(false);
		}
	});
});

describe('hit/draw consistency control', () => {
	test('shifting a drawn rect by 3 px is detected', () => {
		const o = settle(everything(900, 800));
		expect(drawHitMismatches(o)).toEqual([]);
		const victim = o.hits.find((h) => h.id === 'bar:aa')!;
		expect(victim.ov).toBeGreaterThanOrEqual(0);
		o.overlays[victim.ov].x += 3;
		expect(drawHitMismatches(o)).toContain('bar:aa');
	});
});

describe('hit testing and layering', () => {
	test('topmost wins: the lightbox covers the bar', () => {
		const s = state(900, 800, { lightbox: { w: 1600, h: 900, caption: 'a figure' } });
		const o = settle(s);
		const close = hitById(o.hits, 'bar:close')!;
		const top = hitChrome(o.hits, close.x + 4, close.y + 4)!;
		expect(top.id).toBe('lb:scrim');
		expect(top.onClick).toBe('lb:close');
		expect(o.lightbox).not.toBeNull();
		const r = o.lightbox!.rect;
		expect(r.x).toBeGreaterThanOrEqual(0);
		expect(r.x + r.w).toBeLessThanOrEqual(900);
		expect(r.y).toBeGreaterThanOrEqual(BAR_H);
		expect(r.y + r.h).toBeLessThanOrEqual(800);
		// bar text is dimmed under the scrim
		const t = settle(state(900, 800));
		const bright = Math.max(...t.uiText.filter((g) => g.y < BAR_H && g.size === 13).map((g) => g.a));
		const dim = Math.max(...o.uiText.filter((g) => g.y < BAR_H && g.size === 13).map((g) => g.a));
		expect(dim).toBeLessThan(bright * 0.2);
	});

	test('Aa open: the Aa button stays above the outside-click catcher', () => {
		const o = settle(state(900, 800, { aa: { open: true, step: 1, steps: 5, hasFold: false, alwaysFull: false } }));
		const b = hitById(o.hits, 'bar:aa')!;
		expect(hitChrome(o.hits, b.x + 2, b.y + 2)!.onClick).toBe('toggleAa');
		expect(hitChrome(o.hits, 100, 700)!.onClick).toBe('aa:close');
		const st = hitById(o.hits, 'aa:step:3')!;
		expect(hitChrome(o.hits, st.x + 3, st.y + 3)!.onClick).toBe('aa:step:3');
	});

	test('cursor follows the topmost chrome rect, empty outside chrome', () => {
		const s = state(900, 800);
		frame(s);
		const b = hitById(s.anim.prevHits, 'bar:aa')!;
		expect(frame(s, { ...idle, pointer: { x: b.x + 3, y: b.y + 3 } }).cursor).toBe('pointer');
		expect(frame(s, { ...idle, pointer: { x: 400, y: 500 } }).cursor).toBe('');
	});

	test('the scrollbar thumb is a capture id', () => {
		const o = settle(state(900, 800));
		const sc = hitById(o.hits, 'sb:thumb')!;
		expect(sc.capture).toBe(true);
		expect(fractionIn(sc, sc.x + sc.w / 2)).toBeCloseTo(0.5, 6);
		expect(fractionIn(sc, sc.x - 50)).toBe(0);
		// thumb drag maps the track proportionally
		expect(thumbScrollY(40 + 0, 0, 40, 760, 100, 6000, 800)).toBe(0);
		expect(thumbScrollY(10000, 0, 40, 760, 100, 6000, 800)).toBe(5200);
		const o2 = frame(state(900, 800), { ...idle, captured: 'sb:thumb' });
		expect(o2.cursor).toBe('grab');
	});

	test('actions named for the root', () => {
		const o = settle(everything(900, 800));
		const clicks = new Set(o.hits.map((h) => h.onClick).filter(Boolean));
		for (const a of ['close', 'toggleAa', 'aa:step:0', 'aa:full', 'cite:open:0', 'copy:3', 'find:next', 'find:prev', 'find:close', 'find:field', 'sb:thumb']) {
			expect(clicks.has(a)).toBe(true);
		}
	});
});

describe('code copy corner, citation placement', () => {
	test('corner is reserved in the top-right and holds the button and language label', () => {
		const b = { block: 1, rect: { x: 100, y: 100, w: 600, h: 200 }, lang: 'rust' };
		const c = layoutCodeCorner(b, false, m);
		expect(c.corner.x + c.corner.w).toBeLessThanOrEqual(700 + 1e-6);
		expect(c.corner.y).toBeGreaterThanOrEqual(100);
		for (const r of [c.button, { x: c.lang.x, y: c.button.y, w: m('rust', 'mono', 11), h: c.button.h }]) {
			expect(r.x).toBeGreaterThanOrEqual(c.corner.x - 1e-6);
			expect(r.x + r.w).toBeLessThanOrEqual(c.corner.x + c.corner.w + 1e-6);
		}
		expect(intersects({ x: c.lang.x, y: c.button.y, w: m('rust', 'mono', 11), h: c.button.h }, c.button)).toBe(false);
	});

	test('copy button appears on hover or focus only, and the flash shows Copied', () => {
		const idleS = state(900, 800, { hoverCode: -1 });
		expect(settle(idleS).hits.some((h) => h.id === 'copy:3')).toBe(false);
		expect(settle(state(900, 800, { hoverCode: -1, focusCode: 3 })).hits.some((h) => h.id === 'copy:3')).toBe(true);
		const flash = settle(state(900, 800, { hoverCode: -1, copyFlash: { 3: 9_900 } }));
		const btn = flash.hits.find((h) => h.id === 'copy:3')!;
		expect(btn).toBeDefined();
		const word = flash.uiText.filter((g) => g.y > btn.y && g.y < btn.y + btn.h && g.x >= btn.x && g.x <= btn.x + btn.w).map((g) => String.fromCodePoint(g.glyphId)).join('');
		expect(word).toBe('Copied');
	});

	test('citation popover sits below the cite and flips above near the bottom', () => {
		const s = state(900, 800);
		const ref = s.meta.refs[0];
		const below = layoutCite(s, ref, { x: 400, y: 300, w: 20, h: 18 }, m);
		expect(below.below).toBe(true);
		expect(below.card.y).toBeGreaterThanOrEqual(318);
		const above = layoutCite(s, ref, { x: 400, y: 740, w: 20, h: 18 }, m);
		expect(above.below).toBe(false);
		expect(above.card.y + above.card.h).toBeLessThanOrEqual(740);
		expect(below.open.x + below.open.w).toBeLessThanOrEqual(below.card.x + below.card.w);
	});
});

describe('find bar editing', () => {
	test('type, backspace, delete, arrows, home, end, paste', () => {
		let q = '', c = 0;
		const apply = (k: Parameters<typeof editField>[2]) => { const r = editField(q, c, k)!; q = r.query; c = r.caret; return r; };
		apply({ key: 'a' }); apply({ key: 'b' }); apply({ key: 'c' });
		expect([q, c]).toEqual(['abc', 3]);
		apply({ key: 'ArrowLeft' }); apply({ key: 'Backspace' });
		expect([q, c]).toEqual(['ac', 1]);
		apply({ key: 'Delete' });
		expect([q, c]).toEqual(['a', 1]);
		apply({ key: 'Home' }); apply({ key: 'x' });
		expect([q, c]).toEqual(['xa', 1]);
		apply({ key: 'End' });
		expect(c).toBe(2);
		apply({ key: 'v', mod: true, paste: 'one\ntwo' });
		expect(q).toBe('xaone two');
		expect(editField(q, c, { key: 'Tab' })).toBeNull();
		expect(editField(q, c, { key: 'a', mod: true })).toBeNull();
		// surrogate pairs move as one
		q = 'a\u{1F600}'; c = q.length;
		apply({ key: 'Backspace' });
		expect(q).toBe('a');
		expect(editField('abc', 0, { key: 'Backspace' })!.changed).toBe(false);
	});

	test('buildChrome applies keys, reports actions, Esc closes, Enter and Shift+Enter step', () => {
		const s = state(900, 800, { find: { open: true, query: 'ab', caret: 2, count: 3, index: 1 } });
		const o = frame(s, { ...idle, keys: [{ key: 'c' }, { key: 'Backspace' }, { key: 'Backspace' }, { key: 'Enter' }, { key: 'Enter', shift: true }, { key: 'Escape' }] });
		expect(s.find.query).toBe('a');
		expect(s.find.caret).toBe(1);
		expect(o.actions).toEqual(['find:query', 'find:query', 'find:query', 'find:next', 'find:prev', 'find:close']);
		expect(o.animating).toBe(true); // caret blink
	});

	test('count text and caret placement', () => {
		const s = state(900, 800, { find: { open: true, query: 'needle', caret: 3, count: 12, index: 3 } });
		const o = settle(s);
		const f = hitById(o.hits, 'find:field')!;
		const txt = o.uiText.filter((g) => g.y > f.y && g.y < f.y + f.h && g.x < f.x + f.w).map((g) => String.fromCodePoint(g.glyphId)).join('');
		expect(txt).toBe('needle');
		const all = o.uiText.map((g) => String.fromCodePoint(g.glyphId)).join('');
		expect(all).toContain('3 of 12');
		expect(caretIndexAt('needle', 0, m)).toBe(0);
		expect(caretIndexAt('needle', 1e6, m)).toBe(6);
		expect(caretIndexAt('needle', m('nee', 'sans', 13) + 1, m)).toBe(3);
		// long query stays clipped inside the field
		const long = state(900, 800, { find: { open: true, query: 'x'.repeat(200), caret: 200, count: 0, index: 0 } });
		const ol = settle(long);
		const fl = hitById(ol.hits, 'find:field')!;
		for (const g of ol.uiText.filter((g) => g.y > fl.y && g.y < fl.y + fl.h && g.font === 'sans' && g.size === 13 && String.fromCodePoint(g.glyphId) === 'x')) {
			expect(g.x).toBeGreaterThanOrEqual(fl.x);
			expect(g.x).toBeLessThanOrEqual(fl.x + fl.w);
		}
	});
});

describe('animation', () => {
	test('frame-rate independent: 1 x 120 ms equals 12 x 10 ms', () => {
		const mk = () => state(900, 800, { reduced: false, aa: { open: true, step: 1, steps: 5, hasFold: false, alwaysFull: false } });
		const a = mk();
		frame(a, idle, 120);
		const b = mk();
		for (let i = 0; i < 12; i++) frame(b, idle, 10);
		expect(a.anim.aaT).toBeCloseTo(b.anim.aaT, 9);
		expect(a.anim.aaT).toBeGreaterThan(0.5);
		expect(a.anim.aaT).toBeLessThan(1);
	});

	test('reduced snaps and reports not animating; animating otherwise until settled', () => {
		const r = state(900, 800, { aa: { open: true, step: 1, steps: 5, hasFold: false, alwaysFull: false } });
		const o = frame(r);
		expect(r.anim.aaT).toBe(1);
		expect(o.animating).toBe(false);
		const s = state(900, 800, { reduced: false, aa: { open: true, step: 1, steps: 5, hasFold: false, alwaysFull: false } });
		expect(frame(s, idle, 16).animating).toBe(true);
		let o2 = frame(s, idle, 16);
		for (let i = 0; i < 200; i++) o2 = frame(s, idle, 16);
		expect(o2.animating).toBe(false);
		expect(s.anim.aaT).toBe(1);
	});

	test('toast fades in and out by age and expires', () => {
		const alpha = (age: number) => {
			const o = settle(state(900, 800, { reduced: false, toasts: [{ id: 1, msg: 'Copied', atMs: 10_000 - age }] }));
			return o.uiText.filter((g) => g.y > 700).reduce((mx, g) => Math.max(mx, g.a), 0);
		};
		expect(alpha(1000)).toBeCloseTo(1, 6);
		expect(alpha(2050)).toBeLessThan(0.6);
		expect(alpha(2300)).toBe(0);
	});
});

describe('link preview card', () => {
	const tip = (anchor: Rect, over: Partial<{ host: string; url: string; title: string; description: string }> = {}) => ({
		anchor, host: 'example.com', url: 'https://example.com/a/very/long/path/that/keeps/going/and/going/and/going/forever.html',
		title: 'A page title that is long enough to need to wrap over a couple of lines on a small card',
		description: 'A description that is long enough to wrap over several lines and must be cut off after three of them with an ellipsis at the end of the last one. '.repeat(3), ...over
	});
	const view = { w: 1000, h: 800 };

	test('opens below the link and centres on it', () => {
		const L = layoutLinkTip(view, tip({ x: 480, y: 300, w: 40, h: 20 }), m);
		expect(L.below).toBe(true);
		expect(L.card.y).toBeGreaterThan(320);
		expect(L.card.x + L.card.w / 2).toBeCloseTo(500, 5);
		expect(L.card.w).toBe(TIP.maxW);
	});
	test('flips above when there is no room below, and clamps under the bar', () => {
		const a = layoutLinkTip(view, tip({ x: 480, y: 700, w: 40, h: 20 }), m);
		expect(a.below).toBe(false);
		expect(a.card.y + a.card.h).toBeLessThanOrEqual(700);
		const b = layoutLinkTip({ w: 1000, h: 330 }, tip({ x: 480, y: 150, w: 40, h: 20 }), m);
		expect(b.card.y).toBeGreaterThanOrEqual(BAR_H + 4);
		expect(b.card.y + b.card.h).toBeLessThanOrEqual(330 - 12 + 1e-6);
	});
	test('clamps to 12 px from either side and shrinks on a narrow view', () => {
		expect(layoutLinkTip(view, tip({ x: 2, y: 300, w: 30, h: 20 }), m).card.x).toBe(12);
		const r = layoutLinkTip(view, tip({ x: 970, y: 300, w: 28, h: 20 }), m);
		expect(r.card.x + r.card.w).toBe(view.w - 12);
		const n = layoutLinkTip({ w: 320, h: 700 }, tip({ x: 100, y: 300, w: 40, h: 20 }), m);
		expect(n.card.w).toBe(296);
	});
	test('line limits: title 2, description 3, url one ellipsized line; host and url only when the lookup failed', () => {
		const L = layoutLinkTip(view, tip({ x: 480, y: 300, w: 40, h: 20 }), m);
		expect(L.titleLines.length).toBeLessThanOrEqual(2);
		expect(L.descLines).toHaveLength(3);
		expect(L.descLines[2].text.endsWith('…')).toBe(true);
		expect(m(L.url.text, 'mono', TIP.urlSize)).toBeLessThanOrEqual(TIP.maxW - 2 * TIP.pad + 1e-6);
		const bare = layoutLinkTip(view, tip({ x: 480, y: 300, w: 40, h: 20 }, { title: '', description: '' }), m);
		expect(bare.titleLines).toHaveLength(0);
		expect(bare.descLines).toHaveLength(0);
		expect(bare.card.h).toBeLessThan(L.card.h);
		expect(bare.letter).toBe('E');
	});
	test('springs in: scale 0.96 to 1 with the fade, about 180 ms; hides with a quick fade', () => {
		const s = state(1000, 800, { reduced: false, linkTip: tip({ x: 480, y: 300, w: 40, h: 20 }) });
		const f0 = frame(s, idle, 16);
		const card = (o: ChromeOut) => o.overlays.filter((v) => v.w > 200 && v.w < 345).at(-1);
		const w0 = card(f0)!.w, a0 = card(f0)!.a;
		let o = f0;
		for (let i = 0; i < 12; i++) o = frame(s, idle, 16);
		expect(card(o)!.w).toBeGreaterThan(w0);
		expect(card(o)!.w).toBeLessThanOrEqual(TIP.maxW + 1e-6);
		expect(card(o)!.a).toBeGreaterThan(a0);
		expect(card(o)!.a).toBeGreaterThan(0.95);
		expect(card(o)!.w).toBeGreaterThan(0.99 * TIP.maxW);
		expect(f0.hits.some((h) => h.id.startsWith('tip'))).toBe(false); // non-interactive
		s.linkTip = null;
		for (let i = 0; i < 20; i++) o = frame(s, idle, 16);
		expect(card(o)).toBeUndefined();
	});
});
