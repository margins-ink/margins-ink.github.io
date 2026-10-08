// Icon pipeline: bun scripts/icons/build.ts <name>... [--src <iconify collection json>]
// Reads Iconify icons (default: Material Icon Theme, MIT, node_modules/@iconify/json) and turns every filled shape into triangles (earcut),
// so a multi-colour file-type icon is drawn by the page pass as plain overlay triangles (shape 8 in page.wgsl.ts), at any size, with no atlas.
// Emits src/lib/reading/icons.gen.ts (the triangles, read by exhibit.ts) and world/src/museum/icons_gen.rs (the names in id order, read by icons.rs).
// Add a name to ICON_NAMES below (or pass names on the command line) and rerun: the Rust ids and the TS table cannot drift because both come from this run.
import earcut from 'earcut';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** The icons the site uses; `bun scripts/icons/build.ts` with no names builds exactly these. Order = icon id. */
export const ICON_NAMES = ['rust', 'toml'] as const;

export interface BuiltIcon {
	name: string;
	/** sRGB 0..1 per colour */
	colours: [number, number, number][];
	/** triangles x0 y0 x1 y1 x2 y2 in 0..1 icon space (y down) */
	tris: number[];
	/** colour index per triangle */
	ci: number[];
	/** ring area (sum of |area|, holes subtracted) in 0..1 space, for the tests */
	area: number;
}

type Pt = [number, number];

// ---- SVG path -> rings --------------------------------------------------------------------------------------------

function arcToPoints(x1: number, y1: number, rx: number, ry: number, phiDeg: number, fa: number, fs: number, x2: number, y2: number): Pt[] {
	if (rx === 0 || ry === 0) return [[x2, y2]];
	rx = Math.abs(rx); ry = Math.abs(ry);
	const phi = (phiDeg * Math.PI) / 180, c = Math.cos(phi), s = Math.sin(phi);
	const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
	const x1p = c * dx + s * dy, y1p = -s * dx + c * dy;
	const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	const co = (fa === fs ? -1 : 1) * Math.sqrt(Math.max(0, num / den));
	const cxp = (co * rx * y1p) / ry, cyp = (-co * ry * x1p) / rx;
	const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2;
	const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const th1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let dth = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!fs && dth > 0) dth -= 2 * Math.PI;
	if (fs && dth < 0) dth += 2 * Math.PI;
	const n = Math.max(2, Math.ceil(Math.abs(dth) / (Math.PI / 10)));
	const out: Pt[] = [];
	for (let i = 1; i <= n; i++) {
		const t = th1 + (dth * i) / n;
		const px = rx * Math.cos(t), py = ry * Math.sin(t);
		out.push([c * px - s * py + cx, s * px + c * py + cy]);
	}
	out[out.length - 1] = [x2, y2];
	return out;
}

function pathToRings(d: string): Pt[][] {
	const toks = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
	const rings: Pt[][] = [];
	let ring: Pt[] = [], cx = 0, cy = 0, sx = 0, sy = 0, i = 0, cmd = '', lastC: Pt | null = null, lastQ: Pt | null = null;
	const num = () => { const v = Number(toks[i++]); if (!Number.isFinite(v)) throw new Error(`path: bad number near token ${i} of ${d.slice(0, 40)}`); return v; };
	const flag = () => { const t = toks[i]; if (t.length > 1 && /^[01]/.test(t) && !t.includes('.')) { toks[i] = t.slice(1); return Number(t[0]); } i++; return Number(t); };
	const close = () => { if (ring.length > 2) rings.push(ring); ring = []; };
	const cubic = (x1: number, y1: number, x2: number, y2: number, x: number, y: number) => {
		const len = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
		const n = Math.min(10, Math.max(2, Math.ceil(Math.sqrt(len) * 1.1)));
		for (let k = 1; k <= n; k++) {
			const t = k / n, m = 1 - t;
			ring.push([m * m * m * cx + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x, m * m * m * cy + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y]);
		}
		lastC = [x2, y2]; cx = x; cy = y;
	};
	while (i < toks.length) {
		if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
		const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
		const ox = rel ? cx : 0, oy = rel ? cy : 0;
		if (C !== 'C' && C !== 'S') lastC = null;
		if (C !== 'Q' && C !== 'T') lastQ = null;
		switch (C) {
			case 'M': close(); cx = num() + ox; cy = num() + oy; sx = cx; sy = cy; ring = [[cx, cy]]; cmd = rel ? 'l' : 'L'; break;
			case 'L': cx = num() + ox; cy = num() + oy; ring.push([cx, cy]); break;
			case 'H': cx = num() + (rel ? cx : 0); ring.push([cx, cy]); break;
			case 'V': cy = num() + (rel ? cy : 0); ring.push([cx, cy]); break;
			case 'C': { const a = num() + ox, b = num() + oy, c2 = num() + ox, d2 = num() + oy, x = num() + ox, y = num() + oy; cubic(a, b, c2, d2, x, y); break; }
			case 'S': { const r: Pt = lastC ? [2 * cx - lastC[0], 2 * cy - lastC[1]] : [cx, cy]; const c2 = num() + ox, d2 = num() + oy, x = num() + ox, y = num() + oy; cubic(r[0], r[1], c2, d2, x, y); break; }
			case 'Q': case 'T': {
				let qx: number, qy: number;
				if (C === 'Q') { qx = num() + ox; qy = num() + oy; } else { const r: Pt = lastQ ? [2 * cx - lastQ[0], 2 * cy - lastQ[1]] : [cx, cy]; [qx, qy] = r; }
				const x = num() + ox, y = num() + oy;
				cubic(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), x + (2 / 3) * (qx - x), y + (2 / 3) * (qy - y), x, y);
				lastQ = [qx, qy];
				break;
			}
			case 'A': { const rx = num(), ry = num(), rot = num(), fa = flag(), fs = flag(), x = num() + ox, y = num() + oy; for (const p of arcToPoints(cx, cy, rx, ry, rot, fa, fs, x, y)) ring.push(p); cx = x; cy = y; break; }
			case 'Z': ring.push([sx, sy]); close(); cx = sx; cy = sy; break;
			default: throw new Error(`path: unsupported command ${cmd}`);
		}
	}
	close();
	return rings.map((r) => (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1] ? r.slice(0, -1) : r));
}

const signedArea = (r: Pt[]) => { let a = 0; for (let i = 0; i < r.length; i++) { const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length]; a += x0 * y1 - x1 * y0; } return a / 2; };
function inside(p: Pt, r: Pt[]): boolean {
	let c = false;
	for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
		const [xi, yi] = r[i], [xj, yj] = r[j];
		if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
	}
	return c;
}

/** Even-odd nesting: a ring with an odd number of containers is a hole of the smallest one. Returns [outer, holes[]] groups. */
function groupRings(rings: Pt[][]): { outer: Pt[]; holes: Pt[][] }[] {
	const order = rings.map((r, i) => i).sort((a, b) => Math.abs(signedArea(rings[b])) - Math.abs(signedArea(rings[a])));
	const depth = new Map<number, number>(), parent = new Map<number, number>();
	for (const i of order) {
		const containers = order.filter((j) => j !== i && Math.abs(signedArea(rings[j])) > Math.abs(signedArea(rings[i])) && inside(rings[i][0], rings[j]));
		depth.set(i, containers.length);
		if (containers.length) parent.set(i, containers[containers.length - 1]);
	}
	const groups = new Map<number, { outer: Pt[]; holes: Pt[][] }>();
	for (const i of order) if ((depth.get(i) ?? 0) % 2 === 0) groups.set(i, { outer: rings[i], holes: [] });
	for (const i of order) if ((depth.get(i) ?? 0) % 2 === 1) groups.get(parent.get(i)!)?.holes.push(rings[i]);
	return [...groups.values()];
}

// ---- icon body -> triangles ------------------------------------------------------------------------------------------

function hexRgb(h: string): [number, number, number] {
	const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(h.trim());
	if (!m) throw new Error(`unsupported fill ${h}`);
	const s = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
	return [0, 2, 4].map((k) => Math.round((parseInt(s.slice(k, k + 2), 16) / 255) * 1000) / 1000) as [number, number, number];
}
const attr = (a: string, n: string) => new RegExp(`(?:^|\\s)${n}="([^"]*)"`).exec(a)?.[1];
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function buildIcon(name: string, body: string, size: number): BuiltIcon {
	if (/transform=|<use|<mask|<clipPath|<linearGradient|stroke=/.test(body)) throw new Error(`${name}: transform, use, mask, gradient and stroke are not supported`);
	const colours: [number, number, number][] = [];
	const tris: number[] = [], ci: number[] = [];
	let area = 0;
	for (const m of body.matchAll(/<(path|rect|circle|ellipse|polygon)\b([^>]*?)\/?>/g)) {
		const [, tag, a] = m;
		const fill = attr(a, 'fill') ?? '#000';
		if (fill === 'none') continue;
		const col = hexRgb(fill);
		let k = colours.findIndex((c) => c.every((v, j) => v === col[j]));
		if (k < 0) k = colours.push(col) - 1;
		let rings: Pt[][];
		const n = (key: string) => Number(attr(a, key) ?? 0);
		if (tag === 'path') rings = pathToRings(attr(a, 'd') ?? '');
		else if (tag === 'rect') { const [x, y, w, h] = [n('x'), n('y'), n('width'), n('height')]; rings = [[[x, y], [x + w, y], [x + w, y + h], [x, y + h]]]; }
		else if (tag === 'polygon') { const v = (attr(a, 'points') ?? '').trim().split(/[\s,]+/).map(Number); rings = [Array.from({ length: v.length / 2 }, (_, i) => [v[2 * i], v[2 * i + 1]] as Pt)]; }
		else { const rx = tag === 'circle' ? n('r') : n('rx'), ry = tag === 'circle' ? n('r') : n('ry'); rings = [Array.from({ length: 28 }, (_, i) => [n('cx') + rx * Math.cos((i * 2 * Math.PI) / 28), n('cy') + ry * Math.sin((i * 2 * Math.PI) / 28)] as Pt)]; }
		for (const g of groupRings(rings)) {
			const flat: number[] = [];
			const holeIdx: number[] = [];
			for (const p of g.outer) flat.push(p[0], p[1]);
			for (const h of g.holes) { holeIdx.push(flat.length / 2); for (const p of h) flat.push(p[0], p[1]); }
			const idx = earcut(flat, holeIdx);
			for (let t = 0; t < idx.length; t++) tris.push(r3(flat[idx[t] * 2] / size), r3(flat[idx[t] * 2 + 1] / size));
			for (let t = 0; t < idx.length / 3; t++) ci.push(k);
			area += (Math.abs(signedArea(g.outer)) - g.holes.reduce((s, h) => s + Math.abs(signedArea(h)), 0)) / (size * size);
		}
	}
	if (!tris.length) throw new Error(`${name}: no fillable shapes`);
	return { name, colours, tris, ci, area };
}

export function buildAll(names: readonly string[], srcPath: string): BuiltIcon[] {
	const col = JSON.parse(readFileSync(srcPath, 'utf8')) as { icons: Record<string, { body: string; width?: number; height?: number }>; width?: number; height?: number };
	return names.map((n) => {
		const ic = col.icons[n];
		if (!ic) throw new Error(`icon ${n} is not in ${srcPath}`);
		const w = ic.width ?? col.width ?? 16, h = ic.height ?? col.height ?? w;
		if (w !== h) throw new Error(`${n}: non-square icon ${w}x${h}`);
		return buildIcon(n, ic.body, w);
	});
}

export function emitTs(icons: BuiltIcon[], srcNote: string): string {
	const rows = icons.map((i) => `\t{ name: ${JSON.stringify(i.name)}, colours: ${JSON.stringify(i.colours)}, ci: ${JSON.stringify(i.ci)}, tris: [${i.tris.join(',')}] }`);
	return `// GENERATED by scripts/icons/build.ts (${srcNote}). Do not edit. Triangles in 0..1 icon space, y down; colours are sRGB 0..1.
// Icons: Material Icon Theme (MIT), docs/upstream/icons/SOURCE.md.
export interface FileIcon { name: string; colours: [number, number, number][]; ci: number[]; tris: number[] }
export const FILE_ICONS: readonly FileIcon[] = [
${rows.join(',\n')}
];
`;
}

export function emitRust(icons: BuiltIcon[]): string {
	return `// GENERATED by scripts/icons/build.ts. Do not edit. The file-type icons the page pass can draw (draw shape ICON, aux = index here); the triangles
// live in src/lib/reading/icons.gen.ts from the same run, so the two cannot drift.
pub const FILE_ICONS: &[&str] = &[${icons.map((i) => JSON.stringify(i.name)).join(', ')}];
`;
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const si = args.indexOf('--src');
	const src = si >= 0 ? args.splice(si, 2)[1] : resolve(import.meta.dir, '../../node_modules/@iconify/json/json/material-icon-theme.json');
	const names = args.length ? args : [...ICON_NAMES];
	const icons = buildAll(names, src);
	const root = resolve(import.meta.dir, '../..');
	writeFileSync(resolve(root, 'src/lib/reading/icons.gen.ts'), emitTs(icons, `source ${src.replace(root + '/', '')}`));
	writeFileSync(resolve(root, 'world/src/museum/icons_gen.rs'), emitRust(icons));
	for (const i of icons) console.log(`${i.name}: ${i.tris.length / 6} triangles, ${i.colours.length} colours`);
}
