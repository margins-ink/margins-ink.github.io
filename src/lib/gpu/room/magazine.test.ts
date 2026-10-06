import { describe, expect, test } from 'bun:test';
import {
	ItemType, NO_CHAN, NONE16, PALETTE2_SIZE, REC2, Sec2, packItem, packMagazine, unpackContainer, type MagazineModel
} from '../../magazine/format';
import { Sec as FSec, packContainer, FONTS_MAGIC } from '../../reader/format';
import { MAGAZINE_EVAL_WGSL, MAGAZINE_TRACE_WGSL, MAGAZINE_WGSL, CHAN_BASE, DATA_BASE, MH, MH_WORDS } from './magazine.wgsl';
import { BOW, EM, assemble, leafAngle, pickSpread, writeRd, RD_FLOATS, type Book, type MagazineUniforms } from './magazine';

const model = (): MagazineModel => ({
	widthClass: 0, emPx0: 16, spreadW: 80, spreadH: 56, sheetW: 40, marginOuter: 4.5, marginSpine: 3.5, gutter: 1.2,
	cellW: 6, cellH: 1.6, plainTextBytes: 5,
	spreads: [
		{ x: 0, w: 80, h: 56, template: 3, gridCols: 14, gridRows: 35, firstItem: 0, itemCount: 4, firstCell: 0, tone565: 0xf79e, materialMask: 3, accentIdx: 8, firstLine: 0, lineCount: 1, layer: 0 },
		{ x: 100, w: 80, h: 56, template: 4, gridCols: 14, gridRows: 35, firstItem: 4, itemCount: 0, firstCell: 1, tone565: 0xf79e, materialMask: 1, accentIdx: 8, firstLine: 0, lineCount: 0, layer: 0 }
	],
	cells: [{ start: 0, count: 4 }, { start: 4, count: 0 }],
	items: [packItem(ItemType.glyph, 0), packItem(ItemType.shape, 0), packItem(ItemType.stroke, 0), packItem(ItemType.numeral, 0)],
	glyphs: [{ x: 4.5, y: 4.8, glyphId: 0x80000001, size: 4.2, colour: 3, flags: 16, charOffset: 0, group: NONE16, frame: 2 }],
	rects: [],
	images: [{ x0: 0, y0: 0, x1: 10, y1: 10, imageId: 5, radius: 0, altOffset: 3 }],
	shapes: [{ x0: 8, y0: 3, x1: 18, y1: 7, kind: 0, colour: 8, colour2: 13, flags: 0, radius: 0.4, param: 0, group: 0, chan: 1, mixChan: NO_CHAN, aux: 0 }],
	paths: [],
	strokes: [{ firstSeg: 0, segCount: 1, width: 0.18, flags: 0, colour: 8, group: 0, dashOn: 0.6, dashOff: 0.4, phaseChan: 0, trimT0Chan: NO_CHAN, trimT1Chan: 2, widthChan: NO_CHAN, colour2: 0, mixChan: NO_CHAN }],
	segs: [{ x0: 18, y0: 1, x1: 18, y1: 6, x2: 18, y2: 12, cum: 0, len: 11 }],
	groups: [{ parent: -1, txChan: NO_CHAN, tyChan: NO_CHAN, rotChan: NO_CHAN, scaleChan: 3, opacityChan: NO_CHAN, tx: 0, ty: 0, rot: 0, scale: 1, opacity: 1, pivotX: 9, pivotY: 5 }],
	numerals: [{ x: 60, y: 30, cellW: 6.5, size: 14, colour: 13, style: 1, digits: 3, digitSet: 0, chan: 4, group: NONE16 }],
	digitSets: [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]],
	chans: [{ firstKey: 0, keyCount: 2 }],
	keys: [{ t: 0, v: 0, ease: 0 }, { t: 14, v: 72, ease: 5 }],
	figures: [{ id: 0, firstChan: 0, chanCount: 1, mode: 0, duration: 14, poster: 11, alt: 6, describe: 12, x0: 0, y0: 0, x1: 72, y1: 26, spread: 0 }],
	lines: [], links: [], anchors: [],
	extra: { dir: new Uint32Array(8), curves: new Uint16Array(8), bands: new Uint32Array(2) },
	text: new TextEncoder().encode('Hello'), strings: new TextEncoder().encode('a\0'),
	palette: Uint32Array.from({ length: PALETTE2_SIZE }, (_, i) => 0xff000000 | i)
});

const fontsBin = () =>
	unpackContainer(packContainer(FONTS_MAGIC, [], [
		{ id: FSec.dir, data: new Uint32Array(16).fill(7), count: 2 },
		{ id: FSec.curves, data: new Uint16Array(8).fill(3), count: 1 },
		{ id: FSec.bands, data: new Uint32Array(4).fill(9), count: 4 }
	]));

describe('magazine.wgsl', () => {
	test('block structure: balanced, bindings 6 27 28, no backticks, no reserved identifiers', () => {
		for (const s of [MAGAZINE_EVAL_WGSL, MAGAZINE_TRACE_WGSL]) {
			expect(s.includes('`')).toBe(false);
			expect(s.split('{').length).toBe(s.split('}').length);
			expect(s.split('(').length).toBe(s.split(')').length);
			expect(s.split('[').length).toBe(s.split(']').length);
			expect(s.includes('${')).toBe(false);
			expect(s.includes('undefined')).toBe(false);
			expect(s.includes('NaN')).toBe(false);
		}
		expect(MAGAZINE_EVAL_WGSL).toContain('@group(0) @binding(6) var<storage, read> reader');
		expect(MAGAZINE_EVAL_WGSL).toContain('@binding(27) var reader_img');
		expect(MAGAZINE_EVAL_WGSL).toContain('@binding(28) var img_s');
		expect(MAGAZINE_WGSL.match(/@binding\(/g)!.length).toBe(3);
		expect(MAGAZINE_WGSL.match(/var<storage/g)!.length).toBe(1);
		const reserved = ['active', 'target', 'get', 'sample', 'texture', 'ref', 'half', 'loop', 'filter', 'mod', 'set', 'match', 'type', 'new', 'use', 'self', 'shared', 'super', 'static', 'smooth', 'layout', 'final', 'from', 'meta', 'module', 'common', 'patch', 'template', 'this', 'with', 'where', 'move', 'mut', 'impl', 'trait', 'try', 'union', 'virtual', 'yield'];
		const decl = /\b(?:let|var|const|fn)\s+(?:<[^>]*>\s*)?([A-Za-z_][A-Za-z0-9_]*)/g;
		const params = /[(,]\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/g;
		for (const re of [decl, params]) {
			for (const m of MAGAZINE_WGSL.matchAll(re)) expect(reserved.includes(m[1]), `reserved word used as identifier: ${m[1]}`).toBe(false);
		}
	});

	test('strides in the shader come from REC2', () => {
		expect(MAGAZINE_EVAL_WGSL).toContain(`const SZ_SHAPE = ${REC2.shape / 4}u;`);
		expect(MAGAZINE_EVAL_WGSL).toContain(`const SZ_STROKE = ${REC2.stroke / 4}u;`);
		expect(MAGAZINE_EVAL_WGSL).toContain(`const SZ_SEG = ${REC2.seg / 4}u;`);
		expect(MAGAZINE_EVAL_WGSL).toContain(`const SZ_GROUP = ${REC2.group / 4}u;`);
		expect(MAGAZINE_EVAL_WGSL).toContain(`const SZ_SPREAD = ${REC2.spread / 4}u;`);
		// seg.cum is word 6 of the 8 word segment record
		expect(MAGAZINE_EVAL_WGSL).toContain('ff32(lr, 24u)');
		// header indices are unique and inside the header
		const v = Object.values(MH);
		expect(new Set(v).size).toBe(v.length);
		expect(Math.max(...v)).toBeLessThan(MH_WORDS);
	});

	test('control: a plant (backtick, unbalanced brace) is caught by the same checks', () => {
		const planted = MAGAZINE_TRACE_WGSL + ' } `';
		expect(planted.includes('`')).toBe(true);
		expect(planted.split('{').length).not.toBe(planted.split('}').length);
	});

	test('every item type of the sample is dispatched by spread_albedo', () => {
		for (const fn of ['mg_glyph', 'mg_rect', 'mg_image', 'mg_shape', 'mg_path', 'mg_stroke', 'mg_numeral']) {
			expect(MAGAZINE_EVAL_WGSL).toContain(`c = ${fn}(ix, p, fw`);
		}
	});
});

describe('assemble', () => {
	test('header, sections, channel table and image patch', () => {
		const art = unpackContainer(packMagazine(model()));
		const { words, imageIds } = assemble(art, fontsBin(), () => ({ w: 1024, h: 512 }), false);
		expect(words[MH.magic]).not.toBe(0);
		expect(new Float32Array(words.buffer)[MH.sheetW]).toBe(40);
		expect(new Float32Array(words.buffer)[MH.spreadW]).toBe(80);
		expect(words[MH.spreadN]).toBe(2);
		expect(words[MH.single]).toBe(0);
		expect(words[MH.chans]).toBe(CHAN_BASE);
		expect(MH_WORDS).toBe(32);
		expect(DATA_BASE).toBe(MH_WORDS + 256);
		for (let i = CHAN_BASE; i < DATA_BASE; i++) expect(words[i]).toBe(0);
		// fonts then the article's tables, each at the offset its header word says, byte for byte
		expect(words[MH.fdir]).toBe(DATA_BASE);
		expect(words[words[MH.fdir]]).toBe(7);
		const sp = art.sections.get(Sec2.spreads)!.bytes;
		const spw = new Uint32Array(sp.buffer, sp.byteOffset, sp.byteLength >> 2);
		expect(Array.from(words.subarray(words[MH.spreads], words[MH.spreads] + spw.length))).toEqual(Array.from(spw));
		expect(words[MH.spreads] + spw.length).toBe(words[MH.cells]);
		const it = art.sections.get(Sec2.items)!.bytes;
		expect(words[words[MH.items] + 2]).toBe(new Uint32Array(it.buffer, it.byteOffset, 4)[2]);
		// the shape record starts REC2.shape bytes before the next table's first word
		expect(words[MH.paths] - words[MH.shapes]).toBe(REC2.shape / 4);
		// image: id 5 became layer 0, uv scale is f16x2 (1024/2048, 512/2048)
		expect(imageIds).toEqual([5]);
		const iw = words[MH.images];
		expect(words[iw + 4] & 0xffff).toBe(0);
		expect(words[iw + 5]).toBe(0x3800 | (0x3400 << 16));
		// strides: every table is a whole number of records
		expect((words[MH.groups + 0] > 0) && (words[MH.numerals] - words[MH.groups]) % (REC2.group / 4) === 0).toBe(true);
	});

	test('control: wrong magic is rejected', () => {
		const bytes = packMagazine(model());
		bytes[0] ^= 0xff;
		expect(() => assemble(unpackContainer(bytes), fontsBin(), () => ({ w: 1, h: 1 }), false)).toThrow();
	});
});

describe('page_trace mirror', () => {
	const u = (o: Partial<MagazineUniforms> = {}): MagazineUniforms => ({
		k: 1, magObj: -1, progress: 0, dir: 0, spineX: 0, topY: 0.4, z: 0, index: 3, hoverSpread: -1, dark: false, peel: -1, bow: 0, ...o
	});
	const book: Book = { sheetW: 40, spreadH: 56, spreadCount: 8, single: false };
	// camera on +z looking down -z
	const ray = (x: number, y: number) => ({ o: [x, y, 2] as const, d: [0, 0, -1] as const });

	test('flat book: right sheet is the shown spread, x from the left edge, spine at x = 40 em', () => {
		const { o, d } = ray(10 * EM, 0.4 - 8 * EM);
		const h = pickSpread(book, u(), o, d)!;
		expect(h.spread).toBe(3);
		expect(h.x).toBeCloseTo(50, 3);
		expect(h.y).toBeCloseTo(8, 3);
		expect(h.a).toBeCloseTo(10, 3);
		const l = pickSpread(book, u(), ray(-10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(l.x).toBeCloseTo(30, 3);
		expect(pickSpread(book, u(), ray(41 * EM, 0.2).o, d)).toBeNull();
		expect(pickSpread(book, u({ k: 0.5 }), o, d)).toBeNull();
	});

	test('forward turn: p=0 leaf front shows this spread, p=1 the back shows the next on the left sheet', () => {
		const d = [0, 0, -1] as const;
		const at = ray(10 * EM, 0.4 - 8 * EM).o;
		const h0 = pickSpread(book, u({ dir: 1, progress: 0 }), at, d)!;
		expect(h0.spread).toBe(3);
		expect(h0.face).toBe(0);
		expect(h0.x).toBeCloseTo(50, 3);
		// the sheet under the leaf is the next spread (visible at p=1 on the right)
		const h1 = pickSpread(book, u({ dir: 1, progress: 1 }), at, d)!;
		expect(h1.spread).toBe(4);
		const left = pickSpread(book, u({ dir: 1, progress: 1 }), ray(-10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(left.face).toBe(1);
		expect(left.spread).toBe(4);
		expect(left.x).toBeCloseTo(30, 3);
	});

	test('backward turn mirrors it: at p=1 the leaf back shows the previous spread on the right sheet', () => {
		const d = [0, 0, -1] as const;
		const right = pickSpread(book, u({ dir: -1, progress: 1 }), ray(10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(right.face).toBe(1);
		expect(right.spread).toBe(2);
		expect(right.x).toBeCloseTo(50, 3);
		const left = pickSpread(book, u({ dir: -1, progress: 0 }), ray(-10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(left.face).toBe(0);
		expect(left.spread).toBe(3);
	});

	test('narrow class: one sheet, spine is the left edge, back of the leaf is blank, turning back runs forward in reverse', () => {
		const nb: Book = { sheetW: 28, spreadH: 56, spreadCount: 5, single: true };
		const d = [0, 0, -1] as const;
		const h = pickSpread(nb, u({ index: 2 }), ray(10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(h.spread).toBe(2);
		expect(h.x).toBeCloseTo(10, 3);
		expect(pickSpread(nb, u({ index: 2 }), ray(-5 * EM, 0.2).o, d)).toBeNull();
		const flipped = pickSpread(nb, u({ index: 2, dir: 1, progress: 1 }), ray(-10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(flipped.face).toBe(2);
		const back = pickSpread(nb, u({ index: 2, dir: -1, progress: 1 }), ray(10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(back.spread).toBe(1);
		expect(back.face).toBe(0);
		const start = pickSpread(nb, u({ index: 2, dir: -1, progress: 0 }), ray(10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(start.spread).toBe(2);
		const back0 = pickSpread(nb, u({ index: 2, dir: -1, progress: 0 }), ray(-10 * EM, 0.4 - 8 * EM).o, d)!;
		expect(back0.face).toBe(2);
	});

	test('bow lifts the outer edge toward the viewer; a ray from above the spine hits earlier at the rim', () => {
		const b = { ...u(), bow: BOW };
		const mid = pickSpread(book, b, [30 * EM, 0.2, 2], [0, 0, -1])!;
		expect(mid.t).toBeCloseTo(2 - 30 * EM * Math.sin(BOW) / Math.cos(BOW) * 1, 2);
	});

	test('leaf angles never go below the bow and are monotone along the leaf', () => {
		for (const p of [0, 0.25, 0.5, 0.75, 1]) {
			let prev = Infinity;
			for (let j = 0; j < 8; j++) {
				const a = leafAngle(j, p);
				expect(a).toBeGreaterThanOrEqual(BOW - 1e-9);
				expect(a).toBeLessThanOrEqual(prev + 1e-9);
				prev = a;
			}
		}
		expect(leafAngle(0, 0)).toBeCloseTo(BOW, 9);
		expect(leafAngle(7, 1)).toBeCloseTo(Math.PI - BOW, 9);
	});

	test('writeRd fills 24 floats in the documented order', () => {
		const out = new Float32Array(30);
		writeRd(out, 3, { k: 1, magObj: 7, progress: 0.5, dir: -1, spineX: 2, topY: 3, z: 4, index: 5, hoverSpread: 6, hoverRect: [1, 2, 3, 4], dark: true, peel: 0.25 });
		expect(RD_FLOATS).toBe(24);
		expect(Array.from(out.subarray(3, 3 + 24)).map((v) => +v.toFixed(4))).toEqual([
			1, 7, +EM.toFixed(4), 0.5, 2, 3, 4, -1, 5, 0, 7, 1, 1, 2, 3, 4, 0.25, 0, 0, 0, +BOW.toFixed(4), 0.18, 1, 0
		]);
	});
});
