// The film engine of world.wasm for bun (scripts and tests): stage text into the module, run film_* exports, read the out buffer.
// Mirrors src/lib/film/abi.ts for the browser; here the wasm is instantiated straight from disk.
import fs from 'node:fs';
import path from 'node:path';
import { wasiImports } from '../../src/lib/wasi';

const WASM = process.env.FILM_WASM ?? path.resolve(import.meta.dir, '../../src/lib/gpu/room/world.wasm');

export interface FilmEngine {
	x: Record<string, any>;
	mem(): WebAssembly.Memory;
	/** run `film_load` (or `film_reload`) on `src`: null when ok, else the error text */
	load(src: string): string | null;
	/** `film_inspect`: lint + layout of a script without loading it */
	inspect(src: string): { ok: true; info: any } | { ok: false; error: string };
	/** `film_align`: staged align.json text; null when ok */
	align(json: string): string | null;
	alignClear(): void;
	/** `film_info` of the loaded film */
	info(): any;
	/** `film_pack(t)`: items (stride 8), strings and the meta row */
	pack(t: number): { count: number; items: Float32Array; meta: Float32Array; str(i: number): string };
}

export function newFilmEngine(): FilmEngine {
	let memory!: WebAssembly.Memory;
	const mod = new WebAssembly.Module(fs.readFileSync(WASM));
	const x = new WebAssembly.Instance(mod, wasiImports(() => memory)).exports as Record<string, any>;
	memory = x.memory as WebAssembly.Memory;
	x.reading_init();
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const stage = (s: string): number => {
		const b = enc.encode(s);
		const p = x.film_buf(b.length);
		new Uint8Array(memory.buffer, p, b.length).set(b);
		return b.length;
	};
	const out = (): string => dec.decode(new Uint8Array(memory.buffer, x.film_out_ptr(), x.film_out_len()));
	return {
		x,
		mem: () => memory,
		load(src) {
			const rc = x.film_load(stage(src));
			return rc === 0 ? null : out();
		},
		inspect(src) {
			const rc = x.film_inspect(stage(src));
			return rc === 0 ? { ok: true, info: JSON.parse(out()) } : { ok: false, error: out() };
		},
		align(json) {
			const rc = x.film_align(stage(json));
			return rc === 0 ? null : out();
		},
		alignClear: () => x.film_align_clear(),
		info() {
			const rc = x.film_info();
			if (rc !== 0) throw new Error(out());
			return JSON.parse(out());
		},
		pack(t) {
			const count = x.film_pack(t);
			const items = new Float32Array(memory.buffer.slice(x.film_draw_ptr(), x.film_draw_ptr() + count * 8 * 4));
			const meta = new Float32Array(memory.buffer.slice(x.film_meta_ptr(), x.film_meta_ptr() + 64 * 4));
			return {
				count,
				items,
				meta,
				str: (i) => dec.decode(new Uint8Array(memory.buffer, x.film_str_ptr(i), x.film_str_len(i)))
			};
		}
	};
}

export const FILM_SRC = (slug: string) => path.resolve(import.meta.dir, `../../src/routes/(site)/thoughts/${slug}/film.flecs`);
