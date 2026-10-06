// GPU side of the in-world reader (docs/READER.md): loads the build-time binaries (static/reader/*.bin),
// assembles the single `reader` storage buffer the page shader reads (reader.wgsl.ts), owns the image
// texture array, and answers hit tests on the CPU.
import { cstr, LinkKind, REC, Sec, toF16, unpackContainer, type Container } from '$lib/reader/format';

/** metres per layout em: a 40 em sheet is 0.62 m wide, a little larger than a shelf magazine. */
export const EM = 0.0155;
const LAYER = 2048;
const MAX_LAYERS = 8;
const BUF_BYTES = 4 << 20;
// header word indices, mirrored in reader.wgsl.ts
const H = { magic: 0, sheetW: 1, sheetH: 2, cols: 3, rows: 4, cellW: 5, cellH: 6, pages: 7, fdir: 8, fcur: 9, fband: 10, xdir: 11, xcur: 12, xband: 13, page: 14, cell: 15, item: 16, glyph: 17, rect: 18, img: 19, pal: 20, stride: 21 };

interface ImageInfo { id: number; w: number; h: number; tiers: { w: number; h: number; url: string }[] }
interface Index {
	fonts: string;
	classes: { id: number; name: string; sheetW: number; sheetH: number }[];
	articles: { slug: string; pageCount: Record<string, number>; bins: Record<string, { file: string }> }[];
	images: ImageInfo[];
}

export interface LinkHit {
	kind: number;
	target: string;
	page: number;
	rect: [number, number, number, number];
}

/** One resident article. Coordinates are page-local em, y down. */
export interface Article {
	slug: string;
	cls: 'wide' | 'narrow';
	sheetW: number;
	sheetH: number;
	gap: number;
	pageCount: number;
	links: LinkHit[];
	anchors: { id: string; page: number; y: number }[];
	imageIds: number[];
}

/** Everything the sheet geometry depends on; the same numbers go to the shader as the rd* uniforms. */
export interface Sheet {
	/** world x of the sheet centre, world y of the top edge of sheet 0 at scroll 0, plane z */
	x: number;
	topY: number;
	z: number;
	scroll: number;
	/** 0..1 the magazine opening (state[0]); sheets spread from sheet 0 with it */
	k: number;
}

const f32v = new Float32Array(1);
const u32v = new Uint32Array(f32v.buffer);
const bits = (v: number) => ((f32v[0] = v), u32v[0]);

export class Reader {
	readonly buffer: GPUBuffer;
	readonly sampler: GPUSampler;
	imgView: GPUTextureView;
	/** called when imgView was replaced (bind groups must be rebuilt) */
	onRebind: () => void = () => {};
	/** called when pixels arrived (a redraw is needed) */
	onDirty: () => void = () => {};
	article: Article | null = null;

	private img: GPUTexture;
	private index: Promise<Index> | null = null;
	private fonts: Promise<Container> | null = null;
	private bins = new Map<string, Promise<Container>>();
	private cont: Container | null = null;
	private gen = 0;

	constructor(private device: GPUDevice) {
		this.buffer = device.createBuffer({ size: BUF_BYTES, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
		this.img = this.alloc(1, 4);
		this.imgView = this.img.createView({ dimension: '2d-array' });
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
		return (this.index ??= fetch('/reader/index.json').then((r) => {
			if (!r.ok) throw new Error(`reader/index.json: ${r.status}`);
			return r.json() as Promise<Index>;
		}));
	}

	private async bin(file: string): Promise<Container> {
		let p = this.bins.get(file);
		if (!p) {
			p = fetch(`/reader/${file}`).then(async (r) => {
				if (!r.ok) throw new Error(`reader/${file}: ${r.status}`);
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

	/** Width class for a canvas aspect ratio (docs/READER.md 2.1). */
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
		const cc = ix.classes.find((c) => c.name === cls)!;
		const get = (c: Container, id: number) => c.sections.get(id)!;
		const words = (c: Container, id: number) => {
			const b = get(c, id).bytes;
			return new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
		};

		// image records: rewrite imageId to a texture layer and word 5 to the uv scale of the tier placed in that layer
		const imgRaw = words(art, Sec.images).slice();
		const imageIds: number[] = [];
		const tiers = new Map<number, ImageInfo['tiers'][number]>();
		for (let i = 0; i < get(art, Sec.images).count; i++) {
			const o = i * (REC.image / 4);
			const id = imgRaw[o + 4] & 0xffff;
			let slot = imageIds.indexOf(id);
			if (slot < 0) {
				slot = imageIds.length;
				if (slot >= MAX_LAYERS) throw new Error(`reader: ${slug} has more than ${MAX_LAYERS} images`);
				imageIds.push(id);
				const info = ix.images[id];
				const fit = info.tiers.filter((t) => t.w <= LAYER);
				tiers.set(slot, fit[fit.length - 1] ?? info.tiers[0]);
			}
			const t = tiers.get(slot)!;
			imgRaw[o + 4] = (imgRaw[o + 4] & 0xffff0000) | slot;
			imgRaw[o + 5] = toF16(t.w / LAYER) | (toF16(t.h / LAYER) << 16);
		}

		const parts: [number, ArrayLike<number>][] = [
			[H.fdir, words(fonts, Sec.dir)], [H.fcur, words(fonts, Sec.curves)], [H.fband, words(fonts, Sec.bands)],
			[H.xdir, words(art, Sec.exDir)], [H.xcur, words(art, Sec.exCurves)], [H.xband, words(art, Sec.exBands)],
			[H.page, words(art, Sec.pages)], [H.cell, words(art, Sec.gridCells)], [H.item, words(art, Sec.items)],
			[H.glyph, words(art, Sec.glyphs)], [H.rect, words(art, Sec.rects)], [H.img, imgRaw], [H.pal, words(art, Sec.palette)]
		];
		let total = 32;
		for (const [, p] of parts) total += p.length;
		if (total * 4 > BUF_BYTES) throw new Error(`reader: ${slug} needs ${total * 4} bytes, buffer is ${BUF_BYTES}`);
		const out = new Uint32Array(total);
		let off = 32;
		for (const [h, p] of parts) {
			out[h] = off;
			out.set(p as Uint32Array, off);
			off += p.length;
		}
		const pf = art.paramsF;
		const P = { sheetW: pf[2], sheetH: pf[3], cellW: pf[7], cellH: pf[8], cols: art.params[9], rows: art.params[10], pages: art.params[12] };
		const gap = words(art, Sec.pages).length ? new Float32Array(art.buf, get(art, Sec.pages).bytes.byteOffset, 9)[0] : 0;
		const page1 = new Float32Array(art.buf, get(art, Sec.pages).bytes.byteOffset, 18)[9];
		const stride = P.pages > 1 ? page1 - gap : P.sheetH + 0.6;
		out[H.magic] = 0x52444731;
		out[H.sheetW] = bits(P.sheetW);
		out[H.sheetH] = bits(P.sheetH);
		out[H.cols] = P.cols;
		out[H.rows] = P.rows;
		out[H.cellW] = bits(P.cellW);
		out[H.cellH] = bits(P.cellH);
		out[H.pages] = P.pages;
		out[H.stride] = bits(stride);
		this.device.queue.writeBuffer(this.buffer, 0, out);

		// links and anchors (CPU only)
		const strings = get(art, Sec.strings).bytes;
		const ldv = (id: number) => {
			const b = get(art, id).bytes;
			return new DataView(b.buffer, b.byteOffset, b.byteLength);
		};
		const links: LinkHit[] = [];
		const lv = ldv(Sec.links);
		for (let i = 0; i < get(art, Sec.links).count; i++) {
			const o = i * REC.link;
			links.push({
				rect: [lv.getFloat32(o, true), lv.getFloat32(o + 4, true), lv.getFloat32(o + 8, true), lv.getFloat32(o + 12, true)],
				kind: lv.getUint32(o + 16, true),
				target: cstr(strings, lv.getUint32(o + 20, true)),
				page: lv.getUint32(o + 24, true)
			});
		}
		const anchors: Article['anchors'] = [];
		const av = ldv(Sec.anchors);
		for (let i = 0; i < get(art, Sec.anchors).count; i++) {
			const o = i * REC.anchor;
			anchors.push({ id: cstr(strings, av.getUint32(o, true)), page: av.getUint32(o + 4, true), y: av.getFloat32(o + 8, true) });
		}
		this.cont = art;
		this.article = { slug, cls, sheetW: P.sheetW, sheetH: P.sheetH, gap: stride - P.sheetH, pageCount: P.pages, links, anchors, imageIds };
		void cc;
		void this.loadImages(ix, imageIds, [...tiers.values()], my);
		return this.article;
	}

	private async loadImages(_ix: Index, ids: number[], tiers: { w: number; h: number; url: string }[], my: number) {
		const old = this.img;
		const tex = this.alloc(Math.max(1, ids.length), ids.length ? LAYER : 4);
		this.img = tex;
		this.imgView = tex.createView({ dimension: '2d-array' });
		this.onRebind();
		old.destroy();
		await Promise.all(
			tiers.map(async (t, layer) => {
				const blob = await (await fetch(t.url)).blob();
				for (let m = 0; ; m++) {
					if (my !== this.gen || this.img !== tex) return;
					const w = Math.max(1, t.w >> m);
					const h = Math.max(1, t.h >> m);
					const bmp = await createImageBitmap(blob, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
					this.device.queue.copyExternalImageToTexture({ source: bmp }, { texture: tex, mipLevel: m, origin: [0, 0, layer] }, [w, h]);
					bmp.close();
					if (w === 1 && h === 1) break;
					if (m >= Math.log2(LAYER)) break;
				}
				this.onDirty();
			})
		);
	}

	/** Drop the resident article (its data stays in the buffer until the next load; the shader sees zero pages). */
	unload() {
		this.gen++;
		this.article = null;
		this.cont = null;
		this.device.queue.writeBuffer(this.buffer, H.pages * 4, new Uint32Array([0]));
	}

	destroy() {
		this.buffer.destroy();
		this.img.destroy();
	}
}

type V3 = [number, number, number];

/** Mirror of page_trace in reader.wgsl.ts for a ray (origin o, unit direction d). */
export function pickSheet(a: Article, s: Sheet, first: number, count: number, o: V3, d: V3) {
	if (s.k < 0.9 || Math.abs(d[2]) < 1e-6) return null;
	const unf = smooth(0.9, 1, s.k);
	const stride = a.sheetH + a.gap;
	let best: { t: number; page: number; x: number; y: number } | null = null;
	for (let i = first; i < Math.min(first + count, a.pageCount); i++) {
		const z = s.z - 0.0015 * i;
		const t = (z - o[2]) / d[2];
		if (t <= 0 || (best && t >= best.t)) continue;
		const qx = o[0] + d[0] * t;
		const qy = o[1] + d[1] * t;
		const px = (qx - s.x) / EM + a.sheetW * 0.5;
		const py = (s.topY - qy) / EM + s.scroll * unf - i * stride * unf;
		if (px < 0 || px > a.sheetW || py < 0 || py > a.sheetH) continue;
		best = { t, page: i, x: px, y: py };
	}
	return best;
}

export function linkAt(a: Article, page: number, x: number, y: number): LinkHit | null {
	for (const l of a.links) {
		if (l.page !== page) continue;
		if (x >= l.rect[0] && x <= l.rect[2] && y >= l.rect[1] && y <= l.rect[3]) return l;
	}
	return null;
}

const smooth = (a: number, b: number, x: number) => {
	const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
	return t * t * (3 - 2 * t);
};

export { LinkKind };
