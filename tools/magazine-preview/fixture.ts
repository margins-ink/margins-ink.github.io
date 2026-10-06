// A self-contained RDR2 fixture (plus fonts.bin) for the preview page: one `duo`-shaped distilled spread of the
// ifd copy with the real Inter and Instrument Sans glyph tables, a tinted quote field, diagram panels with a few
// shapes. It exists so the loop (watch.ts -> WebSocket -> page) works before the compile lane's pipeline lands, and
// as the test input for pack.ts. It does no real layout (greedy wrap, fixed frames), so it is not a layout oracle.
import { FontSet, F, GlyphTableBuilder } from '../../scripts/reader/fonts';
import { buildPalette, PAL_EXT } from '../../scripts/magazine/palette';
import { VOICES, voiceFor } from '../../scripts/magazine/voices';
import {
	ItemType, LINE_H, PAL2, RectKind, ShapeKind, ShapeFlag, SPREAD_H, SPREAD_W, packItem, packMagazine, CELL_H, CELL_W,
	type MagazineModel
} from '../../src/lib/magazine/format';
import { packFontsBin, type FontInfo } from '../../src/lib/reader/format';

export interface Meta {
	/** frame rectangles in spread em with flow order, for `frames=1` */
	frames: { id: number; x0: number; y0: number; x1: number; y1: number; label: string }[];
	/** per text line Knuth-Plass adjustment ratio (left-edge tint, red above 1.5); the fixture supplies slack as a stand-in */
	ratios: { x0: number; y0: number; y1: number; r: number }[];
}

export interface Fixture { fonts: Uint8Array; article: Uint8Array; meta: Meta }

const COPY = {
	headline: 'IFD is fine',
	definition: "Import From Derivation: during evaluation, the Nix language asks for a path whose bytes depend on a derivation's output.",
	deck: "The case against import-from-derivation is a case against CppNix's evaluator, not against the idea.",
	capA: 'When a thunk demands the contents of ${drv}/foo, the evaluator stops, calls out to the daemon, waits for the build, resumes.',
	capB: 'Eval and build are nodes in one graph. The graph grows as eval discovers more of it. A thunk that needs a build emits a request and yields.',
	quote: 'The IFD ban was a polite way to say "the reference evaluator cannot handle this yet." The phrasing outlived the constraint.'
};

const rgb565 = (c: number) => { const r = c & 255, g = (c >> 8) & 255, b = (c >> 16) & 255; return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3); };

export function buildFixture(slug = 'ifd', widthClass = 0): Fixture {
	const voice = voiceFor(VOICES.some((v) => v.slug === slug) ? slug : 'ifd');
	const fonts = new FontSet();
	const display = fonts.display(voice.wdth, voice.wght);
	const union = new GlyphTableBuilder();
	const glyphs: MagazineModel['glyphs'] = [];
	const lines: MagazineModel['lines'] = [];
	const rects: MagazineModel['rects'] = [];
	const shapes: MagazineModel['shapes'] = [];
	const boxes: { x0: number; y0: number; x1: number; y1: number; item: number }[] = [];
	const meta: Meta = { frames: [], ratios: [] };
	let frameId = 0;

	const addRect = (x0: number, y0: number, x1: number, y1: number, colour: number, kind: number) => {
		rects.push({ x0, y0, x1, y1, colour, kind, group: 0xffff });
		boxes.push({ x0, y0, x1, y1, item: packItem(ItemType.rect, rects.length - 1) });
	};
	const addShape = (kind: number, x0: number, y0: number, x1: number, y1: number, colour: number, flags: number, radius = 0, param = 0) => {
		shapes.push({ x0, y0, x1, y1, kind, colour, colour2: colour, flags, radius, param, group: 0xffff, chan: -1, mixChan: -1, aux: 0 });
		boxes.push({ x0: x0 - 0.3, y0: y0 - 0.3, x1: x1 + 0.3, y1: y1 + 0.3, item: packItem(ItemType.shape, shapes.length - 1) });
	};

	/** Greedy-wrapped text block in a frame; returns the next free baseline. */
	const text = (s: string, fi: number, size: number, x: number, y: number, width: number, colour: number, lead: number, label: string, features: string[] = []) => {
		const font = fonts.fonts[fi];
		const words = s.split(' ');
		const frame = frameId++;
		let line: string[] = [], base = y;
		const flush = () => {
			if (!line.length) return;
			const str = line.join(' ');
			const first = glyphs.length;
			let pen = x;
			for (const g of font.shape(str, features)) {
				const cs = font.outline(g.gid);
				if (cs.length) {
					const gi = union.add(`${fi}:${g.gid}`, cs, [fi, g.gid]);
					const gx = pen + g.xOffset * size, gy = base - g.yOffset * size;
					glyphs.push({ x: gx, y: gy, glyphId: gi, size, colour, flags: 0, charOffset: 0, group: 0xffff, frame });
					const b = union.boxes[gi];
					boxes.push({ x0: gx + b[0] * size - 0.25, y0: gy - b[3] * size - 0.25, x1: gx + b[2] * size + 0.25, y1: gy - b[1] * size + 0.25, item: packItem(ItemType.glyph, glyphs.length - 1) });
				}
				pen += g.xAdvance * size;
			}
			lines.push({ yTop: base - size, yBot: base + 0.3 * size, x0: x, x1: pen, firstGlyph: first, glyphCount: glyphs.length - first, charOffset: 0, frame });
			meta.ratios.push({ x0: x, y0: base - size, y1: base + 0.3 * size, r: 3 * Math.max(0, (width - (pen - x)) / width) });
			base += lead;
			line = [];
		};
		const measure = (t: string) => font.shape(t, features).reduce((a, g) => a + g.xAdvance, 0) * size;
		for (const w of words) {
			if (line.length && measure([...line, w].join(' ')) > width) flush();
			line.push(w);
		}
		flush();
		meta.frames.push({ id: frame, x0: x, y0: y - size, x1: x + width, y1: base - lead + 0.3 * size, label });
		return base;
	};

	// colours (palette slots) and accent from the voice
	const pal = buildPalette(voice.hue);
	const C = PAL2;
	const half = SPREAD_W / 2, top = 3 * LINE_H;
	// left sheet: headline, diagram A and its caption
	text(COPY.headline, display, 7.5, 4.5, top + 7.5 * 0.95, 32, C.heading, 8, 'H');
	addRect(4.5, top + 11, half - 3.5, top + 11 + 20 * 1.6 * 0.8, C.panel, RectKind.panel);
	addShape(ShapeKind.rrect, 6, top + 14, 16, top + 17.2, C.neutral2, ShapeFlag.hatch, 0.4);
	addShape(ShapeKind.rrect, 6, top + 19, 22, top + 22.2, C.accent, 0, 0.4);
	addShape(ShapeKind.line, 6, top + 25, 30, top + 25, C.muted, 0, 0.2);
	text(COPY.capA, F.sans, 0.78, 4.5, top + 11 + 20 * 1.28 + 3.2, 26, C.muted, LINE_H * 0.8, 'a');
	// right sheet: definition, deck, diagram B, captions, quote field
	let y = text(COPY.definition, display, 1.6, half + 3.5, top + 2, 32, C.ink, LINE_H, 'D');
	y = text(COPY.deck, F.body, 1.4, half + 3.5, y + 0.8, 32, C.ink, LINE_H, 'D');
	addRect(half + 3.5, y + 1, SPREAD_W - 4.5, y + 1 + 20 * 0.8 * 1.6, C.panel, RectKind.panel);
	addShape(ShapeKind.circle, half + 8, y + 5, half + 11, y + 8, C.accent, 0);
	addShape(ShapeKind.rrect, half + 16, y + 5, half + 19, y + 8, C.neutral2, ShapeFlag.stroke, 0.3, 0.2);
	text(COPY.capB, F.sans, 0.78, half + 3.5, y + 1 + 20 * 1.28 + 3.2, 32, C.muted, LINE_H * 0.8, 'b');
	addRect(half + 3.5, SPREAD_H - 15, SPREAD_W - 4.5, SPREAD_H - 5.5, C.field, RectKind.field);
	text(COPY.quote, display, 2.4, half + 5, SPREAD_H - 15 + 4.2, 28, PAL_EXT.fieldInk, 3.2, 'Q');

	// grid cells (6 x 1.6 em), items dilated 0.25 em by the boxes above
	const cols = Math.ceil(SPREAD_W / CELL_W), rows = Math.ceil(SPREAD_H / CELL_H);
	const cells: MagazineModel['cells'] = [];
	const items: number[] = [];
	const lists: number[][] = Array.from({ length: cols * rows }, () => []);
	for (const b of boxes) {
		const cx0 = Math.max(0, Math.floor(b.x0 / CELL_W)), cx1 = Math.min(cols - 1, Math.floor(b.x1 / CELL_W));
		const cy0 = Math.max(0, Math.floor(b.y0 / CELL_H)), cy1 = Math.min(rows - 1, Math.floor(b.y1 / CELL_H));
		for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) lists[cy * cols + cx].push(b.item);
	}
	for (const l of lists) { cells.push({ start: items.length, count: l.length }); items.push(...l); }

	const table = union.finish();
	const info: FontInfo[] = fonts.fonts.map((f) => f.info);
	const tags = union.tag;
	const fontsBin = packFontsBin(table, info, Uint32Array.from(tags.map((t) => Number(t[0]))), Uint32Array.from(tags.map((t) => Number(t[1]))));
	const model: MagazineModel = {
		widthClass, emPx0: 16, spreadW: SPREAD_W, spreadH: SPREAD_H, sheetW: 40, marginOuter: 4.5, marginSpine: 3.5, gutter: 1.2, cellW: CELL_W, cellH: CELL_H,
		plainTextBytes: 0,
		spreads: [{
			x: 0, w: SPREAD_W, h: SPREAD_H, template: 0, gridCols: cols, gridRows: rows, firstItem: 0, itemCount: items.length, firstCell: 0,
			tone565: rgb565(pal[C.ink]), materialMask: 1, accentIdx: C.accent, firstLine: 0, lineCount: lines.length
		}],
		cells, items, glyphs, rects, images: [], shapes, paths: [], strokes: [], segs: [], groups: [], numerals: [], digitSets: [], chans: [], keys: [], figures: [],
		lines, links: [], anchors: [], extra: { dir: new Uint32Array(0), curves: new Uint16Array(0), bands: new Uint32Array(0) },
		text: new Uint8Array(0), strings: new Uint8Array(0), palette: pal
	};
	return { fonts: fontsBin, article: packMagazine(model), meta };
}
