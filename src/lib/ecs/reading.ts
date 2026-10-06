// Typed wrapper over the reading exports of world.wasm (world/src/reading.rs, contract in src/lib/reading/abi.ts).
// JS owns no reading state: every gesture ends in `input(kind, a, b)`, the springs, culling, section spy and figure clocks run in Flecs.
import type { ReadingModel } from '../magazine/format';
import { createScrollApi, packLoad, READING_EVENTS, type Reading, type ReadingExports, type ScrollExports } from '../reading/abi';
import { instantiateWasi } from '../wasi';
import wasmUrl from '../gpu/room/world.wasm?url';

export function createReading(x: ReadingExports & ScrollExports): Reading {
	return {
		scroll: createScrollApi(x),
		load(m: ReadingModel) {
			const words = packLoad(m);
			// reading_buf may grow the wasm memory: build the view after the call
			const ptr = x.reading_buf(words.length);
			new Uint32Array(x.memory.buffer, ptr, words.length).set(words);
			if (x.reading_load() !== 0) throw new Error('reading_load: malformed load buffer');
		},
		setViewport: (w, h, dpr, emPx, widthClass) => x.reading_set_viewport(w, h, dpr, emPx, widthClass),
		setScroll: (y) => x.reading_set_scroll(y),
		input: (kind, a, b = 0) => x.reading_input(kind, a, b),
		tick: (dtMs) => x.reading_tick(dtMs),
		// re-derived on every call: a grown memory detaches old views
		state: () => new Float32Array(x.memory.buffer, x.reading_state_ptr(), 64),
		ackDirty: () => x.reading_ack_dirty(),
		poll() {
			const v = x.reading_event_poll();
			if (v === 0) return null;
			return { kind: READING_EVENTS[(v >>> 24) - 1], arg: v & 0xffffff };
		},
		blockAt: (yEm) => x.reading_block_at(yEm),
		entityCount: () => x.reading_entity_count()
	};
}

/** Reader-only mode: world.wasm with a bare world that holds only the ReadingModule (no scene, no book). */
export async function loadReadingOnly(): Promise<Reading> {
	let memory!: WebAssembly.Memory;
	const instance = await instantiateWasi(fetch(wasmUrl), () => memory);
	const x = instance.exports as unknown as ReadingExports & ScrollExports;
	memory = x.memory;
	if (x.reading_init() !== 0) throw new Error('reading_init failed');
	return createReading(x);
}
