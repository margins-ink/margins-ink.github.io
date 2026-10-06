// The 3D book of the room (docs/BOOK.md, book.rs): the shelf magazine lifts off, flies to the camera and its cover swings open onto one
// blank sheet. Reading itself happens on the page pass (src/lib/reading/page.ts) over the dimmed room, so the sheet carries no content:
// this file only owns the sheet geometry constants, the rd* scene uniforms and the small header buffer magazine.wgsl.ts reads.
import { MH, MH_WORDS } from './magazine.wgsl';

/** metres per layout em: the sheet is 38.7 em wide, 0.6 m, a little larger than a shelf magazine. */
export const EM = 0.0155;
/** sheet size in em */
export const SHEET_W = 0.6 / EM;
export const SHEET_H = 0.8 / EM;
/** open-book bow, radians (2.5 degrees) */
export const BOW = (2.5 * Math.PI) / 180;
export const GUTTER = 0.18;

/** Everything the book geometry and the shader depend on; written into the scene uniform with writeRd. */
export interface BookUniforms {
	/** reading blend 0..1 (the shader draws nothing below 0.9) */
	k: number;
	/** object index of the magazine whose cover is the cover board, or -1 */
	magObj: number;
	/** world x of the sheet's left edge (one sheet), y of the sheet top edge, z of the sheet plane */
	spineX: number;
	topY: number;
	z: number;
	/** front cover hinge 0 (closed) .. 1 (open), and whether the cover board is in play */
	hinge: number;
	cover: number;
}

export const RD_FLOATS = 24;

/** Write rd0..rd5 (24 floats) into the scene uniform array at float offset `at`. */
export function writeRd(out: Float32Array, at: number, u: BookUniforms) {
	out.set([
		u.k, u.magObj, EM, 0,
		u.spineX, u.topY, u.z, 0,
		0, 0, 0, 0,
		0, 0, 0, 0,
		-1, u.hinge, u.cover, 0,
		BOW, GUTTER, 1, 0
	], at);
}

/** The `reader` storage buffer: a header describing one blank single sheet, a zero palette (the shader's paper fallback) and nothing else. */
export function makeBookBuffer(device: GPUDevice): GPUBuffer {
	const words = new ArrayBuffer(64 * 4);
	const u = new Uint32Array(words);
	const f = new Float32Array(words);
	u[MH.magic] = 0x4d414732;
	f[MH.sheetW] = SHEET_W;
	f[MH.spreadW] = SHEET_W;
	f[MH.spreadH] = SHEET_H;
	u[MH.spreadN] = 1;
	u[MH.single] = 1;
	u[MH.palette] = MH_WORDS; // zeros: alpha 0 selects the paper fallback
	const buf = device.createBuffer({ size: 64 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	device.queue.writeBuffer(buf, 0, words);
	return buf;
}

/** A 1x1 image array for the unused reader_img binding. */
export function makeBookImage(device: GPUDevice) {
	const tex = device.createTexture({
		size: [1, 1, 1],
		format: 'rgba8unorm-srgb',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
	});
	const view = tex.createView({ dimension: '2d-array' });
	const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
	return { tex, view, sampler };
}
