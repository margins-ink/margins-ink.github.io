// Stage 1: font instances, outline extraction (harfbuzzjs), and the Slug band builder.
// Variable fonts are instanced with hb_font_set_variations (identical result to a static instance, no
// fonttools step). Only glyphs actually used across the corpus are emitted (GlyphTableBuilder is
// filled on demand by layout, then finish() writes the union table).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from 'harfbuzzjs';
import { BAND_EPS, CONTOUR_END, roundF16, toF16, type FontInfo, type GlyphTable } from '../../src/lib/reader/format';
import { inkArea, mapContours, PathBuilder, type Contour } from './geom';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FONT_DIR = path.join(ROOT, 'docs/upstream/reader/fonts'); // Fira Code, Noto Emoji (and the retired Newsreader files)
export const MAG_FONT_DIR = path.join(ROOT, 'docs/upstream/magazine/fonts'); // Inter, Instrument Sans (MAGAZINE.md 3.1)

/** Commercial fonts (Berkeley Mono): gitignored, never committed, copied here by hand (docs/upstream/magazine/SOURCE.md, open item). */
export const PRIVATE_FONT_DIR = path.join(ROOT, 'fonts-private');

/** Absolute path of a font file: private dir, then the magazine dir, then the reader dir. */
export function fontPath(file: string): string {
	for (const d of [PRIVATE_FONT_DIR, MAG_FONT_DIR]) {
		const m = path.join(d, file);
		if (fs.existsSync(m)) return m;
	}
	return path.join(FONT_DIR, file);
}

/**
 * The monospace family slot. ONE line to swap: change `MONO_FAMILY`. Berkeley Mono is commercial and lives in the gitignored
 * fonts-private/ dir; when its files are absent (CI, a fresh clone) the slot falls back to Fira Code (OFL, vendored) with a warning,
 * and a build that must be Berkeley passes MAGAZINE_REQUIRE_BERKELEY=1. Both shape ligatures through `calt`.
 */
export const MONO_FAMILY: 'berkeley' | 'fira' = 'berkeley';
const MONO_FILES = {
	berkeley: { name: 'Berkeley Mono', regular: 'BerkeleyMono-Regular.otf', bold: 'BerkeleyMono-Bold.otf', variations: [{}, {}] as Record<string, number>[], features: ['kern', 'liga', 'calt', 'clig'] },
	fira: { name: 'Fira Code', regular: 'FiraCode.ttf', bold: 'FiraCode.ttf', variations: [{ wght: 400 }, { wght: 500 }] as Record<string, number>[], features: ['kern', 'liga', 'calt', 'clig'] }
};
function monoFamily() {
	if (MONO_FAMILY === 'fira') return MONO_FILES.fira;
	const f = MONO_FILES.berkeley;
	if (fs.existsSync(path.join(PRIVATE_FONT_DIR, f.regular)) && fs.existsSync(path.join(PRIVATE_FONT_DIR, f.bold))) return f;
	if (process.env.MAGAZINE_REQUIRE_BERKELEY) throw new Error(`Berkeley Mono missing from ${PRIVATE_FONT_DIR}`);
	console.warn(`[fonts] ${f.name} not in ${PRIVATE_FONT_DIR}: falling back to ${MONO_FILES.fira.name}`);
	return MONO_FILES.fira;
}
export const MONO = monoFamily();

export interface FontSpec {
	name: string;
	file: string;
	variations: Record<string, number>;
	features: string[]; // OpenType features switched on (value 1)
	/** also usable as an opentype.js reference when the variations equal the font defaults */
	defaultInstance: boolean;
	/** the font declares programming ligatures (liga/calt); the build checks the sequences in LIGATURE_TESTS really substitute */
	ligatures?: boolean;
}

/** Sequences every ligature font must substitute (the build fails if one shapes to the same glyphs with the features off). */
export const LIGATURE_TESTS = ['=>', '->', '!=', '==', '<=', '::'];

// One sans family (MAGAZINE.md direction 2026-10-06): Inter for body and UI, Instrument Sans for display.
// Inter opsz 14 is the axis default (and what CSS opsz:auto gives at reading size). Inter has no `liga`
// feature (its ligature-like substitutions are `calt`); Instrument Sans has `liga` and no `calt`; both have
// `kern` and `tnum` (read from GSUB/GPOS on 2026-10-06). Features a face lacks are ignored by harfbuzz.
const INTER = ['kern', 'calt'];
export const FONT_SPECS: FontSpec[] = [
	{ name: 'Inter 400', file: 'Inter.ttf', variations: { wght: 400, opsz: 14 }, features: INTER, defaultInstance: true },
	{ name: 'Inter Italic 400', file: 'Inter-Italic.ttf', variations: { wght: 400, opsz: 14 }, features: INTER, defaultInstance: true },
	{ name: 'Inter 600', file: 'Inter.ttf', variations: { wght: 600, opsz: 14 }, features: INTER, defaultInstance: false },
	{ name: 'Inter 500', file: 'Inter.ttf', variations: { wght: 500, opsz: 14 }, features: INTER, defaultInstance: false },
	{ name: `${MONO.name} 400`, file: MONO.regular, variations: MONO.variations[0], features: MONO.features, defaultInstance: false, ligatures: true },
	{ name: `${MONO.name} bold`, file: MONO.bold, variations: MONO.variations[1], features: MONO.features, defaultInstance: false, ligatures: true },
	{ name: 'Noto Emoji 400', file: 'NotoEmoji.ttf', variations: { wght: 400 }, features: ['kern'], defaultInstance: false },
	{ name: 'Instrument Sans wdth 80 wght 600', file: 'InstrumentSans.ttf', variations: { wdth: 80, wght: 600 }, features: ['kern', 'liga'], defaultInstance: false },
	// coverage fallback for glyphs the mono family lacks (box drawing, maths): Fira Code is OFL, vendored, and has the same 0.6 em advance as Berkeley Mono
	{ name: 'Fira Code 400', file: 'FiraCode.ttf', variations: { wght: 400 }, features: ['kern'], defaultInstance: false },
	// section headings (h2): Inter 600 at its display optical size, tracking 0, never the condensed Instrument Sans axis (that voice is the hero's)
	{ name: 'Inter 600 opsz 28', file: 'Inter.ttf', variations: { wght: 600, opsz: 28 }, features: INTER, defaultInstance: false },
	// article title: Inter 600 at its largest optical size (tight built-in spacing), the Apple-style headline
	{ name: 'Inter 650 opsz 32', file: 'Inter.ttf', variations: { wght: 650, opsz: 32 }, features: INTER, defaultInstance: false }
];
// Indices into FONT_SPECS. `sans` is the label face (Inter 500); `display` is the default display instance;
// per-article display instances are appended by FontSet.display().
export const F = { body: 0, italic: 1, bold: 2, sans: 3, code: 4, codeBold: 5, emoji: 6, display: 7, fallback: 8, head: 9, title: 10 } as const;
/** Template font roles (src/lib/magazine/types.ts FontRole) to font index; display roles use FontSet.display(). */
export const ROLE_FONT = { body: F.body, label: F.sans, code: F.code, display: F.display, pullquote: F.display, numeral: F.display } as const;
/** Instrument Sans axis limits (METADATA.pb read 2026-10-06). */
export const DISPLAY_AXES = { wdth: [75, 100], wght: [400, 700] } as const;
/** Fonts tried, in order, for a character the run's own font lacks. */
const FALLBACKS = [F.code, F.fallback, F.emoji];

export interface Shaped {
	gid: number;
	cluster: number; // UTF-16 index into the shaped string
	xAdvance: number; // em
	xOffset: number;
	yOffset: number;
}

export class LoadedFont {
	face: hb.Face;
	font: hb.Font;
	upem: number;
	features: hb.Feature[];
	info: FontInfo;
	private outlines = new Map<number, Contour[]>();
	private drawFuncs: hb.DrawFuncs;
	private pb: PathBuilder | null = null;

	constructor(public spec: FontSpec) {
		const bytes = fs.readFileSync(fontPath(spec.file));
		this.face = new hb.Face(new hb.Blob(bytes));
		this.font = new hb.Font(this.face);
		this.upem = this.face.upem;
		this.font.setVariations(Object.entries(spec.variations).map(([k, v]) => new hb.Variation(k, v)));
		this.features = spec.features.map((f) => new hb.Feature(f, 1));
		const ext = this.font.hExtents();
		const os2 = this.face.referenceTable('OS/2');
		let cap = 0.7, xh = 0.5;
		if (os2 && os2.length >= 90) {
			const dv = new DataView(os2.buffer, os2.byteOffset, os2.byteLength);
			if (dv.getUint16(0) >= 2) { xh = dv.getInt16(86) / this.upem; cap = dv.getInt16(88) / this.upem; }
		}
		this.info = { name: spec.name, upem: this.upem, ascender: ext.ascender / this.upem, descender: ext.descender / this.upem, capHeight: cap, xHeight: xh };
		const df = new hb.DrawFuncs();
		const u = this.upem;
		df.setMoveToFunc((x, y) => this.pb!.moveTo(x / u, y / u));
		df.setLineToFunc((x, y) => this.pb!.lineTo(x / u, y / u));
		df.setQuadraticToFunc((cx, cy, x, y) => this.pb!.quadTo(cx / u, cy / u, x / u, y / u));
		df.setCubicToFunc((a, b, c, d, x, y) => this.pb!.cubicTo(a / u, b / u, c / u, d / u, x / u, y / u));
		df.setClosePathFunc(() => this.pb!.close());
		this.drawFuncs = df;
	}

	/** Shape `text` (one style run). Returns glyphs in visual order with advances in em. */
	shape(text: string, extraFeatures: string[] = [], disable: string[] = []): Shaped[] {
		const buf = new hb.Buffer();
		buf.addText(text);
		buf.guessSegmentProperties();
		buf.setClusterLevel(1 as any); // monotone graphemes: clusters stay at char granularity
		// a disabled tag is set to 0 (not dropped): harfbuzz switches liga, calt and clig on by default
		const feats = [...this.features.filter((f) => !disable.includes(f.tag)), ...disable.map((t) => new hb.Feature(t, 0)), ...extraFeatures.map((t) => new hb.Feature(t, 1))];
		hb.shape(this.font, buf, feats);
		const infos = buf.getGlyphInfos();
		const pos = buf.getGlyphPositions();
		const out = infos.map((g, i) => ({
			gid: g.codepoint, cluster: g.cluster, xAdvance: pos[i].xAdvance / this.upem, xOffset: pos[i].xOffset / this.upem, yOffset: pos[i].yOffset / this.upem
		}));
		buf.destroy?.();
		return out;
	}

	/**
	 * Shape source code: like `shape`, but `::` stays two separate plain colons (Rust paths read as `a::b`, not as the font's merged two-cell glyph).
	 * Each colon of a `::` is shaped alone (a colon next to `<` or another colon would otherwise still pick the ligature form, e.g. `::<T>`), the
	 * text between pairs is shaped as one piece, so `->`, `=>`, `!=`, `<=`, `>=` and the rest are drawn as the font draws them. Clusters are offset
	 * back into `text`. Fonts without ligatures shape in one call.
	 */
	shapeCode(text: string): Shaped[] {
		if (!this.spec.ligatures || !text.includes('::')) return this.shape(text);
		const out: Shaped[] = [];
		const put = (from: number, to: number) => {
			if (to > from) for (const g of this.shape(text.slice(from, to))) out.push({ ...g, cluster: g.cluster + from });
		};
		let at = 0;
		for (let i = text.indexOf('::'); i >= 0; i = text.indexOf('::', at)) {
			put(at, i);
			put(i, i + 1);
			put(i + 1, i + 2);
			at = i + 2;
		}
		put(at, text.length);
		return out;
	}

	/**
	 * Build-time guard for a font that declares ligatures: every sequence in LIGATURE_TESTS must shape to different glyphs with
	 * liga/calt/clig on than off, else the font (or our feature list) silently renders N separate glyphs. Also checks that every
	 * glyph keeps a cluster inside its sequence (selection and copy map glyphs back to characters through clusters).
	 */
	checkLigatures(): void {
		if (!this.spec.ligatures) return;
		for (const seq of LIGATURE_TESTS) {
			const on = this.shape(seq), off = this.shape(seq, [], ['liga', 'calt', 'clig']);
			const same = on.length === off.length && on.every((g, i) => g.gid === off[i].gid);
			if (same) throw new Error(`${this.spec.name}: "${seq}" shapes to the same glyphs with ligatures on and off (${on.map((g) => g.gid).join(',')}); a ligature font must substitute it`);
			if (on.some((g) => g.cluster < 0 || g.cluster >= seq.length)) throw new Error(`${this.spec.name}: "${seq}" has a cluster outside the string`);
		}
	}

	outline(gid: number): Contour[] {
		let o = this.outlines.get(gid);
		if (!o) {
			this.pb = new PathBuilder();
			this.font.drawGlyph(gid, this.drawFuncs);
			o = this.pb.done();
			this.pb = null;
			this.outlines.set(gid, o);
		}
		return o;
	}
}

export class FontSet {
	fonts: LoadedFont[] = FONT_SPECS.map((s) => new LoadedFont(s));

	constructor() {
		for (const f of this.fonts) f.checkLigatures();
	}
	private displays = new Map<string, number>();

	/**
	 * Font index of the Instrument Sans instance for an article voice (wdth, wght); created on first use and
	 * appended to `fonts`, so every glyph drawn with it lands in the union table under its own FontInfo.
	 * Out-of-range axes throw (fail closed).
	 */
	display(wdth: number, wght: number): number {
		const [w0, w1] = DISPLAY_AXES.wdth, [g0, g1] = DISPLAY_AXES.wght;
		if (!(wdth >= w0 && wdth <= w1 && wght >= g0 && wght <= g1)) throw new Error(`display instance wdth ${wdth} wght ${wght} outside Instrument Sans axes`);
		const key = `${wdth}/${wght}`;
		let i = this.displays.get(key);
		if (i === undefined) {
			const base = FONT_SPECS[F.display];
			if (base.variations.wdth === wdth && base.variations.wght === wght) i = F.display;
			else {
				i = this.fonts.length;
				this.fonts.push(new LoadedFont({ ...base, name: `Instrument Sans wdth ${wdth} wght ${wght}`, variations: { wdth, wght } }));
			}
			this.displays.set(key, i);
		}
		return i;
	}

	/** Code points of `text` that neither font `fi` nor the fallbacks cover (empty = fully covered). Used by the magazine build to fail on a missing glyph. */
	missing(fi: number, text: string): number[] {
		const out: number[] = [];
		for (const ch of text) {
			const cp = ch.codePointAt(0)!;
			if (cp <= 0x20 || cp === 0xa0) continue;
			const g = this.fonts[fi].shape(ch)[0];
			if ((!g || g.gid === 0) && !this.fallback(cp)) out.push(cp);
		}
		return out;
	}
	private fb = new Map<number, { font: number; gid: number; adv: number } | null>();

	/** First fallback font that has a glyph for the code point, with its advance in em. */
	fallback(cp: number) {
		let hit = this.fb.get(cp);
		if (hit === undefined) {
			hit = null;
			for (const fi of FALLBACKS) {
				const g = this.fonts[fi].shape(String.fromCodePoint(cp))[0];
				if (g && g.gid !== 0) { hit = { font: fi, gid: g.gid, adv: g.xAdvance }; break; }
			}
			this.fb.set(cp, hit);
		}
		return hit;
	}
}

// ---- Slug band builder --------------------------------------------------------------------------

const MAX_BANDS = 16;

interface Built {
	index: number;
	area: number;
}

export class GlyphTableBuilder {
	private dir: number[] = [];
	private curves: number[] = []; // u16
	private bands: number[] = []; // u32
	private keys = new Map<string, Built>();
	/** glyph index -> ink area in em^2 (build-time only) */
	areas: number[] = [];
	/** glyph index -> bbox, build-time only */
	boxes: [number, number, number, number][] = [];
	tag: (string | number)[][] = [];

	get count() {
		return this.areas.length;
	}

	/** Add (or reuse) a glyph; contours are in em, y up, relative to the glyph origin. */
	add(key: string, contoursIn: Contour[], meta: (string | number)[] = []): number {
		const hit = this.keys.get(key);
		if (hit) return hit.index;
		const contours = mapContours(contoursIn, roundF16);
		const index = this.areas.length;
		const area = inkArea(contours);
		this.keys.set(key, { index, area });
		this.areas.push(area);
		this.tag.push(meta);

		// curve texels
		const curveStart = this.curves.length >> 2;
		const refs: { texel: number; q: number[] }[] = [];
		let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
		for (const ct of contours) {
			let t = this.curves.length >> 2;
			for (const q of ct) {
				this.curves.push(toF16(q[0]), toF16(q[1]), toF16(q[2]), toF16(q[3]));
				refs.push({ texel: t++, q });
				for (let k = 0; k < 6; k += 2) { x0 = Math.min(x0, q[k]); x1 = Math.max(x1, q[k]); y0 = Math.min(y0, q[k + 1]); y1 = Math.max(y1, q[k + 1]); }
			}
			const last = ct[ct.length - 1];
			this.curves.push(toF16(last[4]), toF16(last[5]), CONTOUR_END, CONTOUR_END);
		}
		if (!refs.length) { x0 = y0 = x1 = y1 = 0; }
		this.boxes.push([x0, y0, x1, y1]);

		const { nH, nV, hLists, vLists } = buildBands(refs, x0, y0, x1, y1);
		const bandStart = this.bands.length;
		// header texels, then lists (shared when identical)
		const total = nH + nV;
		const header = new Array<number>(total).fill(0);
		const body: number[] = [];
		const seen = new Map<string, number>();
		const place = (lists: number[][], base: number) => {
			lists.forEach((l, k) => {
				const sig = l.join(',');
				let off = seen.get(sig);
				if (off === undefined) {
					off = total + body.length;
					body.push(...l);
					seen.set(sig, off);
				}
				if (off > 0xffff || l.length > 0xffff) throw new Error(`glyph ${key}: band offset overflow`);
				header[base + k] = (l.length | (off << 16)) >>> 0;
			});
		};
		// horizontal entries are texel indices with the *horizontal* sort order, vertical likewise
		place(hLists.map((l) => l.map((r) => refs[r].texel)), 0);
		place(vLists.map((l) => l.map((r) => refs[r].texel)), nH);
		this.bands.push(...header, ...body);

		const f32 = new Float32Array(4);
		f32.set([x0, y0, x1, y1]);
		const bits = new Uint32Array(f32.buffer);
		this.dir.push(curveStart, bandStart, (nH | (nV << 16)) >>> 0, refs.length, bits[0], bits[1], bits[2], bits[3]);
		return index;
	}

	finish(): GlyphTable {
		return { dir: Uint32Array.from(this.dir), curves: Uint16Array.from(this.curves), bands: Uint32Array.from(this.bands) };
	}
}

function buildBands(refs: { texel: number; q: number[] }[], x0: number, y0: number, x1: number, y1: number) {
	const n = refs.length;
	if (!n) return { nH: 1, nV: 1, hLists: [[]], vLists: [[]] };
	const lists = (count: number, horizontal: boolean) => {
		const lo0 = horizontal ? y0 : x0;
		const span = (horizontal ? y1 - y0 : x1 - x0) || 1;
		const out: number[][] = [];
		for (let k = 0; k < count; k++) {
			const lo = lo0 + (span * k) / count - BAND_EPS;
			const hi = lo0 + (span * (k + 1)) / count + BAND_EPS;
			const l: number[] = [];
			refs.forEach((r, i) => {
				const q = r.q;
				const a = horizontal ? [q[1], q[3], q[5]] : [q[0], q[2], q[4]];
				const mn = Math.min(...a), mx = Math.max(...a);
				// a curve with constant coordinate along the ray axis cannot contribute to that band set
				if (mn === mx) return;
				if (mx >= lo && mn <= hi) l.push(i);
			});
			const key = (i: number) => (horizontal ? Math.max(refs[i].q[0], refs[i].q[2], refs[i].q[4]) : Math.max(refs[i].q[1], refs[i].q[3], refs[i].q[5]));
			l.sort((a, b) => key(b) - key(a));
			out.push(l);
		}
		return out;
	};
	const pick = (horizontal: boolean) => {
		let best = 1, bestScore = Infinity, bestLists: number[][] = lists(1, horizontal);
		const cap = Math.min(MAX_BANDS, Math.max(1, n));
		for (let c = 1; c <= cap; c++) {
			const l = c === 1 ? bestLists : lists(c, horizontal);
			const mx = Math.max(...l.map((x) => x.length));
			const total = l.reduce((s, x) => s + x.length, 0);
			const score = mx * 1000 + total; // minimise the worst band first, then the data size
			if (score < bestScore) { bestScore = score; best = c; bestLists = l; }
		}
		return { count: best, lists: bestLists };
	};
	const h = pick(true), v = pick(false);
	return { nH: h.count, nV: v.count, hLists: h.lists, vLists: v.lists };
}
