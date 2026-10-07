// Typed wrapper over the reading exports of world.wasm (world/src/reading.rs, contract in src/lib/reading/abi.ts).
// JS owns no reading state: every gesture ends in `input(kind, a, b)`, the springs, culling, section spy and figure clocks run in Flecs.
import type { ReadingModel } from '../magazine/format';
import { createFilmApi, type FilmExports } from '../film/abi';
import { createScrollApi, packLoad, READING_EVENTS, XS, type ExhibitApi, type ExhibitExports, type Reading, type ReadingExports, type ScrollExports } from '../reading/abi';
import { instantiateWasi } from '../wasi';
import wasmUrl from '../gpu/room/world.wasm?url';

const enc = new TextEncoder();
const dec = new TextDecoder();

export function createExhibitApi(x: ExhibitExports): ExhibitApi {
	/** text -> staging buffer; exhibit_buf may grow memory, so the view is built after the call */
	const stage = (text: string): number => {
		const bytes = enc.encode(text);
		const ptr = x.exhibit_buf(bytes.length);
		new Uint8Array(x.memory.buffer, ptr, bytes.length).set(bytes);
		return bytes.length;
	};
	const out = (): string => dec.decode(new Uint8Array(x.memory.buffer, x.exhibit_out_ptr(), x.exhibit_out_len()));
	const outN = (n: number): string => dec.decode(new Uint8Array(x.memory.buffer, x.exhibit_out_ptr(), n));
	return {
		load: (ex, src) => (x.exhibit_load(ex, stage(src)) === 0 ? null : out()),
		reload: (ex, src) => (x.exhibit_reload(ex, stage(src)) === 0 ? null : out()),
		inspect(src) {
			const ok = x.exhibit_inspect(stage(src)) === 0;
			return { ok, text: out() };
		},
		pointer: (ex, kind, xe, ye, buttons, mods) => x.exhibit_pointer(ex, kind, xe, ye, buttons, mods),
		key: (code, mods) => (x.exhibit_key(code, mods) & 1) !== 0,
		focus: (ex) => x.exhibit_focus(ex),
		snapshot(ex) {
			const n = x.exhibit_snapshot(ex);
			return n === 0 ? null : outN(n);
		},
		restore: (ex, text) => x.exhibit_restore(ex, stage(text)) === 0,
		pack(ex) {
			const count = x.exhibit_pack(ex);
			return { count, items: new Float32Array(x.memory.buffer, x.exhibit_draw_ptr(), count * 8) };
		},
		str: (i) => dec.decode(new Uint8Array(x.memory.buffer, x.exhibit_str_ptr(i), x.exhibit_str_len(i))),
		state: () => new Float32Array(x.memory.buffer, x.exhibit_state_ptr(), XS.stride * XS.max)
	};
}

export function createReading(x: ReadingExports & ScrollExports & ExhibitExports): Reading {
	return {
		scroll: createScrollApi(x),
		exhibit: createExhibitApi(x),
		film: createFilmApi(x as unknown as FilmExports),
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
	const x = instance.exports as unknown as ReadingExports & ScrollExports & ExhibitExports;
	memory = x.memory;
	if (x.reading_init() !== 0) throw new Error('reading_init failed');
	return createReading(x);
}
