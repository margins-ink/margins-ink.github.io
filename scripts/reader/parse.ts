// Stage 2, step 1-3: mdsvex source -> reader block AST. remark-parse + frontmatter + gfm + math,
// a fail-closed component registry (Cite, References, StickyNote, <script>; anything else throws
// with file:line), shiki tokens for fenced and `{:lang}` inline code.
import fs from 'node:fs';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import YAML from 'yaml';
import { codeToTokens } from 'shiki';
import { readerTheme } from './shiki-theme';
import { Pal, GlyphFlag } from '../../src/lib/reader/format';
import { F } from './fonts';
import { extractDirectives, directiveFromComment, parseDistill, bodyOf, type DirectiveEvent, type DistillBlock, type FigPlace } from '../magazine/parse-directives';

export const slugify = (text: string) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

/** A styled run of inline content. Colour is a palette index, or a shiki dark-theme colour resolved later. */
export interface Run {
	text?: string;
	font: number;
	size: number; // relative to the block's em
	color: number | { dark: string };
	flags: number; // GlyphFlag bits
	href?: string;
	inlineCode?: boolean;
	sup?: boolean;
	math?: { tex: string; display: boolean };
	brk?: boolean; // hard line break
	imageInline?: { src: string; alt: string };
}

export interface RefEntry { id: string; title: string; url: string }

export type Block =
	| { t: 'heading'; depth: number; runs: Run[]; id?: string }
	| { t: 'para'; runs: Run[] }
	| { t: 'code'; lang: string; lines: Run[][]; source: string; wide?: boolean }
	| { t: 'exhibit'; id: string; place: FigPlace; line: number }
	| { t: 'list'; ordered: boolean; start: number; items: Block[][] }
	| { t: 'quote'; children: Block[] }
	| { t: 'note'; children: Block[] }
	| { t: 'rule' }
	| { t: 'image'; src: string; alt: string }
	| { t: 'math'; tex: string }
	| { t: 'table'; align: (string | null)[]; rows: Run[][][] }
	| { t: 'pagebreak' }
	| { t: 'refs'; items: RefEntry[] }
	| { t: 'footnotes'; items: { n: number; children: Block[] }[] };

export interface Parsed {
	slug: string;
	file: string;
	meta: { title: string; dek: string; date: string; visible: boolean; [k: string]: unknown };
	blocks: Block[];
	refs: RefEntry[];
	source: string;
	/** the post body (source without frontmatter), the input of the distill review sha */
	body: string;
	/** the frontmatter `distill` block (MAGAZINE.md 1.7), shape-checked only */
	distill?: DistillBlock;
	/** every shiki dark-theme colour used (for palette quantisation) with counts */
	shikiPairs: Map<string, number>;
}

interface Style { font: number; size: number; color: Run['color']; flags: number; href?: string; sup?: boolean; inlineCode?: boolean }
/** inline code: the coral `property` syntax slot (palette slot 20 + its index in SYNTAX_ORDER) */
const CODE_INK = 20 + 7;
const BASE: Style = { font: F.body, size: 1, color: Pal.ink, flags: 0 };

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm).use(remarkMath);

class ParseError extends Error {}

interface Ctx {
	file: string;
	refs: RefEntry[];
	pairs: Map<string, number>;
	footnoteOrder: string[];
	footnoteDefs: Map<string, any>;
	events?: Map<number, DirectiveEvent>;
	wide?: boolean;
}

const at = (ctx: Ctx, node: any) => `${ctx.file}:${node?.position?.start?.line ?? '?'}`;

// ---- html tokenising (mdsvex passes component tags through as raw html nodes) ----------------

const TAG = /<(\/?)([A-Za-z][A-Za-z0-9]*)((?:\s+[^<>]*?)?)\s*(\/?)>/g;
const ATTR = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{([^}]*)\})/g;
const attrs = (s: string) => {
	const o: Record<string, string> = {};
	for (const m of s.matchAll(ATTR)) o[m[1]] = m[2] ?? m[3] ?? m[4];
	return o;
};
const decodeEntities = (s: string) =>
	s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');

type Tok = { text: string } | { tag: string; close: boolean; self: boolean; attrs: Record<string, string>; raw: string };
function htmlTokens(value: string): Tok[] {
	const out: Tok[] = [];
	let last = 0;
	for (const m of value.matchAll(TAG)) {
		if (m.index! > last) out.push({ text: value.slice(last, m.index) });
		out.push({ tag: m[2], close: m[1] === '/', self: m[4] === '/', attrs: attrs(m[3] ?? ''), raw: m[0] });
		last = m.index! + m[0].length;
	}
	if (last < value.length) out.push({ text: value.slice(last) });
	return out;
}

const SIMPLE_INLINE = new Set(['code', 'em', 'i', 'strong', 'b', 'br', 'a', 'span', 'kbd']);

/** Walk html tokens inside a phrasing context, emitting runs. `stack` carries open simple tags. */
function htmlInline(ctx: Ctx, node: any, toks: Tok[], style: Style, out: Run[], stack: Style[]) {
	for (const tk of toks) {
		if ('text' in tk) {
			const t = decodeEntities(tk.text);
			if (t) out.push(textRun(t, stack[stack.length - 1] ?? style));
			continue;
		}
		const cur = stack[stack.length - 1] ?? style;
		if (tk.tag === 'Cite') {
			const n = ctx.refs.findIndex((r) => r.id === tk.attrs.id);
			if (n < 0) throw new ParseError(`${at(ctx, node)}: <Cite id="${tk.attrs.id}"> has no matching useRefs entry`);
			out.push({ text: `[${n + 1}]`, font: F.sans, size: 0.7, color: Pal.link, flags: GlyphFlag.link | GlyphFlag.super, href: `#ref-${tk.attrs.id}`, sup: true });
			continue;
		}
		if (!SIMPLE_INLINE.has(tk.tag)) {
			throw new ParseError(`${at(ctx, node)}: unsupported component or tag ${tk.raw} (reader registry: Cite, References, StickyNote, script, code, em, strong, br, a)`);
		}
		if (tk.tag === 'br') { out.push({ brk: true, font: cur.font, size: cur.size, color: cur.color, flags: 0 }); continue; }
		if (tk.close) { stack.pop(); continue; }
		if (tk.self) continue;
		let s: Style = cur;
		if (tk.tag === 'code' || tk.tag === 'kbd') s = { ...cur, font: F.code, size: cur.size * 0.9, flags: cur.flags | GlyphFlag.code, inlineCode: true, color: CODE_INK };
		else if (tk.tag === 'em' || tk.tag === 'i') s = { ...cur, font: cur.font === F.code ? cur.font : F.italic };
		else if (tk.tag === 'strong' || tk.tag === 'b') s = { ...cur, font: cur.font === F.code ? F.codeBold : F.bold };
		else if (tk.tag === 'a') s = { ...cur, color: Pal.link, flags: cur.flags | GlyphFlag.link, href: tk.attrs.href };
		stack.push(s);
	}
}

function textRun(text: string, s: Style): Run {
	return { text, font: s.font, size: s.size, color: s.color, flags: s.flags, href: s.href, inlineCode: s.inlineCode, sup: s.sup };
}

// ---- inline (phrasing) content ------------------------------------------------------------------

async function inline(ctx: Ctx, nodes: any[], style: Style): Promise<Run[]> {
	const out: Run[] = [];
	const htmlStack: Style[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const n = nodes[i];
		const cur = htmlStack[htmlStack.length - 1] ?? style;
		switch (n.type) {
			case 'text': {
				out.push(textRun(n.value.replace(/\s+/g, ' '), cur));
				break;
			}
			case 'emphasis': out.push(...(await inline(ctx, n.children, { ...cur, font: cur.font === F.code ? cur.font : F.italic }))); break;
			case 'strong': out.push(...(await inline(ctx, n.children, { ...cur, font: cur.font === F.code ? F.codeBold : cur.font === F.sans ? F.sans : F.bold }))); break;
			case 'delete': out.push(...(await inline(ctx, n.children, { ...cur, color: Pal.muted }))); break;
			case 'link':
				out.push(...(await inline(ctx, n.children, { ...cur, color: Pal.link, flags: cur.flags | GlyphFlag.link, href: n.url })));
				break;
			case 'inlineCode': {
				const nxt = nodes[i + 1];
				const m = nxt?.type === 'text' ? /^\{:([a-zA-Z0-9_+#-]+)\}/.exec(nxt.value) : null;
				const base: Style = { ...cur, font: cur.font === F.bold || cur.font === F.sans ? F.code : F.code, size: cur.size * 0.9, flags: cur.flags | GlyphFlag.code, inlineCode: true, color: CODE_INK };
				if (m) {
					nxt.value = nxt.value.slice(m[0].length);
					out.push(...(await shikiRuns(ctx, n.value, m[1], base, false)).flat());
				} else out.push(textRun(n.value, base));
				break;
			}
			case 'break': out.push({ brk: true, font: cur.font, size: cur.size, color: cur.color, flags: 0 }); break;
			case 'inlineMath': out.push({ math: { tex: n.value, display: false }, font: cur.font, size: cur.size, color: Pal.ink, flags: GlyphFlag.math, href: cur.href }); break;
			case 'image': out.push({ imageInline: { src: n.url, alt: n.alt ?? '' }, font: cur.font, size: cur.size, color: cur.color, flags: 0 }); break;
			case 'footnoteReference': {
				let k = ctx.footnoteOrder.indexOf(n.identifier);
				if (k < 0) k = ctx.footnoteOrder.push(n.identifier) - 1;
				out.push({ text: String(k + 1), font: F.sans, size: 0.7, color: Pal.link, flags: GlyphFlag.link | GlyphFlag.super, href: `#fn-${n.identifier}`, sup: true });
				break;
			}
			case 'html': htmlInline(ctx, n, htmlTokens(n.value), style, out, htmlStack); break;
			default:
				throw new ParseError(`${at(ctx, n)}: unsupported inline markdown node "${n.type}"`);
		}
	}
	if (htmlStack.length) throw new ParseError(`${ctx.file}: unclosed inline html tag`);
	return normalise(out);
}

/** Collapse double spaces across run boundaries and trim the block ends (not inside code). */
function normalise(runs: Run[]): Run[] {
	const out: Run[] = [];
	let prevSpace = true;
	for (const r of runs) {
		if (r.text === undefined) { out.push(r); prevSpace = false; continue; }
		let t = r.text;
		if (!r.inlineCode) {
			if (prevSpace) t = t.replace(/^ +/, '');
		}
		if (!t) continue;
		out.push({ ...r, text: t });
		prevSpace = t.endsWith(' ');
	}
	// trailing space
	while (out.length) {
		const l = out[out.length - 1];
		if (l.text !== undefined && !l.inlineCode && l.text.endsWith(' ')) {
			const t = l.text.replace(/ +$/, '');
			if (t) { out[out.length - 1] = { ...l, text: t }; break; }
			out.pop();
		} else break;
	}
	return out;
}

// ---- shiki ---------------------------------------------------------------------------------------

/** Custom Shiki theme generated from the token table (shiki-theme.ts); tokens carry exactly the twelve SYNTAX hex colours. */
const THEME = readerTheme();

const LANG_ALIAS: Record<string, string> = { sh: 'bash', shell: 'bash', zsh: 'bash', js: 'javascript', ts: 'typescript', rs: 'rust', yml: 'yaml' };

async function shikiRuns(ctx: Ctx, code: string, langIn: string, base: Style, block: boolean): Promise<Run[][]> {
	const lang = LANG_ALIAS[langIn] ?? langIn;
	let tokens;
	try {
		tokens = (await codeToTokens(code, { lang: lang || 'text', themes: { dark: THEME }, defaultColor: false })).tokens;
	} catch (e) {
		console.warn(`reader: shiki cannot highlight lang "${lang}" at ${ctx.file}; falling back to plain text`);
		tokens = (await codeToTokens(code, { lang: 'text', themes: { dark: THEME }, defaultColor: false })).tokens;
	}
	void block;
	return tokens.map((line) =>
		line.map((tk) => {
			const st: any = tk.htmlStyle ?? {};
			const dark = st['--shiki-dark'];
			let color: Run['color'] = base.color;
			if (dark) {
				color = { dark };
				ctx.pairs.set(dark, (ctx.pairs.get(dark) ?? 0) + tk.content.length);
			}
			const r = textRun(tk.content, base);
			r.color = color;
			return r;
		})
	);
}

// ---- blocks --------------------------------------------------------------------------------------

function mdText(node: any): string {
	if (node.value !== undefined && !node.children) return node.value;
	return (node.children ?? []).map(mdText).join('');
}

function parseRefs(script: string, ctx: Ctx, node: any): RefEntry[] {
	const i = script.indexOf('useRefs(');
	if (i < 0) return [];
	let j = script.indexOf('[', i);
	if (j < 0) return [];
	let depth = 0, q = '';
	let k = j;
	for (; k < script.length; k++) {
		const c = script[k];
		if (q) { if (c === '\\') k++; else if (c === q) q = ''; continue; }
		if (c === '"' || c === "'" || c === '`') q = c;
		else if (c === '[') depth++;
		else if (c === ']' && --depth === 0) break;
	}
	try {
		// Local, trusted source: the array literal is plain data.
		return new Function(`return ${script.slice(j, k + 1)}`)() as RefEntry[];
	} catch (e) {
		throw new ParseError(`${at(ctx, node)}: cannot read useRefs([...]): ${(e as Error).message}`);
	}
}

async function blocks(ctx: Ctx, nodes: any[], inList = false): Promise<Block[]> {
	const out: Block[] = [];
	for (const n of nodes) {
		switch (n.type) {
			case 'yaml': break;
			case 'heading': {
				const runs = await inline(ctx, n.children, { ...BASE, font: F.bold, color: Pal.heading });
				const id = n.depth === 2 || n.depth === 3 ? slugify(mdText(n)) : undefined;
				out.push({ t: 'heading', depth: n.depth, runs, id });
				break;
			}
			case 'paragraph': {
				if (n.children.length === 1 && n.children[0].type === 'text' && n.children[0].value.trim() === '---page---') {
					out.push({ t: 'pagebreak' });
					break;
				}
				// split at inline images (each becomes an image block)
				let acc: any[] = [];
				const flush = async () => {
					if (acc.length) {
						const runs = await inline(ctx, acc, BASE);
						if (runs.length) out.push({ t: 'para', runs });
					}
					acc = [];
				};
				for (const c of n.children) {
					if (c.type === 'image') {
						await flush();
						out.push({ t: 'image', src: c.url, alt: c.alt ?? '' });
					} else acc.push(c);
				}
				await flush();
				break;
			}
			case 'code': {
				const code = String(n.value).replace(/\t/g, '    ');
				const lang = n.lang ?? 'text';
				const lines = await shikiRuns(ctx, code, lang, { font: F.code, size: 0.8, color: Pal.ink, flags: GlyphFlag.code }, true);
				out.push({ t: 'code', lang, lines, source: code, ...(ctx.wide ? { wide: true } : {}) });
				break;
			}
			case 'list': {
				const items: Block[][] = [];
				for (const li of n.children) items.push(await blocks(ctx, li.children, true));
				out.push({ t: 'list', ordered: !!n.ordered, start: n.start ?? 1, items });
				break;
			}
			case 'blockquote': out.push({ t: 'quote', children: await blocks(ctx, n.children) }); break;
			case 'thematicBreak': out.push({ t: 'rule' }); break;
			case 'math': out.push({ t: 'math', tex: n.value }); break;
			case 'table': {
				const rows: Run[][][] = [];
				for (let r = 0; r < n.children.length; r++) {
					const cells: Run[][] = [];
					for (const c of n.children[r].children) cells.push(await inline(ctx, c.children, r === 0 ? { ...BASE, font: F.bold } : BASE));
					rows.push(cells);
				}
				out.push({ t: 'table', align: n.align ?? [], rows });
				break;
			}
			case 'footnoteDefinition': ctx.footnoteDefs.set(n.identifier, n); break;
			case 'definition': break;
			case 'html': {
				const v: string = n.value;
				const dir = directiveFromComment(v, ctx.events);
				if (dir) {
					if (dir.kind === 'exhibit') out.push({ t: 'exhibit', id: dir.id, place: dir.place, line: dir.line });
					else ctx.wide = dir.kind === 'code-wide-open';
					break;
				}
				if (/^\s*<script[\s>]/.test(v)) {
					break; // script blocks only feed imports and refs (refs are collected up front)
				}
				if (/^\s*<!--/.test(v)) break;
				const toks = htmlTokens(v);
				const first = toks.find((t) => 'tag' in t) as Extract<Tok, { tag: string }> | undefined;
				if (first?.tag === 'References') {
					// refs list was defined by a script block earlier in the file
					out.push({ t: 'refs', items: ctx.refs });
					break;
				}
				if (first?.tag === 'StickyNote' && !first.close) {
					const inner: Run[] = [];
					const stack: Style[] = [];
					const innerToks = toks.filter((t) => !('tag' in t && t.tag === 'StickyNote'));
					htmlInline(ctx, n, innerToks, { ...BASE, font: F.body }, inner, stack);
					out.push({ t: 'note', children: [{ t: 'para', runs: normalise(inner.map((r) => (r.text !== undefined && !r.inlineCode ? { ...r, text: r.text.replace(/\s+/g, ' ') } : r))) }] });
					break;
				}
				// other html at block level: treat as a paragraph of inline html (throws on unknown tags)
				const runs: Run[] = [];
				htmlInline(ctx, n, toks, BASE, runs, []);
				if (runs.length) out.push({ t: 'para', runs: normalise(runs) });
				break;
			}
			default:
				throw new ParseError(`${at(ctx, n)}: unsupported markdown node "${n.type}"`);
		}
	}
	void inList;
	return out;
}

export async function parseArticle(file: string): Promise<Parsed> {
	const source = fs.readFileSync(file, 'utf8');
	const slug = file.split('/').slice(-2)[0];
	const ex = extractDirectives(source, file); // fail closed on unknown directives, file:line
	const tree: any = processor.parse(ex.source);
	const fm = tree.children.find((c: any) => c.type === 'yaml');
	const meta = (fm ? YAML.parse(fm.value) : {}) as Parsed['meta'];
	if (!meta.title) throw new ParseError(`${file}: frontmatter has no title`);
	meta.title = String(meta.title);
	meta.dek = String(meta.dek ?? '');
	meta.date = meta.date instanceof Date ? (meta.date as Date).toISOString().slice(0, 10) : String(meta.date ?? '');
	meta.visible = meta.visible !== false;
	const ctx: Ctx = { file, refs: [], pairs: new Map(), footnoteOrder: [], footnoteDefs: new Map(), events: ex.events };
	// useRefs script may follow its first use in file order only for References; collect refs first.
	for (const c of tree.children) if (c.type === 'html' && /<script[\s>]/.test(c.value) && c.value.includes('useRefs(')) ctx.refs.push(...parseRefs(c.value, ctx, c));
	let bl = await blocks(ctx, tree.children);
	if (ctx.footnoteOrder.length) {
		const items = ctx.footnoteOrder.map((id, i) => {
			const def = ctx.footnoteDefs.get(id);
			if (!def) throw new ParseError(`${file}: footnote [^${id}] has no definition`);
			return { id, n: i + 1, def };
		});
		const fn: { n: number; children: Block[] }[] = [];
		for (const it of items) fn.push({ n: it.n, children: await blocks(ctx, it.def.children) });
		bl = [...bl, { t: 'footnotes', items: fn }];
	}
	// drop a leading h1 that repeats the frontmatter title
	const plain = meta.title.replace(/`([^`]+)`/g, '$1').trim().toLowerCase();
	if (bl[0]?.t === 'heading' && bl[0].depth === 1 && bl[0].runs.map((r) => r.text ?? '').join('').trim().toLowerCase() === plain) bl = bl.slice(1);
	return { slug, file, meta, blocks: bl, refs: ctx.refs, source, body: bodyOf(source), distill: parseDistill(fm ? (YAML.parse(fm.value) ?? {}).distill : undefined, file), shikiPairs: ctx.pairs };
}
