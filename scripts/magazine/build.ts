// Reading build: every thoughts/*/+page.svx (+ figures.ts, spread.json) -> RDR3 page binaries, one per width class.
//   bun scripts/magazine/build.ts [--force] [--only slug]
// Output: static/magazine/<slug>.<wide|mid|narrow>.<hash>.bin, fonts.<hash>.bin, index.json (version 3).
// Pipeline per article and class: parse (scripts/reader/parse.ts) -> figures (fig lane) -> flow layout (flow.ts) ->
// emitReading (emit.ts: rebase, per-figure cell grids, pack). Output is byte-deterministic for the same inputs.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { packFontsBin } from '../../src/lib/reader/format';
import { PALETTE2_SIZE, WIDTH_CLASSES } from '../../src/lib/magazine/format';
import { FontSet, GlyphTableBuilder, ROOT, FONT_SPECS, fontPath } from '../reader/fonts';
import { parseArticle, type Block, type Parsed, type Run } from '../reader/parse';
import { StringSink, TextSink, type Env } from './typeset';
import { collectImageSrcs, ImageStore } from '../reader/images';
import { emitReading, type EmitContext } from './emit';
import { CFG, flowArticle, wordsOf, type Neighbour } from './flow';
import { parsePost, lintDistill, type DistillBlock as LintBlock } from './distill';
import { voiceFor } from './voices';
import { buildPalette, PAL_SYNTAX_START, type Rgb } from './palette';
import { loadEnUs, type Hyphenator } from './hyph';
import { loadFigures, type FigureArt } from './fig/emit';

export const THOUGHTS = path.join(ROOT, 'src/routes/(site)/thoughts');
export const OUT_DIR = path.join(ROOT, 'static/magazine');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const sha1 = (b: Buffer | Uint8Array | string) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 10);

export interface MagClass { id: number; name: 'wide' | 'mid' | 'narrow' }
export const MAG_CLASSES: MagClass[] = WIDTH_CLASSES.map((c) => ({ id: c.id, name: c.name }));

/** Channel records are article-global and the runtime channel table holds 256 f32 (reader[32..288)). */
export const MAX_CHANNELS = 256;

// ---- palette ----------------------------------------------------------------------------------------

const hexRGB = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const toRgb = (h: string): Rgb => hexRGB(h).map((v) => v / 255) as unknown as Rgb;
export const SYNTAX_BASE = PAL_SYNTAX_START;

/** Greedy palette quantisation: the most-used shiki (github-dark) colours get the syntax slots, the rest map to the nearest. */
export function quantiseSyntax(pairs: Map<string, number>) {
	const entries = [...pairs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const reps = entries.slice(0, PALETTE2_SIZE - SYNTAX_BASE).map(([k]) => k);
	const dist = (a: string, b: string) => {
		const ar = hexRGB(a), br = hexRGB(b);
		return ar.reduce((s, v, i) => s + (v - br[i]) ** 2, 0);
	};
	const idx = new Map<string, number>();
	for (const [k] of entries) {
		let best = 0, bd = Infinity;
		reps.forEach((r, i) => { const d = dist(k, r); if (d < bd) { bd = d; best = i; } });
		idx.set(k, SYNTAX_BASE + best);
	}
	return { syntax: reps.map((r) => ({ dark: r })), idx };
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

export interface BuildOpts { force?: boolean; only?: string; quiet?: boolean; thoughts?: string; outDir?: string }
export interface BuildResult { skipped: boolean; index: any; files: { name: string; bytes: number; brotli: number }[]; ms: number }

interface Shared { fonts: FontSet; union: GlyphTableBuilder; missing: Set<string>; images: ImageStore; shikiIdx: Map<string, number>; syntax: { dark: string }[] }

function voiceOf(slug: string, side: ReturnType<typeof sidecar>) {
	const ov: Record<string, number> = {};
	if (side.accentHue !== undefined) ov.hue = side.accentHue;
	if (side.display?.wdth !== undefined) ov.wdth = side.display.wdth;
	if (side.display?.wght !== undefined) ov.wght = side.display.wght;
	try { return voiceFor(slug, ov); } catch { return { slug, hue: 265, wdth: 85, wght: 600, ...ov }; }
}

/** One article at one width class: flow layout and emit. */
async function layOut(sh: Shared, p: Parsed, cls: MagClass, neighbours: { prev?: Neighbour; next?: Neighbour }) {
	const dir = path.dirname(p.file);
	const side = sidecar(dir);
	const voice = voiceOf(p.slug, side);
	const palette = buildPalette(side.accentHue ?? voice.hue, sh.syntax.map((x) => toRgb(x.dark)));
	const cfg = CFG[cls.id];
	const wc = { id: cls.id, sheetW: cfg.colW, sheetH: 0, measure: cfg.colW, marginX: 0, marginY: 0 };
	const env: Env = {
		fonts: sh.fonts, union: sh.union, extra: new GlyphTableBuilder(), cls: wc, digitSets: [], shikiIdx: sh.shikiIdx, images: sh.images,
		strings: new StringSink(), text: new TextSink(), slug: p.slug, missing: sh.missing,
		kp: { justify: false, hyphenator: hyphFor(side.hyphenExceptions) }
	};
	const figFile = path.join(dir, 'figures.ts');
	const figures = fs.existsSync(figFile) ? await loadFigures(figFile, env) : new Map<string, FigureArt>();
	const flow = flowArticle({
		p, env, cfg, figures, display: sh.fonts.display(voice.wdth, voice.wght), neighbours,
		ctx: { extra: env.extra, union: env.union, strings: env.strings.bytes(), palette, digitSets: env.digitSets } as never
	});
	const text = env.text.bytes();
	flow.finish(text);
	const ctx: EmitContext = { extra: env.extra, union: env.union, text, strings: env.strings.bytes(), palette, digitSets: env.digitSets };
	const r = emitReading(flow.store, flow.parts, ctx, `${p.file} [${cls.name}]`);
	return { ...r, words: flow.words, hasBrief: !!p.distill, docH: flow.parts.docH };
}

async function prepare(files: string[], errors: string[], log: (...a: unknown[]) => void) {
	const parsed: Parsed[] = [];
	for (const f of files) {
		try { parsed.push(await parseArticle(f)); } catch (e) { errors.push((e as Error).message); }
	}
	if (errors.length) throw new Error(`reading build: ${errors.length} article(s) failed to parse:\n  ${errors.join('\n  ')}`);
	for (const p of parsed) {
		try {
			if (p.distill) {
				const post = parsePost(p.source, p.file);
				const ids = fs.existsSync(path.join(path.dirname(p.file), 'figures.ts')) ? undefined : [];
				const lint = lintDistill({ captions: [], synth: [], ...p.distill } as unknown as LintBlock, post, ids ? { figureIds: ids } : {});
				for (const w of lint.warnings) log(`reading: ${p.slug}: distill warning ${w.path}: ${w.message}`);
				if (!lint.ok) errors.push(`${p.file}: distill lint:\n    ${lint.errors.map((e) => `${e.path}: ${e.message}`).join('\n    ')}`);
			}
		} catch (e) { errors.push((e as Error).message); }
	}
	if (errors.length) throw new Error(`reading build failed:\n  ${errors.join('\n  ')}`);
	const images = new ImageStore();
	for (const p of parsed) for (const src of collectImageSrcs(p.blocks)) await images.add(src, p.file);
	const pairs = new Map<string, number>();
	for (const p of parsed) for (const [k, v] of p.shikiPairs) pairs.set(k, (pairs.get(k) ?? 0) + v);
	const { syntax, idx: shikiIdx } = quantiseSyntax(pairs);
	const sh: Shared = { fonts: new FontSet(), union: new GlyphTableBuilder(), missing: new Set(), images, shikiIdx, syntax };
	return { parsed, sh };
}

const fontsBin = (sh: Shared) => {
	const table = sh.union.finish();
	return packFontsBin(table, sh.fonts.fonts.map((f) => f.info), Uint32Array.from(sh.union.tag.map((t) => Number(t[0]))), Uint32Array.from(sh.union.tag.map((t) => Number(t[1]))));
};

/** Visible articles newest first; prev = the next newer one, next = the next older one. */
export function neighboursOf(parsed: Parsed[]): Map<string, { prev?: Neighbour; next?: Neighbour }> {
	const vis = parsed.filter((p) => p.meta.visible).sort((a, b) => String(b.meta.date).localeCompare(String(a.meta.date)) || (a.slug < b.slug ? -1 : 1));
	const out = new Map<string, { prev?: Neighbour; next?: Neighbour }>();
	const nb = (p?: Parsed): Neighbour | undefined => (p ? { slug: p.slug, title: p.meta.title } : undefined);
	vis.forEach((p, i) => out.set(p.slug, { prev: nb(vis[i - 1]), next: nb(vis[i + 1]) }));
	return out;
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
	const stamp = opts.only ? '' : inputsHash(thoughts);
	if (!opts.force && stamp && fs.existsSync(stampFile)) {
		const prev = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
		const ok = prev.version === 3 && prev.stamp === stamp && [prev.fonts, ...prev.articles.flatMap((a: any) => Object.values(a.bins).map((b: any) => b.file))].every((f: string) => fs.existsSync(path.join(outDir, f)));
		if (ok) return { skipped: true, index: prev, files: [], ms: performance.now() - t0 };
	}
	const all = fs.readdirSync(thoughts).sort().map((d) => path.join(thoughts, d, '+page.svx')).filter((f) => fs.existsSync(f));
	const errors: string[] = [];
	// neighbours need every article's meta, so the whole set is parsed even for --only
	const { parsed: everything, sh } = await prepare(all, errors, log);
	const parsed = everything.filter((p) => !opts.only || p.slug === opts.only);
	const nbs = neighboursOf(everything);
	const { union, missing, images } = sh;

	type Built = { p: Parsed; cls: MagClass; bytes: Uint8Array; words: number; hasBrief: boolean; docH: number };
	const built: Built[] = [];
	for (const p of parsed) {
		for (const cls of MAG_CLASSES) {
			try {
				const r = await layOut(sh, p, cls, nbs.get(p.slug) ?? {});
				built.push({ p, cls, bytes: r.bytes, words: r.words, hasBrief: r.hasBrief, docH: r.docH });
			} catch (e) { errors.push(`${p.file} [${cls.name}]: ${(e as Error).stack?.split('\n').slice(0, 5).join('\n    ') ?? (e as Error).message}`); }
		}
	}
	if (missing.size) errors.push(`characters with no glyph in the chosen font (the build fails closed):\n    ${[...missing].join('\n    ')}`);
	if (errors.length) throw new Error(`reading build failed:\n  ${errors.join('\n  ')}`);

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
		for (const cls of MAG_CLASSES) {
			const b = built.find((x) => x.p === p && x.cls.id === cls.id)!;
			const name = `${p.slug}.${cls.name}.${sha1(b.bytes)}.bin`;
			const e = write(name, b.bytes);
			bins[cls.name] = { file: name, bytes: e.bytes, brotli: e.brotli, docH: b.docH };
		}
		const b0 = built.find((x) => x.p === p)!;
		articles.push({
			slug: p.slug, title: p.meta.title, dek: p.meta.dek, date: p.meta.date, hidden: !p.meta.visible, hasBrief: b0.hasBrief, words: b0.words,
			hue: voiceOf(p.slug, sidecar(path.dirname(p.file))).hue, refs: p.refs, neighbours: nbs.get(p.slug) ?? {}, bins
		});
	}
	const index = {
		version: 3, magic: 'RDR3', stamp, preview: false, stubs: [] as string[], fonts: fontsName, fontsBytes: fe.bytes, fontsBrotli: fe.brotli, glyphs: union.count,
		classes: MAG_CLASSES.map((c, i) => ({ id: c.id, name: c.name, minPx: WIDTH_CLASSES[i].minPx, col: WIDTH_CLASSES[i].col })), articles, images: images.byId
	};
	if (!opts.only) {
		const keep = new Set([fontsName, 'index.json', ...articles.flatMap((a) => Object.values(a.bins).map((b: any) => b.file))]);
		for (const f of fs.readdirSync(outDir)) if (f.endsWith('.bin') && !keep.has(f)) fs.rmSync(path.join(outDir, f));
		fs.writeFileSync(stampFile, JSON.stringify(index, null, '\t'));
	} else fs.writeFileSync(path.join(outDir, 'index.partial.json'), JSON.stringify(index, null, '\t'));
	const ms = performance.now() - t0;
	log(`reading: ${articles.length} articles, ${union.count} union glyphs, ${(ms / 1000).toFixed(1)} s`);
	for (const f of outFiles) log(`  ${f.name.padEnd(48)} ${String(f.bytes).padStart(8)} B  brotli ${String(f.brotli).padStart(7)} B`);
	return { skipped: false, index, files: outFiles, ms };
}

if (process.argv[1] && /scripts\/magazine\/build\.ts$/.test(process.argv[1])) {
	const a = process.argv.slice(2);
	const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
	buildMagazine({ force: a.includes('--force'), only: val('--only') })
		.then((r) => { if (r.skipped) console.log('reading: up to date (use --force to rebuild)'); })
		.catch((e) => { console.error(e.message); process.exit(1); });
}
