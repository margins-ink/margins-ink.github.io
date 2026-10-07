// The pure parts of the film host: the transport clock with its gates, and the caption word layout. No DOM, no GPU, no wasm: film.test.ts runs it as is.
// The film itself is a pure function of its time (world/src/film); everything here only decides which time to ask for.
import type { FilmInfo, GateInfo } from './abi';

// ---- transport: one film clock, gates that hold it for the viewer -----------------------------------------------------------

export interface Gate extends GateInfo { id: number; scene: number }

/** Every gate of the film in time order (a gate with `hold <= 0` never reaches the host). */
export function gatesOf(info: FilmInfo): Gate[] {
	const out: Gate[] = [];
	info.scenes.forEach((s, scene) => s.gates.forEach((g) => out.push({ ...g, id: out.length, scene })));
	return out.sort((a, b) => a.t - b.t).map((g, id) => ({ ...g, id }));
}

export const SPEEDS = [0.75, 1, 1.25, 1.5, 2] as const;

export interface Transport {
	/** film seconds; frozen at the gate's start while a gate holds */
	t: number;
	playing: boolean;
	speed: number;
	/** the active gate (the clock is held), else null */
	gate: Gate | null;
	/** real seconds the active gate has been held */
	held: number;
	/** gates already passed (by playing through, continuing, or seeking beyond) */
	passed: Set<number>;
	ended: boolean;
}

export const newTransport = (speed = 1): Transport => ({ t: 0, playing: false, speed, gate: null, held: 0, passed: new Set(), ended: false });

export type TransportEvent = { kind: 'enter' | 'leave'; gate: Gate } | { kind: 'ended' };

/** Move the clock to `nt` (a later time), stopping at the first unpassed gate on the way. Events are appended to `ev`. */
export function advanceTo(tr: Transport, gates: readonly Gate[], nt: number, total: number, ev: TransportEvent[]): void {
	if (tr.gate) return;
	for (const g of gates) {
		if (tr.passed.has(g.id) || g.t < tr.t || g.t > nt) continue;
		tr.t = g.t;
		tr.gate = g;
		tr.held = 0;
		ev.push({ kind: 'enter', gate: g });
		return;
	}
	tr.t = Math.min(nt, total);
	if (tr.t >= total) {
		tr.playing = false;
		tr.ended = true;
		ev.push({ kind: 'ended' });
	}
}

/** The viewer is done with the active gate (or its hold ran out): the clock jumps over the held silence and runs on. */
export function leaveGate(tr: Transport, ev: TransportEvent[]): void {
	const g = tr.gate;
	if (!g) return;
	tr.passed.add(g.id);
	tr.gate = null;
	tr.held = 0;
	tr.t = g.t + g.hold;
	ev.push({ kind: 'leave', gate: g });
}

/** Wall-clock step. `audioT`: the voice file's time when the film is slaved to it (and not held), else null. */
export function stepTransport(tr: Transport, gates: readonly Gate[], total: number, dtSec: number, audioT: number | null, ev: TransportEvent[]): void {
	if (!tr.playing) return;
	if (tr.gate) {
		tr.held += dtSec;
		if (tr.held >= tr.gate.hold) leaveGate(tr, ev);
		return;
	}
	const nt = audioT !== null ? Math.max(tr.t, audioT) : tr.t + dtSec * tr.speed;
	advanceTo(tr, gates, nt, total, ev);
}

/** Seek: the clock goes to `t`, gates before it count as passed (also those whose hold contains it), later gates are fresh. */
export function seekTo(tr: Transport, gates: readonly Gate[], t: number, total: number): void {
	tr.t = Math.max(0, Math.min(total, t));
	tr.gate = null;
	tr.held = 0;
	tr.ended = false;
	tr.passed.clear();
	for (const g of gates) if (g.t < tr.t) tr.passed.add(g.id);
}

export const sceneIndexAt = (info: FilmInfo, t: number): number => {
	let k = 0;
	for (let i = 0; i < info.scenes.length; i++) if (info.scenes[i].start <= t) k = i;
	return k;
};

export function fmtTime(s: number): string {
	const n = Math.max(0, Math.floor(s));
	return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

// ---- captions ---------------------------------------------------------------------------------------------------------------

/** Break words into lines no wider than maxW: the indices of the words of each line (a word wider than maxW takes a line alone). */
export function wrapWords(widths: readonly number[], space: number, maxW: number): number[][] {
	const lines: number[][] = [];
	let cur: number[] = [];
	let x = 0;
	widths.forEach((w, i) => {
		const add = cur.length ? space + w : w;
		if (cur.length && x + add > maxW) {
			lines.push(cur);
			cur = [i];
			x = w;
		} else {
			cur.push(i);
			x += add;
		}
	});
	if (cur.length) lines.push(cur);
	return lines;
}

/** The spoken word at time t: the last word that has started, -1 before the first. Words that never started are upcoming. */
export function activeWord(cw: readonly (readonly [number, number])[], t: number): number {
	let a = -1;
	for (let i = 0; i < cw.length; i++) {
		if (cw[i][0] <= t) a = i;
		else break;
	}
	return a;
}

/** The caption window: `rows` lines shown at once, paged so the active word's line is inside. */
export function captionPage(lines: readonly number[][], active: number, rows: number): number {
	if (active < 0) return 0;
	const li = lines.findIndex((l) => l.includes(active));
	return li < 0 ? 0 : Math.floor(li / rows) * rows;
}

/** The say shown at film time t: the line being spoken, held for `linger` seconds after it ends; -1 when none. */
export function sayAt(says: readonly { start: number; dur: number }[], t: number, linger = 0.6): number {
	let k = -1;
	for (let i = 0; i < says.length; i++) {
		if (says[i].start <= t + 0.05) k = i;
		else break;
	}
	if (k < 0) return -1;
	return t <= says[k].start + says[k].dur + linger ? k : -1;
}
