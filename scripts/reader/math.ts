// Stage 2, step 5: TeX -> positioned quadratic glyph objects with MathJax 4 (SVG output, fontCache
// 'none', so every <path> is self-contained). The SVG is flattened to the same quadratic form as text
// glyphs: each distinct path (with its linear transform baked in) becomes one glyph in the article's
// extra table; instances are placed glyph records, fraction bars and radicals are rects.
import { mathjax } from '@mathjax/src/js/mathjax.js';
import { TeX } from '@mathjax/src/js/input/tex.js';
import { SVG } from '@mathjax/src/js/output/svg.js';
import { liteAdaptor } from '@mathjax/src/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from '@mathjax/src/js/handlers/html.js';
import '@mathjax/src/js/input/tex/base/BaseConfiguration.js';
import '@mathjax/src/js/input/tex/ams/AmsConfiguration.js';
import '@mathjax/src/js/input/tex/newcommand/NewcommandConfiguration.js';
import '@mathjax/src/js/input/tex/noundefined/NoUndefinedConfiguration.js';
import { type Affine, type Contour, parseSvgPath, transformContours } from './geom';

export interface MathGlyph { key: string; contours: Contour[]; x: number; y: number }
export interface MathRect { x0: number; y0: number; x1: number; y1: number }
export interface MathObj {
	tex: string;
	width: number; // em
	ascent: number; // em above the baseline
	descent: number; // em below the baseline
	glyphs: MathGlyph[]; // y up, relative to the baseline origin
	rects: MathRect[];
}

let doc: any, adaptor: any;
function init() {
	if (doc) return;
	adaptor = liteAdaptor();
	RegisterHTMLHandler(adaptor);
	doc = mathjax.document('', {
		InputJax: new TeX({ packages: ['base', 'ams', 'newcommand'] }),
		OutputJax: new SVG({ fontCache: 'none' })
	});
}

const mul = (p: Affine, c: Affine): Affine => [
	p[0] * c[0] + p[2] * c[1], p[1] * c[0] + p[3] * c[1],
	p[0] * c[2] + p[2] * c[3], p[1] * c[2] + p[3] * c[3],
	p[0] * c[4] + p[2] * c[5] + p[4], p[1] * c[4] + p[3] * c[5] + p[5]
];

function parseTransform(s: string | undefined, tex: string): Affine {
	let m: Affine = [1, 0, 0, 1, 0, 0];
	if (!s) return m;
	for (const t of s.matchAll(/(\w+)\(([^)]*)\)/g)) {
		const v = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
		let c: Affine;
		if (t[1] === 'translate') c = [1, 0, 0, 1, v[0], v[1] ?? 0];
		else if (t[1] === 'scale') c = [v[0], 0, 0, v[1] ?? v[0], 0, 0];
		else if (t[1] === 'matrix') c = v as Affine;
		else throw new Error(`math "${tex}": unsupported svg transform ${t[1]}`);
		m = mul(m, c);
	}
	return m;
}

const attr = (s: string, name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(s)?.[1];

const cache = new Map<string, MathObj>();

export function mathObject(tex: string, display: boolean): MathObj {
	const key = (display ? 'D:' : 'I:') + tex;
	const hit = cache.get(key);
	if (hit) return hit;
	init();
	const node = doc.convert(tex, { display });
	const html: string = adaptor.outerHTML(node);
	if (/data-mjx-error|merror/.test(html)) throw new Error(`math "${tex}": MathJax reported a TeX error`);
	const svgOpen = /<svg\b[^>]*>/.exec(html);
	if (!svgOpen) throw new Error(`math "${tex}": no svg in MathJax output`);
	const vb = attr(svgOpen[0], 'viewBox')!.split(/\s+/).map(Number);
	const [minX, minY, vw, vh] = vb;
	const obj: MathObj = { tex, width: vw / 1000, ascent: -minY / 1000, descent: (minY + vh) / 1000, glyphs: [], rects: [] };

	const stack: Affine[] = [[1, 0, 0, 1, 0, 0]];
	const body = html.slice(svgOpen.index! + svgOpen[0].length);
	for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g)) {
		const [, close, tag, rest, self] = m;
		if (close) { if (tag === 'g') stack.pop(); continue; }
		const cur = stack[stack.length - 1];
		if (tag === 'g') {
			const sw = attr(rest, 'stroke-width');
			if (sw && Number(sw) !== 0) throw new Error(`math "${tex}": stroked group unsupported`);
			stack.push(mul(cur, parseTransform(attr(rest, 'transform'), tex)));
			if (self) stack.pop();
		} else if (tag === 'path') {
			const t = mul(cur, parseTransform(attr(rest, 'transform'), tex));
			const d = attr(rest, 'd')!;
			const sw = attr(rest, 'stroke-width');
			if (sw && Number(sw) !== 0) throw new Error(`math "${tex}": stroked path unsupported`);
			// glyph-local shape: linear part with y flipped to y-up, in em; instance origin from the translation
			const lin: Affine = [t[0] / 1000, -t[1] / 1000, t[2] / 1000, -t[3] / 1000, 0, 0];
			// x' = (a x + c y)/1000 ; y_up = -(b x + d y)/1000
			const contours = transformContours(parseSvgPath(d), [lin[0], lin[1], lin[2], lin[3], 0, 0]);
			const gkey = `${d}|${t.slice(0, 4).map((v) => v.toFixed(5)).join(',')}`;
			obj.glyphs.push({ key: gkey, contours, x: (t[4] - minX) / 1000, y: -t[5] / 1000 });
		} else if (tag === 'rect') {
			const t = mul(cur, parseTransform(attr(rest, 'transform'), tex));
			const x = Number(attr(rest, 'x') ?? 0), y = Number(attr(rest, 'y') ?? 0), w = Number(attr(rest, 'width')), h = Number(attr(rest, 'height'));
			if (t[1] !== 0 || t[2] !== 0) throw new Error(`math "${tex}": rotated rect unsupported`);
			const xa = (t[0] * x + t[4] - minX) / 1000, xb = (t[0] * (x + w) + t[4] - minX) / 1000;
			const ya = -(t[3] * y + t[5]) / 1000, yb = -(t[3] * (y + h) + t[5]) / 1000;
			obj.rects.push({ x0: Math.min(xa, xb), x1: Math.max(xa, xb), y0: Math.min(ya, yb), y1: Math.max(ya, yb) });
		} else if (['svg', 'defs', 'title', 'desc', 'mjx-container'].includes(tag)) {
			// metadata only
		} else if (tag === 'use' || tag === 'text' || tag === 'image' || tag === 'foreignObject' || tag === 'line' || tag === 'polyline') {
			throw new Error(`math "${tex}": unsupported svg element <${tag}>`);
		}
	}
	if (!obj.glyphs.length && !obj.rects.length) throw new Error(`math "${tex}": produced no geometry`);
	cache.set(key, obj);
	return obj;
}
