import type { Thought } from '$lib/thoughts';
import { createReading } from '../../ecs/reading';
import type { Reading, ReadingExports, ScrollExports } from '../../reading/abi';
import { ATLAS, MAP, SIGN, signRect, tileRect } from './atlas';
import wasmUrl from './world.wasm?url';
import { instantiateWasi } from '../../wasi';

export { wasiImports } from '../../wasi';

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
	/** The book (take off the shelf, carry, open, close; docs/BOOK.md). */
	reader: ReaderApi;
	/** The page: blocks, scroll, fold, figures (world/src/reading.rs). `world_tick` advances it together with the book, so the host never calls `reading.tick` in the room. */
	reading: Reading;
	/** the raw wasm exports */
	exports: unknown;
	/** Dev hot reload: update the named script (`decor`, `rooms`, ...) in place and re-pack. Returns the new buffers, or `{ error }` with the previous scene intact (docs/WORLD.md "Hot reload"). */
	reloadScene(name: string, src: string): SceneUpdate | { error: string };
}

/** The packed scene after a hot reload (the same fields as `World`). */
export interface SceneUpdate {
	floors: Floor[];
	levelH: number;
	roomH: number;
	roomD: number;
	objs: Float32Array;
	panes: Float32Array;
	lvl: Float32Array;
	links: Int32Array;
}

/** Events of the book (`event_poll`). The page has its own ring: `Reading.poll()` (READING_EVENTS in reading/abi.ts). */
export type ReaderEvent = { kind: 'opened' | 'closed' | 'sound' | 'phase'; arg: number };

/** Indices into `ReaderApi.state()`. */
export const RS = {
	t: 0, target: 1, article: 4, magObj: 5, lift: 6, camT: 7, mag: 12,
	/** book choreography (docs/BOOK.md): phase 0 shelf, 1 lifting, 2 carrying, 3 opening, 4 reading, 5 closing */
	phase: 40, carry: 41, face: 42, hinge: 43, reveal: 44, dim: 45, cardOn: 46, pagesOn: 47, cardLight: 48, curl: 49, bank: 50
} as const;

export interface ReaderApi {
	tick(dtMs: number): void;
	/** Open a book: it lifts off the shelf, or snaps open (cold deep link). The page itself is loaded through `World.reading`. */
	open(index: number, snap: boolean): boolean;
	close(snap: boolean): void;
	/** A click on a book: it starts lifting at once, before the article has loaded. */
	begin(index: number): void;
	setReadingPose(cx: number, cy: number, cz: number, halfW: number, halfH: number): void;
	poll(): ReaderEvent | null;
	/** 64 floats, a live view onto wasm memory (valid until the next call into wasm that may grow it). */
	state(): Float32Array;
	entityCount(): number;
}

const rect = (r: { x: number; y: number; w: number; h: number }) => [r.x, r.y, r.w, r.h];

interface Exports extends ReadingExports, ScrollExports {
	world_input(len: number): number;
	world_build(): number;
	scene_buf(len: number): number;
	scene_override(): number;
	scene_reload(): number;
	world_buf(id: number): number;
	world_buf_len(id: number): number;
	world_tick(dtMs: number): void;
	article_open(index: number, snap: number): number;
	article_close(snap: number): void;
	book_begin(index: number): void;
	set_reading_pose(cx: number, cy: number, cz: number, hw: number, hh: number): void;
	event_poll(): number;
	reader_state_ptr(): number;
	world_entity_count(): number;
}

/** event_poll kinds of the book: 1 opened, 2 closed, 11 sound, 12 phase */
const EVENTS: Record<number, ReaderEvent['kind']> = { 1: 'opened', 2: 'closed', 11: 'sound', 12: 'phase' };

function readerApi(x: Exports): ReaderApi {
	const poll = (): ReaderEvent | null => {
		for (let v = x.event_poll(); v !== 0; v = x.event_poll()) {
			const kind = EVENTS[v >>> 24];
			if (kind) return { kind, arg: v & 0xffffff }; // an unknown kind is skipped, not mislabelled
		}
		return null;
	};
	return {
		tick: (dt) => x.world_tick(dt),
		open: (i, snap) => x.article_open(i, snap ? 1 : 0) === 0,
		close: (snap) => x.article_close(snap ? 1 : 0),
		begin: (i) => x.book_begin(i),
		setReadingPose: (a, b, c, d, e) => x.set_reading_pose(a, b, c, d, e),
		poll,
		// re-derived on every call: a grown memory detaches old views
		state: () => new Float32Array(x.memory.buffer, x.reader_state_ptr(), 64),
		entityCount: () => x.world_entity_count()
	};
}

export async function loadWorld(items: Thought[]): Promise<World> {
	let memory!: WebAssembly.Memory;
	const instance = await instantiateWasi(fetch(wasmUrl), () => memory);
	const x = instance.exports as unknown as Exports;
	memory = x.memory;

	const input = new TextEncoder().encode(
		JSON.stringify({
			items: items.map((t, i) => ({ slug: t.slug, date: t.date, archived: t.archived, tex: rect(tileRect(i)) })),
			signs: Array.from({ length: Math.floor(ATLAS / SIGN.h) }, (_, i) => rect(signRect(i))),
			map: rect(MAP)
		})
	);
	const inPtr = x.world_input(input.length);
	new Uint8Array(memory.buffer, inPtr, input.length).set(input);

	// the views are copied out: the wasm heap is garbage once this function returns
	const bytes = (id: number) => memory.buffer.slice(x.world_buf(id), x.world_buf(id) + x.world_buf_len(id));
	const text = (id: number) => new TextDecoder().decode(bytes(id));
	const sendScript = (name: string, src: string) => {
		const b = new TextEncoder().encode(`${name}\n${src}`);
		// the call may grow the memory: read `memory.buffer` after it
		const ptr = x.scene_buf(b.length);
		new Uint8Array(memory.buffer, ptr, b.length).set(b);
	};
	const read = (): SceneUpdate => {
		const meta = JSON.parse(text(4));
		return {
			floors: meta.floors,
			levelH: meta.levelH,
			roomH: meta.roomH,
			roomD: meta.roomD,
			objs: new Float32Array(bytes(0)),
			panes: new Float32Array(bytes(1)),
			lvl: new Float32Array(bytes(2)),
			links: new Int32Array(bytes(3))
		};
	};
	// dev: start from the .flecs files on disk instead of the copies baked into the wasm
	if (import.meta.env.DEV) {
		const { sceneSources } = await import('./scene-hot');
		for (const [name, src] of Object.entries(await sceneSources())) {
			sendScript(name, src);
			if (x.scene_override() !== 0) console.error('world: scene_override', name, text(5));
		}
	}
	if (x.world_build() !== 0) throw new Error(text(5));
	return {
		...read(),
		reader: readerApi(x),
		reading: createReading(x),
		exports: x,
		reloadScene(name, src) {
			sendScript(name, src);
			return x.scene_reload() === 0 ? read() : { error: text(5) };
		}
	};
}
