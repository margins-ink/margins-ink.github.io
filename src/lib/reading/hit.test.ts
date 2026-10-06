import { describe, expect, test } from 'bun:test';
import { BlockKind, NOTE_BIT, type ReadingModel } from '../magazine/format';
import { NONE_HIT, caretAt, displayToLayoutY, foldEndOf, glyphCellEnd, hitTest, layoutToDisplayY, textIndex, type Hit, type ViewOpts } from './hit';
import { demoModel, loadBin } from './testmodel';

/** Fraction of sampled glyphs whose cell centre hits that very glyph (a hit function may be wrapped to plant a bug). */
function accuracy(m: ReadingModel, hit: (x: number, y: number) => Hit, opts: { dx?: (b: number) => number } = {}, stride = 1) {
	const ix = textIndex(m);
	let n = 0, ok = 0;
	const bad: string[] = [];
	m.lines.forEach((L, li) => {
		if (ix.isUi[li] || L.glyphCount <= 0) return;
		const bi = ix.isNote[li] ? -1 : L.block;
		const dx = bi >= 0 && m.blocks[bi].kind === BlockKind.code ? (opts.dx?.(bi) ?? 0) : 0;
		for (let j = L.firstGlyph; j < L.firstGlyph + L.glyphCount; j += stride) {
			const w = glyphCellEnd(m, li, j) - m.glyphs[j].x;
			if (w < 0.01) continue; // zero-advance record: its centre is its neighbour's edge
			const cx = m.glyphs[j].x + w / 2 - dx;
			if (bi >= 0 && m.blocks[bi].kind === BlockKind.code && (cx < m.blocks[bi].x0 || cx > m.blocks[bi].x1)) continue; // scrolled out of the panel
			n++;
			const h = hit(cx, (L.yTop + L.yBot) / 2);
			if (h.glyph === j && h.line === li && (h.kind === 'text' || h.kind === 'link' || h.kind === 'cite')) ok++;
			else if (bad.length < 5) bad.push(`line ${li} glyph ${j} got ${h.kind}/${h.glyph}`);
		}
	});
	return { n, ok, frac: n ? ok / n : 1, bad };
}

describe('hitTest on the synthetic page', () => {
	const m = demoModel();
	const codeBlock = m.blocks.findIndex((b) => b.kind === BlockKind.code);
	const dx = (b: number) => (b === codeBlock ? 6 : 0);

	test('every glyph centre hits its glyph, with code scrolled and without', () => {
		const a = accuracy(m, (x, y) => hitTest(m, x, y));
		expect(a.n).toBeGreaterThan(100);
		expect(a.bad).toEqual([]);
		expect(a.frac).toBe(1);
		const b = accuracy(m, (x, y) => hitTest(m, x, y, { codeDx: dx }), { dx });
		expect(b.frac).toBe(1);
	});

	test('planted off-by-one control fails the same check', () => {
		const planted = accuracy(m, (x, y) => {
			const h = hitTest(m, x, y);
			return h.glyph >= 0 ? { ...h, glyph: h.glyph + 1 } : h;
		});
		expect(planted.frac).toBeLessThan(0.05);
		// and a half-cell shift in x (hit the right edge instead of the centre) is caught too
		const shifted = accuracy(m, (x, y) => hitTest(m, x + 0.7, y));
		expect(shifted.frac).toBeLessThan(1);
	});

	test('kinds: link, cite, figure, code panel, margin, fold', () => {
		const para = m.blocks[1];
		const L = m.lines[para.firstLine];
		const mid = (L.yTop + L.yBot) / 2;
		expect(hitTest(m, 0.5, mid).kind).toBe('text');
		const url = hitTest(m, 7.5, mid);
		expect(url.kind).toBe('link');
		expect(m.links[url.link].kind).toBe(0);
		expect(hitTest(m, 19.5, mid).kind).toBe('cite');
		const fig = m.blocks.findIndex((b) => b.kind === BlockKind.figure);
		const fb = m.blocks[fig];
		expect(hitTest(m, 10, (fb.y0 + fb.y1) / 2)).toMatchObject({ kind: 'figure', block: fig, fig: 0 });
		const cb = m.blocks[codeBlock];
		const cl = m.lines[cb.firstLine];
		expect(hitTest(m, 15, (cl.yTop + cl.yBot) / 2).kind).toBe('code'); // panel right of the short first line
		expect(hitTest(m, 5.5, (cl.yTop + cl.yBot) / 2).kind).toBe('text');
		expect(hitTest(m, -2, 3)).toEqual(NONE_HIT); // left margin
		expect(hitTest(m, 10, m.docH + 5)).toEqual(NONE_HIT);
		const fold = m.blocks.findIndex((b) => b.kind === BlockKind.fold);
		const f = m.blocks[fold];
		expect(hitTest(m, 3, (f.y0 + f.y1) / 2)).toMatchObject({ kind: 'fold', block: fold });
	});

	test('margin note is hit before the blocks it overlaps in y', () => {
		const n = m.notes[0];
		const L = m.lines[n.firstLine];
		const h = hitTest(m, 40.5, (L.yTop + L.yBot) / 2);
		expect(h).toMatchObject({ kind: 'text', note: 0, block: -1 });
		expect(m.lines[h.line].block >>> 0).toBe(NOTE_BIT);
	});

	test('closed fold: tail moves up, folded blocks are unreachable, the peek band is the fold control', () => {
		const clip = m.foldY + m.peekH;
		const o: ViewOpts = { clipEm: clip };
		const tail = m.blocks[m.blocks.length - 1];
		const shift = foldEndOf(m) - clip;
		expect(shift).toBeGreaterThan(0);
		expect(layoutToDisplayY(m, tail.y0, clip)).toBeCloseTo(tail.y0 - shift);
		expect(displayToLayoutY(m, tail.y0 - shift, clip)).toBeCloseTo(tail.y0);
		const L = m.lines[tail.firstLine];
		const x = m.glyphs[L.firstGlyph].x + 0.5;
		const h = hitTest(m, x, (L.yTop + L.yBot) / 2 - shift, o);
		expect(h.line).toBe(tail.firstLine);
		expect(hitTest(m, x, m.foldY + 0.3, o).kind).toBe('fold');
		// no displayed point may return a line of a folded block
		for (let y = 0; y < m.docH - shift; y += 0.1) {
			for (const xx of [0.5, 5.5, 12.5]) {
				const r = hitTest(m, xx, y, o);
				if (r.line >= 0) expect(m.blocks[m.lines[r.line].block]?.flags & 2).toBe(0);
			}
		}
	});

	test('caretAt: boundaries, line ends and clamping above/below', () => {
		const para = m.blocks[1];
		const li = para.firstLine;
		const L = m.lines[li];
		const mid = (L.yTop + L.yBot) / 2;
		const ix = textIndex(m);
		expect(caretAt(m, -10, mid)!.off).toBe(ix.lineStart[li]);
		expect(caretAt(m, 100, mid)!.off).toBe(ix.lineEnd[li]);
		const g1 = m.glyphs[L.firstGlyph + 1];
		expect(caretAt(m, g1.x + 0.1, mid)!.off).toBe(g1.charOffset); // left half: before glyph 1
		expect(caretAt(m, g1.x + 0.9, mid)!.off).toBe(m.glyphs[L.firstGlyph + 2].charOffset);
		expect(caretAt(m, 3, -50)!.line).toBe(0);
		const lastBody = ix.bodyByY[ix.bodyByY.length - 1];
		expect(caretAt(m, 3, 1e6)!.line).toBe(lastBody);
		// notes domain stays in the margin
		expect(caretAt(m, 3, mid, { domain: 'notes' })!.note).toBe(0);
	});
});

describe('hitTest on the built articles', () => {
	for (const [slug, cls] of [['ifd', 'wide'], ['ifd', 'narrow'], ['hyperion', 'wide'], ['hyperion', 'mid']] as const) {
		const m = loadBin(slug, cls);
		test.skipIf(!m)(`${slug} ${cls}: 100 percent of glyph centres hit their glyph; planted off-by-one fails`, () => {
			const a = accuracy(m!, (x, y) => hitTest(m!, x, y));
			expect(a.n).toBeGreaterThan(2000);
			expect(a.bad).toEqual([]);
			expect(a.frac).toBe(1);
			const p = accuracy(m!, (x, y) => { const h = hitTest(m!, x, y); return h.glyph >= 0 ? { ...h, glyph: h.glyph + 1 } : h; }, {}, 7);
			expect(p.frac).toBeLessThan(0.05);
		});
	}
});
