// Outline geometry for the reader build: path collection, SVG path parsing (MathJax), cubic to
// quadratic conversion, affine transforms. All coordinates are plain numbers in em units.

/** One quadratic Bezier: x1 y1 (start), x2 y2 (control), x3 y3 (end). */
export type Quad = [number, number, number, number, number, number];
/** A closed contour of connected quads (quad[i] end == quad[i+1] start). */
export type Contour = Quad[];
export type Affine = [number, number, number, number, number, number]; // a b c d e f: x' = a x + c y + e

export const CUBIC_TOL = 1 / 4096; // em

export class PathBuilder {
	contours: Contour[] = [];
	private cur: Contour | null = null;
	private sx = 0; private sy = 0; private x = 0; private y = 0;

	moveTo(x: number, y: number) {
		this.close();
		this.sx = this.x = x;
		this.sy = this.y = y;
		this.cur = [];
	}
	lineTo(x: number, y: number) {
		if (!this.cur) this.moveTo(this.x, this.y);
		if (x === this.x && y === this.y) return;
		// Slug: a straight line is the quad {p1, p2, p2}.
		this.cur!.push([this.x, this.y, x, y, x, y]);
		this.x = x; this.y = y;
	}
	quadTo(cx: number, cy: number, x: number, y: number) {
		if (!this.cur) this.moveTo(this.x, this.y);
		this.cur!.push([this.x, this.y, cx, cy, x, y]);
		this.x = x; this.y = y;
	}
	cubicTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number) {
		if (!this.cur) this.moveTo(this.x, this.y);
		const p0x = this.x, p0y = this.y;
		// Max distance between a cubic and its best single quad is sqrt(3)/36 * |P3 - 3P2 + 3P1 - P0|;
		// splitting into n equal parts divides it by n^3.
		const dx = x - 3 * c2x + 3 * c1x - p0x, dy = y - 3 * c2y + 3 * c1y - p0y;
		const err = (Math.sqrt(3) / 36) * Math.hypot(dx, dy);
		const n = Math.max(1, Math.ceil(Math.cbrt(err / CUBIC_TOL)));
		let a: [number, number, number, number, number, number, number, number] = [p0x, p0y, c1x, c1y, c2x, c2y, x, y];
		for (let i = 0; i < n; i++) {
			// split off the first 1/(n-i) of the remaining cubic
			const t = 1 / (n - i);
			const [l, r] = splitCubic(a, t);
			const qx = (3 * (l[2] + l[4]) - (l[0] + l[6])) / 4;
			const qy = (3 * (l[3] + l[5]) - (l[1] + l[7])) / 4;
			this.cur!.push([l[0], l[1], qx, qy, l[6], l[7]]);
			a = r;
		}
		this.x = x; this.y = y;
	}
	close() {
		if (this.cur && this.cur.length) {
			if (Math.abs(this.x - this.sx) > 1e-9 || Math.abs(this.y - this.sy) > 1e-9) this.lineTo(this.sx, this.sy);
			this.contours.push(this.cur);
		}
		this.cur = null;
		this.x = this.sx; this.y = this.sy;
	}
	done(): Contour[] {
		this.close();
		return this.contours;
	}
}

type C8 = [number, number, number, number, number, number, number, number];
function splitCubic(c: C8, t: number): [C8, C8] {
	const lerp = (a: number, b: number) => a + (b - a) * t;
	const x01 = lerp(c[0], c[2]), y01 = lerp(c[1], c[3]);
	const x12 = lerp(c[2], c[4]), y12 = lerp(c[3], c[5]);
	const x23 = lerp(c[4], c[6]), y23 = lerp(c[5], c[7]);
	const x012 = lerp(x01, x12), y012 = lerp(y01, y12);
	const x123 = lerp(x12, x23), y123 = lerp(y12, y23);
	const xm = lerp(x012, x123), ym = lerp(y012, y123);
	return [
		[c[0], c[1], x01, y01, x012, y012, xm, ym],
		[xm, ym, x123, y123, x23, y23, c[6], c[7]]
	];
}

export function transformContours(cs: Contour[], m: Affine): Contour[] {
	const [a, b, c, d, e, f] = m;
	const tx = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f] as const;
	// a mirrored transform flips winding but Slug takes abs() of the winding, so no reversal needed
	return cs.map((ct) =>
		ct.map((q) => {
			const p1 = tx(q[0], q[1]), p2 = tx(q[2], q[3]), p3 = tx(q[4], q[5]);
			return [p1[0], p1[1], p2[0], p2[1], p3[0], p3[1]] as Quad;
		})
	);
}

export function mapContours(cs: Contour[], f: (v: number) => number): Contour[] {
	return cs.map((ct) => ct.map((q) => q.map(f) as Quad));
}

/** Parse an SVG path `d` (absolute and relative M L H V C S Q T Z; no arcs) into contours. */
export function parseSvgPath(d: string, scale = 1): Contour[] {
	const pb = new PathBuilder();
	const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
	let i = 0;
	let cmd = '';
	let cx = 0, cy = 0, sx = 0, sy = 0;
	let lcx = 0, lcy = 0, lastCmd = '';
	const num = () => {
		const v = Number(toks[i++]);
		if (Number.isNaN(v)) throw new Error(`svg path: bad number in "${d.slice(0, 60)}"`);
		return v * scale;
	};
	while (i < toks.length) {
		if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
		else if (cmd === 'M') cmd = 'L';
		else if (cmd === 'm') cmd = 'l';
		const rel = cmd === cmd.toLowerCase();
		const C = cmd.toUpperCase();
		const ox = rel ? cx : 0, oy = rel ? cy : 0;
		switch (C) {
			case 'M': { const x = num() + ox, y = num() + oy; pb.moveTo(x, y); cx = sx = x; cy = sy = y; break; }
			case 'L': { const x = num() + ox, y = num() + oy; pb.lineTo(x, y); cx = x; cy = y; break; }
			case 'H': { const x = num() + ox; pb.lineTo(x, cy); cx = x; break; }
			case 'V': { const y = num() + oy; pb.lineTo(cx, y); cy = y; break; }
			case 'C': {
				const x1 = num() + ox, y1 = num() + oy, x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
				pb.cubicTo(x1, y1, x2, y2, x, y); lcx = x2; lcy = y2; cx = x; cy = y; break;
			}
			case 'S': {
				const [r1x, r1y] = lastCmd === 'C' || lastCmd === 'S' ? [2 * cx - lcx, 2 * cy - lcy] : [cx, cy];
				const x2 = num() + ox, y2 = num() + oy, x = num() + ox, y = num() + oy;
				pb.cubicTo(r1x, r1y, x2, y2, x, y); lcx = x2; lcy = y2; cx = x; cy = y; break;
			}
			case 'Q': {
				const x1 = num() + ox, y1 = num() + oy, x = num() + ox, y = num() + oy;
				pb.quadTo(x1, y1, x, y); lcx = x1; lcy = y1; cx = x; cy = y; break;
			}
			case 'T': {
				const [r1x, r1y] = lastCmd === 'Q' || lastCmd === 'T' ? [2 * cx - lcx, 2 * cy - lcy] : [cx, cy];
				const x = num() + ox, y = num() + oy;
				pb.quadTo(r1x, r1y, x, y); lcx = r1x; lcy = r1y; cx = x; cy = y; break;
			}
			case 'Z': pb.close(); cx = sx; cy = sy; break;
			default: throw new Error(`svg path: unsupported command ${cmd}`);
		}
		lastCmd = C;
	}
	return pb.done();
}

/** Flatten to polygons (for ink area and for independent reference tests). */
export function flatten(cs: Contour[], steps = 8): [number, number][][] {
	return cs.map((ct) => {
		const pts: [number, number][] = [];
		for (const q of ct) {
			for (let s = 0; s < steps; s++) {
				const t = s / steps, u = 1 - t;
				pts.push([u * u * q[0] + 2 * u * t * q[2] + t * t * q[4], u * u * q[1] + 2 * u * t * q[3] + t * t * q[5]]);
			}
		}
		return pts;
	});
}

export function inkArea(cs: Contour[]): number {
	let area = 0;
	for (const poly of flatten(cs, 8)) {
		let a = 0;
		for (let i = 0; i < poly.length; i++) {
			const p = poly[i], q = poly[(i + 1) % poly.length];
			a += p[0] * q[1] - q[0] * p[1];
		}
		area += a / 2;
	}
	return Math.abs(area);
}
