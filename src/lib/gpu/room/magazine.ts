// GPU side of the in-world magazine (docs/MAGAZINE.md): loads the build-time RDR2 binaries (static/magazine/*.bin), assembles
// the single `reader` storage buffer magazine.wgsl.ts reads, owns the image texture array and the per-frame channel
// subrange, mirrors the sheet geometry on the CPU for hit tests, and fills the rd* scene uniforms. Replaces reader.ts.
//
// Reader buffer layout (u32 words): [0, MH_WORDS) header (indices in MH), [CHAN_BASE, CHAN_BASE + 256) channel table
// (f32, rewritten every frame by writeChannels), then the sections: fonts dir/curves/bands, the article's extra table,
// then the RDR2 record tables copied byte for byte (their strides are REC2 in format.ts, the shader derives the same).
import {
	ARTICLE2_MAGIC, REC2, RDR2_PARAMS, Sec2, cstr, fieldOffset, unpackContainer, unpackMagazine, toF16,
	type Container, type FigureRec
} from '../../magazine/format';
import { Sec as FSec, LinkKind } from '../../reader/format';
import { CHAN_BASE, CHAN_FLOATS, DATA_BASE, MAGIC_MAG, MH, MH_WORDS, SEL_BASE, SEL_RECTS } from './magazine.wgsl';
import { buildTextModel, type TextModel } from '../../magazine/select';

/** metres per layout em: a 40 em sheet is 0.62 m wide, a little larger than a shelf magazine. */
export const EM = 0.0155;
/** open-book bow, radians (2.5 degrees, MAGAZINE.md 4.4) */
export const BOW = (2.5 * Math.PI) / 180;
export const GUTTER = 0.18;
const LAYER = 2048;
const MAX_LAYERS = 8;
const MIN_BUF_BYTES = 4 << 20;

interface ImageInfo { id: number; w: number; h: number; tiers: { w: number; h: number; url: string }[] }
interface Index {
	fonts: string;
	classes: { id: number; name: string; sheetW: number; sheetH: number }[];
	articles: { slug: string; opensFull?: boolean; bins: Record<string, { file: string }> }[];
	images: ImageInfo[];
}

export interface LinkHit {
	kind: number;
	target: string;
	spread: number;
	rect: [number, number, number, number];
}

export interface FigureInfo {
	id: number; firstChan: number; chanCount: number; mode: number; duration: number; poster: number;
	spread: number; bounds: [number, number, number, number];
}

/** One resident article. Coordinates are spread-local em, y down. */
export interface Article {
	slug: string;
	cls: 'wide' | 'narrow';
	/** one sheet wide (narrow class): no spine, no left sheet, the spine is the left edge */
	single: boolean;
	sheetW: number;
	spreadW: number;
	spreadH: number;
	spreadCount: number;
	/** spread index to layer (0 distilled, 1 full text); needs `layer` in the spread record, 0 until the contract lane adds it */
	layers: number[];
	links: LinkHit[];
	anchors: { id: string; spread: number; y: number }[];
	figures: FigureInfo[];
	imageIds: number[];
	/** the article has no distilled layer of its own (voice template null): open on the full text */
	opensFull: boolean;
	/** packed channel and key tables (format.ts records) for the figure evaluator */
	chans: { firstKey: number; keyCount: number }[];
	keys: { t: number; v: number; ease: number }[];
	/** laid-out lines, glyph boundaries and plain text, for text selection */
	text: TextModel;
}

/** Everything the book geometry and the shader depend on; written into the scene uniform with writeRd. */
export interface MagazineUniforms {
	/** reading blend 0..1 (the shader draws nothing below 0.9) */
	k: number;
	/** object index of the magazine whose cover crossfades into spread 0, or -1 */
	magObj: number;
	em?: number;
	/** turn progress 0..1 and direction (-1 back, 0 none, 1 forward) */
	progress: number;
	dir: number;
	/** world x of the spine (narrow class: of the sheet's left edge), y of the sheet top edge, z of the spine plane */
	spineX: number;
	topY: number;
	z: number;
	/** spread index shown (the turning leaf's front is this spread) */
	index: number;
	/** hovered spread index, or -1 */
	hoverSpread: number;
	hoverRect?: readonly [number, number, number, number];
	/** 0: the rect is a link (underline), 1: a scrubbable figure (frame) */
	hoverKind?: number;
	dark: boolean;
	/** corner peel 0..1 for spread 0's Full text corner, -1 for none */
	peel: number;
	bow?: number;
	gutter?: number;
	gain?: number;
}

export const RD_FLOATS = 24;

/** Write rd0..rd5 (24 floats) into the scene uniform array at float offset `at`. */
export function writeRd(out: Float32Array, at: number, u: MagazineUniforms) {
	const hr = u.hoverRect ?? [0, 0, 0, 0];
	out.set([
		u.k, u.magObj, u.em ?? EM, u.progress,
		u.spineX, u.topY, u.z, u.dir,
		u.index, u.hoverKind ?? 0, u.hoverSpread + 1, u.dark ? 1 : 0,
		hr[0], hr[1], hr[2], hr[3],
		u.peel, 0, 0, 0,
		u.bow ?? BOW, u.gutter ?? GUTTER, u.gain ?? 1, 0
	], at);
}

const f32v = new Float32Array(1);
const u32v = new Uint32Array(f32v.buffer);
const bits = (v: number) => ((f32v[0] = v), u32v[0]);

export interface AssembleResult {
	words: Uint32Array;
	/** per-image-table-row: layer slot, in order of first use */
	imageIds: number[];
	/** the image tier chosen for each layer slot, by image id */
	imageSlots: Map<number, number>;
}

const words = (c: Container, id: number): Uint32Array => {
	const s = c.sections.get(id);
	if (!s) throw new Error(`magazine: missing section ${id}`);
	return new Uint32Array(s.bytes.buffer, s.bytes.byteOffset, s.bytes.byteLength >> 2);
};

/**
 * Pure assembly of the reader buffer from an RDR2 container and the shared fonts container (no GPU, testable).
 * `tierFor(imageId)` returns the pixel size {w, h} of the tier placed in the layer so the image uv scale can be written.
 */
export function assemble(art: Container, fonts: Container, tierFor: (imageId: number) => { w: number; h: number }, single: boolean): AssembleResult {
	if (art.magic !== ARTICLE2_MAGIC) throw new Error('magazine: not an RDR2 bin');
	const P = (name: (typeof RDR2_PARAMS)[number]) => RDR2_PARAMS.indexOf(name);
	const pf = (name: (typeof RDR2_PARAMS)[number]) => art.paramsF[P(name)];
	const pu = (name: (typeof RDR2_PARAMS)[number]) => art.params[P(name)];

	// image records: imageId (low 16 bits of its word) becomes a texture layer, the altOffset word becomes the f16x2 uv scale
	const imgRaw = words(art, Sec2.images).slice();
	const stride = REC2.image / 4;
	const wId = fieldOffset('image', 'imageId') >> 2;
	const wScale = fieldOffset('image', 'altOffset') >> 2;
	const imageIds: number[] = [];
	const imageSlots = new Map<number, number>();
	for (let i = 0; i < art.sections.get(Sec2.images)!.count; i++) {
		const o = i * stride;
		const id = imgRaw[o + wId] & 0xffff;
		let slot = imageSlots.get(id);
		if (slot === undefined) {
			slot = imageIds.length;
			if (slot >= MAX_LAYERS) throw new Error(`magazine: more than ${MAX_LAYERS} images`);
			imageIds.push(id);
			imageSlots.set(id, slot);
		}
		const t = tierFor(id);
		imgRaw[o + wId] = (imgRaw[o + wId] & 0xffff0000) | slot;
		imgRaw[o + wScale] = toF16(t.w / LAYER) | (toF16(t.h / LAYER) << 16);
	}

	const parts: [number, ArrayLike<number>][] = [
		[MH.fdir, words(fonts, FSec.dir)], [MH.fcur, words(fonts, FSec.curves)], [MH.fband, words(fonts, FSec.bands)],
		[MH.xdir, words(art, Sec2.exDir)], [MH.xcur, words(art, Sec2.exCurves)], [MH.xband, words(art, Sec2.exBands)],
		[MH.spreads, words(art, Sec2.spreads)], [MH.cells, words(art, Sec2.gridCells)], [MH.items, words(art, Sec2.items)],
		[MH.glyphs, words(art, Sec2.glyphs)], [MH.rects, words(art, Sec2.rects)], [MH.images, imgRaw],
		[MH.shapes, words(art, Sec2.shapes)], [MH.paths, words(art, Sec2.paths)], [MH.strokes, words(art, Sec2.strokes)],
		[MH.segs, words(art, Sec2.segs)], [MH.groups, words(art, Sec2.groups)], [MH.numerals, words(art, Sec2.numerals)],
		[MH.digits, words(art, Sec2.digitSets)], [MH.palette, words(art, Sec2.palette)]
	];
	let total = DATA_BASE;
	for (const [, p] of parts) total += p.length;
	const out = new Uint32Array(total);
	let off = DATA_BASE;
	for (const [h, p] of parts) {
		out[h] = off;
		out.set(p as Uint32Array, off);
		off += p.length;
	}
	out[MH.magic] = MAGIC_MAG;
	out[MH.sheetW] = bits(pf('sheetW'));
	out[MH.spreadW] = bits(pf('spreadW'));
	out[MH.spreadH] = bits(pf('spreadH'));
	out[MH.cellW] = bits(pf('cellW'));
	out[MH.cellH] = bits(pf('cellH'));
	out[MH.spreadN] = pu('spreadCount');
	out[MH.single] = single ? 1 : 0;
	out[MH.chans] = CHAN_BASE;
	return { words: out, imageIds, imageSlots };
}

export class Magazine {
	buffer: GPUBuffer;
	readonly sampler: GPUSampler;
	imgView: GPUTextureView;
	/** called when buffer or imgView was replaced (bind groups must be rebuilt) */
	onRebind: () => void = () => {};
	/** called when pixels arrived (a redraw is needed) */
	onDirty: () => void = () => {};
	article: Article | null = null;

	private img: GPUTexture;
	private index: Promise<Index> | null = null;
	private fonts: Promise<Container> | null = null;
	private bins = new Map<string, Promise<Container>>();
	private gen = 0;

	constructor(private device: GPUDevice) {
		this.buffer = this.allocBuffer(MIN_BUF_BYTES);
		this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
		this.img = this.alloc(1, 4);
		this.imgView = this.img.createView({ dimension: '2d-array' });
	}

	private allocBuffer(bytes: number) {
		return this.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	}

	private alloc(layers: number, size: number) {
		return this.device.createTexture({
			size: [size, size, layers],
			format: 'rgba8unorm-srgb',
			mipLevelCount: Math.floor(Math.log2(size)) + 1,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
		});
	}

	private getIndex() {
		return (this.index ??= fetch('/magazine/index.json').then((r) => {
			if (!r.ok) throw new Error(`magazine/index.json: ${r.status}`);
			return r.json() as Promise<Index>;
		}));
	}

	private async bin(file: string): Promise<Container> {
		let p = this.bins.get(file);
		if (!p) {
			p = fetch(`/magazine/${file}`).then(async (r) => {
				if (!r.ok) throw new Error(`magazine/${file}: ${r.status}`);
				return unpackContainer(new Uint8Array(await r.arrayBuffer()));
			});
			this.bins.set(file, p);
			if (this.bins.size > 4) this.bins.delete(this.bins.keys().next().value!);
		}
		return p;
	}

	/** Fetch the index and the shared glyph data ahead of the first open. */
	async prefetch() {
		const ix = await this.getIndex();
		this.fonts ??= this.bin(ix.fonts);
		await this.fonts;
	}

	/** Width class for a canvas aspect ratio: portrait gets one sheet per spread. */
	static classFor(aspect: number): 'wide' | 'narrow' {
		return aspect < 0.9 ? 'narrow' : 'wide';
	}

	/** Load an article and make it the resident one. Resolves when text data is on the GPU; images stream in after. */
	async load(slug: string, cls: 'wide' | 'narrow'): Promise<Article | null> {
		const ix = await this.getIndex();
		const a = ix.articles.find((x) => x.slug === slug);
		if (!a) return null;
		const my = ++this.gen;
		this.fonts ??= this.bin(ix.fonts);
		const [fonts, art] = await Promise.all([this.fonts, this.bin(a.bins[cls].file)]);
		if (my !== this.gen) return null;

		const tiers = new Map<number, ImageInfo['tiers'][number]>();
		const tierFor = (id: number) => {
			let t = tiers.get(id);
			if (!t) {
				const fit = ix.images[id].tiers.filter((x) => x.w <= LAYER);
				t = fit[fit.length - 1] ?? ix.images[id].tiers[0];
				tiers.set(id, t);
			}
			return t;
		};
		const single = cls === 'narrow';
		const asm = assemble(art, fonts, tierFor, single);
		if (asm.words.length * 4 > this.buffer.size) {
			this.buffer.destroy();
			this.buffer = this.allocBuffer(Math.ceil((asm.words.length * 4) / MIN_BUF_BYTES) * MIN_BUF_BYTES);
			this.onRebind();
		}
		this.device.queue.writeBuffer(this.buffer, 0, asm.words);

		const m = unpackMagazine(new Uint8Array(art.buf));
		const strings = m.strings;
		const links: LinkHit[] = m.links.map((l) => ({ rect: [l.x0, l.y0, l.x1, l.y1], kind: l.kind, target: cstr(strings, l.offset), spread: l.spread }));
		const anchors = m.anchors.map((x) => ({ id: cstr(strings, x.idOffset), spread: x.spread, y: x.y }));
		const figures: FigureInfo[] = m.figures.map((f: FigureRec) => ({
			id: f.id, firstChan: f.firstChan, chanCount: f.chanCount, mode: f.mode, duration: f.duration, poster: f.poster,
			spread: f.spread, bounds: [f.x0, f.y0, f.x1, f.y1]
		}));
		const layers = m.spreads.map((s) => (s as unknown as { layer?: number }).layer ?? 0);
		this.article = {
			slug, cls, single, sheetW: m.sheetW, spreadW: m.spreadW, spreadH: m.spreadH, spreadCount: m.spreads.length,
			layers, links, anchors, figures, imageIds: asm.imageIds, opensFull: !!a.opensFull,
			chans: m.chans as unknown as Article['chans'], keys: m.keys as unknown as Article['keys'],
			text: buildTextModel(m.lines, m.glyphs, m.text, m.spreads)
		};
		void this.loadImages(asm.imageIds, asm.imageIds.map((id) => tierFor(id)), my);
		return this.article;
	}

	private async loadImages(ids: number[], tiers: { w: number; h: number; url: string }[], my: number) {
		const old = this.img;
		const tex = this.alloc(Math.max(1, ids.length), ids.length ? LAYER : 4);
		this.img = tex;
		this.imgView = tex.createView({ dimension: '2d-array' });
		this.onRebind();
		old.destroy();
		await Promise.all(
			tiers.map(async (t, layer) => {
				const blob = await (await fetch(t.url)).blob();
				for (let mip = 0; ; mip++) {
					if (my !== this.gen || this.img !== tex) return;
					const w = Math.max(1, t.w >> mip);
					const h = Math.max(1, t.h >> mip);
					const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
					this.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, mipLevel: mip, origin: [0, 0, layer] }, [w, h]);
					bmp.close();
					if (w === 1 && h === 1) break;
					if (mip >= Math.log2(LAYER)) break;
				}
				this.onDirty();
			})
		);
	}

	/**
	 * Per-frame channel values (global channel index -> value), from evalChannels over the visible figures. Writes only the
	 * 1 KB subrange; call it only while a spread with figures is visible and once more when the last one leaves.
	 */
	writeChannels(values: Float32Array) {
		const n = Math.min(values.length, CHAN_FLOATS);
		this.device.queue.writeBuffer(this.buffer, CHAN_BASE * 4, values.buffer, values.byteOffset, n * 4);
	}

	/** Highlight rects (spread em, x0 y0 x1 y1 each) of the text selection on `spread`; an empty list clears it. */
	writeSelection(spread: number, rects: readonly number[]) {
		const n = Math.min(rects.length >> 2, SEL_RECTS);
		const w = new Uint32Array(2 + 4 * n);
		w[0] = n;
		w[1] = n ? spread + 1 : 0;
		new Float32Array(w.buffer, 8, 4 * n).set(rects.slice(0, 4 * n));
		this.device.queue.writeBuffer(this.buffer, SEL_BASE * 4, w);
	}

	/** Drop the resident article (its data stays in the buffer until the next load; the shader sees zero spreads). */
	unload() {
		this.gen++;
		this.article = null;
		this.device.queue.writeBuffer(this.buffer, MH.spreadN * 4, new Uint32Array([0]));
	}

	destroy() {
		this.buffer.destroy();
		this.img.destroy();
	}
}

// ---- CPU mirror of page_trace (magazine.wgsl.ts): hit test and picking ----------------------------------------------

type V3 = readonly [number, number, number];

export interface SpreadHit {
	t: number;
	spread: number;
	/** spread-local em, y down */
	x: number;
	y: number;
	/** distance from the spine along the sheet, em */
	a: number;
	/** 0 front, 1 back of the turning leaf, 2 blank back (narrow class) */
	face: number;
}

export interface Book {
	/** em of the shown spread */
	sheetW: number;
	spreadH: number;
	spreadCount: number;
	single: boolean;
}

/** Mirror of the strip geometry: the leaf angle of strip j at turn progress p. */
export function leafAngle(j: number, progress: number, bow = BOW) {
	const phi = bow + progress * (Math.PI - 2 * bow);
	const lag = 0.8 * Math.sin(Math.PI * progress);
	return Math.max(phi - (lag * j) / 7, bow);
}

/**
 * Ray (origin o, unit direction d, world metres) against the open book exactly as page_trace does. `u` carries the same
 * numbers as the rd* uniforms. Returns the nearest hit or null.
 */
export function pickSpread(b: Book, u: MagazineUniforms, o: V3, d: V3): SpreadHit | null {
	if (u.k < 0.9 || b.spreadCount === 0) return null;
	const em = u.em ?? EM;
	const bow = u.bow ?? BOW;
	const sw = b.sheetW;
	const spx = b.single ? 0 : sw;
	const len = sw * em;
	const sg = o[2] >= u.z ? 1 : -1;
	const o2: [number, number] = [o[0] - u.spineX, sg * (o[2] - u.z)];
	const d2: [number, number] = [d[0], sg * d[2]];
	let idx = Math.min(Math.max(Math.floor(u.index), 0), b.spreadCount - 1);
	let dir = Math.round(u.dir);
	let prog = Math.min(Math.max(u.progress, 0), 1);
	if (b.single && dir < 0) {
		if (idx === 0) dir = 0;
		else { idx -= 1; dir = 1; prog = 1 - prog; }
	}
	if (dir > 0 && idx + 1 >= b.spreadCount) dir = 0;
	if (dir < 0 && idx === 0) dir = 0;

	const cross = (a: readonly number[], c: readonly number[]) => a[0] * c[1] - a[1] * c[0];
	const seg = (p0: readonly number[], p1: readonly number[]): [number, number] => {
		const e = [p1[0] - p0[0], p1[1] - p0[1]];
		const den = cross(d2, e);
		if (Math.abs(den) < 1e-9) return [-1, 0];
		const w = [p0[0] - o2[0], p0[1] - o2[1]];
		const t = cross(w, e) / den;
		const uu = cross(w, d2) / den;
		return uu < 0 || uu > 1 ? [-1, 0] : [t, uu];
	};
	const yAt = (t: number) => (u.topY - (o[1] + d[1] * t)) / em;

	let best: SpreadHit | null = null;
	for (let side = 0; side < 2; side++) {
		if (b.single && side === 0) continue;
		const m = side === 1 ? 1 : -1;
		let sp = idx;
		if (side === 1 && dir > 0) sp = idx + 1;
		if (side === 0 && dir < 0) sp = idx - 1;
		const h = seg([0, 0], [len * m * Math.cos(bow), len * Math.sin(bow)]);
		if (h[0] <= 0 || (best && h[0] >= best.t)) continue;
		const py = yAt(h[0]);
		if (py < 0 || py > b.spreadH) continue;
		best = { t: h[0], spread: sp, x: spx + m * h[1] * sw, y: py, a: h[1] * sw, face: 0 };
	}
	if (dir !== 0) {
		const m = dir;
		const sl = len / 8;
		let pt: [number, number] = [0, 0];
		let leaf: SpreadHit | null = null;
		for (let j = 0; j < 8; j++) {
			const th = leafAngle(j, prog, bow);
			const p1: [number, number] = [pt[0] + sl * m * Math.cos(th), pt[1] + sl * Math.sin(th)];
			const h = seg(pt, p1);
			pt = p1;
			if (h[0] <= 0 || (leaf && h[0] >= leaf.t)) continue;
			const py = yAt(h[0]);
			if (py < 0 || py > b.spreadH) continue;
			const a = ((j + h[1]) * sw) / 8;
			const nf = [-m * Math.sin(th), Math.cos(th)];
			const front = d2[0] * nf[0] + d2[1] * nf[1] < 0;
			let sp = idx;
			let px = spx + m * a;
			let face = 0;
			if (!front) {
				if (b.single) { face = 2; px = a; }
				else { face = 1; sp = dir > 0 ? idx + 1 : idx - 1; px = spx - m * a; }
			}
			leaf = { t: h[0], spread: sp, x: px, y: py, a, face };
		}
		if (leaf && (!best || leaf.t < best.t + 1e-4)) best = leaf;
	}
	return best;
}

export function linkAt(a: Article, spread: number, x: number, y: number): LinkHit | null {
	for (const l of a.links) {
		if (l.spread !== spread) continue;
		if (x >= l.rect[0] && x <= l.rect[2] && y >= l.rect[1] && y <= l.rect[3]) return l;
	}
	return null;
}

export { LinkKind };
