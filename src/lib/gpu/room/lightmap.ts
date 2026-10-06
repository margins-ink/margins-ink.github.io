/**
 * Layout of the per-surface irradiance lightmaps (see docs/LIGHTING.md).
 * meta[(obj * 6 + face) * 4 ..] = (texel offset, nu, nv, level); nu = 0: no map for that face.
 * Box face f: axis a = f >> 1, sign + for even f; u runs along axis (a+1)%3, v along (a+2)%3.
 * Spheres use face 0 only: a lat-long grid (u = atan2(z, x), v = acos(y)).
 */
export const OBJ_FLOATS = 28;
export const TEXEL_FURNITURE = 0.05;
export const TEXEL_SHELL = 0.04;
export const FACE_MIN = 2;
export const FACE_MAX = 128;
export const FACE_MAX_SHELL = 192;

export interface LightmapLayout {
	meta: Uint32Array;
	texels: number;
}

export function buildLightmapLayout(objs: Float32Array, lvl: Float32Array): LightmapLayout {
	const n = objs.length / OBJ_FLOATS;
	const meta = new Uint32Array(n * 6 * 4);
	const levelOf = new Uint32Array(n);
	// the elevator cab list (lvl[3] = 1) is lit analytically and has no lightmap
	const isCab = new Uint8Array(n);
	for (let l = 0; l < lvl.length / 20; l++) {
		const start = lvl[l * 20];
		const count = lvl[l * 20 + 1];
		for (let i = start; i < start + count; i++) {
			levelOf[i] = l;
			if (lvl[l * 20 + 3] === 1) isCab[i] = 1;
		}
	}
	let off = 0;
	const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
	for (let i = 0; i < n; i++) {
		const b = i * OBJ_FLOATS;
		const kind = objs[b + 3];
		for (let f = 0; f < 6; f++) {
			const m = (i * 6 + f) * 4;
			let nu = 0;
			let nv = 0;
			if (isCab[i]) {
				// no map
			} else if (kind === 1 || kind === 3 || kind === 9) {
				// glass pane, accent panel and lamp bulb are emitters: never lit
			} else if (kind >= 8) {
				if (f === 0) {
					nu = clamp(Math.ceil((2 * Math.PI * objs[b + 4]) / TEXEL_FURNITURE), 8, 64);
					nv = nu >> 1;
				}
			} else {
				const a = f >> 1;
				const ts = kind === 4 ? TEXEL_SHELL : TEXEL_FURNITURE;
				const mx = kind === 4 ? FACE_MAX_SHELL : FACE_MAX;
				nu = clamp(Math.ceil((2 * objs[b + 4 + ((a + 1) % 3)]) / ts), FACE_MIN, mx);
				nv = clamp(Math.ceil((2 * objs[b + 4 + ((a + 2) % 3)]) / ts), FACE_MIN, mx);
			}
			meta[m] = off;
			meta[m + 1] = nu;
			meta[m + 2] = nv;
			meta[m + 3] = levelOf[i];
			off += nu * nv;
		}
	}
	return { meta, texels: off };
}
