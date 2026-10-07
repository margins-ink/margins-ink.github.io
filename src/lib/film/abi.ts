// The film exports of world.wasm (world/src/film, contract docs/NARRATED.md "Built contract") and a typed wrapper.
// The browser (ecs/reading.ts) and bun (scripts/film/engine.ts) both build their FilmApi from the instance exports with createFilmApi.

export interface FilmExports {
	memory: WebAssembly.Memory;
	film_buf(len: number): number;
	film_load(len: number): number;
	film_reload(len: number): number;
	film_inspect(len: number): number;
	film_align(len: number): number;
	film_align_clear(): void;
	film_info(): number;
	film_out_ptr(): number;
	film_out_len(): number;
	film_pack(t: number): number;
	film_draw_ptr(): number;
	film_meta_ptr(): number;
	film_str_ptr(i: number): number;
	film_str_len(i: number): number;
	exhibit_drive?(ex: number, verb: number, n: number): number;
}

export interface SayInfo {
	key: string; name: string; text: string; spoken: string; status: string; placeholder: boolean; cite: string;
	gap: number; start: number; dur: number; aligned: boolean; words: number;
	/** the shown words' [start, end] in film seconds */
	cw: [number, number][];
}
export interface GateInfo { t: number; hold: number; until: string; n: number; mount: number | null }
export interface CmdInfo { mount: number; t: number; verb: string; n: number }
export interface MountInfo { prop: number; id: string; dock: [number, number, number, number]; grabbable: boolean; resume: boolean }
export interface SceneInfo {
	name: string; heading: string; covers: string; start: number; end: number; still: number;
	says: SayInfo[]; gates: GateInfo[]; cmds: CmdInfo[]; mounts: MountInfo[]; placeholders: string[]; beats: number; props: number;
}
export interface FilmInfo { name: string; title: string; voice: { id: string; rev: string }; total: number; scenes: SceneInfo[]; items: number | null }

/** Stage frame in stage units and the meta row layout of `film_pack` (world/src/film/pack.rs) */
export const STAGE = { w: 32, h: 18 } as const;
export const META = { head: 8, mount: 8, scene: 0, ts: 1, t: 2, total: 3, sceneStart: 4, sceneEnd: 5, mounts: 6 } as const;

export interface MountRow { x: number; y: number; w: number; h: number; alpha: number; id: string; prop: number; grabbable: boolean }
export interface FilmFrame { count: number; items: Float32Array; scene: number; ts: number; t: number; total: number; mounts: MountRow[]; str(i: number): string }

export interface FilmApi {
	/** 0 ok, else the error text */
	load(src: string): string | null;
	reload(src: string): string | null;
	inspect(src: string): { ok: true; info: FilmInfo } | { ok: false; error: string };
	align(json: string): string | null;
	alignClear(): void;
	info(): FilmInfo;
	/** the stage draw list at film time t; `items` and `mounts` are valid until the next call */
	pack(t: number): FilmFrame;
	/** museum exhibit control by the film (`Do` beats): verbs 0 load preset n, 1 step n, 2 run, 3 reset, 4 toggle; false when unsupported */
	drive(ex: number, verb: number, n: number): boolean;
}

export function createFilmApi(x: FilmExports): FilmApi {
	const enc = new TextEncoder();
	const dec = new TextDecoder();
	const stage = (s: string): number => {
		const b = enc.encode(s);
		const p = x.film_buf(b.length);
		new Uint8Array(x.memory.buffer, p, b.length).set(b);
		return b.length;
	};
	const out = (): string => dec.decode(new Uint8Array(x.memory.buffer, x.film_out_ptr(), x.film_out_len()));
	const rows: MountRow[] = [];
	return {
		load: (src) => (x.film_load(stage(src)) === 0 ? null : out()),
		reload: (src) => (x.film_reload(stage(src)) === 0 ? null : out()),
		inspect(src) {
			const rc = x.film_inspect(stage(src));
			return rc === 0 ? { ok: true, info: JSON.parse(out()) as FilmInfo } : { ok: false, error: out() };
		},
		align: (json) => (x.film_align(stage(json)) === 0 ? null : out()),
		alignClear: () => x.film_align_clear(),
		info() {
			if (x.film_info() !== 0) throw new Error(out());
			return JSON.parse(out()) as FilmInfo;
		},
		pack(t) {
			const count = x.film_pack(t);
			const items = new Float32Array(x.memory.buffer, x.film_draw_ptr(), count * 8);
			const meta = new Float32Array(x.memory.buffer, x.film_meta_ptr(), META.head + META.mount * 6);
			const str = (i: number) => dec.decode(new Uint8Array(x.memory.buffer, x.film_str_ptr(i), x.film_str_len(i)));
			const n = meta[META.mounts] | 0;
			rows.length = 0;
			for (let i = 0; i < n; i++) {
				const o = META.head + i * META.mount;
				rows.push({ x: meta[o], y: meta[o + 1], w: meta[o + 2], h: meta[o + 3], alpha: meta[o + 4], id: str(meta[o + 5] | 0), prop: meta[o + 6] | 0, grabbable: meta[o + 7] !== 0 });
			}
			return { count, items, scene: meta[META.scene] | 0, ts: meta[META.ts], t: meta[META.t], total: meta[META.total], mounts: rows, str };
		},
		drive: (ex, verb, n) => (x.exhibit_drive ? x.exhibit_drive(ex, verb, n) === 0 : false)
	};
}
