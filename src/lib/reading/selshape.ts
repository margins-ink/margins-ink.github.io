// The selection shape and the copy acknowledgment, ported from ix (packages/web/src/lib/site/copy-flash.ts, which ports the os text
// field's `paint_selection_shape` and `selection_copy_scale`). Pure: rows in, overlay rows out; the reader draws them.
//
// Resting selection and copy flash are the SAME shape and colour: rows joined gap-free, corners facing a neighbouring row square,
// so the rows read as one shape. On copy the shape grows 2.5% on a fast ease-out pulse over 300 ms with the copied glyphs scaling
// rigidly about the selection centre, a soft white light sweeps left to right (opacity sin(pi * phase) * 0.12) and then the shape
// rests (`keep`: the text stays selected, nothing blinks).

export interface Row { left: number; top: number; right: number; bottom: number }

/** The one selection colour (ix SELECTION rgb(10 132 255 / 0.30)): drag-select and the copy flash. */
export const SELECTION_RGB = [10 / 255, 132 / 255, 255 / 255] as const;
export const SELECTION_ALPHA = 0.3;

export const PULSE_MS = 300;
/** the copied text jumps 2.5% */
export const PULSE_GROW = 0.025;
export const RADIUS = 4;
export const STAGGER_MS = 40;
export const ROW_IN_MS = 110;
export const SWEEP_ALPHA = 0.12;

/** 1 -> 1.025 -> 1: the os `selection_copy_scale` curve over the 300 ms pulse. */
export function pulse(phase: number): number {
	const p = phase <= 0.18 ? 1 - (1 - phase / 0.18) ** 3 : (1 - (phase - 0.18) / 0.82) ** 3;
	return 1 + PULSE_GROW * p;
}

/**
 * Merge fragments on one visual line, then stretch neighbouring lines to meet so the shape has no seams. Lines further apart than
 * `maxGap` (a paragraph break) stay separate shapes. `snap` rounds shared edges to device pixels so abutting translucent rows leave no seam.
 */
export function joinRows(fragments: readonly Row[], maxGap = Infinity, snap = 0): Row[] {
	const lines: Row[] = [];
	for (const f of [...fragments].sort((a, b) => a.top - b.top || a.left - b.left)) {
		const last = lines[lines.length - 1];
		if (last && Math.abs((f.top + f.bottom) / 2 - (last.top + last.bottom) / 2) < (last.bottom - last.top) / 2) {
			last.left = Math.min(last.left, f.left);
			last.right = Math.max(last.right, f.right);
			last.top = Math.min(last.top, f.top);
			last.bottom = Math.max(last.bottom, f.bottom);
		} else lines.push({ ...f });
	}
	const q = (v: number): number => (snap > 0 ? Math.round(v * snap) / snap : v);
	for (let i = 1; i < lines.length; i++) {
		const a = lines[i - 1], b = lines[i];
		if (b.top - a.bottom > maxGap) continue;
		const mid = q((a.bottom + b.top) / 2);
		a.bottom = mid;
		b.top = mid;
	}
	return lines;
}

/** Row `i` and its neighbour are one shape only when they touch. */
const touches = (a: Row, b: Row): boolean => Math.abs(a.bottom - b.top) < 0.5;

/** Corner radii (top-left, top-right, bottom-right, bottom-left) of row `i`: corners facing a neighbouring row that covers them stay square. */
export function rowRadii(rows: readonly Row[], i: number): [number, number, number, number] {
	const row = rows[i];
	const above = i > 0 && touches(rows[i - 1], row) ? rows[i - 1] : undefined;
	const below = i + 1 < rows.length && touches(row, rows[i + 1]) ? rows[i + 1] : undefined;
	const sq = (n: Row | undefined, left: boolean): boolean => n !== undefined && (left ? n.left <= row.left + 0.5 : n.right >= row.right - 0.5);
	const r = Math.min(RADIUS, (row.bottom - row.top) / 4);
	return [sq(above, true) ? 0 : r, sq(above, false) ? 0 : r, sq(below, false) ? 0 : r, sq(below, true) ? 0 : r];
}

/** Bit set of the corners that stay square: 1 top-left, 2 top-right, 4 bottom-right, 8 bottom-left (the overlay shape's `width`). */
export function squareMask(rows: readonly Row[], i: number): number {
	const [tl, tr, br, bl] = rowRadii(rows, i);
	return (tl === 0 ? 1 : 0) | (tr === 0 ? 2 : 0) | (br === 0 ? 4 : 0) | (bl === 0 ? 8 : 0);
}

export interface Bounds { left: number; top: number; right: number; bottom: number; cx: number; cy: number }
export function boundsOf(rows: readonly Row[]): Bounds {
	let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
	for (const r of rows) { left = Math.min(left, r.left); top = Math.min(top, r.top); right = Math.max(right, r.right); bottom = Math.max(bottom, r.bottom); }
	return { left, top, right, bottom, cx: (left + right) / 2, cy: (top + bottom) / 2 };
}

/** One drawn row of the shape (shape 9) or of its light (shape 10), in css px, already scaled about the selection centre. */
export interface ShapeRow { x: number; y: number; w: number; h: number; radius: number; mask: number; alpha: number; sweep: boolean; phase: number }

/** The sweep is encoded in the overlay's `width`: mask + 16 * round(phase * 1000). */
export const sweepWidth = (mask: number, phase: number): number => mask + 16 * Math.round(Math.min(Math.max(phase, 0), 1) * 1000);

/**
 * The rows of the shape `ms` after the copy (negative or beyond the pulse: the resting selection, scale 1, no light). Rows ease in on
 * the light only (the shape itself is already on screen: `keep`).
 */
export function shapeRows(rows: readonly Row[], ms: number, reduced = false): { scale: number; bounds: Bounds; rows: ShapeRow[] } {
	const bounds = boundsOf(rows);
	const live = !reduced && ms >= 0 && ms < PULSE_MS;
	const phase = live ? ms / PULSE_MS : 1;
	const scale = live ? pulse(phase) : 1;
	const out: ShapeRow[] = [];
	rows.forEach((row, i) => {
		const x = bounds.cx + (row.left - bounds.cx) * scale;
		const y = bounds.cy + (row.top - bounds.cy) * scale;
		const w = (row.right - row.left) * scale;
		const h = (row.bottom - row.top) * scale;
		const mask = squareMask(rows, i);
		const radius = Math.min(RADIUS, (row.bottom - row.top) / 4) * scale;
		out.push({ x, y, w, h, radius, mask, alpha: SELECTION_ALPHA, sweep: false, phase });
		if (live) {
			const enter = Math.min(Math.max((ms - i * STAGGER_MS) / ROW_IN_MS, 0), 1);
			out.push({ x, y, w, h, radius, mask, alpha: Math.max(Math.sin(Math.PI * phase), 0) * SWEEP_ALPHA * enter, sweep: true, phase });
		}
	});
	return { scale, bounds, rows: out };
}
