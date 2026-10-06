/// <reference types="bun" />
// Run: bun test src/lib/reader/bands.test.ts
// Stage 1 acceptance: Slug bands round-trip through the binary and agree with an independent fill
// (opentype.js path for the default-instance fonts, harfbuzz outlines flattened for the rest) on 200
// random points per glyph. A planted-bug control corrupts the bands and must be caught.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import { fontPath, FontSet, GlyphTableBuilder, F } from '../../../scripts/reader/fonts';
import { flatten, type Contour } from '../../../scripts/reader/geom';
import { glyphCount, glyphRec, packFontsBin, readFontsBin, packArticle, unpackArticle, type ArticleModel, type GlyphTable } from './format';
import { contoursOf, windingFromBands } from './slug-cpu';

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789&@%$#{}[]()<>=+-*/\\|!?.,;:\'"~^_`fiflffé→≠';
const POINTS = 200;

let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

type Poly = [number, number][][];

function windingPoly(polys: Poly, px: number, py: number): number {
	let w = 0;
	for (const p of polys) {
		for (let i = 0; i < p.length; i++) {
			const a = p[i], b = p[(i + 1) % p.length];
			if (a[1] <= py) { if (b[1] > py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) > 0) w++; }
			else if (b[1] <= py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) < 0) w--;
		}
	}
	return w;
}

function distToPoly(polys: Poly, px: number, py: number): number {
	let d = Infinity;
	for (const p of polys) for (let i = 0; i < p.length; i++) {
		const a = p[i], b = p[(i + 1) % p.length];
		const dx = b[0] - a[0], dy = b[1] - a[1];
		const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)));
		d = Math.min(d, Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)));
	}
	return d;
}

const fonts = new FontSet();

interface Sample { fontIdx: number; ch: string; gid: number; index: number; poly: Poly; ot?: Poly }

function build() {
	const b = new GlyphTableBuilder();
	const samples: Sample[] = [];
	const ots = new Map<number, opentype.Font>();
	for (const fi of [F.body, F.italic, F.bold, F.sans, F.code]) {
		const font = fonts.fonts[fi];
		if (font.spec.defaultInstance) {
			const buf = fs.readFileSync(fontPath(font.spec.file));
			ots.set(fi, opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)));
		}
		const seen = new Set<number>();
		for (const ch of CHARS) {
			const g = font.shape(ch)[0];
			if (!g || g.gid === 0 || seen.has(g.gid)) continue;
			seen.add(g.gid);
			const cs = font.outline(g.gid);
			if (!cs.length) continue;
			const index = b.add(`${fi}:${g.gid}`, cs);
			const s: Sample = { fontIdx: fi, ch, gid: g.gid, index, poly: flatten(cs, 24) };
			const ot = ots.get(fi);
			if (ot) {
				const og = ot.charToGlyph(ch);
				const p = og.getPath(0, 0, ot.unitsPerEm); // 1 em = unitsPerEm px, y down
				const polys: Poly = [];
				let cur: [number, number][] = [];
				let last: [number, number] = [0, 0];
				const em = ot.unitsPerEm;
				const pt = (x: number, y: number): [number, number] => [x / em, -y / em];
				for (const c of p.commands) {
					if (c.type === 'M') { if (cur.length) polys.push(cur); cur = [pt(c.x, c.y)]; last = [c.x, c.y]; }
					else if (c.type === 'L') { cur.push(pt(c.x, c.y)); last = [c.x, c.y]; }
					else if (c.type === 'Q') { for (let s2 = 1; s2 <= 24; s2++) { const t = s2 / 24, u = 1 - t; cur.push(pt(u * u * last[0] + 2 * u * t * c.x1 + t * t * c.x, u * u * last[1] + 2 * u * t * c.y1 + t * t * c.y)); } last = [c.x, c.y]; }
					else if (c.type === 'C') { for (let s2 = 1; s2 <= 24; s2++) { const t = s2 / 24, u = 1 - t; cur.push(pt(u * u * u * last[0] + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x, u * u * u * last[1] + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y)); } last = [c.x, c.y]; }
					else if (c.type === 'Z') { if (cur.length) polys.push(cur); cur = []; }
				}
				if (cur.length) polys.push(cur);
				s.ot = polys;
			}
			samples.push(s);
		}
	}
	return { table: b.finish(), samples, builder: b };
}

/** Compare band walks to a reference fill on POINTS random interior/exterior points per glyph. */
function compare(table: GlyphTable, samples: Sample[], which: 'poly' | 'ot') {
	let n = 0, bad = 0, skipped = 0, inside = 0;
	for (const s of samples) {
		const ref = which === 'ot' ? s.ot : s.poly;
		if (!ref) continue;
		const g = glyphRec(table, s.index);
		for (let k = 0; k < POINTS; k++) {
			const px = g.x0 + rnd() * (g.x1 - g.x0), py = g.y0 + rnd() * (g.y1 - g.y0);
			if (distToPoly(ref, px, py) < 0.004) { skipped++; continue; } // f16 + flattening tolerance
			const inRef = windingPoly(ref, px, py) !== 0;
			const w = windingFromBands(table, s.index, px, py);
			n++;
			if (inRef) inside++;
			if ((w.h !== 0) !== inRef || (w.v !== 0) !== inRef) bad++;
		}
	}
	return { n, bad, skipped, inside };
}

describe('slug bands', () => {
	const { table, samples } = build();

	test('glyph table is non-trivial', () => {
		expect(samples.length).toBeGreaterThan(250);
		expect(glyphCount(table)).toBe(samples.length);
	});

	test('winding parity against the harfbuzz outline (all fonts)', () => {
		const r = compare(table, samples, 'poly');
		console.log('hb outline parity', r);
		expect(r.n).toBeGreaterThan(20000);
		expect(r.inside).toBeGreaterThan(r.n * 0.1); // the points really are inside glyphs sometimes
		expect(r.bad).toBe(0);
	});

	test('winding parity against opentype.js paths (default-instance fonts)', () => {
		const withOt = samples.filter((s) => s.ot);
		expect(withOt.length).toBeGreaterThan(100);
		const r = compare(table, withOt, 'ot');
		console.log('opentype.js parity', r);
		expect(r.bad).toBe(0);
	});

	test('contours rebuilt from curve texels reproduce the outline', () => {
		for (const s of samples.slice(0, 60)) {
			const cs = contoursOf(table, s.index);
			const src = fonts.fonts[s.fontIdx].outline(s.gid);
			expect(cs.length).toBe(src.length);
			cs.forEach((ct, i) => expect(ct.length).toBe((src[i] as Contour).length));
		}
	});

	test('control: planted corruption in the bands is caught', () => {
		const bad = { dir: table.dir, curves: table.curves, bands: Uint32Array.from(table.bands) };
		// zero the count of every non-empty band header: every band walk returns winding 0
		for (const s of samples) {
			const g = glyphRec(bad, s.index);
			for (let k = 0; k < g.nH + g.nV; k++) bad.bands[g.bandStart + k] = 0;
		}
		const r = compare(bad, samples.slice(0, 80), 'poly');
		expect(r.bad).toBeGreaterThan(r.inside * 0.5);
	});

	test('fonts.bin and article containers round-trip', () => {
		const glyphFont = new Uint32Array(glyphCount(table)).fill(0);
		const bytes = packFontsBin(table, fonts.fonts.map((f) => f.info), glyphFont, glyphFont);
		const back = readFontsBin(bytes);
		expect([...back.table.dir]).toEqual([...table.dir]);
		expect([...back.table.curves]).toEqual([...table.curves]);
		expect([...back.table.bands]).toEqual([...table.bands]);

		const m: ArticleModel = {
			widthClass: 1, emPx0: 16, sheetW: 28, sheetH: 56, measure: 21, marginX: 3.5, marginY: 5, cellW: 6, cellH: 1.6, gridCols: 5, gridRows: 35, plainTextBytes: 3,
			pages: [{ y0: 0, h: 56, firstLine: 0, lineCount: 1, firstItem: 0, itemCount: 1, tone565: 0xf79e, coverage: 0.5, pageNo: 1 }],
			cells: [{ start: 0, count: 1 }], items: [7],
			glyphs: [{ x: 3.5, y: 6.25, glyphId: 12, size: 0.85, colour: 9, flags: 1, charOffset: 2 }],
			rects: [{ x0: 1, y0: 2, x1: 3, y1: 4, colour: 6, kind: 1 }],
			images: [{ x0: 1, y0: 2, x1: 3, y1: 4, imageId: 2, radius: 4, altOffset: 1 }],
			lines: [{ yTop: 5, yBot: Math.fround(6.6), x0: 3.5, x1: 9, firstGlyph: 0, glyphCount: 1, charOffset: 2 }],
			links: [{ x0: 1, y0: 2, x1: 3, y1: 4, kind: 3, offset: 1, page: 0 }],
			anchors: [{ idOffset: 1, page: 0, y: 5 }],
			extra: table, text: new Uint8Array([97, 98, 99]), strings: new Uint8Array([0, 120, 0]), palette: new Uint32Array(48).fill(0xff102030)
		};
		const m2 = unpackArticle(packArticle(m));
		expect(m2.pages).toEqual(m.pages);
		expect(m2.glyphs[0].size).toBeCloseTo(0.85, 2);
		expect({ ...m2.glyphs[0], size: 0 }).toEqual({ ...m.glyphs[0], size: 0 });
		expect(m2.rects).toEqual(m.rects);
		expect(m2.images).toEqual(m.images);
		expect(m2.lines).toEqual(m.lines);
		expect(m2.links).toEqual(m.links);
		expect(m2.anchors).toEqual(m.anchors);
		expect([...m2.text]).toEqual([97, 98, 99]);
		expect(m2.cells).toEqual(m.cells);
		expect(m2.gridCols).toBe(5);
	});
});
