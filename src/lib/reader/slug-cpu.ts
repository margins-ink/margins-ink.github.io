// CPU reference of the Slug band walk (docs/upstream/reader/slug/SlugPixelShader.hlsl: CalcRootCode,
// SolveHorizPoly, SolveVertPoly), producing exact (non-antialiased) winding numbers. Used by the
// band tests and the article validator; the WGSL evaluator in stage 3 must agree with it.
import { CONTOUR_END, fromF16, glyphRec, type GlyphTable } from './format';

export type Curve = [number, number, number, number, number, number];

/** Decode the curve that starts at texel t. */
export function curveAt(t: GlyphTable, texel: number): Curve {
	const c = t.curves;
	const a = texel * 4;
	const b = (texel + 1) * 4;
	return [fromF16(c[a]), fromF16(c[a + 1]), fromF16(c[a + 2]), fromF16(c[a + 3]), fromF16(c[b]), fromF16(c[b + 1])];
}

function rootCode(y1: number, y2: number, y3: number): number {
	const shift = (y1 < 0 ? 1 : 0) | (y2 < 0 ? 2 : 0) | (y3 < 0 ? 4 : 0);
	return (0x2e74 >> shift) & 0x0101;
}

/** Signed crossings of the ray from (px,py) towards +x. `c` is relative to the sample. */
function crossH(c: Curve, px: number, py: number): number {
	const y1 = c[1] - py, y2 = c[3] - py, y3 = c[5] - py;
	const code = rootCode(y1, y2, y3);
	if (!code) return 0;
	const ax = c[0] - 2 * c[2] + c[4], bx = c[0] - c[2];
	const ay = y1 - 2 * y2 + y3, by = y1 - y2;
	let t1: number, t2: number;
	if (Math.abs(ay) < 1 / 65536) t1 = t2 = y1 / (2 * by);
	else {
		const d = Math.sqrt(Math.max(by * by - ay * y1, 0));
		t1 = (by - d) / ay;
		t2 = (by + d) / ay;
	}
	const x = (t: number) => (ax * t - 2 * bx) * t + c[0];
	let w = 0;
	if (code & 1 && x(t1) > px) w += 1;
	if (code > 1 && x(t2) > px) w -= 1;
	return w;
}

function crossV(c: Curve, px: number, py: number): number {
	const t: Curve = [c[1], c[0], c[3], c[2], c[5], c[4]];
	return crossH(t, py, px);
}

/** Winding number at (px,py) from the horizontal band and from the vertical band of glyph `gi`. */
export function windingFromBands(t: GlyphTable, gi: number, px: number, py: number): { h: number; v: number } {
	const g = glyphRec(t, gi);
	const kh = Math.min(g.nH - 1, Math.max(0, Math.floor(((py - g.y0) / (g.y1 - g.y0 || 1)) * g.nH)));
	const kv = Math.min(g.nV - 1, Math.max(0, Math.floor(((px - g.x0) / (g.x1 - g.x0 || 1)) * g.nV)));
	const walk = (k: number, vertical: boolean) => {
		const hdr = t.bands[g.bandStart + k + (vertical ? g.nH : 0)];
		const count = hdr & 0xffff;
		const off = hdr >>> 16;
		let w = 0;
		for (let i = 0; i < count; i++) {
			const c = curveAt(t, t.bands[g.bandStart + off + i]);
			if (!vertical) {
				if (Math.max(c[0], c[2], c[4]) < px) break; // sorted by descending max x
				w += crossH(c, px, py);
			} else {
				if (Math.max(c[1], c[3], c[5]) < py) break;
				w += crossV(c, px, py);
			}
		}
		return w;
	};
	return { h: walk(kh, false), v: walk(kv, true) };
}

/** Rebuild a glyph's contours from the curve texels (contour ends are marked by CONTOUR_END). */
export function contoursOf(t: GlyphTable, gi: number): Curve[][] {
	const g = glyphRec(t, gi);
	const out: Curve[][] = [];
	let cur: Curve[] = [];
	let texel = g.curveStart;
	for (let k = 0; k < g.numCurves; k++) {
		cur.push(curveAt(t, texel));
		if (t.curves[(texel + 1) * 4 + 2] === CONTOUR_END) {
			out.push(cur);
			cur = [];
			texel += 2;
		} else texel += 1;
	}
	if (cur.length) out.push(cur);
	return out;
}
