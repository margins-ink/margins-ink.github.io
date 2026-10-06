// Pure channel evaluation (docs/MAGAZINE.md 5): keyframe tables to scalars at time t. No DOM, no node
// imports, so the CPU reference, the figure compiler's lint and the wasm host pointer reader share it.
// Semantics: before the first key the first value holds, after the last the last holds; the ease on key i
// shapes the segment from key i-1 to key i; `step` holds the previous value until the key's time.

import { Ease, type EaseName } from './format';
import type { Channel, Keyframe } from './types';

const BACK = 1.70158;

export function ease(name: EaseName, x: number): number {
	switch (name) {
		case 'linear': return x;
		case 'inSine': return 1 - Math.cos((x * Math.PI) / 2);
		case 'outSine': return Math.sin((x * Math.PI) / 2);
		case 'inOutSine': return -(Math.cos(Math.PI * x) - 1) / 2;
		case 'inCubic': return x * x * x;
		case 'outCubic': return 1 - (1 - x) ** 3;
		case 'inOutCubic': return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
		case 'step': return x >= 1 ? 1 : 0;
		case 'outBack': return 1 + (BACK + 1) * (x - 1) ** 3 + BACK * (x - 1) ** 2;
	}
}

const EASE_NAMES = Object.keys(Ease) as EaseName[];
export const easeFromId = (id: number): EaseName => EASE_NAMES.find((n) => Ease[n] === id) ?? 'linear';

type AnyKey = { t: number; v: number; ease: EaseName | number };

/** Value at time t of keys[first .. first+count) (sorted by t). Used by both the authoring and the packed form. */
export function evalKeys(keys: ArrayLike<AnyKey>, t: number, first = 0, count = keys.length - first): number {
	if (count <= 0) return 0;
	const last = first + count - 1;
	if (t <= keys[first].t) return keys[first].v;
	if (t >= keys[last].t) return keys[last].v;
	let lo = first;
	let hi = last; // keys[lo].t <= t < keys[hi].t
	while (hi - lo > 1) {
		const mid = (lo + hi) >> 1;
		if (keys[mid].t <= t) lo = mid;
		else hi = mid;
	}
	const a = keys[lo];
	const b = keys[hi];
	const e = typeof b.ease === 'number' ? easeFromId(b.ease) : b.ease;
	const span = b.t - a.t;
	const x = span > 0 ? (t - a.t) / span : 1;
	return a.v + (b.v - a.v) * ease(e, x);
}

export const evalChannel = (c: Channel | { keys: Keyframe[] }, t: number): number => evalKeys(c.keys, t);

/** Evaluate channels at time t into out[0..n): the per-frame channel uniform writer (CPU side). */
export function evalChannels(chans: readonly { keys: Keyframe[] }[], t: number, out: Float32Array | number[]): void {
	for (let i = 0; i < chans.length; i++) out[i] = evalKeys(chans[i].keys, t);
}

/** Same for the packed tables of format.ts (`chan` records index into `key` records). */
export function evalPacked(
	chans: readonly { firstKey: number; keyCount: number }[],
	keys: readonly { t: number; v: number; ease: number }[],
	t: number,
	out: Float32Array | number[]
): void {
	for (let i = 0; i < chans.length; i++) out[i] = evalKeys(keys, t, chans[i].firstKey, chans[i].keyCount);
}

/** Figure clock to timeline time: loop wraps, once and scrub clamp, static is the poster frame. */
export function figureTime(mode: 'loop' | 'once' | 'scrub' | 'static', clock: number, duration: number, poster: number): number {
	if (mode === 'static') return poster;
	if (mode === 'loop') return duration > 0 ? ((clock % duration) + duration) % duration : 0;
	return Math.min(Math.max(clock, 0), duration);
}
