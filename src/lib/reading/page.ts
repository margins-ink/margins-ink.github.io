// The page pass (docs/READING.md section 7): owns a canvas, a WebGPU device and the buffers of one RDR3 article, and draws the
// PageFrame the reader hands it. Draw structure per dirty frame, one render pass:
//   1. ground            1 call  (full screen triangle, skipped when groundA = 0)
//   2. text              1 call per run: contiguous item range of visible blocks with equal opacity / dy / dx
//   3. notes text        1 call per run of the visible sidenotes
//   3b. (before 2) exhibit sets: spotlight and plinth overlays of each exhibit, scissored to its block
//   4. timeline exhibits 1 instanced call over the visible exhibit blocks with a compiled art; then per script exhibit: its overlays and UI text, scissored to the block
//   5. overlays          1 instanced call
//   6. UI text           1 instanced call (uiText glyphs, same glyph atlas and coverage as the article text)
// Idle frames (dirty = false) draw nothing. Shader: page.wgsl.ts. Buffer layout: header words MH, channel table, sections.
import {
	BlockKind, ItemType, REC2, RectKind, Sec2, fieldOffset, itemIndex, itemType, packReading, toF16, unpackContainer,
	type ReadingModel
} from '../magazine/format';
import { glyphCount, readFontsBin, type GlyphTable } from '../reader/format';
import type { Overlay, PageFrame, PageOptions, PagePass } from './page-api';
import { NO_GLYPH, type UiGlyph } from './ui/types';
import { CHAN_BASE, CHAN_FLOATS, DATA_BASE, FRAME_VEC4, MAGIC_PAGE, MH, PAGE_WGSL, SEG_BYTES } from './page.wgsl';

const MAX_LAYER = 2048;
const MAX_CANVAS_PIX = 5e6;
/** Budget for the image array incl. mips (RGBA8 = 4 B/px, x4/3 for mips): keeps a many-image article under ~200 MB. */
const MAX_IMAGE_BYTES = 192 * 2 ** 20;
const MAX_FIGS = 1024;
const MAX_OVERLAYS = 4096; // chrome (~512) plus two exhibits at 400 items, plus file icons (up to ~100 triangles each)
const OVERLAY_FLOATS = 12;
const MAX_UI_GLYPHS = 8192;
const UI_FLOATS = 12;
const MIN_BUF_BYTES = 1 << 20;

// ---- pure helpers (tested without a GPU) ----------------------------------------------------------

export interface DocMap { originX: number; originY: number; scrollPx: number; emPx: number; viewW: number; viewH: number }

/** Document em point to CSS px of the canvas (dyPx and dxPx are the per-block offsets; dx > 0 moves content left). */
export function docToPx(m: DocMap, x: number, y: number, dyPx = 0, dxPx = 0): [number, number] {
	return [m.originX + x * m.emPx - dxPx, m.originY + y * m.emPx - m.scrollPx + dyPx];
}

/** Document em point to clip space (x right, y up, both -1..1) exactly as vs_text computes it. */
export function docToClip(m: DocMap, x: number, y: number, dyPx = 0, dxPx = 0): [number, number] {
	const [px, py] = docToPx(m, x, y, dyPx, dxPx);
	return [(px / m.viewW) * 2 - 1, 1 - (py / m.viewH) * 2];
}

/**
 * Envelope of the item words of blocks [visFirst, visFirst + visCount): first item of the earliest block with items and the end
 * of the latest. Exact only when the visible blocks' item lists are contiguous; the pass itself draws textRuns, which does not
 * assume that.
 */
export function itemRange(model: Pick<ReadingModel, 'blocks'>, visFirst: number, visCount: number): { first: number; count: number } {
	const lo = Math.max(0, visFirst);
	const hi = Math.min(model.blocks.length, visFirst + visCount);
	let first = Infinity;
	let end = 0;
	for (let i = lo; i < hi; i++) {
		const b = model.blocks[i];
		if (b.itemCount <= 0) continue;
		first = Math.min(first, b.firstItem);
		end = Math.max(end, b.firstItem + b.itemCount);
	}
	return first === Infinity ? { first: 0, count: 0 } : { first, count: end - first };
}

/** One text draw: instances read items[first .. first + count) with these per-run parameters. */
export interface Run { first: number; count: number; alpha: number; dy: number; dx: number; /** block whose box scissors the run, or -1 */ clipBlock: number }

interface RunMaps { alpha?: Map<number, number>; dy?: Map<number, number>; dx?: Map<number, number> }

/** Runs of the text items of blocks [lo, hi): merges neighbours with equal parameters and adjacent item ranges; splits code panels from their text. */
export function textRuns(model: Pick<ReadingModel, 'blocks' | 'items' | 'rects'>, lo: number, hi: number, maps: RunMaps = {}): Run[] {
	const runs: Run[] = [];
	const push = (first: number, count: number, alpha: number, dy: number, dx: number, clipBlock: number) => {
		if (count <= 0) return;
		const l = runs[runs.length - 1];
		if (l && l.clipBlock === clipBlock && clipBlock < 0 && l.alpha === alpha && l.dy === dy && l.dx === dx && l.first + l.count === first) l.count += count;
		else runs.push({ first, count, alpha, dy, dx, clipBlock });
	};
	for (let i = Math.max(0, lo); i < Math.min(model.blocks.length, hi); i++) {
		const b = model.blocks[i];
		if (b.itemCount <= 0) continue;
		const alpha = maps.alpha?.get(i) ?? 1;
		if (alpha <= 0) continue;
		const dy = maps.dy?.get(i) ?? 0;
		const dx = b.kind === BlockKind.code ? (maps.dx?.get(i) ?? 0) : 0;
		if (dx === 0 && b.kind !== BlockKind.code) { push(b.firstItem, b.itemCount, alpha, dy, 0, -1); continue; }
		// code is always scissored to its panel (a long line never paints past the border); panel background: the first rect item of kind codeBg stays put, everything else moves and is clipped to the block box
		let pi = -1;
		for (let k = b.firstItem; k < b.firstItem + b.itemCount; k++) {
			const w = model.items[k];
			if (itemType(w) === ItemType.rect && model.rects[itemIndex(w)]?.kind === RectKind.codeBg) { pi = k; break; }
		}
		if (pi < 0) { push(b.firstItem, b.itemCount, alpha, dy, dx, i); continue; }
		push(b.firstItem, pi - b.firstItem, alpha, dy, dx, i);
		push(pi, 1, alpha, dy, 0, -1);
		push(pi + 1, b.firstItem + b.itemCount - pi - 1, alpha, dy, dx, i);
	}
	return runs;
}

/** Runs of the visible sidenotes (items of each note), optionally only those annotating blocks in [onlyLo, onlyHi). */
export function noteRuns(model: Pick<ReadingModel, 'notes'>, first: number, count: number, only?: { first: number; count: number }): Run[] {
	const runs: Run[] = [];
	for (let i = Math.max(0, first); i < Math.min(model.notes.length, first + count); i++) {
		const n = model.notes[i];
		if (n.itemCount <= 0) continue;
		if (only && (n.anchorBlock < only.first || n.anchorBlock >= only.first + only.count)) continue;
		const l = runs[runs.length - 1];
		if (l && l.first + l.count === n.firstItem) l.count += n.itemCount;
		else runs.push({ first: n.firstItem, count: n.itemCount, alpha: 1, dy: 0, dx: 0, clipBlock: -1 });
	}
	return runs;
}

/** Timeline exhibit instances: exhibit index, opacity, dy for the exhibit blocks in [lo, hi) that have a compiled art (a cell grid); script exhibits draw through the host. */
export function exhibitInstances(model: Pick<ReadingModel, 'blocks' | 'exhibits'>, lo: number, hi: number, maps: RunMaps = {}): { fig: number; alpha: number; dy: number }[] {
	const out: { fig: number; alpha: number; dy: number }[] = [];
	for (let i = Math.max(0, lo); i < Math.min(model.blocks.length, hi) && out.length < MAX_FIGS; i++) {
		const b = model.blocks[i];
		if (b.ex < 0 || !(model.exhibits[b.ex]?.gridCols > 0)) continue;
		const alpha = maps.alpha?.get(i) ?? 1;
		if (alpha > 0) out.push({ fig: b.ex, alpha, dy: maps.dy?.get(i) ?? 0 });
	}
	return out;
}

/** Visible block range after `only`: [lo, hi). */
export function blockSpan(f: Pick<PageFrame, 'visFirst' | 'visCount' | 'only'>, nBlocks: number): [number, number] {
	let lo = Math.max(0, f.visFirst);
	let hi = Math.min(nBlocks, f.visFirst + f.visCount);
	if (f.only) { lo = Math.max(lo, f.only.first); hi = Math.min(hi, f.only.first + f.only.count); }
	return [lo, Math.max(lo, hi)];
}

/** Pack the frame uniform (FRAME_VEC4 vec4f). */
export function packFrame(f: PageFrame, canvasW: number, extended: boolean, hdrCap: number, out = new Float32Array(FRAME_VEC4 * 4)): Float32Array {
	const s = canvasW / f.viewW;
	out.set([
		f.viewW, f.viewH, s, f.emPx,
		f.originX, f.originY - f.scrollPx, f.foldClipEm, f.foldFadeEm,
		1 / (f.emPx * s), extended ? 2 : 1, hdrCap, f.time,
		f.ground.x0, f.ground.y0, f.ground.x1, f.ground.y1,
		f.ground.radius, f.groundA, f.flash?.first ?? 0, f.flash?.end ?? 0,
		f.flash?.cx ?? 0, f.flash?.cy ?? 0, f.flash?.scale ?? 0, 0
	]);
	return out;
}

/** Overlay floats: x y w h, radius hdr shape width, r g b a. Writes from overlay `at` on; returns the count written (capped by the buffer). */
export function packOverlays(list: readonly Overlay[], extended: boolean, hdrGain: number, out: Float32Array, at = 0): number {
	const n = Math.max(0, Math.min(list.length, MAX_OVERLAYS - at));
	const cap = Math.max(1, hdrGain);
	for (let i = 0; i < n; i++) {
		const o = list[i];
		const hdr = extended ? Math.min(o.hdr ?? 1, cap) : 1;
		out.set([o.x, o.y, o.w, o.h, o.radius, hdr, o.shape ?? 0, o.width ?? 0, o.r, o.g, o.b, o.a], (at + i) * OVERLAY_FLOATS);
	}
	return n;
}

/**
 * UI glyph floats, 3 vec4f per glyph: x y size glyphId (f32 integer), r g b a, hdr 0 0 0. Glyphs with a glyph id outside [0, glyphs) (or NO_GLYPH),
 * a non-finite position or size, or zero alpha are skipped. rgb stays straight sRGB (the shader decodes and premultiplies), alpha is clamped to 0..1.
 */
export function packUiText(list: readonly UiGlyph[], glyphs: number, extended: boolean, hdrGain: number, out: Float32Array, at = 0): number {
	const cap = Math.max(1, hdrGain);
	let n = at;
	for (const g of list) {
		if (n >= MAX_UI_GLYPHS) break;
		if (g.glyphId === NO_GLYPH || g.glyphId < 0 || g.glyphId >= glyphs || g.glyphId >= 1 << 24 || !(g.size > 0) || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !(g.a > 0)) continue;
		const o = n * UI_FLOATS;
		out[o] = g.x; out[o + 1] = g.y; out[o + 2] = g.size; out[o + 3] = g.glyphId; // exact in f32 below 2^24; an f32 integer avoids reading integer bit patterns as floats
		out[o + 4] = g.r; out[o + 5] = g.g; out[o + 6] = g.b; out[o + 7] = Math.min(1, g.a);
		out[o + 8] = extended ? Math.min(g.hdr ?? 1, cap) : 1; out[o + 9] = 0; out[o + 10] = 0; out[o + 11] = 0;
		n++;
	}
	return n - at;
}

export interface Assembled {
	words: Uint32Array;
	/** word offset of the images table and its row count / image id per row, to patch the uv scale when textures arrive */
	imagesAt: number;
	imageIds: number[];
}

const u32 = (b: Uint8Array) => new Uint32Array(b.buffer, b.byteOffset, b.byteLength >> 2);
const curveWords = (a: Uint16Array): Uint32Array => {
	const out = new Uint32Array((a.length + 1) >> 1);
	new Uint16Array(out.buffer).set(a);
	return out;
};
const bits = (() => {
	const f = new Float32Array(1);
	const u = new Uint32Array(f.buffer);
	return (v: number) => ((f[0] = v), u[0]);
})();

/** Pure assembly of the page buffer (no GPU): header, channel table, font and article glyph tables, the RDR3 tables. */
export function assemblePage(fonts: GlyphTable, model: ReadingModel): Assembled {
	const c = unpackContainer(packReading(model));
	const sec = (id: number) => u32(c.sections.get(id)!.bytes);
	const imgRaw = sec(Sec2.images).slice();
	const stride = REC2.image / 4;
	const wId = fieldOffset('image', 'imageId') >> 2;
	const wScale = fieldOffset('image', 'altOffset') >> 2;
	const imageIds: number[] = [];
	for (let i = 0; i < imgRaw.length / stride; i++) {
		imageIds.push(imgRaw[i * stride + wId] & 0xffff);
		imgRaw[i * stride + wScale] = 0; // uv scale, written when the texture layer is known
	}
	const parts: [number, Uint32Array][] = [
		[MH.fdir, fonts.dir], [MH.fcur, curveWords(fonts.curves)], [MH.fband, fonts.bands],
		[MH.xdir, model.extra.dir], [MH.xcur, curveWords(model.extra.curves)], [MH.xband, model.extra.bands],
		[MH.cells, sec(Sec2.gridCells)], [MH.items, Uint32Array.from(model.items)],
		[MH.glyphs, sec(Sec2.glyphs)], [MH.rects, sec(Sec2.rects)], [MH.images, imgRaw],
		[MH.shapes, sec(Sec2.shapes)], [MH.paths, sec(Sec2.paths)], [MH.strokes, sec(Sec2.strokes)], [MH.segs, sec(Sec2.segs)],
		[MH.groups, sec(Sec2.groups)], [MH.numerals, sec(Sec2.numerals)], [MH.digits, sec(Sec2.digitSets)], [MH.palette, sec(Sec2.palette)],
		[MH.exhibits, sec(Sec2.exhibits)], [MH.blocks, sec(Sec2.blocks)], [MH.notes, sec(Sec2.notes)]
	];
	let total = DATA_BASE;
	for (const [, p] of parts) total += p.length;
	const words = new Uint32Array(total);
	let off = DATA_BASE;
	for (const [h, p] of parts) {
		words[h] = off;
		words.set(p, off);
		off += p.length;
	}
	words[MH.magic] = MAGIC_PAGE;
	words[MH.chans] = CHAN_BASE;
	words[MH.nBlocks] = model.blocks.length;
	words[MH.nNotes] = model.notes.length;
	words[MH.nExhibits] = model.exhibits.length;
	words[MH.nItems] = model.items.length;
	return { words, imagesAt: words[MH.images], imageIds };
}

// ---- the pass -------------------------------------------------------------------------------------

interface Debug { frames: number; lastGpuMs: number; gpuBytes: number; lastDrawCalls: number }

class PageImpl implements PagePass {
	readonly canvas: HTMLCanvasElement;
	/** device lost: the pass stopped drawing; the host may read it and rebuild */
	lost = false;
	/** called when pixels arrived after load() resolved (images): the host should redraw */
	onDirty: () => void = () => {};

	private model: ReadingModel | null = null;
	private asm: Assembled | null = null;
	private reader: GPUBuffer | null = null;
	private img: GPUTexture;
	private imgView: GPUTextureView;
	private g0: GPUBindGroup | null = null;
	private g1: GPUBindGroup;
	private frameBuf: GPUBuffer;
	private frameBuf2: GPUBuffer;
	private g1b: GPUBindGroup;
	private frameData2 = new Float32Array(FRAME_VEC4 * 4);
	private segBuf: GPUBuffer;
	private segCap = 64;
	private segStride: number;
	private figBuf: GPUBuffer;
	private ovlBuf: GPUBuffer;
	private uiBuf: GPUBuffer;
	private uiGlyphs = 0;
	private sampler: GPUSampler;
	private gen = 0;
	private force = true;
	private readerBytes = 0;
	private imgBytes = 0;
	private extraBytes = 0;
	private cssW = 0;
	private cssH = 0;
	private frames = 0;
	private drawCalls = 0;
	private gpuMs: number[] = [];
	private qs: GPUQuerySet | null = null;
	private qResolve: GPUBuffer | null = null;
	private qRead: { buf: GPUBuffer; busy: boolean }[] = [];
	private dbg: Debug | null = null;
	private ownCanvas: boolean;
	private frameData = new Float32Array(FRAME_VEC4 * 4);
	private ovlData = new Float32Array(MAX_OVERLAYS * OVERLAY_FLOATS);
	private uiData = new Float32Array(MAX_UI_GLYPHS * UI_FLOATS);
	private figData = new ArrayBuffer(MAX_FIGS * 16);

	constructor(
		canvas: HTMLCanvasElement, own: boolean,
		private device: GPUDevice, private ctx: GPUCanvasContext,
		private extended: boolean, private opts: PageOptions,
		private pipes: { ground: GPURenderPipeline; text: GPURenderPipeline; fig: GPURenderPipeline; ovl: GPURenderPipeline; ui: GPURenderPipeline },
		private l0: GPUBindGroupLayout, private l1: GPUBindGroupLayout, private format: GPUTextureFormat
	) {
		this.canvas = canvas;
		this.ownCanvas = own;
		this.segStride = Math.max(256, device.limits.minUniformBufferOffsetAlignment);
		this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', maxAnisotropy: 16, addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
		this.frameBuf = device.createBuffer({ size: FRAME_VEC4 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		this.frameBuf2 = device.createBuffer({ size: FRAME_VEC4 * 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		this.segBuf = this.allocSeg();
		this.figBuf = device.createBuffer({ size: MAX_FIGS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		this.ovlBuf = device.createBuffer({ size: MAX_OVERLAYS * OVERLAY_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		this.uiBuf = device.createBuffer({ size: MAX_UI_GLYPHS * UI_FLOATS * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		this.extraBytes = 2 * FRAME_VEC4 * 16 + MAX_FIGS * 16 + MAX_OVERLAYS * OVERLAY_FLOATS * 4 + MAX_UI_GLYPHS * UI_FLOATS * 4;
		this.img = this.makeTexture(1, 1, 1);
		this.imgView = this.img.createView({ dimension: '2d-array' });
		this.g1 = this.makeG1();
		this.g1b = this.makeG1(this.frameBuf2);
		if (device.features.has('timestamp-query')) {
			this.qs = device.createQuerySet({ type: 'timestamp', count: 2 });
			this.qResolve = device.createBuffer({ size: 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
			for (let i = 0; i < 3; i++) this.qRead.push({ buf: device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST }), busy: false });
			this.extraBytes += 16 + 48;
		}
		if (opts.debug) {
			this.dbg = { frames: 0, lastGpuMs: NaN, gpuBytes: 0, lastDrawCalls: 0 };
			(window as unknown as { __page: Debug }).__page = this.dbg;
		}
		void device.lost.then((info) => {
			this.lost = true;
			if (info.reason !== 'destroyed') console.error(`page: WebGPU device lost (${info.reason}): ${info.message}`);
		});
	}

	private allocSeg() {
		this.extraBytes += this.segCap * this.segStride;
		return this.device.createBuffer({ size: this.segCap * this.segStride, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	}

	private makeG1(frame: GPUBuffer = this.frameBuf) {
		return this.device.createBindGroup({
			layout: this.l1,
			entries: [
				{ binding: 0, resource: { buffer: frame } },
				{ binding: 1, resource: { buffer: this.segBuf, size: SEG_BYTES } },
				{ binding: 2, resource: { buffer: this.figBuf } },
				{ binding: 3, resource: { buffer: this.ovlBuf } },
				{ binding: 4, resource: { buffer: this.uiBuf } }
			]
		});
	}

	private makeG0() {
		if (!this.reader) return null;
		return this.device.createBindGroup({
			layout: this.l0,
			entries: [
				{ binding: 6, resource: { buffer: this.reader } },
				{ binding: 27, resource: this.imgView },
				{ binding: 28, resource: this.sampler }
			]
		});
	}

	private makeTexture(w: number, h: number, layers: number) {
		const mips = Math.floor(Math.log2(Math.max(w, h))) + 1;
		let b = 0;
		for (let m = 0; m < mips; m++) b += Math.max(1, w >> m) * Math.max(1, h >> m) * 4 * layers;
		this.imgBytes = b;
		return this.device.createTexture({
			size: [w, h, layers], format: 'rgba8unorm-srgb', mipLevelCount: mips,
			usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
		});
	}

	async load(fonts: Uint8Array, model: ReadingModel, imageUrls: string[]): Promise<void> {
		const my = ++this.gen;
		const fb = readFontsBin(fonts);
		const asm = assemblePage(fb.table, model);
		this.uiGlyphs = glyphCount(fb.table);
		const bytes = asm.words.byteLength;
		const lim = Math.min(this.device.limits.maxStorageBufferBindingSize, this.device.limits.maxBufferSize);
		if (bytes > lim) throw new Error(`page: article buffer ${bytes} bytes exceeds the device storage binding limit ${lim}`);
		const size = Math.ceil(bytes / MIN_BUF_BYTES) * MIN_BUF_BYTES;
		const buf = this.device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
		this.device.queue.writeBuffer(buf, 0, asm.words);
		this.reader?.destroy();
		this.reader = buf;
		this.readerBytes = size;
		this.model = model;
		this.asm = asm;
		this.g0 = this.makeG0();
		this.force = true;
		void this.loadImages(my, imageUrls);
	}

	private async loadImages(my: number, urls: string[]) {
		if (!urls.length || !this.asm) return;
		const asm = this.asm;
		const blobs = await Promise.all(urls.map(async (u) => {
			try {
				const r = await fetch(u);
				if (!r.ok) throw new Error(String(r.status));
				return await r.blob();
			} catch (e) { console.warn(`page: image ${u}: ${(e as Error).message}`); return null; }
		}));
		const bmps = await Promise.all(blobs.map((b) => (b ? createImageBitmap(b, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' }).catch(() => null) : null)));
		if (my !== this.gen) { bmps.forEach((b) => b?.close()); return; }
		const dim = Math.max(1, ...bmps.map((b) => (b ? Math.max(b.width, b.height) : 1)));
		let L = Math.min(dim, MAX_LAYER, this.device.limits.maxTextureDimension2D);
		while (L > 256 && L * L * 4 * (4 / 3) * urls.length > MAX_IMAGE_BYTES) L >>= 1;
		const old = this.img;
		const tex = this.makeTexture(L, L, urls.length);
		const mips = Math.floor(Math.log2(L)) + 1;
		const scales = new Map<number, number>();
		await Promise.all(bmps.map(async (bmp, layer) => {
			if (!bmp) return;
			const f = Math.min(1, L / Math.max(bmp.width, bmp.height));
			const w0 = Math.max(1, Math.round(bmp.width * f));
			const h0 = Math.max(1, Math.round(bmp.height * f));
			for (let m = 0; m < mips; m++) {
				if (my !== this.gen) return;
				const w = Math.max(1, w0 >> m);
				const h = Math.max(1, h0 >> m);
				const src: ImageBitmap = w === bmp.width && h === bmp.height ? bmp : await createImageBitmap(bmp, { resizeWidth: w, resizeHeight: h, resizeQuality: 'high', premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
				this.device.queue.copyExternalImageToTexture({ source: src }, { texture: tex, mipLevel: m, origin: [0, 0, layer] }, [w, h]);
				if (src !== bmp) src.close();
			}
			scales.set(layer, (toF16(w0 / L) | (toF16(h0 / L) << 16)) >>> 0);
		}));
		bmps.forEach((b) => b?.close());
		if (my !== this.gen) { tex.destroy(); return; }
		this.img = tex;
		this.imgView = tex.createView({ dimension: '2d-array' });
		old.destroy();
		// uv scale words of the image rows
		const stride = REC2.image / 4;
		const wScale = fieldOffset('image', 'altOffset') >> 2;
		const patch = new Uint32Array(asm.imageIds.length * stride);
		patch.set(asm.words.subarray(asm.imagesAt, asm.imagesAt + patch.length));
		asm.imageIds.forEach((id, i) => { patch[i * stride + wScale] = scales.get(id) ?? 0; });
		this.device.queue.writeBuffer(this.reader!, asm.imagesAt * 4, patch);
		this.g0 = this.makeG0();
		this.force = true;
		this.onDirty();
	}

	resize(cssW: number, cssH: number, dpr: number): void {
		this.cssW = cssW;
		this.cssH = cssH;
		// phones: a 3x dpr full-screen canvas plus the f16 HDR format is what gets the tab killed; cap the pixel count and the texture dimension
		const maxDim = this.device.limits.maxTextureDimension2D;
		while (dpr > 1 && cssW * dpr * cssH * dpr > MAX_CANVAS_PIX) dpr = Math.max(1, dpr - 0.25);
		this.canvas.width = Math.max(1, Math.min(maxDim, Math.round(cssW * dpr)));
		this.canvas.height = Math.max(1, Math.min(maxDim, Math.round(cssH * dpr)));
		this.configure();
		this.force = true;
	}

	private configure() {
		const cfg: Record<string, unknown> = { device: this.device, format: this.format, alphaMode: this.opts.alpha };
		if (this.extended) cfg.toneMapping = { mode: 'extended' };
		this.ctx.configure(cfg as unknown as GPUCanvasConfiguration);
	}

	private scissor(x0: number, y0: number, x1: number, y1: number, s: number): [number, number, number, number] | null {
		const W = this.canvas.width;
		const H = this.canvas.height;
		const x = Math.max(0, Math.floor(x0 * s));
		const y = Math.max(0, Math.floor(y0 * s));
		const w = Math.min(W, Math.ceil(x1 * s)) - x;
		const h = Math.min(H, Math.ceil(y1 * s)) - y;
		return w > 0 && h > 0 ? [x, y, w, h] : null;
	}

	draw(f: PageFrame): void {
		if (this.lost || !this.model || !this.g0) return;
		if (!f.dirty && !this.force) return;
		const W = this.canvas.width;
		const H = this.canvas.height;
		if (!W || !H) return;
		this.force = false;
		const model = this.model;
		const dev = this.device;
		const s = W / f.viewW;

		const [lo, hi] = blockSpan(f, model.blocks.length);
		const maps = { alpha: f.blockAlpha, dy: f.blockDy, dx: f.blockDx };
		const runs = textRuns(model, lo, hi, maps).concat(noteRuns(model, f.noteFirst, f.noteCount, f.only));
		const nMain = runs.length;
		// lightbox: the image item of one block through a second frame uniform (the image fitted into its rect)
		let lb: { rect: { x: number; y: number; w: number; h: number } } | null = null;
		if (f.lightbox && f.lightbox.alpha > 0 && f.lightbox.rect.w > 0) {
			const L = f.lightbox;
			const b = model.blocks[L.block];
			let ik = -1;
			if (b) for (let k = b.firstItem; k < b.firstItem + b.itemCount; k++) if (itemType(model.items[k]) === ItemType.image) { ik = k; break; }
			if (ik >= 0) {
				const em = L.rect.w / Math.max(1e-6, L.em.x1 - L.em.x0);
				const f2: PageFrame = { ...f, emPx: em, originX: L.rect.x - L.em.x0 * em, originY: 0, scrollPx: L.em.y0 * em - L.rect.y, foldClipEm: 1e9, groundA: 0 };
				packFrame(f2, W, this.extended, this.extended ? Math.max(1, f.hdrGain) : 1, this.frameData2);
				dev.queue.writeBuffer(this.frameBuf2, 0, this.frameData2);
				runs.push({ first: ik, count: 1, alpha: L.alpha, dy: 0, dx: 0, clipBlock: -1 });
				lb = { rect: L.rect };
			}
		}
		const figs = exhibitInstances(model, lo, hi, maps);

		// per-frame writes: channels, frame uniform, run segments, figure list, overlays
		dev.queue.writeBuffer(this.reader!, CHAN_BASE * 4, f.chans.buffer as ArrayBuffer, f.chans.byteOffset, Math.min(f.chans.length, CHAN_FLOATS) * 4);
		packFrame(f, W, this.extended, this.extended ? Math.max(1, f.hdrGain) : 1, this.frameData);
		dev.queue.writeBuffer(this.frameBuf, 0, this.frameData);
		if (runs.length > this.segCap) {
			this.segBuf.destroy();
			this.extraBytes -= this.segCap * this.segStride;
			while (this.segCap < runs.length) this.segCap *= 2;
			this.segBuf = this.allocSeg();
			this.g1 = this.makeG1();
			this.g1b = this.makeG1(this.frameBuf2);
		}
		if (runs.length) {
			const seg = new ArrayBuffer((runs.length - 1) * this.segStride + SEG_BYTES);
			runs.forEach((r, i) => {
				const o = i * this.segStride;
				new Uint32Array(seg, o, 1)[0] = r.first;
				new Float32Array(seg, o + 8, 3).set([r.alpha, r.dy, r.dx]);
			});
			dev.queue.writeBuffer(this.segBuf, 0, seg);
		}
		if (figs.length) {
			const u = new Uint32Array(this.figData);
			const fl = new Float32Array(this.figData);
			figs.forEach((q, i) => { u[i * 4] = q.fig; fl[i * 4 + 1] = q.alpha; fl[i * 4 + 2] = q.dy; });
			dev.queue.writeBuffer(this.figBuf, 0, this.figData, 0, figs.length * 16);
		}
		// chrome first, then each exhibit's items after them (drawn earlier through firstInstance)
		const nOvl = packOverlays(f.overlays, this.extended, f.hdrGain, this.ovlData);
		const nUi = f.uiText?.length ? packUiText(f.uiText, this.uiGlyphs, this.extended, f.hdrGain, this.uiData) : 0;
		const exDraws: { clip: [number, number, number, number]; ovl0: number; nOvl: number; ui0: number; nUi: number }[] = [];
		const unders: { clip: [number, number, number, number]; ovl0: number; n: number }[] = [];
		let ovlEnd = nOvl;
		let uiEnd = nUi;
		for (const e of f.exhibits ?? []) {
			const clip = this.scissor(e.clip.x0, e.clip.y0, e.clip.x1, e.clip.y1, s);
			if (!clip) continue;
			const no = packOverlays(e.overlays, this.extended, f.hdrGain, this.ovlData, ovlEnd);
			const nu = packUiText(e.uiText, this.uiGlyphs, this.extended, f.hdrGain, this.uiData, uiEnd);
			if (no || nu) exDraws.push({ clip, ovl0: ovlEnd, nOvl: no, ui0: uiEnd, nUi: nu });
			ovlEnd += no;
			uiEnd += nu;
		}
		if (ovlEnd) dev.queue.writeBuffer(this.ovlBuf, 0, this.ovlData, 0, ovlEnd * OVERLAY_FLOATS);
		if (uiEnd) dev.queue.writeBuffer(this.uiBuf, 0, this.uiData, 0, uiEnd * UI_FLOATS);

		const enc = dev.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [{ view: this.ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }],
			...(this.qs ? { timestampWrites: { querySet: this.qs, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 } } : {})
		});
		let calls = 0;
		pass.setBindGroup(0, this.g0);
		const full = this.scissor(0, 0, f.viewW, f.viewH, s)!;
		pass.setScissorRect(...full);
		if (f.groundA > 0) {
			pass.setPipeline(this.pipes.ground);
			pass.setBindGroup(1, this.g1, [0]);
			pass.draw(3);
			calls++;
		}
		for (const u of unders) { // exhibit sets (spotlight, plinth) sit on the ground, behind the text and the compiled art
			pass.setScissorRect(...u.clip);
			pass.setPipeline(this.pipes.ovl);
			pass.setBindGroup(1, this.g1, [0]);
			pass.draw(4, u.n, 0, u.ovl0);
			calls++;
		}
		const clip = f.clip ? this.scissor(f.clip.x0, f.clip.y0, f.clip.x1, f.clip.y1, s) : full;
		if (clip) {
			pass.setScissorRect(...clip);
			pass.setPipeline(this.pipes.text);
			runs.slice(0, nMain).forEach((r, i) => {
				let sc: [number, number, number, number] | null = clip;
				if (r.clipBlock >= 0) {
					const b = model.blocks[r.clipBlock];
					const dy = f.blockDy?.get(r.clipBlock) ?? 0;
					const [x0, y0] = docToPx(f, b.x0, b.y0, dy);
					const [x1, y1] = docToPx(f, b.x1, b.y1, dy);
					const c = f.clip;
					sc = this.scissor(Math.max(x0, c?.x0 ?? -Infinity), Math.max(y0, c?.y0 ?? -Infinity), Math.min(x1, c?.x1 ?? Infinity), Math.min(y1, c?.y1 ?? Infinity), s);
				}
				if (!sc) return;
				pass.setScissorRect(sc[0], sc[1], sc[2], sc[3]);
				pass.setBindGroup(1, this.g1, [i * this.segStride]);
				pass.draw(4, r.count);
				calls++;
			});
			if (figs.length) {
				pass.setScissorRect(...clip);
				pass.setPipeline(this.pipes.fig);
				pass.setBindGroup(1, this.g1, [0]);
				pass.draw(4, figs.length);
				calls++;
			}
		}
		for (const e of exDraws) {
			pass.setScissorRect(...e.clip);
			pass.setBindGroup(1, this.g1, [0]);
			if (e.nOvl) {
				pass.setPipeline(this.pipes.ovl);
				pass.draw(4, e.nOvl, 0, e.ovl0);
				calls++;
			}
			if (e.nUi) {
				pass.setPipeline(this.pipes.ui);
				pass.draw(4, e.nUi, 0, e.ui0);
				calls++;
			}
		}
		if (nOvl) {
			pass.setScissorRect(...full);
			pass.setPipeline(this.pipes.ovl);
			pass.setBindGroup(1, this.g1, [0]);
			pass.draw(4, nOvl);
			calls++;
		}
		if (lb) {
			const sc = this.scissor(lb.rect.x - 1, lb.rect.y - 1, lb.rect.x + lb.rect.w + 1, lb.rect.y + lb.rect.h + 1, s);
			if (sc) {
				pass.setScissorRect(sc[0], sc[1], sc[2], sc[3]);
				pass.setPipeline(this.pipes.text);
				pass.setBindGroup(1, this.g1b, [nMain * this.segStride]);
				pass.draw(4, 1);
				calls++;
			}
		}
		if (nUi) {
			const uc = f.uiClip ? this.scissor(f.uiClip.x0, f.uiClip.y0, f.uiClip.x1, f.uiClip.y1, s) : full;
			if (uc) {
				pass.setScissorRect(...uc);
				pass.setPipeline(this.pipes.ui);
				pass.setBindGroup(1, this.g1, [0]);
				pass.draw(4, nUi);
				calls++;
			}
		}
		pass.end();

		let rb: { buf: GPUBuffer; busy: boolean } | undefined;
		if (this.qs && this.qResolve) {
			enc.resolveQuerySet(this.qs, 0, 2, this.qResolve, 0);
			rb = this.qRead.find((q) => !q.busy);
			if (rb) enc.copyBufferToBuffer(this.qResolve, 0, rb.buf, 0, 16);
		}
		dev.queue.submit([enc.finish()]);
		if (rb) {
			const q = rb;
			q.busy = true;
			q.buf.mapAsync(GPUMapMode.READ).then(() => {
				const t = new BigUint64Array(q.buf.getMappedRange().slice(0));
				q.buf.unmap();
				q.busy = false;
				const ms = Number(t[1] - t[0]) / 1e6;
				if (ms >= 0 && ms < 1000) {
					this.gpuMs.push(ms);
					if (this.gpuMs.length > 8) this.gpuMs.shift();
					if (this.dbg) this.dbg.lastGpuMs = this.lastGpuMs();
				}
			}).catch(() => { q.busy = false; });
		}
		this.frames++;
		this.drawCalls = calls;
		if (this.dbg) { this.dbg.frames = this.frames; this.dbg.lastDrawCalls = calls; this.dbg.gpuBytes = this.gpuBytes(); }
	}

	gpuBytes(): number { return this.readerBytes + this.imgBytes + this.extraBytes; }

	lastGpuMs(): number {
		if (!this.gpuMs.length) return NaN;
		return this.gpuMs.reduce((a, b) => a + b, 0) / this.gpuMs.length;
	}

	dispose(): void {
		this.gen++;
		this.reader?.destroy();
		this.img.destroy();
		this.frameBuf.destroy();
		this.frameBuf2.destroy();
		this.segBuf.destroy();
		this.figBuf.destroy();
		this.ovlBuf.destroy();
		this.uiBuf.destroy();
		this.qs?.destroy();
		this.qResolve?.destroy();
		this.qRead.forEach((q) => q.buf.destroy());
		this.device.destroy();
		if (this.ownCanvas) this.canvas.remove();
	}
}

/** Create the page pass on its own adapter and device. Throws when WebGPU is missing. */
export async function createPagePass(canvas: HTMLCanvasElement | null, opts: PageOptions): Promise<PagePass> {
	if (typeof navigator === 'undefined' || !navigator.gpu) throw new Error('page pass: WebGPU is not available in this browser (no fallback by design)');
	const adapter = await navigator.gpu.requestAdapter();
	if (!adapter) throw new Error('page pass: no WebGPU adapter');
	const requiredFeatures: GPUFeatureName[] = [];
	if (adapter.features.has('timestamp-query')) requiredFeatures.push('timestamp-query');
	const device = await adapter.requestDevice({ requiredFeatures });
	device.addEventListener?.('uncapturederror', (e) => console.error('page: WebGPU error', (e as GPUUncapturedErrorEvent).error.message));

	const own = !canvas;
	if (!canvas) {
		canvas = document.createElement('canvas');
		canvas.setAttribute('aria-hidden', 'true');
		canvas.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none';
		const dpr = window.devicePixelRatio || 1;
		canvas.width = Math.max(1, Math.round(window.innerWidth * dpr));
		canvas.height = Math.max(1, Math.round(window.innerHeight * dpr));
	}
	const ctx = canvas.getContext('webgpu');
	if (!ctx) throw new Error('page pass: canvas.getContext("webgpu") returned null');

	// the extended range float16 canvas when the display has HDR headroom, else the preferred 8 bit format (shader gamma-encodes)
	let format: GPUTextureFormat = navigator.gpu.getPreferredCanvasFormat();
	let extended = false;
	if (typeof matchMedia === 'function' && matchMedia('(dynamic-range: high)').matches) {
		try {
			ctx.configure({ device, format: 'rgba16float', alphaMode: opts.alpha, toneMapping: { mode: 'extended' } } as unknown as GPUCanvasConfiguration);
			format = 'rgba16float';
			extended = true;
		} catch { /* stay SDR */ }
	}
	if (!extended) ctx.configure({ device, format, alphaMode: opts.alpha });

	const vf = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
	const l0 = device.createBindGroupLayout({
		entries: [
			{ binding: 6, visibility: vf, buffer: { type: 'read-only-storage' } },
			{ binding: 27, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
			{ binding: 28, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
		]
	});
	const l1 = device.createBindGroupLayout({
		entries: [
			{ binding: 0, visibility: vf, buffer: { type: 'uniform' } },
			{ binding: 1, visibility: vf, buffer: { type: 'uniform', hasDynamicOffset: true, minBindingSize: SEG_BYTES } },
			{ binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
			{ binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
				{ binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } }
		]
	});
	const layout = device.createPipelineLayout({ bindGroupLayouts: [l0, l1] });
	const module = device.createShaderModule({ code: PAGE_WGSL });
	void module.getCompilationInfo().then((ci) => {
		const errs = ci.messages.filter((m) => m.type === 'error');
		if (errs.length) console.error('page: WGSL error: ' + errs.map((m) => `${m.lineNum}:${m.message}`).join(' | '));
	});
	const blend: GPUBlendState = {
		color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
		alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
	};
	const mk = (vs: string, fs: string, topology: GPUPrimitiveTopology) => device.createRenderPipelineAsync({
		layout,
		vertex: { module, entryPoint: vs },
		fragment: { module, entryPoint: fs, targets: [{ format, blend }] },
		primitive: { topology }
	});
	const [ground, text, fig, ovl, ui] = await Promise.all([
		mk('vs_ground', 'fs_ground', 'triangle-list'), mk('vs_text', 'fs_text', 'triangle-strip'),
		mk('vs_fig', 'fs_fig', 'triangle-strip'), mk('vs_ovl', 'fs_ovl', 'triangle-strip'), mk('vs_ui', 'fs_ui', 'triangle-strip')
	]);
	return new PageImpl(canvas, own, device, ctx, extended, opts, { ground, text, fig, ovl, ui }, l0, l1, format);
}
