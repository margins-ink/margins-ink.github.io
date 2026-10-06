import type { Floor, Hotspot } from '$lib/gpu/room/room';

/** State shared between the persistent World canvas (site layout) and the pages that sit on top of it. */
export const worldState = $state({
	/** the WebGPU room is running */
	live: false,
	/** WebGPU is unavailable or the room failed to start: pages fall back to plain HTML */
	failed: false,
	spots: [] as Hotspot[],
	floors: [] as Floor[],
	/** elevator position 0..1, kept across routes so the shelf comes back where it was */
	progress: 0,
	/** slug of the article being read (from the URL), or null */
	reading: null as string | null,
	/** page index at the view centre and total pages while reading */
	page: 0,
	pages: 0
});
