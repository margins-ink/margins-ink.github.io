// Encode and decode the UI font tables carried in fonts.bin (section Sec.ui). No node imports: shared by the build and the runtime.
// Section bytes, little-endian u32 words:
//   version (1), nFonts (2: sans, mono)
//   per font: notdefGid, notdefAdv (f32 em), nCp, nKern, cp[nCp] (sorted), gid[nCp], adv[nCp] (f32 em), kernKey[nKern] ((l << 16) | r), kernVal[nKern] (f32 em)
// A character with an advance but no outline (space) has gid NO_GLYPH.
import { NO_GLYPH, type UiFont, type UiFontTable, type UiTables } from './types';

export const UI_TABLE_VERSION = 1;
export const UI_FONTS: readonly UiFont[] = ['sans', 'mono'];

export interface UiFontData {
	notdef: { glyphId: number; adv: number };
	cp: number[];
	gid: number[];
	adv: number[];
	kern: [number, number, number][]; // left, right, em
}

export function encodeUiTables(d: Record<UiFont, UiFontData>): Uint8Array {
	const words: number[] = [UI_TABLE_VERSION, UI_FONTS.length];
	const f = new Float32Array(1);
	const u = new Uint32Array(f.buffer);
	const bits = (v: number) => ((f[0] = v), u[0]);
	for (const name of UI_FONTS) {
		const t = d[name];
		const order = t.cp.map((_, i) => i).sort((a, b) => t.cp[a] - t.cp[b]);
		words.push(t.notdef.glyphId >>> 0, bits(t.notdef.adv), t.cp.length, t.kern.length);
		for (const i of order) words.push(t.cp[i]);
		for (const i of order) words.push(t.gid[i] >>> 0);
		for (const i of order) words.push(bits(t.adv[i]));
		for (const k of t.kern) words.push(((k[0] << 16) | k[1]) >>> 0);
		for (const k of t.kern) words.push(bits(k[2]));
	}
	return new Uint8Array(Uint32Array.from(words).buffer);
}

export function decodeUiTables(bytes: Uint8Array): UiTables {
	// copy so the views are 4-aligned whatever the caller's byteOffset
	const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
	const w = new Uint32Array(buf);
	const f = new Float32Array(buf);
	if (w[0] !== UI_TABLE_VERSION) throw new Error(`ui tables: version ${w[0]}`);
	if (w[1] !== UI_FONTS.length) throw new Error(`ui tables: ${w[1]} fonts`);
	let p = 2;
	const out = {} as UiTables;
	for (const name of UI_FONTS) {
		const notdef = { glyphId: w[p], adv: f[p + 1] };
		const n = w[p + 2];
		const nk = w[p + 3];
		p += 4;
		const cp = w.slice(p, p + n); p += n;
		const gid = w.slice(p, p + n); p += n;
		const adv = f.slice(p, p + n); p += n;
		const kern = new Map<number, number>();
		for (let i = 0; i < nk; i++) kern.set(w[p + i], f[p + nk + i]);
		p += 2 * nk;
		out[name] = { notdef, cp, gid, adv, kern } satisfies UiFontTable;
	}
	if (p !== w.length) throw new Error('ui tables: trailing words');
	return out;
}

export { NO_GLYPH };
