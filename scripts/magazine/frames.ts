// Frames and threading (docs/MAGAZINE.md 1.4 steps 1 and 2): a body or code area becomes a frame whose baselines
// sit on the grid and whose available interval per line is a function of the exclusions placed on it.
import type { Frame, Rect } from '../../src/lib/magazine/types';
import { LINE_H, type Solved } from './grid';

/** Line box around a baseline: 1.2 em above, 0.4 em below (1.6 em tall). */
export const ASCENT = 1.2;
export const DESCENT = 0.4;
export const EXCLUDE_PAD = 0.5; // em kept clear between text and an exclusion
export const MIN_INTERVAL = 4; // em; narrower than this the line is blocked

const EPS = 1e-9;

export interface GridFrame extends Frame {
	thread: number;
	sheet: number;
	/** baseline spacing in em */
	step: number;
	/** number of baselines that fit */
	lines: number;
	exclusions: Rect[];
	baseline(line: number): number;
	exclude(r: Rect): void;
	width: number;
}

/** First baseline: the lowest grid multiple whose line box starts at or below the frame top. */
export function firstBaseline(top: number, step = LINE_H): number {
	return Math.ceil((top + ASCENT) / step - EPS) * step;
}

export function lineCount(top: number, bottom: number, step = LINE_H): number {
	const fb = firstBaseline(top, step);
	const n = Math.floor((bottom - DESCENT - fb) / step + EPS) + 1;
	return Math.max(0, n);
}

export function makeFrame(id: number, slot: string, rect: Rect, thread: number, sheet: number, step = LINE_H): GridFrame {
	const fb = firstBaseline(rect.y0, step);
	const lines = lineCount(rect.y0, rect.y1, step);
	const exclusions: Rect[] = [];
	const baseline = (line: number) => Math.round((fb + line * step) * 1e6) / 1e6;
	const interval = (line: number): readonly [number, number] | null => {
		if (line < 0 || line >= lines) return null;
		const b = baseline(line);
		const top = b - ASCENT, bot = b + DESCENT;
		let a = rect.x0, z = rect.x1;
		for (const e of exclusions) {
			if (Math.min(bot, e.y1) - Math.max(top, e.y0) <= 0.01) continue;
			if (e.x0 <= a + EPS) a = Math.max(a, e.x1 + EXCLUDE_PAD);
			else if (e.x1 >= z - EPS) z = Math.min(z, e.x0 - EXCLUDE_PAD);
			else if (e.x0 - a >= z - e.x1) z = e.x0 - EXCLUDE_PAD;
			else a = e.x1 + EXCLUDE_PAD;
		}
		return z - a >= MIN_INTERVAL ? [a, z] : null;
	};
	return { id, slot, rect, thread, sheet, step, lines, exclusions, baseline, interval, width: rect.x1 - rect.x0, exclude: (r) => { exclusions.push(r); } };
}

/** Body and code areas of a solved template as frames, ids in thread reading order (thread, then left to right, then top to bottom). */
export function buildFrames(s: Solved): GridFrame[] {
	const items = s.order
		.map((l) => s.areas[l])
		.filter((a) => a.slot.type === 'body' || a.slot.type === 'code');
	items.sort((a, b) => (a.slot.thread ?? 0) - (b.slot.thread ?? 0) || a.rect.x0 - b.rect.x0 || a.rect.y0 - b.rect.y0);
	return items.map((a, i) => {
		const sheetW = s.geom.sheetW;
		const sheet = Math.min(s.geom.sheets - 1, Math.floor((a.rect.x0 + 1e-6) / sheetW));
		return makeFrame(i, a.letter, a.rect, a.slot.thread ?? 0, sheet);
	});
}

/** Frames of each thread in reading order. */
export function threads(frames: GridFrame[]): Map<number, GridFrame[]> {
	const m = new Map<number, GridFrame[]>();
	for (const f of frames) {
		const l = m.get(f.thread);
		if (l) l.push(f); else m.set(f.thread, [f]);
	}
	return m;
}

export interface ThreadPos { frame: GridFrame; line: number }

/** Global line index within a thread (frames concatenated) to a frame and a line. null past the end. */
export function locate(thread: GridFrame[], global: number): ThreadPos | null {
	let g = global;
	for (const f of thread) {
		if (g < f.lines) return { frame: f, line: g };
		g -= f.lines;
	}
	return null;
}

export const threadCapacity = (thread: GridFrame[]) => thread.reduce((n, f) => n + f.lines, 0);
