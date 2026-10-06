import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { Window } from 'happy-dom';
import {
	BlockKind, BlockFlag, ItemType, LineFlag, LinkKind, packItem, sampleReading, stringAt, unpackReading,
	type BlockRec, type ReadingModel
} from '../magazine/format';
import { buildMirror, normalizeText } from './mirror';

const win = new Window();
const document = win.document as unknown as Document;
const MARKER = /^(?:\[\d+\]|\d+[.)]|[-*•–])\s/;
const enc = new TextEncoder();
const dec = new TextDecoder();
const css = readFileSync(new URL('./mirror.css', import.meta.url), 'utf8');

beforeAll(() => {
	const st = document.createElement('style');
	st.textContent = css;
	document.head.appendChild(st);
});

// ---- the model text, straight from the text blob and the line offsets (independent of mirror.ts) ----------------------------
// Normalisation: every whitespace run becomes one space, the result is trimmed (exactly normalizeText).
// Order: blocks in index order, each followed by the notes anchored to it; a block's lines join with one space (nothing after a
// joinNext line), code lines join with a newline; blocks join with a space.
function modelText(m: ReadingModel): string {
	const lt = (li: number) => dec.decode(m.text.subarray(m.lines[li].textOff, m.lines[li].textOff + m.lines[li].textLen));
	const join = (first: number, count: number, code: boolean) => {
		let s = '';
		for (let k = 0; k < count; k++) {
			if (k) s += code ? '\n' : m.lines[first + k - 1].flags & LineFlag.joinNext ? '' : ' ';
			s += lt(first + k);
		}
		return s;
	};
	const parts: string[] = [];
	m.blocks.forEach((b, i) => {
		if (b.kind === BlockKind.fold && b.lineCount === 0) parts.push(dec.decode(m.text.subarray(b.textOff, b.textOff + b.textLen)));
		else parts.push(join(b.firstLine, b.lineCount, b.kind === BlockKind.code));
		for (const n of m.notes) if (n.anchorBlock === i) parts.push(join(n.firstLine, n.lineCount, false));
	});
	return normalizeText(parts.join(' '));
}

const headingLevels = (m: ReadingModel): number[] =>
	m.blocks.filter((b) => b.kind === BlockKind.heading || (b.kind === BlockKind.hero && b.level === 1)).map((b) => (b.kind === BlockKind.hero ? 1 : Math.min(6, Math.max(1, b.level || 2))));

const mirrorLevels = (root: HTMLElement) =>
	Array.from(root.querySelectorAll('h1,h2,h3,h4,h5,h6')).map((h) => Number(h.tagName[1]));

function expectedHref(m: ReadingModel, k: number): string {
	const l = m.links[k];
	const t = stringAt(m.strings, l.offset);
	return (l.kind === LinkKind.anchor || l.kind === LinkKind.ref) && !t.startsWith('#') ? `#${t}` : t;
}

// ---- synthetic model -----------------------------------------------------------------------------------------------------

function synthetic(): ReadingModel {
	const m = sampleReading();
	const text: number[] = [];
	const strs: number[] = [0];
	const seen = new Map<string, number>();
	const str = (s: string) => {
		let o = seen.get(s);
		if (o === undefined) { o = strs.length; strs.push(...enc.encode(s), 0); seen.set(s, o); }
		return o;
	};
	const lines: ReadingModel['lines'] = [];
	const blocks: BlockRec[] = [];
	const links: ReadingModel['links'] = [];
	const base = m.blocks[0];
	const addBlock = (kind: number, level: number, ls: (string | { t: string; join?: boolean })[], extra: Partial<BlockRec> = {}) => {
		const firstLine = lines.length;
		for (const l of ls) {
			const t = typeof l === 'string' ? l : l.t;
			const textOff = text.length;
			text.push(...enc.encode(t));
			lines.push({ yTop: 0, yBot: 1, x0: 0, x1: 1, firstGlyph: 0, glyphCount: 0, textOff, textLen: enc.encode(t).length, block: blocks.length, size: 1, font: 0, flags: typeof l !== 'string' && l.join ? LineFlag.joinNext : 0 });
		}
		blocks.push({ ...base, kind, level, firstLine, lineCount: ls.length, itemCount: 0, anchor: 0, fig: -1, flags: 0, textOff: 0, textLen: 0, ...extra });
		return blocks.length - 1;
	};
	const link = (line: number, sub: string, target: string, kind: number) => {
		const lt = dec.decode(new Uint8Array(text).subarray(lines[line].textOff, lines[line].textOff + lines[line].textLen));
		const i = lt.indexOf(sub);
		links.push({ x0: 0, y0: 0, x1: 1, y1: 1, kind, offset: str(target), line, t0: lines[line].textOff + enc.encode(lt.slice(0, i)).length, t1: lines[line].textOff + enc.encode(lt.slice(0, i + sub.length)).length });
	};
	addBlock(BlockKind.hero, 1, ['A Title'], { anchor: str('top') });
	addBlock(BlockKind.hero, 2, ['The dek line']);
	addBlock(BlockKind.hero, 3, ['May 13, 2026  ·  5 min read']);
	addBlock(BlockKind.heading, 2, ['First section'], { anchor: str('first') });
	addBlock(BlockKind.para, 0, ['See the manual for the long linked', { t: 'phrase that wraps, then hy-', join: true }, 'phenated word.']);
	link(lines.length - 3, 'the', 'https://example.com/a', LinkKind.url);
	link(lines.length - 3, 'long linked', 'https://example.com/wrap', LinkKind.url);
	link(lines.length - 2, 'phrase that wraps', 'https://example.com/wrap', LinkKind.url);
	addBlock(BlockKind.heading, 3, ['A subsection']);
	addBlock(BlockKind.list, 0, ['- one two', 'continues here', '- three']);
	link(lines.length - 1, 'three', 'first', LinkKind.anchor);
	addBlock(BlockKind.list, 0, ['1. alpha', '2. beta']);
	addBlock(BlockKind.quote, 0, ['A quoted line.']);
	addBlock(BlockKind.code, 0, ['fn main() {', '    println!("hi");', '}']);
	addBlock(BlockKind.figure, 0, [], { fig: 0, anchor: str('fig-1') });
	addBlock(BlockKind.caption, 0, ['Fig. 1  A caption.']);
	m.images = [{ ...(m.images[0] ?? ({} as never)), altOffset: str('A diagram of things'), imageId: 3 } as never];
	m.items = [...m.items, packItem(ItemType.image, 0)];
	addBlock(BlockKind.image, 0, [], { firstItem: m.items.length - 1, itemCount: 1 });
	addBlock(BlockKind.note, 0, ['A margin note.']);
	addBlock(BlockKind.fold, 0, ['Read the full post  ·  5 min']);
	m.foldH = 10; m.foldY = 0;
	addBlock(BlockKind.heading, 2, ['Folded section'], { flags: BlockFlag.folded });
	addBlock(BlockKind.para, 0, ['Folded body text, always present in the mirror.'], { flags: BlockFlag.folded });
	addBlock(BlockKind.heading, 2, ['Tail section']);
	addBlock(BlockKind.refs, 0, ['[1] First reference', '[2] Second reference with a link']);
	link(lines.length - 1, 'link', 'https://example.com/ref', LinkKind.url);
	addBlock(BlockKind.nextprev, 0, ['Next post']);
	link(lines.length - 1, 'Next post', 'other', LinkKind.article);
	m.notes = [{ x0: 0, y0: 0, x1: 1, y1: 1, firstItem: 0, itemCount: 0, firstLine: lines.length, lineCount: 1, anchorBlock: 4, anchorLine: 0, refIndex: 0 }];
	lines.push({ ...lines[0], textOff: text.length, textLen: enc.encode('Sidenote text.').length, block: 0, flags: 0 });
	text.push(...enc.encode('Sidenote text.'));
	m.figures = [{ ...m.figures[0], alt: str('short alt'), describe: str('A long description of the figure.'), block: 12 }];
	m.blocks = blocks; m.lines = lines; m.links = links;
	m.text = Uint8Array.from(text); m.strings = Uint8Array.from(strs);
	return m;
}

function loadReal(): { name: string; model: ReadingModel }[] {
	const dir = new URL('../../../static/magazine/', import.meta.url);
	const out: { name: string; model: ReadingModel }[] = [];
	for (const f of readdirSync(dir)) {
		if (!/^(ifd|hyperion)\.(narrow|mid|wide)\..+\.bin$/.test(f)) continue;
		out.push({ name: f.replace(/\.[0-9a-f]+\.bin$/, ''), model: unpackReading(new Uint8Array(readFileSync(new URL(f, dir)))) });
	}
	return out;
}

const cases = [{ name: 'synthetic', model: synthetic() }, ...loadReal()];

describe('mirror text equals model text', () => {
	test('found the real models', () => expect(cases.length).toBeGreaterThanOrEqual(7));
	for (const { name, model } of cases) {
		test(name, () => {
			const mir = buildMirror(model, { document });
			expect(mir.text()).toBe(modelText(model));
			expect(mir.text().length).toBeGreaterThan(20);
			// every line is present in the text, individually
			const t = mir.text();
			model.lines.forEach((_, li) => {
				const s = normalizeText(dec.decode(model.text.subarray(model.lines[li].textOff, model.lines[li].textOff + model.lines[li].textLen)));
				if (s) expect(t.includes(s)).toBe(true);
			});
		});
	}
	test('planted bug: a dropped line fails the equality', () => {
		const model = synthetic();
		const b = model.blocks.findIndex((x) => x.kind === BlockKind.para);
		const broken = { ...model, blocks: model.blocks.map((x, i) => (i === b ? { ...x, lineCount: x.lineCount - 1 } : x)) };
		expect(buildMirror(broken, { document }).text()).not.toBe(modelText(model));
		// control: unbroken passes
		expect(buildMirror(model, { document }).text()).toBe(modelText(model));
	});
});

describe('structure', () => {
	for (const { name, model } of cases) {
		test(`${name}: heading levels and counts equal the model's`, () => {
			const mir = buildMirror(model, { document });
			expect(mirrorLevels(mir.root)).toEqual(headingLevels(model));
		});
		test(`${name}: every link has its href, inside the tree`, () => {
			const mir = buildMirror(model, { document });
			expect(mir.linkEls.length).toBe(model.links.length);
			model.links.forEach((_, k) => {
				expect(mir.linkEls[k].getAttribute('href')).toBe(expectedHref(model, k));
				expect(mir.root.contains(mir.linkEls[k])).toBe(true);
			});
			// one real anchor per logical link: contents-nav anchors aside, nothing else
			const inTree = new Set(mir.linkEls);
			const nav = mir.root.querySelector('nav[data-mirror-nav]');
			const all = Array.from(mir.root.querySelectorAll('a')).filter((a) => !nav?.contains(a));
			expect(all.length).toBe(inTree.size);
		});
		test(`${name}: one block element per block, no layout styles`, () => {
			const mir = buildMirror(model, { document });
			expect(mir.blockEls.length).toBe(model.blocks.length);
			expect(mir.blockEls.every((e) => e && mir.root.contains(e))).toBe(true);
			expect(mir.root.querySelectorAll('[style]').length).toBe(0);
		});
	}

	test('synthetic: semantic elements', () => {
		const model = synthetic();
		const mir = buildMirror(model, { document, codeLanguage: () => 'rust' });
		const r = mir.root;
		expect(r.id).toBe('reader-mirror');
		expect(r.className).toBe('sr-mirror');
		expect(r.querySelectorAll('ul').length).toBe(1);
		expect(r.querySelectorAll('ul > li').length).toBe(2);
		expect(r.querySelectorAll('ol > li').length).toBe(2 + 2 + 3); // numbered list, refs, contents nav (3 level-2 headings)
		expect(r.querySelector('blockquote')?.textContent).toContain('A quoted line.');
		expect(r.querySelector('pre')?.getAttribute('aria-label')).toBe('Code (rust)');
		expect(r.querySelector('pre > code')?.textContent).toBe('fn main() {\n    println!("hi");\n}');
		const fig = r.querySelector('figure[data-fig]')!;
		expect(fig.getAttribute('aria-label')).toBe('A long description of the figure.');
		expect(fig.querySelector('figcaption')?.textContent).toBe('Fig. 1  A caption.');
		expect(r.querySelector('img')?.getAttribute('alt')).toBe('A diagram of things');
		expect(r.querySelectorAll('aside').length).toBe(2); // note block and the model note
		expect(r.querySelector('nav[data-mirror-nav] a')?.getAttribute('href')).toBe('#first');
		expect(r.querySelectorAll('nav[data-mirror-nav] a').length).toBe(3); // level 2 headings
		expect(r.querySelector('nav[aria-label="More posts"]')?.textContent).toBe('Next post');
		// the wrapped link is one anchor holding both fragments, and the hyphen cut has no space
		const wrap = mir.linkEls[1];
		expect(mir.linkEls[2]).toBe(wrap);
		expect(wrap.textContent).toBe('long linked phrase that wraps');
		expect(mir.text()).toContain('hy-phenated word.');
		// the fold's text is present whether expanded or not, never hidden
		const region = r.querySelector('#fold-region')!;
		expect(region.textContent).toContain('Folded body text');
		for (const open of [false, true]) {
			mir.setExpanded(open);
			expect(region.getAttribute('data-expanded')).toBe(String(open));
			expect(region.hasAttribute('hidden')).toBe(false);
			expect(mir.text()).toContain('Folded body text');
		}
	});

	test('focusLink sets aria-current and focuses without scrolling', () => {
		const model = synthetic();
		const mir = buildMirror(model, { document });
		document.body.appendChild(mir.root);
		let opts: unknown;
		const orig = mir.linkEls[0].focus.bind(mir.linkEls[0]);
		mir.linkEls[0].focus = (o?: FocusOptions) => { opts = o; orig(o); };
		mir.focusLink(0);
		expect(opts).toEqual({ preventScroll: true });
		expect(mir.linkEls[0].getAttribute('aria-current')).toBe('true');
		expect(document.activeElement).toBe(mir.linkEls[0]);
		mir.focusLink(3);
		expect(mir.linkEls[0].hasAttribute('aria-current')).toBe(false);
		expect(mir.linkEls[3].getAttribute('aria-current')).toBe('true');
		mir.root.remove();
	});
});

describe('invisible to sight and pointer, present to assistive technology', () => {
	test('root and descendants: pointer-events none, not display:none, not visibility:hidden', () => {
		const model = synthetic();
		const mir = buildMirror(model, { document });
		document.body.appendChild(mir.root);
		const cs = win.getComputedStyle(mir.root as unknown as never);
		expect(cs.display).not.toBe('none');
		expect(cs.visibility).not.toBe('hidden');
		expect(cs.pointerEvents).toBe('none');
		expect(cs.position).toBe('fixed');
		expect(cs.left).toBe('-10000px');
		expect(cs.width).toBe('1px');
		expect(cs.height).toBe('1px');
		expect(cs.overflow).toBe('hidden');
		// nothing below the root overrides pointer-events, display or visibility (inline style or attribute), nothing is interactive but links
		for (const el of Array.from(mir.root.querySelectorAll('*'))) {
			expect(el.hasAttribute('style')).toBe(false);
			expect(el.hasAttribute('hidden')).toBe(false);
			expect(['button', 'input', 'select', 'textarea', 'canvas'].includes(el.tagName.toLowerCase())).toBe(false);
			const tab = el.getAttribute('tabindex');
			expect(tab === null || Number(tab) < 0).toBe(true);
			const c = win.getComputedStyle(el as unknown as never);
			expect(c.pointerEvents === 'none' || c.pointerEvents === '' || c.pointerEvents === 'auto').toBe(true);
			expect(c.display).not.toBe('none');
		}
		mir.root.remove();
	});
	test('planted control: a display:none root is caught by the same check', () => {
		const mir = buildMirror(synthetic(), { document });
		mir.root.className = '';
		(mir.root as HTMLElement).setAttribute('style', 'display:none');
		document.body.appendChild(mir.root);
		expect(win.getComputedStyle(mir.root as unknown as never).display).toBe('none');
		mir.root.remove();
	});
	test('mirror.css has the required declarations', () => {
		for (const d of ['position: fixed', 'left: -10000px', 'top: 0', 'width: 1px', 'height: 1px', 'overflow: hidden', 'pointer-events: none', 'user-select: none']) expect(css).toContain(d);
		expect(css).not.toMatch(/display:\s*none|visibility:\s*hidden/);
	});
});
