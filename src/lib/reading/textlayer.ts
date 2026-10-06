// The DOM text layer (docs/READING_CONTRACT.md "DOM text layer"): the accessible, selectable, findable page.
// One element per RDR3 block, one absolutely positioned span.ln per layout line. Everything is placed in em through CSS custom
// properties (--x --y --w --h --s --lh, scaled by --em on .reader), so a resize or an Aa change only rewrites --em and never rebuilds.
// The spans are transparent (the canvas draws the ink); calibrate() fits each visible span to the layout width with scaleX.
import {
	BlockFlag, BlockKind, ItemType, LineFlag, LinkKind, itemIndex, itemType,
	type BlockRec, type LinkRec, type ReadingModel
} from '../magazine/format';

export interface TextLayerOpts {
	/** the fold region starts expanded (no hidden attribute) */
	foldExpanded?: boolean;
	/** aria-label of a code block; default "Code" */
	codeLabel?: (b: BlockRec, i: number) => string;
}

export interface HeadingInfo { block: number; level: number; id: string; text: string; section: number }

export interface LineRange { first: number; last: number }

export interface TextLayer {
	readonly doc: HTMLElement;
	readonly model: ReadingModel;
	/** element per block index (a block's own element; hero is a header) */
	readonly blocks: HTMLElement[];
	/** span per line index (empty lines included) */
	readonly lines: HTMLElement[];
	/** aside per note index */
	readonly notes: HTMLElement[];
	readonly headings: HeadingInfo[];
	foldRegion: HTMLElement | null;
	foldButton: HTMLButtonElement | null;
	foldBlock: number;
	tail: HTMLElement | null;
	/** layout width of each line in em (x1 - x0) */
	readonly lineW: Float32Array;
	/** scaleX currently applied per line */
	readonly lineK: Float32Array;
	/** calibration generation per line; a line is measured when it differs from `gen` */
	readonly calGen: Int32Array;
	gen: number;
	/** true: every line is measured again the next time it is in range (em change, font load) */
	invalidate(): void;
	setFold(expanded: boolean): void;
	/** collapsed tail translation: clipEm is RD.foldClipEm */
	setFoldClip(clipEm: number): void;
	blockText(i: number): string;
	/** exact source of a code block (lines joined by newlines) */
	codeSource(i: number): string;
	dispose(): void;
}

const layers = new WeakMap<HTMLElement, TextLayer>();
export const getTextLayer = (doc: HTMLElement): TextLayer | undefined => layers.get(doc);

/** Faces the text layer asks for; the reader waits on these before calibrating. */
export const READER_FONT_FACES = [
	'400 16px Inter', 'italic 400 16px Inter', '500 16px Inter', '600 16px Inter',
	'600 16px "Instrument Sans"', 'italic 400 16px "Instrument Sans"', '400 16px "Fira Code"'
] as const;

const CAL_CAP = 0.005;
const MARKER = /^(?:\[\d+\]|\d+[.)]|[-*•–])\s/;
const dec = new TextDecoder();
const e3 = (n: number) => String(Math.round(n * 1000) / 1000);

function tagFor(b: BlockRec): string {
	switch (b.kind) {
		case BlockKind.hero: return 'header';
		case BlockKind.heading: return `h${Math.min(6, Math.max(1, b.level || 2))}`;
		case BlockKind.para: case BlockKind.caption: case BlockKind.numerals: case BlockKind.label: case BlockKind.takeaway: return 'p';
		case BlockKind.code: return 'pre';
		case BlockKind.quote: case BlockKind.pullquote: return 'blockquote';
		case BlockKind.list: return 'ul';
		case BlockKind.image: case BlockKind.figure: return 'figure';
		case BlockKind.rule: return 'hr';
		case BlockKind.fold: return 'button';
		case BlockKind.refs: case BlockKind.footnotes: return 'ol';
		case BlockKind.note: return 'aside';
		case BlockKind.nextprev: return 'nav';
		default: return 'div';
	}
}

export function buildTextLayer(model: ReadingModel, doc: HTMLElement, opts: TextLayerOpts = {}): TextLayer {
	const { blocks, lines, links, notes } = model;
	const doc0 = model.docX0;
	const strCache = new Map<number, string>();
	const strAt = (off: number): string => {
		if (!off) return '';
		let s = strCache.get(off);
		if (s === undefined) {
			let e = off;
			while (e < model.strings.length && model.strings[e] !== 0) e++;
			s = dec.decode(model.strings.subarray(off, e));
			strCache.set(off, s);
		}
		return s;
	};
	const text = (a: number, b: number) => (b > a ? dec.decode(model.text.subarray(a, Math.min(b, model.text.length))) : '');
	const lineText = (li: number) => text(lines[li].textOff, lines[li].textOff + lines[li].textLen);

	// links bucketed per line, sorted by t0; continuation fragments are detected against the previous record of the same target
	const order = links.map((_, i) => i).sort((a, b) => links[a].line - links[b].line || links[a].t0 - links[b].t0);
	const byLine = new Map<number, number[]>();
	const isCont = new Set<number>();
	{
		let prev: LinkRec | null = null;
		for (const i of order) {
			const l = links[i];
			if (prev && prev.offset === l.offset && prev.kind === l.kind && l.line === prev.line + 1) isCont.add(i);
			prev = l;
			let a = byLine.get(l.line);
			if (!a) byLine.set(l.line, (a = []));
			a.push(i);
		}
	}

	const lineEls: HTMLElement[] = new Array(lines.length);
	const lineW = new Float32Array(lines.length);
	const lineK = new Float32Array(lines.length).fill(1);
	const calGen = new Int32Array(lines.length).fill(-1);
	for (let i = 0; i < lines.length; i++) lineW[i] = lines[i].x1 - lines[i].x0;

	function makeLine(li: number, ox: number, oy: number): HTMLElement {
		const L = lines[li];
		const span = document.createElement('span');
		span.className = 'ln';
		span.setAttribute('data-line', String(li));
		span.setAttribute('data-f', String(L.font));
		if (((L.flags ?? 0) & LineFlag.joinNext) !== 0) span.setAttribute('data-sp', '0');
		span.style.cssText = `--x:${e3(L.x0 - ox)};--y:${e3(L.yTop - oy)};--s:${e3(L.size)};--lh:${e3(L.yBot - L.yTop)}`;
		const start = L.textOff, end = L.textOff + L.textLen;
		let pos = start;
		for (const k of byLine.get(li) ?? []) {
			const lk = links[k];
			const t0 = Math.max(lk.t0, pos), t1 = Math.min(lk.t1, end);
			if (t1 <= t0) continue;
			if (t0 > pos) span.append(text(pos, t0));
			const a = document.createElement('a');
			const target = strAt(lk.offset);
			const href = (lk.kind === LinkKind.anchor || lk.kind === LinkKind.ref) && !target.startsWith('#') ? `#${target}` : target;
			a.setAttribute('href', href);
			a.setAttribute('data-link', String(k));
			a.setAttribute('data-lk', String(lk.kind));
			if (lk.kind === LinkKind.url && /^https?:/i.test(href)) {
				a.target = '_blank';
				a.rel = 'noopener noreferrer';
			}
			if (isCont.has(k)) {
				a.tabIndex = -1;
				a.setAttribute('aria-hidden', 'true');
			}
			a.textContent = text(t0, t1);
			span.append(a);
			pos = t1;
		}
		if (pos < end) span.append(text(pos, end));
		lineEls[li] = span;
		return span;
	}

	const blockEls: HTMLElement[] = new Array(blocks.length);
	const noteEls: HTMLElement[] = new Array(notes.length);
	const headings: HeadingInfo[] = [];
	const foldActive = model.foldH > 0;
	const foldEnd = model.foldY + model.foldH;
	const frag = document.createDocumentFragment();
	let region: HTMLElement | null = null;
	let tail: HTMLElement | null = null;
	let foldButton: HTMLButtonElement | null = null;
	let foldBlock = -1;
	const expanded = !!opts.foldExpanded;

	const notesOf = new Map<number, number[]>();
	notes.forEach((n, i) => {
		let a = notesOf.get(n.anchorBlock);
		if (!a) notesOf.set(n.anchorBlock, (a = []));
		a.push(i);
	});

	const parentFor = (y0: number, flags: number): HTMLElement => {
		if (foldActive && (flags & BlockFlag.folded)) {
			if (!region) {
				region = document.createElement('div');
				region.className = 'fold-region';
				region.id = 'fold-region';
				if (!expanded) region.setAttribute('hidden', 'until-found');
				frag.append(region);
			}
			return region;
		}
		if (foldActive && y0 >= foldEnd - 1e-3) {
			if (!tail) {
				tail = document.createElement('div');
				tail.className = 'tail';
				frag.append(tail);
			}
			return tail;
		}
		return frag as unknown as HTMLElement;
	};

	function groupLines(el: HTMLElement, b: BlockRec, first: number, count: number, wrap: (li: number, cur: HTMLElement | null) => HTMLElement | null) {
		let cur: HTMLElement | null = null;
		for (let k = 0; k < count; k++) {
			const li = first + k;
			const w = wrap(li, cur);
			if (w && w !== cur) { cur = w; el.append(w); }
			(cur ?? el).append(makeLine(li, b.x0, b.y0));
		}
	}
	const gEl = (tag: string, cls: string) => {
		const x = document.createElement(tag);
		x.className = `g ${cls}`;
		return x;
	};

	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		const prevB = i > 0 ? blocks[i - 1] : null;
		const parent = parentFor(b.y0, b.flags);
		let el: HTMLElement;
		// a caption directly after a figure nests into it as its figcaption
		const nestedCaption = b.kind === BlockKind.caption && prevB && (prevB.kind === BlockKind.figure || prevB.kind === BlockKind.image);
		if (nestedCaption) {
			el = document.createElement('figcaption');
			el.className = 'b';
			el.style.cssText = `--x:${e3(b.x0 - prevB!.x0)};--y:${e3(b.y0 - prevB!.y0)};--w:${e3(b.x1 - b.x0)};--h:${e3(b.y1 - b.y0)}`;
		} else {
			el = document.createElement(tagFor(b));
			el.className = 'b';
			el.style.cssText = `--x:${e3(b.x0 - doc0)};--y:${e3(b.y0)};--w:${e3(b.x1 - b.x0)};--h:${e3(b.y1 - b.y0)}`;
		}
		el.setAttribute('data-block', String(i));
		el.setAttribute('data-kind', String(b.kind));
		if (b.flags) el.setAttribute('data-flags', String(b.flags));
		const id = strAt(b.anchor);
		if (id) el.id = id;
		blockEls[i] = el;

		switch (b.kind) {
			case BlockKind.hero: {
				// the build emits the title, dek and byline as three hero blocks (level 1, 2, 3)
				const tag = b.level === 2 ? 'p' : b.level === 3 ? 'p' : 'h1';
				const cls = b.level === 2 ? 'dek' : b.level === 3 ? 'hero-meta' : 'hero-title';
				let g: HTMLElement | null = null;
				groupLines(el, b, b.firstLine, b.lineCount, () => (g ??= gEl(tag, cls)));
				break;
			}
			case BlockKind.list: case BlockKind.refs: case BlockKind.footnotes: {
				if (b.kind === BlockKind.list && b.lineCount > 0 && /^\d/.test(lineText(b.firstLine))) {
					const ol = document.createElement('ol');
					ol.className = 'b';
					ol.style.cssText = el.style.cssText;
					for (const a of Array.from(el.attributes)) if (a.name !== 'class' && a.name !== 'style') ol.setAttribute(a.name, a.value);
					el = ol;
					blockEls[i] = el;
				}
				groupLines(el, b, b.firstLine, b.lineCount, (li, cur) => (cur === null || MARKER.test(lineText(li)) ? gEl('li', 'item') : cur));
				break;
			}
			case BlockKind.code: {
				el.setAttribute('role', 'region');
				el.tabIndex = 0;
				el.setAttribute('aria-label', opts.codeLabel?.(b, i) ?? 'Code');
				const slot = document.createElement('div');
				slot.className = 'copy-slot';
				slot.setAttribute('data-block', String(i));
				const inner = document.createElement('div');
				inner.className = 'code-inner';
				let maxX = b.x1;
				for (let k = 0; k < b.lineCount; k++) maxX = Math.max(maxX, lines[b.firstLine + k].x1 + 1.2);
				inner.style.cssText = `--iw:${e3(maxX - b.x0)}`;
				for (let k = 0; k < b.lineCount; k++) inner.append(makeLine(b.firstLine + k, b.x0, b.y0));
				el.append(slot, inner);
				break;
			}
			case BlockKind.figure: {
				el.setAttribute('role', 'group');
				el.tabIndex = 0;
				el.setAttribute('aria-roledescription', 'interactive figure');
				const f = b.fig >= 0 ? model.figures[b.fig] : undefined;
				const label = f ? strAt(f.describe) || strAt(f.alt) : '';
				if (label) el.setAttribute('aria-label', label);
				if (b.fig >= 0) el.setAttribute('data-fig', String(b.fig));
				for (let k = 0; k < b.lineCount; k++) el.append(makeLine(b.firstLine + k, b.x0, b.y0));
				break;
			}
			case BlockKind.image: {
				let alt = '', imageId = -1;
				for (let k = 0; k < b.itemCount; k++) {
					const w = model.items[b.firstItem + k];
					if (itemType(w) === ItemType.image) {
						const im = model.images[itemIndex(w)];
						if (im) { alt = strAt(im.altOffset); imageId = im.imageId; }
						break;
					}
				}
				const btn = document.createElement('button');
				btn.type = 'button';
				btn.className = 'image-btn';
				btn.setAttribute('aria-label', alt || 'Image');
				btn.setAttribute('data-image', String(imageId));
				el.setAttribute('data-alt', alt);
				el.append(btn);
				for (let k = 0; k < b.lineCount; k++) el.append(makeLine(b.firstLine + k, b.x0, b.y0));
				break;
			}
			case BlockKind.fold: {
				const btn = el as HTMLButtonElement;
				btn.type = 'button';
				btn.classList.add('fold');
				btn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
				btn.setAttribute('aria-controls', 'fold-region');
				if (b.lineCount > 0) for (let k = 0; k < b.lineCount; k++) el.append(makeLine(b.firstLine + k, b.x0, b.y0));
				else el.textContent = text(b.textOff, b.textOff + b.textLen) || 'Read the full text';
				foldButton = btn;
				if (foldBlock < 0) foldBlock = i;
				break;
			}
			case BlockKind.nextprev:
				el.setAttribute('aria-label', 'More posts');
				for (let k = 0; k < b.lineCount; k++) el.append(makeLine(b.firstLine + k, b.x0, b.y0));
				break;
			case BlockKind.rule:
				break;
			default:
				for (let k = 0; k < b.lineCount; k++) el.append(makeLine(b.firstLine + k, b.x0, b.y0));
		}

		if (b.kind === BlockKind.heading) {
			let t = '';
			for (let k = 0; k < b.lineCount; k++) t += (k && !(lines[b.firstLine + k - 1].flags & LineFlag.joinNext) ? ' ' : '') + lineText(b.firstLine + k);
			headings.push({ block: i, level: b.level || 2, id, text: t, section: b.section });
		}

		if (nestedCaption) blockEls[i - 1].append(el);
		else parent.append(el);
		for (const ni of notesOf.get(i) ?? []) {
			const n = notes[ni];
			const na = document.createElement('aside');
			na.className = 'b note';
			na.setAttribute('data-note', String(ni));
			na.setAttribute('data-kind', String(BlockKind.note));
			na.style.cssText = `--x:${e3(n.x0 - doc0)};--y:${e3(n.y0)};--w:${e3(n.x1 - n.x0)};--h:${e3(n.y1 - n.y0)}`;
			for (let k = 0; k < n.lineCount; k++) na.append(makeLine(n.firstLine + k, n.x0, n.y0));
			noteEls[ni] = na;
			parent.append(na);
		}
	}
	for (let ni = 0; ni < notes.length; ni++) {
		if (noteEls[ni]) continue;
		// a note whose anchor block index is out of range: still part of the document
		const n = notes[ni];
		const na = document.createElement('aside');
		na.className = 'b note';
		na.setAttribute('data-note', String(ni));
		na.setAttribute('data-kind', String(BlockKind.note));
		na.style.cssText = `--x:${e3(n.x0 - doc0)};--y:${e3(n.y0)};--w:${e3(n.x1 - n.x0)};--h:${e3(n.y1 - n.y0)}`;
		for (let k = 0; k < n.lineCount; k++) na.append(makeLine(n.firstLine + k, n.x0, n.y0));
		noteEls[ni] = na;
		frag.append(na);
	}
	if (foldActive && !region) {
		region = document.createElement('div');
		region.className = 'fold-region';
		region.id = 'fold-region';
		if (!expanded) region.setAttribute('hidden', 'until-found');
		frag.append(region);
	}
	doc.replaceChildren(frag);

	const blockText = (i: number): string => {
		const b = blocks[i];
		if (b.textLen > 0) return text(b.textOff, b.textOff + b.textLen);
		const parts: string[] = [];
		for (let k = 0; k < b.lineCount; k++) parts.push(lineText(b.firstLine + k));
		return parts.join(' ');
	};

	const onCopy = (e: ClipboardEvent) => {
		const sel = doc.ownerDocument.getSelection();
		if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
		const r = sel.getRangeAt(0);
		if (!r.intersectsNode(doc)) return;
		const picked: SelectedLine[] = [];
		for (let li = 0; li < lineEls.length; li++) {
			const span = lineEls[li];
			if (!span || !r.intersectsNode(span)) continue;
			const bi = lines[li].block;
			if (foldActive && region?.hasAttribute('hidden') && (blocks[bi]?.flags & BlockFlag.folded)) continue;
			let t: string;
			if (span.contains(r.startContainer) || span.contains(r.endContainer)) {
				const r2 = doc.ownerDocument.createRange();
				r2.selectNodeContents(span);
				if (span.contains(r.startContainer)) r2.setStart(r.startContainer, r.startOffset);
				if (span.contains(r.endContainer)) r2.setEnd(r.endContainer, r.endOffset);
				t = r2.toString();
			} else t = span.textContent ?? '';
			picked.push({ line: li, text: t });
		}
		if (picked.length === 0) return;
		e.clipboardData?.setData('text/plain', selectionText(model, picked));
		e.preventDefault();
	};
	doc.addEventListener('copy', onCopy);

	const layer: TextLayer = {
		doc, model, blocks: blockEls, lines: lineEls, notes: noteEls, headings,
		foldRegion: region, foldButton, foldBlock, tail, lineW, lineK, calGen, gen: 0,
		invalidate() { layer.gen++; },
		setFold(open: boolean) {
			if (layer.foldRegion) {
				if (open) layer.foldRegion.removeAttribute('hidden');
				else layer.foldRegion.setAttribute('hidden', 'until-found');
			}
			layer.foldButton?.setAttribute('aria-expanded', open ? 'true' : 'false');
		},
		setFoldClip(clipEm: number) {
			if (!layer.tail) return;
			layer.tail.style.setProperty('--fold-dy', e3(Math.min(0, clipEm - foldEnd)));
		},
		blockText,
		codeSource(i: number) {
			const b = blocks[i];
			const parts: string[] = [];
			for (let k = 0; k < b.lineCount; k++) parts.push(lineText(b.firstLine + k));
			return parts.join('\n');
		},
		dispose() {
			doc.removeEventListener('copy', onCopy);
			doc.replaceChildren();
			layers.delete(doc);
		}
	};
	layers.set(doc, layer);
	return layer;
}

// ---- selection text (pure) --------------------------------------------------------------------------------------

export interface SelectedLine { line: number; text: string }

/**
 * The plain text of a selection from the selected lines in document order (each already clipped to the selection):
 * inside a block, consecutive lines join with one space, or with nothing when the earlier line has LineFlag.joinNext;
 * code lines join with newlines; list, reference and footnote items start on a new line; blocks are separated by a blank line.
 */
export function selectionText(model: ReadingModel, picked: readonly SelectedLine[]): string {
	let out = '';
	let prevBlock = -1;
	let prevLine = -1;
	for (const p of picked) {
		const L = model.lines[p.line];
		if (!L) continue;
		const bi = L.block;
		if (prevBlock < 0) out = p.text;
		else if (bi !== prevBlock) out += '\n\n' + p.text;
		else {
			const kind = model.blocks[bi]?.kind;
			const prev = model.lines[prevLine];
			if (kind === BlockKind.code) out += '\n' + p.text;
			else if ((kind === BlockKind.list || kind === BlockKind.refs || kind === BlockKind.footnotes) && MARKER.test(p.text)) out += '\n' + p.text;
			else out += (prev && (prev.flags & LineFlag.joinNext) ? '' : ' ') + p.text;
		}
		prevBlock = bi;
		prevLine = p.line;
	}
	return out;
}

// ---- calibration ------------------------------------------------------------------------------------------------

function emOf(doc: HTMLElement): number {
	const v = parseFloat(getComputedStyle(doc).getPropertyValue('--em'));
	return Number.isFinite(v) && v > 0 ? v : 16;
}

/**
 * Fit each line of [range.first, range.last) that is laid out (width > 0) and not yet calibrated in this generation:
 * scaleX(layout width / natural width), limited to 0.5 percent. Reads and writes are batched (one layout). Returns the lines done.
 */
/** Width of a line's text without the trailing whitespace (the span keeps the line break's space for copy; the layout width excludes it). */
function inkWidth(el: HTMLElement): number {
	const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
	let last: Text | null = null;
	while (tw.nextNode()) last = tw.currentNode as Text;
	if (!last) return el.getBoundingClientRect().width;
	let end = last.data.length;
	while (end > 0 && /\s/.test(last.data[end - 1])) end--;
	const r = document.createRange();
	r.setStart(el, 0);
	r.setEnd(last, end);
	return r.getBoundingClientRect().width;
}

export function calibrate(doc: HTMLElement, range: LineRange, emPx?: number): number {
	const L = layers.get(doc);
	if (!L) return 0;
	const em = emPx ?? emOf(doc);
	const first = Math.max(0, range.first), last = Math.min(L.lines.length, range.last);
	const idx: number[] = [];
	for (let i = first; i < last; i++) if (L.calGen[i] !== L.gen && L.lineW[i] > 0) idx.push(i);
	if (idx.length === 0) return 0;
	// The page pass sets glyphs at the build's advances (hb, unhinted); Chrome's advances for the same font differ by up to ~1 percent per
	// glyph. Spread the difference evenly with letter-spacing so every word lands within a pixel of its glyphs (a uniform scaleX would
	// leave the middle of a long line half off). Reads and writes are batched.
	for (const i of idx) { L.lines[i].style.letterSpacing = ''; L.lines[i].style.transform = ''; }
	const widths = new Float32Array(idx.length);
	const ls = new Float32Array(idx.length);
	const todo: number[] = [];
	for (let j = 0; j < idx.length; j++) widths[j] = inkWidth(L.lines[idx[j]]);
	const chars = (i: number) => Math.max(2, L.lines[i].textContent?.length ?? 2);
	for (let j = 0; j < idx.length; j++) {
		const i = idx[j];
		if (widths[j] <= 0) continue; // hidden (collapsed fold) or detached: try again later
		const target = L.lineW[i] * em;
		L.calGen[i] = L.gen;
		L.lineK[i] = 1;
		if (Math.abs(target - widths[j]) < 0.05 || Math.abs(target - widths[j]) / target > 0.06) continue;
		ls[j] = (target - widths[j]) / (chars(i) - 1);
		L.lines[i].style.letterSpacing = `${ls[j].toFixed(4)}px`;
		todo.push(j);
	}
	// letter-spacing also switches off some font features, so the width is not exactly linear in it: one correction pass
	for (const j of todo) widths[j] = inkWidth(L.lines[idx[j]]);
	for (const j of todo) {
		const i = idx[j];
		const target = L.lineW[i] * em;
		const err = target + ls[j] - widths[j];
		if (Math.abs(err) > 0.3) L.lines[i].style.letterSpacing = `${(ls[j] + err / (chars(i) - 1)).toFixed(4)}px`;
	}
	return idx.length;
}

export interface Calibrator { request(): void; flush(): void; dispose(): void }

/** rAF-batched calibration of whatever getRanges() returns now. */
export function createCalibrator(doc: HTMLElement, getRanges: () => LineRange[], getEm: () => number): Calibrator {
	let raf = 0;
	const flush = () => {
		raf = 0;
		const em = getEm();
		for (const r of getRanges()) calibrate(doc, r, em);
	};
	return {
		request() { if (!raf) raf = requestAnimationFrame(flush); },
		flush() { if (raf) cancelAnimationFrame(raf); flush(); },
		dispose() { if (raf) cancelAnimationFrame(raf); raf = 0; }
	};
}

/** Measured DOM rects of every laid-out line, in CSS px relative to the doc's top left (acceptance test 3). */
export function lineRects(doc: HTMLElement): { line: number; x: number; y: number; w: number; h: number }[] {
	const L = layers.get(doc);
	if (!L) return [];
	const o = doc.getBoundingClientRect();
	const out: { line: number; x: number; y: number; w: number; h: number }[] = [];
	for (let i = 0; i < L.lines.length; i++) {
		const r = L.lines[i].getBoundingClientRect();
		if (r.width > 0 || r.height > 0) out.push({ line: i, x: r.left - o.left, y: r.top - o.top, w: r.width, h: r.height });
	}
	return out;
}
