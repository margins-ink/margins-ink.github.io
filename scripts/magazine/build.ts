// Magazine build: every thoughts/*/+page.svx (+ distill block, figures.ts, spread.json) -> RDR2 binaries.
//   bun scripts/magazine/build.ts [--force] [--only slug] [--preview]
// Output: static/magazine/<slug>.<wide|narrow>.<hash>.bin, fonts.<hash>.bin, index.json.
//
// Pipeline per article and width class:
//   parse (scripts/reader/parse.ts, directives + distill) -> figures (fig lane) -> distilled spread, layer 0
//   (grid lane, only if a REVIEWED distill block exists; preview builds also take unreviewed ones) ->
//   full text spreads, layer 1 (grid lane planner) -> emitMagazine (emit.ts: rebase, grid, pack).
//
// Other lanes are loaded by file, by the names in docs/MAGAZINE.md section 8. A lane that is not merged yet is
// replaced by a stub behind the same interface; the stub is recorded in index.json (`stubs`) and the production
// build (vite plugin, not --preview) fails closed on it.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { packFontsBin } from '../../src/lib/reader/format';
import { PALETTE2_SIZE } from '../../src/lib/magazine/format';
import { FontSet, GlyphTableBuilder, ROOT, FONT_SPECS, fontPath } from '../reader/fonts';
import { parseArticle, type Block, type Parsed, type Run } from '../reader/parse';
import { CLASSES, StringSink, TextSink, type Env, type WidthClass } from './typeset';
import { collectImageSrcs, ImageStore } from '../reader/images';
import { emitMagazine, TEMPLATE_IDS, type SpreadContent, type EmitContext } from './emit';
import { parsePost, lintDistill, postSha, type DistillBlock as LintBlock } from './distill';
import { voiceFor } from './voices';
import { buildPalette, PAL_SYNTAX_START, type Rgb } from './palette';
import { loadEnUs, type Hyphenator } from './hyph';
import { loadFigures, type FigureArt } from './fig/emit';
import { planDistilled, planFullText, planOpener, resetFigureSerial, type Voice } from './compose';

export const THOUGHTS = path.join(ROOT, 'src/routes/(site)/thoughts');
export const OUT_DIR = path.join(ROOT, 'static/magazine');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const sha1 = (b: Buffer | Uint8Array | string) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 10);

export interface MagClass extends WidthClass { name: 'wide' | 'narrow' }
export const MAG_CLASSES: MagClass[] = CLASSES.map((c) => ({ ...c, name: c.id === 0 ? ('wide' as const) : ('narrow' as const) }));

/** Channel records are article-global and the runtime channel table holds 256 f32 (reader[32..288)). */
export const MAX_CHANNELS = 256;

// ---- distill gate (MAGAZINE.md 1.7) -----------------------------------------------------------------

export type DistillState = 'none' | 'unreviewed' | 'reviewed';

/**
 * - no block: 'none'.
 * - review.post_sha present but different from the current body: THROWS (a post edit forces a re-review; the stale spread is not shipped).
 * - review empty: 'unreviewed' (drawn only by a preview build).
 */
export function gateDistill(p: Pick<Parsed, 'file' | 'body' | 'distill'>): DistillState {
	const d = p.distill;
	if (!d) return 'none';
	const have = d.review?.post_sha;
	if (!have) return 'unreviewed';
	const want = postSha(p.body);
	if (have !== want) throw new Error(`${p.file}: distill review.post_sha ${have.slice(0, 12)} does not match the current post body ${want.slice(0, 12)}; the post changed, re-review the distill block`);
	return 'reviewed';
}

// ---- palette ----------------------------------------------------------------------------------------

const hexRGB = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toRgb = (h: string): Rgb => hexRGB(h).map((v) => v / 255) as unknown as Rgb;
export const SYNTAX_BASE = PAL_SYNTAX_START;

/** Greedy palette quantisation: the most-used shiki [light,dark] pairs get the syntax slots, the rest map to the nearest. */
export function quantiseSyntax(pairs: Map<string, number>) {
	const entries = [...pairs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const reps = entries.slice(0, PALETTE2_SIZE - SYNTAX_BASE).map(([k]) => k);
	const dist = (a: string, b: string) => {
		const [al, ad] = a.split('|').map(hexRGB), [bl, bd] = b.split('|').map(hexRGB);
		return al.reduce((s, v, i) => s + (v - bl[i]) ** 2, 0) + ad.reduce((s, v, i) => s + (v - bd[i]) ** 2, 0);
	};
	const idx = new Map<string, number>();
	for (const [k] of entries) {
		let best = 0, bd = Infinity;
		reps.forEach((r, i) => { const d = dist(k, r); if (d < bd) { bd = d; best = i; } });
		idx.set(k, SYNTAX_BASE + best);
	}
	return { syntax: reps.map((r) => { const [light, dark] = r.split('|'); return { light, dark }; }), idx };
}

function sidecar(dir: string): { accentHue?: number; hyphenExceptions?: string[]; display?: { wdth?: number; wght?: number } } {
	const f = path.join(dir, 'spread.json');
	return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

const hyphCache = new Map<string, Hyphenator>();
const hyphFor = (ex: string[] = []) => {
	const k = ex.join('|');
	let h = hyphCache.get(k);
	if (!h) { h = loadEnUs(ex); hyphCache.set(k, h); }
	return h;
};

// ---- text helpers -----------------------------------------------------------------------------------

const runText = (rs: Run[]) => rs.map((r) => r.text ?? '').join('');
export function blockText(bl: Block[]): string {
	const out: string[] = [];
	const walk = (b: Block) => {
		switch (b.t) {
			case 'heading': case 'para': out.push(runText(b.runs)); break;
			case 'code': out.push(b.source); break;
			case 'list': b.items.forEach((i) => i.forEach(walk)); break;
			case 'quote': case 'note': b.children.forEach(walk); break;
			case 'table': b.rows.forEach((r) => r.forEach((c) => out.push(runText(c)))); break;
			case 'footnotes': b.items.forEach((i) => i.children.forEach(walk)); break;
			case 'refs': b.items.forEach((r) => out.push(r.title)); break;
			default: break;
		}
	};
	bl.forEach(walk);
	return out.join('\n');
}
export const wordCount = (bl: Block[]) => (blockText(bl).match(/\S+/g) ?? []).length;

// ---- build ------------------------------------------------------------------------------------------

export interface BuildOpts { force?: boolean; only?: string; preview?: boolean; quiet?: boolean; thoughts?: string; outDir?: string }
export interface BuildResult { skipped: boolean; index: any; files: { name: string; bytes: number; brotli: number }[]; ms: number }

interface Shared { fonts: FontSet; union: GlyphTableBuilder; missing: Set<string>; images: ImageStore; shikiIdx: Map<string, number>; syntax: { light: string; dark: string }[] }

interface Laid { spreads: SpreadContent[]; env: Env; palette: Uint32Array; state: DistillState }

function voiceOf(slug: string, side: ReturnType<typeof sidecar>) {
	const ov: Record<string, number> = {};
	if (side.accentHue !== undefined) ov.hue = side.accentHue;
	if (side.display?.wdth !== undefined) ov.wdth = side.display.wdth;
	if (side.display?.wght !== undefined) ov.wght = side.display.wght;
	try { return voiceFor(slug, ov); } catch { return { slug, hue: 265, wdth: 85, wght: 600, template: null as null | string, ...ov }; }
}

/** One article at one width class. `layers` selects what to lay out (preview builds ask for one). */
async function layOut(sh: Shared, p: Parsed, cls: MagClass, state: DistillState, o: { preview: boolean; layers?: ('distilled' | 'full')[]; template?: string }): Promise<Laid> {
	const dir = path.dirname(p.file);
	const side = sidecar(dir);
	const voice = voiceOf(p.slug, side);
	const palette = buildPalette(side.accentHue ?? voice.hue, sh.syntax.map((x) => [toRgb(x.light), toRgb(x.dark)] as const));
	const env: Env = {
		fonts: sh.fonts, union: sh.union, extra: new GlyphTableBuilder(), cls, digitSets: [], shikiIdx: sh.shikiIdx, images: sh.images,
		strings: new StringSink(), text: new TextSink(), slug: p.slug, missing: sh.missing,
		kp: { justify: true, hyphenator: hyphFor(side.hyphenExceptions) }
	};
	resetFigureSerial();
	const figFile = path.join(dir, 'figures.ts');
	const figures = fs.existsSync(figFile) ? await loadFigures(figFile, env) : new Map<string, FigureArt>();
	const want = (l: 'distilled' | 'full') => !o.layers || o.layers.includes(l);
	const spreads: SpreadContent[] = [];
	const v: Voice = { hue: voice.hue, wdth: voice.wdth, wght: voice.wght };
	if (want('distilled')) {
		const useDistill = !!p.distill && (state === 'reviewed' || (state === 'unreviewed' && o.preview));
		if (useDistill) {
			const d = { ...p.distill!, ...(o.template ? { template: o.template as never } : {}) };
			for (const id of d.figures) if (!figures.has(id)) throw new Error(`${p.file}: distill figure "${id}" is not in figures.ts`);
			spreads.push(planDistilled(env, { distill: d, figures, palette, voice: v, title: p.meta.title, dek: p.meta.dek, date: p.meta.date, slug: p.slug }));
		} else if (voice.template !== null) {
			// auto distill: title, dek and the first paragraph
			const lede = (p.blocks.find((b) => b.t === 'para') as Extract<Block, { t: 'para' }> | undefined)?.runs ?? null;
			spreads.push(planOpener(env, { palette, voice: v, title: p.meta.title, dek: p.meta.dek, date: p.meta.date, slug: p.slug, lede }));
		}
	}
	if (want('full')) {
		for (const b of p.blocks) if (b.t === 'fig' && !figures.has(b.id)) throw new Error(`${p.file}:${b.line}: ::fig id "${b.id}" is not in figures.ts`);
		spreads.push(...planFullText(env, p, figures, { slug: p.slug, title: p.meta.title, dek: p.meta.dek, date: p.meta.date, voice: v }));
	}
	const chans = spreads.reduce((n, s) => n + ((s.frag as { chans?: unknown[] }).chans?.length ?? 0), 0);
	if (chans > MAX_CHANNELS) throw new Error(`${p.file} [${cls.name}]: ${chans} animation channels, the runtime table holds ${MAX_CHANNELS}`);
	return { spreads, env, palette, state };
}

function emitOne(laid: Laid, cls: MagClass, where: string) {
	const { env, spreads, palette } = laid;
	const ctx: EmitContext = {
		widthClass: cls.id, sheetW: cls.sheetW, marginOuter: cls.marginX, marginSpine: cls.marginX - 1, gutter: 1.2, extra: env.extra, union: env.union,
		text: env.text.bytes(), strings: env.strings.bytes(), palette, digitSets: env.digitSets
	};
	return { ...emitMagazine(spreads, ctx, where), text: ctx.text };
}

async function prepare(files: string[], errors: string[], preview: boolean, log: (...a: unknown[]) => void) {
	const parsed: Parsed[] = [];
	for (const f of files) {
		try { parsed.push(await parseArticle(f)); } catch (e) { errors.push((e as Error).message); }
	}
	if (errors.length) throw new Error(`magazine build: ${errors.length} article(s) failed to parse:\n  ${errors.join('\n  ')}`);
	const states = new Map<string, DistillState>();
	for (const p of parsed) {
		try {
			const st = gateDistill(p);
			states.set(p.slug, st);
			if (st === 'unreviewed' && !preview) log(`magazine: ${p.slug}: distill block is unreviewed, production build uses the auto opener`);
			if (p.distill) {
				const post = parsePost(p.source, p.file);
				const ids = fs.existsSync(path.join(path.dirname(p.file), 'figures.ts')) ? undefined : [];
				const lint = lintDistill({ captions: [], synth: [], ...p.distill } as unknown as LintBlock, post, ids ? { figureIds: ids } : {});
				for (const w of lint.warnings) log(`magazine: ${p.slug}: distill warning ${w.path}: ${w.message}`);
				if (!lint.ok) errors.push(`${p.file}: distill lint:\n    ${lint.errors.map((e) => `${e.path}: ${e.message}`).join('\n    ')}`);
			}
		} catch (e) { errors.push((e as Error).message); }
	}
	if (errors.length) throw new Error(`magazine build failed:\n  ${errors.join('\n  ')}`);
	const images = new ImageStore();
	for (const p of parsed) for (const src of collectImageSrcs(p.blocks)) await images.add(src, p.file);
	const pairs = new Map<string, number>();
	for (const p of parsed) for (const [k, v] of p.shikiPairs) pairs.set(k, (pairs.get(k) ?? 0) + v);
	const { syntax, idx: shikiIdx } = quantiseSyntax(pairs);
	const sh: Shared = { fonts: new FontSet(), union: new GlyphTableBuilder(), missing: new Set(), images, shikiIdx, syntax };
	return { parsed, states, sh };
}

const fontsBin = (sh: Shared) => {
	const table = sh.union.finish();
	return packFontsBin(table, sh.fonts.fonts.map((f) => f.info), Uint32Array.from(sh.union.tag.map((t) => Number(t[0]))), Uint32Array.from(sh.union.tag.map((t) => Number(t[1]))));
};

export interface BuildReq { slug: string; cls: 'wide' | 'narrow'; template?: string; layer: 'distilled' | 'full' }

/** The preview server's entry point (watch.ts): one article, one class, one layer, unreviewed distill blocks allowed. */
export async function buildForPreview(req: BuildReq): Promise<{ fonts: Uint8Array; article: Uint8Array }> {
	const file = path.join(THOUGHTS, req.slug, '+page.svx');
	if (!fs.existsSync(file)) throw new Error(`no article "${req.slug}"`);
	const errors: string[] = [];
	const { parsed, states, sh } = await prepare([file], errors, true, () => {});
	const cls = MAG_CLASSES.find((c) => c.name === req.cls)!;
	const laid = await layOut(sh, parsed[0], cls, states.get(parsed[0].slug) ?? 'none', { preview: true, layers: [req.layer], template: req.template });
	if (!laid.spreads.length) throw new Error(`${req.slug}: no ${req.layer} layer`);
	const r = emitOne(laid, cls, `${file} [${cls.name}]`);
	if (sh.missing.size) throw new Error(`characters with no glyph: ${[...sh.missing].join(' ')}`);
	return { fonts: fontsBin(sh), article: r.bytes };
}

export function inputsHash(thoughts = THOUGHTS): string {
	const h = crypto.createHash('sha1');
	const add = (f: string) => { h.update(f); h.update(fs.readFileSync(f)); };
	for (const d of fs.readdirSync(thoughts).sort()) {
		for (const n of ['+page.svx', 'figures.ts', 'spread.json']) {
			const f = path.join(thoughts, d, n);
			if (fs.existsSync(f)) add(f);
		}
	}
	const walk = (dir: string) => {
		for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const f = path.join(dir, e.name);
			if (e.isDirectory()) { if (e.name !== 'node_modules') walk(f); }
			else if (/\.(ts|json)$/.test(e.name) && !/\.test\.ts$/.test(e.name)) add(f);
		}
	};
	walk(HERE);
	for (const f of fs.readdirSync(path.join(ROOT, 'scripts/reader')).sort()) if (f.endsWith('.ts')) add(path.join(ROOT, 'scripts/reader', f));
	add(path.join(ROOT, 'src/lib/magazine/format.ts'));
	for (const s of FONT_SPECS) add(fontPath(s.file));
	return h.digest('hex').slice(0, 16);
}

export async function buildMagazine(opts: BuildOpts = {}): Promise<BuildResult> {
	const t0 = performance.now();
	const log = (...a: unknown[]) => { if (!opts.quiet) console.log(...a); };
	const thoughts = opts.thoughts ?? THOUGHTS;
	const outDir = opts.outDir ?? OUT_DIR;
	fs.mkdirSync(outDir, { recursive: true });
	const stampFile = path.join(outDir, 'index.json');
	const stamp = opts.only ? '' : `${inputsHash(thoughts)}${opts.preview ? '+preview' : ''}`;
	if (!opts.force && stamp && fs.existsSync(stampFile)) {
		const prev = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
		const ok = prev.stamp === stamp && [prev.fonts, ...prev.articles.flatMap((a: any) => Object.values(a.bins).map((b: any) => b.file))].every((f: string) => fs.existsSync(path.join(outDir, f)));
		if (ok) return { skipped: true, index: prev, files: [], ms: performance.now() - t0 };
	}
	const files = fs.readdirSync(thoughts).sort().map((d) => path.join(thoughts, d, '+page.svx')).filter((f) => fs.existsSync(f) && (!opts.only || f.includes(`/${opts.only}/`)));
	const errors: string[] = [];
	const { parsed, states, sh } = await prepare(files, errors, !!opts.preview, log);
	const { union, fonts, missing, images } = sh;

	type Built = { p: Parsed; cls: MagClass; bytes: Uint8Array; spreadLayers: number[]; words: number; distilled: DistillState; templates: number[] };
	const built: Built[] = [];
	for (const p of parsed) {
		const state = states.get(p.slug) ?? 'none';
		for (const cls of MAG_CLASSES) {
			try {
				const laid = await layOut(sh, p, cls, state, { preview: !!opts.preview });
				const r = emitOne(laid, cls, `${p.file} [${cls.name}]`);
				const useDistilled = laid.spreads.some((s) => s.meta.layer === 0);
				built.push({ p, cls, bytes: r.bytes, spreadLayers: r.spreadLayers, words: wordCount(p.blocks), distilled: useDistilled ? state : 'none', templates: laid.spreads.map((s) => s.meta.template) });
			} catch (e) { errors.push(`${p.file}: ${(e as Error).stack?.split('\n').slice(0, 4).join('\n    ') ?? (e as Error).message}`); }
		}
	}
	if (missing.size) errors.push(`characters with no glyph in the chosen font (the build fails closed):\n    ${[...missing].join('\n    ')}`);
	if (errors.length) throw new Error(`magazine build failed:\n  ${errors.join('\n  ')}`);

	const outFiles: BuildResult['files'] = [];
	const write = (name: string, bytes: Uint8Array) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		const e = { name, bytes: bytes.length, brotli: zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
		outFiles.push(e);
		return e;
	};
	const fontsBytes = fontsBin(sh);
	const fontsName = `fonts.${sha1(fontsBytes)}.bin`;
	const fe = write(fontsName, fontsBytes);
	const articles: any[] = [];
	for (const p of parsed) {
		const bins: Record<string, any> = {};
		const spreads: Record<string, any> = {};
		let distilled: DistillState = 'none';
		for (const cls of MAG_CLASSES) {
			const b = built.find((x) => x.p === p && x.cls.id === cls.id)!;
			const name = `${p.slug}.${cls.name}.${sha1(b.bytes)}.bin`;
			const e = write(name, b.bytes);
			bins[cls.name] = { file: name, bytes: e.bytes, brotli: e.brotli };
			spreads[cls.name] = { count: b.spreadLayers.length, layers: b.spreadLayers, templates: b.templates };
			distilled = b.distilled;
		}
		const b0 = built.find((x) => x.p === p)!;
		articles.push({ slug: p.slug, title: p.meta.title, dek: p.meta.dek, date: p.meta.date, hidden: !p.meta.visible, distilled, fullWords: b0.words, spreads, bins });
	}
	const index = {
		version: 2, magic: 'RDR2', stamp, preview: !!opts.preview, stubs: [] as string[], fonts: fontsName, fontsBytes: fe.bytes, fontsBrotli: fe.brotli, glyphs: union.count,
		templates: TEMPLATE_IDS, classes: MAG_CLASSES.map((c) => ({ id: c.id, name: c.name, sheetW: c.sheetW, sheetH: c.sheetH })), articles, images: images.byId
	};
	if (!opts.only) {
		const keep = new Set([fontsName, 'index.json', ...articles.flatMap((a) => Object.values(a.bins).map((b: any) => b.file))]);
		for (const f of fs.readdirSync(outDir)) if (f.endsWith('.bin') && !keep.has(f)) fs.rmSync(path.join(outDir, f));
		fs.writeFileSync(stampFile, JSON.stringify(index, null, '\t'));
	} else fs.writeFileSync(path.join(outDir, 'index.partial.json'), JSON.stringify(index, null, '\t'));
	const ms = performance.now() - t0;
	log(`magazine: ${articles.length} articles, ${union.count} union glyphs, ${(ms / 1000).toFixed(1)} s`);
	for (const f of outFiles) log(`  ${f.name.padEnd(48)} ${String(f.bytes).padStart(8)} B  brotli ${String(f.brotli).padStart(7)} B`);
	return { skipped: false, index, files: outFiles, ms };
}

if (process.argv[1] && /scripts\/magazine\/build\.ts$/.test(process.argv[1])) {
	const a = process.argv.slice(2);
	const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
	buildMagazine({ force: a.includes('--force'), only: val('--only'), preview: a.includes('--preview') })
		.then((r) => { if (r.skipped) console.log('magazine: up to date (use --force to rebuild)'); })
		.catch((e) => { console.error(e.message); process.exit(1); });
}
