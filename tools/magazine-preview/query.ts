// Preview page query string (docs/MAGAZINE.md section 7):
//   ?slug=ifd&spread=3&class=wide&dark=1&t=poster|4.2&zoom=2&grid=1&frames=1&layer=distilled
//   &variants=duo,solo,compare   one sheet, same spread in N templates
//   &fig=eval-timeline&t=3.0&play=1&sheet=0,3,6,9,12   figure tuning (needs the fig and shader lanes, see main.ts)
//   &gutter=1&bow=1              flat stand-ins for the gutter shadow and bow gradient
export interface Query {
	slug: string;
	spread: number;
	cls: 'wide' | 'narrow';
	dark: boolean | null; // null: follow the OS
	t: 'poster' | number;
	zoom: number;
	grid: boolean;
	frames: boolean;
	layer: 'distilled' | 'full';
	variants: string[];
	fig: string | null;
	play: boolean;
	sheet: number[];
	gutter: boolean;
	bow: boolean;
	tone: boolean;
}

const TEMPLATES = ['duo', 'solo', 'compare', 'numerals', 'text', 'text-code'];

export function parseQuery(search: string): Query {
	const q = new URLSearchParams(search);
	const num = (k: string, d: number, lo: number, hi: number) => {
		const v = q.get(k);
		if (v === null || v === '') return d;
		const n = Number(v);
		if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`query: ${k}=${v} outside [${lo}, ${hi}]`);
		return n;
	};
	const flag = (k: string) => q.get(k) === '1';
	const cls = q.get('class') ?? 'wide';
	if (cls !== 'wide' && cls !== 'narrow') throw new Error(`query: class=${cls}`);
	const layer = q.get('layer') ?? 'distilled'; // the default view is the distilled spread (section 8, preview lane)
	if (layer !== 'distilled' && layer !== 'full') throw new Error(`query: layer=${layer}`);
	const tq = q.get('t') ?? 'poster';
	const t = tq === 'poster' ? 'poster' : Number(tq);
	if (t !== 'poster' && !(Number.isFinite(t) && t >= 0)) throw new Error(`query: t=${tq}`);
	const variants = (q.get('variants') ?? '').split(',').filter(Boolean);
	for (const v of variants) if (!TEMPLATES.includes(v)) throw new Error(`query: unknown template "${v}" in variants (known: ${TEMPLATES.join(', ')})`);
	if (variants.length > 12) throw new Error('query: at most 12 variants');
	const dark = q.get('dark');
	return {
		slug: q.get('slug') ?? 'ifd',
		spread: Math.floor(num('spread', 0, 0, 9999)),
		cls,
		dark: dark === null ? null : dark === '1',
		t,
		zoom: num('zoom', 1, 0.25, 12),
		grid: flag('grid'),
		frames: flag('frames'),
		layer,
		variants,
		fig: q.get('fig'),
		play: flag('play'),
		sheet: (q.get('sheet') ?? '').split(',').filter(Boolean).map(Number).filter(Number.isFinite),
		gutter: flag('gutter'),
		bow: flag('bow'),
		tone: flag('tone')
	};
}

/** Cells (columns x rows) of the variant sheet for n panels: near-square, at most 4 columns. */
export function sheetGrid(n: number): { cols: number; rows: number } {
	const cols = Math.min(4, Math.max(1, Math.ceil(Math.sqrt(n))));
	return { cols, rows: Math.ceil(n / cols) };
}

/** Viewport rectangle of panel i in a canvas of w x h px with a 12 px gap. */
export function panelRect(i: number, n: number, w: number, h: number, gap = 12): [number, number, number, number] {
	const { cols, rows } = sheetGrid(n);
	const pw = (w - gap * (cols + 1)) / cols, ph = (h - gap * (rows + 1)) / rows;
	const cx = i % cols, cy = Math.floor(i / cols);
	return [gap + cx * (pw + gap), gap + cy * (ph + gap), pw, ph];
}

/** Fit a spread of sw x sh em into a viewport of vw x vh px at `zoom`; returns px per em and the em at the top-left. */
export function fit(sw: number, sh: number, vw: number, vh: number, zoom: number): { ppe: number; x0: number; y0: number } {
	const ppe = Math.min(vw / sw, vh / sh) * zoom;
	return { ppe, x0: sw / 2 - vw / ppe / 2, y0: sh / 2 - vh / ppe / 2 };
}
