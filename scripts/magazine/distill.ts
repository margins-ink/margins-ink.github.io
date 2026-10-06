// Distilled-spread copy pipeline (docs/MAGAZINE.md 1.7): parse the `distill:` frontmatter block, lint it
// against the post (verbatim substrings, word budget, counts), and gate it on `review.post_sha`.
// Pure and deterministic: no LLM calls, no network. The agent that drafts a block runs outside this file.
//
// CLI: bun scripts/magazine/distill.ts check <slug> [--production]   (lint + gate, exit 1 on errors)
//      bun scripts/magazine/distill.ts sha <slug>                    (post_sha for the review line)

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

// ---- types (local; the `contract` lane owns the shared `Distill` type in src/lib/magazine/types.ts) ----

export const DISTILL_TEMPLATES = ['duo', 'solo', 'compare', 'numerals'] as const;
export type DistillTemplate = (typeof DISTILL_TEMPLATES)[number];

export interface DistillReview { by: string; at: string; post_sha: string }
export interface DistillBlock {
	template: DistillTemplate;
	headline: string;
	definition?: string;
	deck?: string;
	figures: string[];
	quote?: { text: string; from?: string };
	captions: { fig: string; text: string }[];
	synth: string[];
	review?: DistillReview;
}

export interface Issue { level: 'error' | 'warning'; path: string; message: string }
export interface LintResult { ok: boolean; errors: Issue[]; warnings: Issue[]; words: number }

export const WORDS_ERROR_MIN = 100;
export const WORDS_WARN_MIN = 150;
export const WORDS_MAX = 250;
export const MAX_CAPTIONS = 3;
export const MAX_FIGURES = 2;

export class DistillError extends Error {}

// ---- the post ----------------------------------------------------------------------------------

export interface Post {
	file: string;
	meta: Record<string, unknown>;
	/** raw text after the frontmatter block, CRLF folded to LF */
	body: string;
	/** sha256 hex of `body` (what `review.post_sha` pins) */
	sha: string;
	/** normalised plain text the verbatim check searches: title, dek, headings and body prose, code included */
	corpus: string;
	/** normalised heading texts */
	headings: string[];
}

const processor = unified().use(remarkParse).use(remarkFrontmatter, ['yaml']).use(remarkGfm).use(remarkMath);

/** Whitespace-normalise for comparison: NFC, collapse runs (incl. nbsp) to one space, trim. */
export function normalise(s: string): string {
	return s.normalize('NFC').replace(/[\s ]+/g, ' ').trim();
}

export function countWords(s: string): number {
	const t = normalise(s);
	return t ? t.split(' ').length : 0;
}

export function postSha(body: string): string {
	return createHash('sha256').update(body, 'utf8').digest('hex');
}

/** Split `---\n...\n---\n` frontmatter from the body. No frontmatter gives an empty meta. */
export function splitFrontmatter(source: string): { fm: string; body: string } {
	const src = source.replace(/\r\n/g, '\n');
	const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(src);
	if (!m) return { fm: '', body: src };
	return { fm: m[1], body: src.slice(m[0].length) };
}

/** Plain text of a mdast subtree. Inline html (e.g. <Cite />) and script blocks contribute nothing. */
function plain(n: any): string {
	switch (n.type) {
		case 'text': case 'inlineCode': case 'inlineMath': case 'code': case 'math': return n.value;
		case 'html': case 'yaml': case 'definition': case 'footnoteDefinition': return '';
		case 'break': return ' ';
		case 'image': return n.alt ?? '';
		default: return n.children ? n.children.map(plain).join('') : '';
	}
}

/** Block-level walk: each block's plain text on its own, joined by a space later. */
function collect(n: any, out: string[], headings: string[]) {
	if (n.type === 'heading') {
		const t = normalise(plain(n));
		headings.push(t);
		out.push(t);
		return;
	}
	if (n.type === 'paragraph' || n.type === 'code' || n.type === 'math' || n.type === 'tableCell') {
		out.push(plain(n));
		return;
	}
	if (n.children) for (const c of n.children) collect(c, out, headings);
}

export function parsePost(source: string, file = '<memory>'): Post {
	const { fm, body } = splitFrontmatter(source);
	let meta: Record<string, unknown> = {};
	if (fm) {
		try {
			meta = (YAML.parse(fm) ?? {}) as Record<string, unknown>;
		} catch (e) {
			throw new DistillError(`${file}: frontmatter is not valid YAML: ${(e as Error).message}`);
		}
	}
	const tree: any = processor.parse(body);
	const parts: string[] = [];
	const headings: string[] = [];
	for (const k of ['title', 'dek']) if (typeof meta[k] === 'string') parts.push(meta[k] as string);
	collect(tree, parts, headings);
	return { file, meta, body, sha: postSha(body), corpus: normalise(parts.join(' ')), headings };
}

// ---- parsing the block -------------------------------------------------------------------------

const BLOCK_KEYS = new Set(['template', 'headline', 'definition', 'deck', 'figures', 'quote', 'captions', 'synth', 'review']);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validate the shape of `meta.distill` (fail closed: unknown keys, wrong types). Returns null if absent. */
export function parseDistill(meta: Record<string, unknown>, file = '<memory>'): DistillBlock | null {
	const raw = meta.distill;
	if (raw === undefined || raw === null) return null;
	const bad = (p: string, m: string): never => { throw new DistillError(`${file}: distill.${p}: ${m}`); };
	if (!isObj(raw)) return bad('', 'must be a mapping');
	for (const k of Object.keys(raw)) if (!BLOCK_KEYS.has(k)) bad(k, 'unknown key');
	const str = (v: unknown, p: string, req: boolean): string | undefined => {
		if (v === undefined || v === null) return req ? bad(p, 'required') : undefined;
		if (typeof v !== 'string' || !normalise(v)) return bad(p, 'must be a non-empty string');
		return v;
	};
	const template = str(raw.template, 'template', true) as DistillTemplate;
	if (!(DISTILL_TEMPLATES as readonly string[]).includes(template)) bad('template', `"${template}" is not one of ${DISTILL_TEMPLATES.join(' | ')}`);
	const headline = str(raw.headline, 'headline', true)!;
	const list = (v: unknown, p: string): unknown[] => {
		if (v === undefined || v === null) return [];
		if (!Array.isArray(v)) return bad(p, 'must be a list');
		return v;
	};
	const figures = list(raw.figures, 'figures').map((f, i) => str(f, `figures[${i}]`, true)!);
	const captions = list(raw.captions, 'captions').map((c, i) => {
		if (!isObj(c)) return bad(`captions[${i}]`, 'must be { fig, text }');
		for (const k of Object.keys(c)) if (k !== 'fig' && k !== 'text') bad(`captions[${i}].${k}`, 'unknown key');
		return { fig: str(c.fig, `captions[${i}].fig`, true)!, text: str(c.text, `captions[${i}].text`, true)! };
	});
	let quote: DistillBlock['quote'];
	if (raw.quote !== undefined && raw.quote !== null) {
		const q = raw.quote;
		if (!isObj(q)) return bad('quote', 'must be { text, from }');
		for (const k of Object.keys(q)) if (k !== 'text' && k !== 'from') bad(`quote.${k}`, 'unknown key');
		quote = { text: str(q.text, 'quote.text', true)!, from: str(q.from, 'quote.from', false) };
	}
	const synth = list(raw.synth, 'synth').map((s, i) => str(s, `synth[${i}]`, true)!);
	let review: DistillReview | undefined;
	const r = raw.review;
	if (r !== undefined && r !== null && !(isObj(r) && Object.keys(r).length === 0)) {
		if (!isObj(r)) return bad('review', 'must be { by, at, post_sha }');
		for (const k of Object.keys(r)) if (k !== 'by' && k !== 'at' && k !== 'post_sha') bad(`review.${k}`, 'unknown key');
		const at = r.at instanceof Date ? r.at.toISOString().slice(0, 10) : str(r.at, 'review.at', true)!;
		review = { by: str(r.by, 'review.by', true)!, at, post_sha: str(r.post_sha, 'review.post_sha', true)! };
	}
	return { template, headline, definition: str(raw.definition, 'definition', false), deck: str(raw.deck, 'deck', false), figures, quote, captions, synth, review };
}

// ---- the lint ----------------------------------------------------------------------------------

export interface LintOptions {
	/** ids defined in the article's figures.ts; when given, every referenced id must be in it */
	figureIds?: string[];
	/** text labels per figure id (from the compiled figures); counted in the word budget */
	figureLabels?: Record<string, string[]>;
}

/** A copy slot: its path (as used in `synth`) and string. */
export function slots(b: DistillBlock): { path: string; text: string }[] {
	const out: { path: string; text: string }[] = [{ path: 'headline', text: b.headline }];
	if (b.definition) out.push({ path: 'definition', text: b.definition });
	if (b.deck) out.push({ path: 'deck', text: b.deck });
	if (b.quote) {
		out.push({ path: 'quote.text', text: b.quote.text });
		if (b.quote.from) out.push({ path: 'quote.from', text: b.quote.from });
	}
	b.captions.forEach((c, i) => out.push({ path: `captions[${i}]`, text: c.text }));
	return out;
}

/** `captions.1` and `captions[1]` are the same path. */
const canonPath = (p: string) => p.replace(/\.(\d+)/g, '[$1]');

export function lintDistill(b: DistillBlock, post: Post, opts: LintOptions = {}): LintResult {
	const errors: Issue[] = [];
	const warnings: Issue[] = [];
	const err = (p: string, message: string) => errors.push({ level: 'error', path: p, message });
	const warn = (p: string, message: string) => warnings.push({ level: 'warning', path: p, message });

	const all = slots(b);
	const synth = new Set(b.synth.map(canonPath));
	for (const s of synth) if (!all.some((x) => x.path === s)) err('synth', `"${s}" names no copy slot (slots: ${all.map((x) => x.path).join(', ')})`);

	// 1. verbatim substring of the post after Markdown stripping and whitespace normalisation
	for (const s of all) {
		if (synth.has(s.path) || s.path === 'quote.from') continue;
		const t = normalise(s.text);
		if (!post.corpus.includes(t)) err(s.path, `not a verbatim substring of the post: "${t.length > 80 ? t.slice(0, 77) + '...' : t}" (list the path in synth if it is deliberately synthesised)`);
	}
	if (b.quote?.from && !synth.has('quote.from') && !post.headings.includes(normalise(b.quote.from))) err('quote.from', `"${b.quote.from}" is not a section heading of the post`);

	// 2. counts and references
	if (b.captions.length > MAX_CAPTIONS) err('captions', `${b.captions.length} captions, at most ${MAX_CAPTIONS}`);
	if (b.figures.length < 1 || b.figures.length > MAX_FIGURES) err('figures', `${b.figures.length} figures, need 1 to ${MAX_FIGURES}`);
	if (new Set(b.figures).size !== b.figures.length) err('figures', 'duplicate figure id');
	if (opts.figureIds) for (const f of b.figures) if (!opts.figureIds.includes(f)) err('figures', `figure "${f}" is not in figures.ts (${opts.figureIds.join(', ') || 'none'})`);
	b.captions.forEach((c, i) => { if (!b.figures.includes(c.fig)) err(`captions[${i}].fig`, `"${c.fig}" is not one of figures`); });

	// 3. word budget over headline, definition, deck, quote, captions and figure labels
	let words = all.filter((s) => s.path !== 'quote.from').reduce((n, s) => n + countWords(s.text), 0);
	for (const f of b.figures) for (const l of opts.figureLabels?.[f] ?? []) words += countWords(l);
	if (words < WORDS_ERROR_MIN) err('words', `${words} words, minimum ${WORDS_ERROR_MIN}`);
	else if (words > WORDS_MAX) err('words', `${words} words, maximum ${WORDS_MAX}`);
	else if (words < WORDS_WARN_MIN) warn('words', `${words} words, below the ${WORDS_WARN_MIN} target`);

	return { ok: errors.length === 0, errors, warnings, words };
}

// ---- the review gate ---------------------------------------------------------------------------

export type GateMode = 'preview' | 'production';

/**
 * review.post_sha must equal the current post body hash (a post edit forces re-review, in any mode).
 * An unreviewed block is allowed in preview only; production refuses it.
 */
export function reviewGate(b: DistillBlock, post: Post, mode: GateMode): Issue[] {
	const out: Issue[] = [];
	if (!b.review) {
		if (mode === 'production') out.push({ level: 'error', path: 'review', message: 'unreviewed distilled block cannot ship in the production build (needs review: { by, at, post_sha })' });
		return out;
	}
	if (b.review.post_sha !== post.sha) out.push({ level: 'error', path: 'review.post_sha', message: `stale: review pins ${b.review.post_sha.slice(0, 12)} but the post body is ${post.sha.slice(0, 12)}; re-review and update post_sha` });
	return out;
}

export interface CheckResult extends LintResult { gate: Issue[]; block: DistillBlock | null }

/** Full check for one post: parse, lint, gate. `block` is null (and ok) when the post has no distill block. */
export function checkDistill(source: string, file: string, mode: GateMode, opts: LintOptions = {}): CheckResult {
	const post = parsePost(source, file);
	const block = parseDistill(post.meta, file);
	if (!block) return { ok: true, errors: [], warnings: [], words: 0, gate: [], block: null };
	const lint = lintDistill(block, post, opts);
	const gate = reviewGate(block, post, mode);
	return { ...lint, errors: [...lint.errors, ...gate], gate, ok: lint.ok && gate.length === 0, block };
}

// ---- CLI ---------------------------------------------------------------------------------------

const postPath = (slug: string) => path.resolve(import.meta.dir, '../../src/routes/(site)/thoughts', slug, '+page.svx');

if (import.meta.main) {
	const [cmd, slug, ...flags] = process.argv.slice(2);
	if (!cmd || !slug || !['check', 'sha'].includes(cmd)) {
		console.error('usage: bun scripts/magazine/distill.ts check <slug> [--production] | sha <slug>');
		process.exit(2);
	}
	const file = postPath(slug);
	const source = fs.readFileSync(file, 'utf8');
	if (cmd === 'sha') {
		console.log(parsePost(source, file).sha);
	} else {
		const r = checkDistill(source, file, flags.includes('--production') ? 'production' : 'preview');
		if (!r.block) console.log(`${slug}: no distill block (opens on the full text layer)`);
		for (const i of [...r.errors, ...r.warnings]) console.log(`${i.level} ${slug} ${i.path}: ${i.message}`);
		if (r.block) console.log(`${slug}: ${r.words} words, ${r.errors.length} errors, ${r.warnings.length} warnings`);
		process.exit(r.ok ? 0 : 1);
	}
}
