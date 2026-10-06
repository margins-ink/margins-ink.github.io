// Figure lint (docs/MAGAZINE.md 2.3 and 2.4): returns messages, empty when clean. Works on the compiled
// figure from compile.ts (its `items`); a bare CompiledFigure gets the channel and time checks only.
// Not done here (needs the `type` lane palette and real glyph metrics): contrast ratios, harfbuzz widths.

import { MAX_CELL_ITEMS, CELL_W, CELL_H } from '../../../src/lib/magazine/format';
import type { CompiledFigure, Rect } from '../../../src/lib/magazine/types';
import type { CompiledFigureX, LintItem } from './compile';

const EPS = 0.05; // em tolerance, as the A1 overlap check
const area = (r: Rect) => Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
const overlap = (a: Rect, b: Rect): Rect | null => {
	const r = { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
	return r.x1 - r.x0 > EPS && r.y1 - r.y0 > EPS ? r : null;
};

/** A text box the reader sees at poster: a text node, or a label inside a shape. */
function textBoxes(items: LintItem[]): { id: string; rect: Rect; host?: Rect }[] {
	const out: { id: string; rect: Rect; host?: Rect }[] = [];
	for (const it of items) {
		if (it.opacityAtPoster < 0.5) continue;
		if (it.kind === 'text') out.push({ id: it.id, rect: it.poster });
		else if (it.labelRect) out.push({ id: `${it.id}.label`, rect: it.labelRect, host: it.poster });
	}
	return out;
}

export function lintFigure(f: CompiledFigure): string[] {
	const msg: string[] = [];
	const { duration, poster } = f.time;
	const [fw, fh] = f.size;

	if (f.describe.length < 40) msg.push(`${f.id}: describe is shorter than 40 characters`);
	if (!f.alt) msg.push(`${f.id}: alt is empty`);
	if (poster < 0 || poster > duration) msg.push(`${f.id}: poster ${poster} outside 0..${duration}`);

	for (const c of f.channels) {
		if (c.keys.length < 2) msg.push(`${f.id}: channel ${c.target} has fewer than 2 keys`);
		for (let i = 0; i < c.keys.length; i++) {
			const k = c.keys[i];
			if (i && k.t < c.keys[i - 1].t) msg.push(`${f.id}: channel ${c.target} key times decrease`);
			if (k.t > duration + 1e-9 || k.t < 0) msg.push(`${f.id}: channel ${c.target} key at ${k.t}s outside the timeline`);
		}
		if (/\.trim\.t[01]$/.test(c.target)) {
			for (let i = 1; i < c.keys.length; i++) {
				if (c.target.endsWith('t1') && c.keys[i].v < c.keys[i - 1].v - 1e-9) msg.push(`${f.id}: ${c.target} must not decrease (draw-on is monotone)`);
			}
			for (const k of c.keys) if (k.v < -1e-9 || k.v > 1 + 1e-9) msg.push(`${f.id}: ${c.target} value ${k.v} outside 0..1`);
		}
		if (c.target.endsWith('.opacity')) for (const k of c.keys) if (k.v < -1e-9 || k.v > 1 + 1e-9) msg.push(`${f.id}: ${c.target} value ${k.v} outside 0..1`);
	}

	const items = (f as Partial<CompiledFigureX>).items;
	if (!items) return msg;

	// everything inside the figure box, over the whole timeline (swept) and at poster
	const box: Rect = { x0: -EPS, y0: -EPS, x1: fw + EPS, y1: fh + EPS };
	const inside = (r: Rect) => r.x0 >= box.x0 && r.y0 >= box.y0 && r.x1 <= box.x1 && r.y1 <= box.y1;
	for (const it of items) {
		if (!inside(it.swept)) msg.push(`${f.id}: ${it.id} leaves the ${fw}x${fh} em box during the timeline (swept ${fmt(it.swept)})`);
		else if (it.labelRect && !inside(it.labelRect)) msg.push(`${f.id}: label of ${it.id} leaves the figure box`);
	}

	// poster readability: (transient text hidden at poster is allowed and ignored by the overlap check) labels fit their host, no text over text
	for (const it of items) {
		if (it.trimAtPoster && it.opacityAtPoster >= 0.5 && it.trimAtPoster[1] - it.trimAtPoster[0] < 0.99) msg.push(`${f.id}: ${it.id} is not fully drawn at poster (trim ${it.trimAtPoster.join('..')})`);
	}
	const boxes = textBoxes(items);
	for (const b of boxes) {
		if (b.host && (b.rect.x0 < b.host.x0 - EPS || b.rect.x1 > b.host.x1 + EPS)) msg.push(`${f.id}: label '${b.id}' is wider than its shape at poster`);
	}
	for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
		if (boxes[i].id.startsWith(boxes[j].id.split('.')[0] + '.') || boxes[j].id.startsWith(boxes[i].id.split('.')[0] + '.')) continue;
		if (overlap(boxes[i].rect, boxes[j].rect)) msg.push(`${f.id}: text '${boxes[i].id}' overlaps '${boxes[j].id}' at poster`);
	}

	// at most MAX_CELL_ITEMS items per 6 x 1.6 em cell (swept bounds; text counts per glyph, estimated by width)
	const cols = Math.ceil(fw / CELL_W), rows = Math.ceil(fh / CELL_H);
	const count = new Float64Array(cols * rows);
	for (const it of items) {
		const r = it.swept;
		const c0 = Math.max(0, Math.floor(r.x0 / CELL_W)), c1 = Math.min(cols - 1, Math.floor(r.x1 / CELL_W));
		const r0 = Math.max(0, Math.floor(r.y0 / CELL_H)), r1 = Math.min(rows - 1, Math.floor(r.y1 / CELL_H));
		const w = Math.max(r.x1 - r.x0, 1e-6);
		for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
			if (it.kind === 'text') {
				const share = Math.min(r.x1, (cx + 1) * CELL_W) - Math.max(r.x0, cx * CELL_W);
				count[cy * cols + cx] += Math.max(1, Math.ceil(it.glyphs * (share / w)));
			} else {
				count[cy * cols + cx] += 1 + (it.labelRect ? 0 : 0);
			}
		}
		if (it.labelRect && it.kind !== 'text') {
			const lr = it.labelRect;
			const lw = Math.max(lr.x1 - lr.x0, 1e-6);
			for (let cy = Math.max(0, Math.floor(lr.y0 / CELL_H)); cy <= Math.min(rows - 1, Math.floor(lr.y1 / CELL_H)); cy++)
				for (let cx = Math.max(0, Math.floor(lr.x0 / CELL_W)); cx <= Math.min(cols - 1, Math.floor(lr.x1 / CELL_W)); cx++) {
					const share = Math.min(lr.x1, (cx + 1) * CELL_W) - Math.max(lr.x0, cx * CELL_W);
					count[cy * cols + cx] += Math.max(1, Math.ceil(it.glyphs * (share / lw)));
				}
		}
	}
	let worst = 0, at = 0;
	count.forEach((v, i) => { if (v > worst) { worst = v; at = i; } });
	if (worst > MAX_CELL_ITEMS) msg.push(`${f.id}: cell (${at % cols}, ${Math.floor(at / cols)}) holds ${worst} items, the cap is ${MAX_CELL_ITEMS}; split or reduce`);

	void area;
	return msg;
}

const fmt = (r: Rect) => `${r.x0.toFixed(1)},${r.y0.toFixed(1)} to ${r.x1.toFixed(1)},${r.y1.toFixed(1)}`;
