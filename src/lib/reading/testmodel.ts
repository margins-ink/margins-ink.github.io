// Test support for the selection, hit-test and find tests: a small synthetic RDR3 model with known geometry, and loaders for the built
// static/magazine bins. Not imported by the app.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
	BlockFlag, BlockKind, LineFlag, LinkKind, NOTE_BIT, sampleReading, unpackReading,
	type BlockRec, type GlyphInst, type LineRec, type LinkRec, type NoteRec, type ReadingModel
} from '../magazine/format';

export interface SLine { text: string; join?: boolean; marker?: string; links?: { c0: number; c1: number; kind: number }[] }
export interface SBlock { kind: number; flags?: number; x0?: number; x1?: number; lines?: SLine[]; fig?: number; sep?: string; h?: number }

const enc = new TextEncoder();
const ADV = 1; // em per character column
const LH = 1.62;

/**
 * Lays blocks out top to bottom (y in em, one column per character, size 1), builds the text blob (blocks joined by a blank line, lines of
 * a block joined by a space, nothing after a `join` line, a newline in code), glyphs (none for spaces, one per marker character) and links.
 * The block after a fold button starts the folded region, `foldBlocks` blocks long; blocks after it are the tail.
 */
export function synth(blocks: SBlock[], opts: { foldAfter?: number; foldBlocks?: number; peek?: number; note?: { text: string; anchor: number } } = {}): ReadingModel {
	const base = sampleReading();
	const out: BlockRec[] = [], lines: LineRec[] = [], glyphs: GlyphInst[] = [], links: LinkRec[] = [];
	let text = '';
	let bytes = 0;
	const put = (s: string) => { text += s; bytes += enc.encode(s).length; };
	let y = 2;
	let foldY = 0, foldH = 0;
	blocks.forEach((sb, bi) => {
		if (bi > 0) put('\n\n');
		const x0 = sb.x0 ?? 0;
		const b: BlockRec = {
			x0, y0: y, x1: sb.x1 ?? 34, y1: y, firstItem: 0, itemCount: 0, firstLine: lines.length, lineCount: sb.lines?.length ?? 0,
			anchor: 0, fig: sb.fig ?? -1, kind: sb.kind, level: 0, flags: sb.flags ?? 0, section: 0, textOff: bytes, textLen: 0
		};
		const isFoldedStart = opts.foldAfter !== undefined && bi === opts.foldAfter + 1;
		if (isFoldedStart) foldY = y;
		(sb.lines ?? []).forEach((sl, k) => {
			if (k > 0) put(sb.kind === BlockKind.code ? '\n' : sl.marker !== undefined ? '\n\n' : (sb.lines![k - 1].join ? '' : ' '));
			const marker = sl.marker ?? '';
			const start = bytes;
			put(marker);
			const textOff = bytes;
			put(sl.text);
			const L: LineRec = {
				yTop: y, yBot: y + LH, x0: x0 + (marker ? 0.6 : 0), x1: 0, firstGlyph: glyphs.length, glyphCount: 0, textOff, textLen: bytes - textOff,
				block: bi, size: 1, font: 0, flags: sl.join ? LineFlag.joinNext : 0
			};
			// one column per character of marker + text, no glyph for a space
			const X0 = x0 + (marker ? 0.6 : 0);
			let col = 0;
			let off = start;
			for (const ch of marker + sl.text) {
				if (ch !== ' ') glyphs.push({ x: X0 + col * ADV, y: y + 1, glyphId: 2, size: 1, colour: 0, flags: 0, charOffset: off, group: 0 });
				col++;
				off += enc.encode(ch).length;
			}
			L.glyphCount = glyphs.length - L.firstGlyph;
			L.x0 = X0;
			L.x1 = X0 + col * ADV;
			for (const lk of sl.links ?? []) {
				links.push({ x0: X0 + (lk.c0 + marker.length) * ADV, y0: y, x1: X0 + (lk.c1 + marker.length) * ADV, y1: y + LH, kind: lk.kind, offset: 0, line: lines.length, t0: 0, t1: 0 });
			}
			lines.push(L);
			y += LH;
		});
		if (!sb.lines?.length) y += sb.h ?? 6;
		b.y1 = y;
		b.textLen = bytes - b.textOff;
		out.push(b);
		y += 0.8;
		if (opts.foldAfter !== undefined && bi === opts.foldAfter + (opts.foldBlocks ?? 0)) foldH = y - foldY;
	});
	const notes: NoteRec[] = [];
	if (opts.note) {
		const nl: LineRec = {
			yTop: out[opts.note.anchor].y0, yBot: out[opts.note.anchor].y0 + LH, x0: 40, x1: 40 + opts.note.text.length, firstGlyph: glyphs.length, glyphCount: 0,
			textOff: 0, textLen: 0, block: (NOTE_BIT | 0) >>> 0, size: 1, font: 0, flags: 0
		};
		put('\n\n');
		nl.textOff = bytes;
		put(opts.note.text);
		nl.textLen = bytes - nl.textOff;
		let off = nl.textOff;
		let c = 0;
		for (const ch of opts.note.text) { if (ch !== ' ') glyphs.push({ x: 40 + c, y: nl.yTop + 1, glyphId: 2, size: 1, colour: 0, flags: 0, charOffset: off, group: 0 }); c++; off += enc.encode(ch).length; }
		nl.glyphCount = glyphs.length - nl.firstGlyph;
		notes.push({ x0: 40, y0: nl.yTop, x1: 40 + opts.note.text.length + 1, y1: nl.yBot, firstItem: 0, itemCount: 0, firstLine: lines.length, lineCount: 1, anchorBlock: opts.note.anchor, anchorLine: 0, refIndex: 0 });
		lines.push(nl);
	}
	return {
		...base, blocks: out, notes, lines, glyphs, links, text: enc.encode(text), docX0: -3, docX1: 54, docH: y + 4,
		foldY, foldH, peekH: foldH > 0 ? (opts.peek ?? 2) : 0, plainTextBytes: bytes, figures: [], anchors: [], items: [], cells: []
	};
}

export const demoBlocks = (): SBlock[] => [
	{ kind: BlockKind.hero, lines: [{ text: 'Title of the post' }] },
	{ kind: BlockKind.para, flags: BlockFlag.brief, lines: [{ text: 'alpha beta gamma delta', links: [{ c0: 6, c1: 10, kind: LinkKind.url }, { c0: 17, c1: 22, kind: LinkKind.ref }] }, { text: 'café half-', join: true }, { text: 'ated end.' }] },
	{ kind: BlockKind.list, lines: [{ marker: '• ', text: 'one apple' }, { marker: '• ', text: 'two pears and' }, { text: 'a plum' }, { marker: '• ', text: 'three' }] },
	{ kind: BlockKind.code, x1: 20, lines: [{ text: 'let x = 1;' }, { text: '  fn long_name(argument_one, argument_two)' }] },
	{ kind: BlockKind.figure, fig: 0, x0: -3, x1: 49 },
	{ kind: BlockKind.fold, flags: BlockFlag.hairTop, lines: [{ text: 'Read the full post' }] },
	{ kind: BlockKind.para, flags: BlockFlag.folded, lines: [{ text: 'hidden alpha one' }, { text: 'two in the fold' }] },
	{ kind: BlockKind.para, flags: BlockFlag.folded, lines: [{ text: 'folded last paragraph' }] },
	{ kind: BlockKind.para, lines: [{ text: 'tail paragraph after the fold' }] }
];

/** demoBlocks with the fold after block 5 (the button), two folded blocks, and a margin note on block 1. */
export const demoModel = (): ReadingModel => synth(demoBlocks(), { foldAfter: 5, foldBlocks: 2, note: { text: 'Side note alpha', anchor: 1 } });

// ---- real bins ---------------------------------------------------------------------------------------------------------------

const MAG = join(import.meta.dir, '../../../static/magazine');

/** The built RDR3 bin of `slug` for width class name ('wide' | 'mid' | 'narrow'), or null when it is not built. */
export function loadBin(slug: string, cls: 'wide' | 'mid' | 'narrow' = 'wide'): ReadingModel | null {
	if (!existsSync(MAG)) return null;
	const f = readdirSync(MAG).find((n) => n.startsWith(`${slug}.${cls}.`) && n.endsWith('.bin'));
	return f ? unpackReading(new Uint8Array(readFileSync(join(MAG, f)))) : null;
}
