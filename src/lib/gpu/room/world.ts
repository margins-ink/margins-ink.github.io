import type { Thought } from '$lib/thoughts';
import { ATLAS, MAP, SIGN, signRect, tileRect } from './atlas';
import wasmUrl from './world.wasm?url';

export interface Floor {
	label: string;
	title: string;
	sub: string;
}

/** The scene as the renderer consumes it. Built once by the Flecs world in world.wasm (see docs/WORLD.md). */
export interface World {
	floors: Floor[];
	levelH: number;
	roomH: number;
	roomD: number;
	/** 28 floats per object. */
	objs: Float32Array;
	/** 16 floats per level. */
	panes: Float32Array;
	/** 20 floats per level. */
	lvl: Float32Array;
	/** Object index of the magazine showing items[i], or -1. */
	links: Int32Array;
	/** Reader state machine (Reading/Scroll/Page entities, see docs/WORLD.md "Reader"). */
	reader: ReaderApi;
	/** the raw wasm exports (the magazine wrapper in ecs/magazine.ts drives them) */
	exports: unknown;
}

export type ReaderEvent = { kind: 'opened' | 'closed' | 'scrollEnd' | 'page' | 'spread' | 'layerOpened' | 'layerClosed' | 'focus' | 'overview' | 'hover'; arg: number };

/** Indices into `ReaderApi.state()`. */
export const RS = {
	t: 0, target: 1, scroll: 2, scrollMax: 3, article: 4, magObj: 5, lift: 6, camT: 7,
	firstPage: 8, visible: 9, centrePage: 10, pageCount: 11, mag: 12
} as const;

export interface ReaderApi {
	tick(dtMs: number): void;
	open(index: number, pageCount: number, sheetW: number, sheetH: number, gap: number, snap: boolean): boolean;
	close(snap: boolean): void;
	scrollBy(dyEm: number): void;
	scrollTo(yEm: number): void;
	/** Start a fling in em/s. */
	fling(vEmS: number): void;
	setViewport(viewHEm: number): void;
	setReadingPose(cx: number, cy: number, cz: number, halfW: number, halfH: number): void;
	poll(): ReaderEvent | null;
	/** 40 floats, a live view onto wasm memory (valid until the next call into wasm that may grow it). */
	state(): Float32Array;
	entityCount(): number;
}

const rect = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h];

/**
 * The module needs only a handful of WASI preview1 calls (clock, random seed for hash maps, empty environment, stderr).
 * Implemented here so no WASI shim dependency is shipped.
 */
export function wasiImports(getMem: () => WebAssembly.Memory) {
	const dv = () => new DataView(getMem().buffer);
	const dec = new TextDecoder();
	return {
		wasi_snapshot_preview1: {
			environ_sizes_get: (a: number, b: number) => {
				dv().setUint32(a, 0, true);
				dv().setUint32(b, 0, true);
				return 0;
			},
			environ_get: () => 0,
			clock_time_get: (_id: number, _prec: bigint, out: number) => {
				dv().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
				return 0;
			},
			fd_close: () => 0,
			fd_fdstat_get: () => 8,
			fd_prestat_get: () => 8,
			fd_prestat_dir_name: () => 8,
			fd_seek: () => 8,
			fd_write: (fd: number, iov: number, n: number, out: number) => {
				const v = dv();
				let total = 0;
				for (let i = 0; i < n; i++) {
					const p = v.getUint32(iov + i * 8, true);
					const l = v.getUint32(iov + i * 8 + 4, true);
					total += l;
					if (fd >= 1) console.warn('world.wasm:', dec.decode(new Uint8Array(getMem().buffer, p, l)));
				}
				v.setUint32(out, total, true);
				return 0;
			},
			poll_oneoff: () => 8,
			random_get: (p: number, n: number) => {
				crypto.getRandomValues(new Uint8Array(getMem().buffer, p, n));
				return 0;
			},
			proc_exit: (code: number) => {
				throw new Error(`world.wasm exited with ${code}`);
			}
		}
	};
}

interface Exports {
	memory: WebAssembly.Memory;
	world_input(len: number): number;
	world_build(): number;
	world_buf(id: number): number;
	world_buf_len(id: number): number;
	world_tick(dtMs: number): void;
	article_open(index: number, pageCount: number, sheetW: number, sheetH: number, gap: number, snap: number): number;
	article_close(snap: number): void;
	scroll_by(dy: number): void;
	scroll_to(y: number): void;
	scroll_fling(v: number): void;
	set_viewport(h: number): void;
	set_reading_pose(cx: number, cy: number, cz: number, hw: number, hh: number): void;
	event_poll(): number;
	reader_state_ptr(): number;
	world_entity_count(): number;
}

const EVENTS: ReaderEvent['kind'][] = ['opened', 'closed', 'scrollEnd', 'page', 'spread', 'layerOpened', 'layerClosed', 'focus', 'overview', 'hover'];

function readerApi(x: Exports): ReaderApi {
	return {
		tick: (dt) => x.world_tick(dt),
		open: (i, n, w, h, g, snap) => x.article_open(i, n, w, h, g, snap ? 1 : 0) === 0,
		close: (snap) => x.article_close(snap ? 1 : 0),
		scrollBy: (d) => x.scroll_by(d),
		scrollTo: (y) => x.scroll_to(y),
		fling: (v) => x.scroll_fling(v),
		setViewport: (h) => x.set_viewport(h),
		setReadingPose: (a, b, c, d, e) => x.set_reading_pose(a, b, c, d, e),
		poll() {
			const v = x.event_poll();
			return v === 0 ? null : { kind: EVENTS[(v >>> 24) - 1], arg: v & 0xffffff };
		},
		// re-derived on every call: a grown memory detaches old views
		state: () => new Float32Array(x.memory.buffer, x.reader_state_ptr(), 40),
		entityCount: () => x.world_entity_count()
	};
}

export async function loadWorld(items: Thought[]): Promise<World> {
	let memory!: WebAssembly.Memory;
	const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), wasiImports(() => memory));
	const x = instance.exports as unknown as Exports;
	memory = x.memory;

	const input = new TextEncoder().encode(
		JSON.stringify({
			items: items.map((t, i) => ({ slug: t.slug, date: t.date, archived: t.archived, tex: rect(tileRect(i)) })),
			signs: Array.from({ length: Math.floor(ATLAS / SIGN.h) }, (_, i) => rect(signRect(i))),
			map: rect(MAP)
		})
	);
	new Uint8Array(memory.buffer, x.world_input(input.length), input.length).set(input);

	// the views are copied out: the wasm heap is garbage once this function returns
	const bytes = (id: number) => memory.buffer.slice(x.world_buf(id), x.world_buf(id) + x.world_buf_len(id));
	if (x.world_build() !== 0) throw new Error(new TextDecoder().decode(bytes(5)));
	const meta = JSON.parse(new TextDecoder().decode(bytes(4)));
	return {
		floors: meta.floors,
		levelH: meta.levelH,
		roomH: meta.roomH,
		roomD: meta.roomD,
		objs: new Float32Array(bytes(0)),
		panes: new Float32Array(bytes(1)),
		lvl: new Float32Array(bytes(2)),
		links: new Int32Array(bytes(3)),
		reader: readerApi(x),
		exports: x
	};
}
