// The semantic mirror (docs/READING_GPU.md "Mirror"): ONE visually hidden, non-interactive DOM tree built from the RDR3 model.
// It is the source of truth for the article's text (a11y, SEO, no-WebGPU, Reader Mode); the GPU draws the same text from the same blob.
// No layout styles at all: the root is `#reader-mirror.sr-mirror`, positioned offscreen by mirror.css.
// Text rules: a block's lines join with one space, or with nothing after a line with LineFlag.joinNext; code lines join with "\n";
// list, reference and footnote items start at a line whose text begins with a marker. Block elements are separated by "\n" text nodes.
import {
	BlockFlag, BlockKind, ItemType, LineFlag, LinkKind, itemIndex, itemType,
	type BlockRec, type ReadingModel
} from '../magazine/format';

export interface MirrorOpts {
	/** document that owns the created nodes; default globalThis.document */
	document?: Document;
	/** the fold region starts expanded (data-expanded="true") */
	foldExpanded?: boolean;
	/** language of a code block, for its aria-label ("Code (rust)") */
	codeLanguage?: (b: BlockRec, i: number) => string | undefined;
	/** aria-label of the contents nav; default "Contents" */
	navLabel?: string;
}

export interface Mirror {
	readonly root: HTMLElement;
	/** one entry per model.links index; a link wrapped over several lines shares one element across its fragments */
	readonly linkEls: HTMLAnchorElement[];
	/** one entry per model.blocks index; null for a block the mirror has no element of (never today) */
	readonly blockEls: (HTMLElement | null)[];
	/** mark the i-th link aria-current and focus it without scrolling the page */
	focusLink(i: number): void;
	setExpanded(expanded: boolean): void;
	/** the article text: root text minus the contents nav (derived from headings), whitespace runs collapsed to one space, trimmed */
	text(): string;
}

/** The whitespace normalisation used by Mirror.text() and by the mirror-vs-model equality test. */
export const normalizeText = (s: string): string => s.replace(/\s+/g, ' ').trim();

export const MIRROR_ID = 'reader-mirror';
const MARKER = /^(?:\[\d+\]|\d+[.)]|[-*•–])\s/;
const dec = new TextDecoder();

function tagFor(b: BlockRec): string {
	switch (b.kind) {
		case BlockKind.hero: return b.level === 2 || b.level === 3 ? 'p' : 'h1';
		case BlockKind.heading: return `h${Math.min(6, Math.max(1, b.level || 2))}`;
		case BlockKind.code: return 'pre';
		case BlockKind.quote: case BlockKind.pullquote: return 'blockquote';
		case BlockKind.list: return 'ul';
		case BlockKind.image: case BlockKind.figure: return 'figure';
		case BlockKind.rule: return 'hr';
		case BlockKind.refs: case BlockKind.footnotes: return 'ol';
		case BlockKind.note: return 'aside';
		case BlockKind.nextprev: return 'nav';
		default: return 'p'; // para, caption, numerals, label, takeaway, math, table, fold control
	}
}

export function buildMirror(model: ReadingModel, opts: MirrorOpts = {}): Mirror {
	const doc = opts.document ?? globalThis.document;
	const { blocks, lines, links, notes } = model;
	const mk = (tag: string) => doc.createElement(tag);
	const nl = () => doc.createTextNode('\n');

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

	// links per line sorted by t0; a record continuing the previous one (same target, next line, same block) joins that anchor
	const order = links.map((_, i) => i).sort((a, b) => links[a].line - links[b].line || links[a].t0 - links[b].t0);
	const byLine = new Map<number, number[]>();
	const headOf = new Int32Array(links.length).fill(-1);
	{
		let prev = -1;
		for (const i of order) {
			const l = links[i];
			const p = prev >= 0 ? links[prev] : null;
			const cont = p && p.offset === l.offset && p.kind === l.kind && l.line === p.line + 1 && lines[l.line]?.block === lines[p.line]?.block;
			headOf[i] = cont ? headOf[prev] : i;
			prev = i;
			let a = byLine.get(l.line);
			if (!a) byLine.set(l.line, (a = []));
			a.push(i);
		}
	}
	const linkEls: HTMLAnchorElement[] = new Array(links.length);
	const makeAnchor = (k: number): HTMLAnchorElement => {
		const lk = links[k];
		const a = mk('a') as HTMLAnchorElement;
		const target = strAt(lk.offset);
		const href = (lk.kind === LinkKind.anchor || lk.kind === LinkKind.ref) && !target.startsWith('#') ? `#${target}` : target;
		a.setAttribute('href', href);
		if (lk.kind === LinkKind.url && /^https?:/i.test(href)) {
			a.setAttribute('target', '_blank');
			a.setAttribute('rel', 'noopener noreferrer');
		}
		return a;
	};

	/** Append one line's text (and its link anchors) to `parent`, preceded by `sep`. */
	function appendLine(parent: Node, li: number, sep: string) {
		const L = lines[li];
		const start = L.textOff, end = L.textOff + L.textLen;
		let pos = start;
		let pending = sep;
		const put = (to: Node, s: string) => { if (s) to.appendChild(doc.createTextNode(s)); };
		for (const k of byLine.get(li) ?? []) {
			const lk = links[k];
			const t0 = Math.max(lk.t0, pos), t1 = Math.min(lk.t1, end);
			if (t1 <= t0) {
				if (lk.t1 > lk.t0 && !linkEls[k]) {
					// fully overlapped by an earlier link (a card link over its title link): an empty anchor named by the text, so the text is not repeated
					const a = makeAnchor(k);
					a.setAttribute('aria-label', text(lk.t0, lk.t1));
					parent.appendChild(a);
					linkEls[k] = a;
				}
				continue;
			}
			const head = headOf[k];
			if (head !== k && linkEls[head]) {
				// continuation: the text (and the line break before it) belongs to the head anchor
				const a = linkEls[head];
				if (t0 > pos) { put(parent, pending + text(pos, t0)); pending = ''; put(a, text(t0, t1)); }
				else put(a, pending + text(t0, t1));
				pending = '';
				linkEls[k] = a;
			} else {
				put(parent, pending + (t0 > pos ? text(pos, t0) : ''));
				pending = '';
				const a = makeAnchor(k);
				a.textContent = text(t0, t1);
				parent.appendChild(a);
				linkEls[k] = a;
			}
			pos = t1;
		}
		put(parent, pending + (pos < end ? text(pos, end) : ''));
	}

	const sepAfter = (li: number) => (lines[li].flags & LineFlag.joinNext ? '' : ' ');
	/** lines [first, first+count) into `parent` as inline text; `joiner` overrides the separator (code: "\n") */
	function appendLines(parent: Node, first: number, count: number, joiner?: string) {
		for (let k = 0; k < count; k++) appendLine(parent, first + k, k === 0 ? '' : (joiner ?? sepAfter(first + k - 1)));
	}
	/** lines grouped into items (li) that start at a marker line */
	function appendItems(parent: Node, first: number, count: number) {
		let cur: HTMLElement | null = null;
		for (let k = 0; k < count; k++) {
			const li = first + k;
			if (cur === null || MARKER.test(lineText(li))) {
				if (cur) parent.appendChild(nl());
				cur = mk('li');
				parent.appendChild(cur);
				appendLine(cur, li, '');
			} else appendLine(cur, li, sepAfter(li - 1));
		}
	}

	const root = mk('div');
	root.id = MIRROR_ID;
	root.className = 'sr-mirror';
	const blockEls: (HTMLElement | null)[] = new Array(blocks.length).fill(null);
	const foldActive = model.foldH > 0;
	const expandedInit = !!opts.foldExpanded;
	let region: HTMLElement | null = null;
	const getRegion = () => {
		if (!region) {
			region = mk('section');
			region.id = 'fold-region';
			region.setAttribute('aria-label', 'Full text');
			region.setAttribute('data-expanded', String(expandedInit));
			root.appendChild(region);
			root.appendChild(nl());
		}
		return region;
	};
	const notesOf = new Map<number, number[]>();
	notes.forEach((n, i) => {
		let a = notesOf.get(n.anchorBlock);
		if (!a) notesOf.set(n.anchorBlock, (a = []));
		a.push(i);
	});
	const makeNote = (ni: number) => {
		const n = notes[ni];
		const na = mk('aside');
		na.setAttribute('data-note', String(ni));
		appendLines(na, n.firstLine, n.lineCount);
		return na;
	};

	const headings: { id: string; text: string; level: number }[] = [];
	const imageAlt = (b: BlockRec): string => {
		for (let k = 0; k < b.itemCount; k++) {
			const w = model.items[b.firstItem + k];
			if (itemType(w) === ItemType.image) {
				const im = model.images[itemIndex(w)];
				return im ? strAt(im.altOffset) : '';
			}
		}
		return '';
	};

	for (let i = 0; i < blocks.length; i++) {
		const b = blocks[i];
		const prevB = i > 0 ? blocks[i - 1] : null;
		const parent: HTMLElement = foldActive && (b.flags & BlockFlag.folded) ? getRegion() : root;
		const nested = b.kind === BlockKind.caption && prevB && (prevB.kind === BlockKind.figure || prevB.kind === BlockKind.image) && blockEls[i - 1];
		let el: HTMLElement = mk(nested ? 'figcaption' : tagFor(b));
		const id = strAt(b.anchor);
		if (id) el.id = id;
		el.setAttribute('data-block', String(i));

		switch (b.kind) {
			case BlockKind.hero:
				if (b.level === 2) el.setAttribute('data-role', 'dek');
				else if (b.level === 3) el.setAttribute('data-role', 'byline');
				appendLines(el, b.firstLine, b.lineCount);
				break;
			case BlockKind.list:
				if (b.lineCount > 0 && /^\d/.test(lineText(b.firstLine))) {
					const ol = mk('ol');
					for (const a of Array.from(el.attributes)) ol.setAttribute(a.name, a.value);
					el = ol;
				}
				appendItems(el, b.firstLine, b.lineCount);
				break;
			case BlockKind.refs: case BlockKind.footnotes:
				appendItems(el, b.firstLine, b.lineCount);
				break;
			case BlockKind.code: {
				const lang = opts.codeLanguage?.(b, i);
				el.setAttribute('role', 'region');
				el.setAttribute('aria-label', lang ? `Code (${lang})` : 'Code');
				const code = mk('code');
				if (lang) code.className = `language-${lang}`;
				appendLines(code, b.firstLine, b.lineCount, '\n');
				el.appendChild(code);
				break;
			}
			case BlockKind.figure: {
				const f = b.fig >= 0 ? model.figures[b.fig] : undefined;
				const label = f ? strAt(f.describe) || strAt(f.alt) : '';
				el.setAttribute('role', 'group');
				el.setAttribute('aria-roledescription', 'interactive figure');
				if (label) el.setAttribute('aria-label', label);
				if (b.fig >= 0) el.setAttribute('data-fig', String(b.fig));
				if (b.lineCount > 0) {
					const p = mk('p');
					appendLines(p, b.firstLine, b.lineCount);
					el.appendChild(p);
				}
				break;
			}
			case BlockKind.image: {
				const img = mk('img');
				img.setAttribute('alt', imageAlt(b) || 'Image');
				el.appendChild(img);
				if (b.lineCount > 0) {
					const p = mk('p');
					appendLines(p, b.firstLine, b.lineCount);
					el.appendChild(p);
				}
				break;
			}
			case BlockKind.nextprev:
				el.setAttribute('aria-label', 'More posts');
				appendLines(el, b.firstLine, b.lineCount);
				break;
			case BlockKind.rule:
				break;
			case BlockKind.fold:
				el.setAttribute('data-role', 'fold');
				if (b.lineCount > 0) appendLines(el, b.firstLine, b.lineCount);
				else el.textContent = text(b.textOff, b.textOff + b.textLen);
				break;
			default:
				appendLines(el, b.firstLine, b.lineCount);
		}

		if (b.kind === BlockKind.heading) {
			let t = '';
			for (let k = 0; k < b.lineCount; k++) t += (k && !(lines[b.firstLine + k - 1].flags & LineFlag.joinNext) ? ' ' : '') + lineText(b.firstLine + k);
			if (!el.id) el.id = `sec-${i}`;
			headings.push({ id: el.id, text: t, level: Math.min(6, Math.max(1, b.level || 2)) });
		}

		blockEls[i] = el;
		if (nested) {
			const host = blockEls[i - 1]!;
			host.appendChild(nl());
			host.appendChild(el);
		} else {
			parent.appendChild(el);
			parent.appendChild(nl());
		}
		for (const ni of notesOf.get(i) ?? []) {
			parent.appendChild(makeNote(ni));
			parent.appendChild(nl());
		}
	}
	// notes whose anchor block is out of range are still part of the document
	for (let ni = 0; ni < notes.length; ni++) {
		if (!blocks[notes[ni].anchorBlock]) {
			root.appendChild(makeNote(ni));
			root.appendChild(nl());
		}
	}
	if (foldActive) getRegion();
	// a link whose line belongs to no block: still reachable, as an empty anchor named by its text
	for (let k = 0; k < links.length; k++) {
		if (linkEls[k]) continue;
		const a = makeAnchor(k);
		a.setAttribute('aria-label', text(links[k].t0, links[k].t1));
		root.appendChild(a);
		linkEls[k] = a;
	}

	// contents: links to the section headings (level 2, else every heading), first child, not part of text()
	let nav: HTMLElement | null = null;
	{
		const level = headings.some((h) => h.level === 2) ? 2 : Math.min(...headings.map((h) => h.level), 6);
		const sections = headings.filter((h) => h.level === level);
		if (sections.length > 0) {
			nav = mk('nav');
			nav.setAttribute('aria-label', opts.navLabel ?? 'Contents');
			nav.setAttribute('data-mirror-nav', '');
			const ol = mk('ol');
			for (const h of sections) {
				const li = mk('li');
				const a = mk('a');
				a.setAttribute('href', `#${h.id}`);
				a.textContent = h.text;
				li.appendChild(a);
				ol.appendChild(li);
			}
			nav.appendChild(ol);
			root.insertBefore(nav, root.firstChild);
		}
	}

	let current: HTMLAnchorElement | null = null;
	return {
		root, linkEls, blockEls,
		focusLink(i: number) {
			const el = linkEls[i];
			if (!el) return;
			if (current && current !== el) current.removeAttribute('aria-current');
			el.setAttribute('aria-current', 'true');
			current = el;
			el.focus({ preventScroll: true });
		},
		setExpanded(expanded: boolean) {
			root.setAttribute('data-expanded', String(expanded));
			region?.setAttribute('data-expanded', String(expanded));
		},
		text() {
			let s = '';
			for (const c of Array.from(root.childNodes)) if (c !== nav) s += c.textContent ?? '';
			return normalizeText(s);
		}
	};
}
