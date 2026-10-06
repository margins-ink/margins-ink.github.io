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
import { pathToFileURL } from 'node:url';
import { packFontsBin } from '../../src/lib/reader/format';
import { PAL2, PALETTE2_SIZE, Material } from '../../src/lib/magazine/format';
import type { CompiledFigure } from '../../src/lib/magazine/types';
import { FontSet, GlyphTableBuilder, ROOT, FONT_SPECS } from '../reader/fonts';
import { parseArticle, type Block, type Parsed, type Run } from '../reader/parse';
import { CLASSES, StringSink, TextSink, type Env, type WidthClass } from '../reader/layout';
import { collectImageSrcs, ImageStore } from '../reader/images';
import { emitMagazine, TEMPLATE_IDS, templateId, type Fragment, type SpreadContent, type EmitContext } from './emit';
import type { DistillBlock } from './parse-directives';

export const THOUGHTS = path.join(ROOT, 'src/routes/(site)/thoughts');
export const OUT_DIR = path.join(ROOT, 'static/magazine');
const HERE = path.dirname(new URL(import.meta.url).pathname);
const sha1 = (b: Buffer | Uint8Array | string) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 10);

// ---- lane interfaces (the contract the other lanes implement) -------------------------------------

export interface MagClass extends WidthClass { name: 'wide' | 'narrow' }
export const MAG_CLASSES: MagClass[] = CLASSES.map((c) => ({ ...c, name: c.id === 0 ? ('wide' as const) : ('narrow' as const) }));

/** A figure after the fig lane compiled it: figure-local fragment (origin top-left of the figure, em) plus lint data. */
export interface FigureArt { id: string; fragment: Fragment; size: [number, number]; compiled: CompiledFigure }

export interface Voice { hue: number; wdth: number; wght: number }

export interface DistilledInput {
	distill: DistillBlock;
	figures: Map<string, FigureArt>;
	palette: Uint32Array;
	voice: Voice;
	title: string;
	slug: string;
}

/** grid lane: scripts/magazine/planner.ts. `env` is the reader Env (fonts, glyph builders, sinks, images, class). */
export interface Planner {
	planDistilled(env: Env, input: DistilledInput): SpreadContent;
	planFullText(env: Env, blocks: Block[], figures: Map<string, FigureArt>, opts: { slug: string; palette: Uint32Array; voice: Voice }): SpreadContent[];
}

/** fig lane: scripts/magazine/fig/index.ts. `file` is the article's figures.ts. */
export interface FigureLoader { loadFigures(file: string, env: Env): Promise<Map<string, FigureArt>> }

/** distill lane: scripts/magazine/distill.ts. Returns error strings; empty means clean. */
export interface DistillLint { lintDistill(d: DistillBlock, body: string, figureIds: string[]): string[]; postSha?(body: string): string }

/** type lane: voices.ts and palette.ts. */
export interface PaletteLane { paletteFor(hue: number, syntax: { light: string; dark: string }[]): Uint32Array }
export interface VoiceLane { voiceFor(slug: string): Voice | undefined }

export interface Lanes {
	planner: Planner;
	figures: FigureLoader;
	distill?: DistillLint;
	palette?: PaletteLane;
	voices?: VoiceLane;
	stubs: string[];
}

const stubPlanner: Planner = {
	planDistilled: (_e, i) => ({ meta: { layer: 0, template: templateId(i.distill.template), w: 80, h: 56, materialMask: Material.matte, accentIdx: PAL2.accent }, frag: { items: [] } }),
	planFullText: (e) => [{ meta: { layer: 1, template: templateId('text'), w: e.cls.id === 0 ? 80 : 28, h: 56, materialMask: Material.matte, accentIdx: PAL2.accent }, frag: { items: [] } }]
};
const stubFigures: FigureLoader = { loadFigures: async () => new Map() };

async function lane<T>(rel: string, pick: (m: any) => T | undefined): Promise<T | undefined> {
	const file = path.join(HERE, rel);
	if (!fs.existsSync(file)) return undefined;
	return pick(await import(pathToFileURL(file).href));
}

export async function loadLanes(): Promise<Lanes> {
	const stubs: string[] = [];
	const planner = await lane('planner.ts', (m) => (typeof m.planDistilled === 'function' && typeof m.planFullText === 'function' ? (m as Planner) : undefined));
	const figures = await lane('fig/index.ts', (m) => (typeof m.loadFigures === 'function' ? (m as FigureLoader) : undefined));
	if (!planner) stubs.push('planner');
	if (!figures) stubs.push('figures');
	return {
		planner: planner ?? stubPlanner,
		figures: figures ?? stubFigures,
		distill: await lane('distill.ts', (m) => (typeof m.lintDistill === 'function' ? (m as DistillLint) : undefined)),
		palette: await lane('palette.ts', (m) => (typeof m.paletteFor === 'function' ? (m as PaletteLane) : undefined)),
		voices: await lane('voices.ts', (m) => (typeof m.voiceFor === 'function' ? (m as VoiceLane) : undefined)),
		stubs
	};
}

// ---- distill gate (MAGAZINE.md 1.7) -----------------------------------------------------------------

export const bodySha = (body: string) => crypto.createHash('sha256').update(body).digest('hex');
export type DistillState = 'none' | 'unreviewed' | 'reviewed';

/**
 * - no block: 'none' (the article opens on its full text layer).
 * - review.post_sha present but different from the current body: THROWS (a post edit forces a re-review; the stale spread is not shipped).
 * - review empty: 'unreviewed' (drawn only by a preview build).
 */
export function gateDistill(p: Pick<Parsed, 'file' | 'body' | 'distill'>, lanes?: Pick<Lanes, 'distill'>): DistillState {
	const d = p.distill;
	if (!d) return 'none';
	const have = d.review?.post_sha;
	if (!have) return 'unreviewed';
	const want = lanes?.distill?.postSha?.(p.body) ?? bodySha(p.body);
	if (have !== want) throw new Error(`${p.file}: distill review.post_sha ${have.slice(0, 12)} does not match the current post body ${want.slice(0, 12)}; the post changed, re-review the distill block`);
	return 'reviewed';
}

// ---- palette fallback -------------------------------------------------------------------------------

const hexRGB = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const rgba = (h: string, a = 255) => { const [r, g, b] = hexRGB(h); return ((a << 24) | (b << 16) | (g << 8) | r) >>> 0; };
export const SYNTAX_BASE = 18; // palette slots after the named ones (PAL2 ends at 17)

/** Used only when the `type` lane's palette.ts is not merged: reserved and named slots from fixed values, syntax slots from shiki pairs. */
export function fallbackPalette(accent: { light: string; dark: string }, syntax: { light: string; dark: string }[]): Uint32Array {
	const pal = new Uint32Array(PALETTE2_SIZE * 2);
	const L: Record<string, number> = {
		ink: rgba('#1c1917'), link: rgba(accent.light), muted: rgba('#78716c'), heading: rgba('#1c1917'), rule: rgba('#d6d3d1'), selection: rgba('#3b82f6', 0x55), codeBg: rgba('#e6e0d2'), quoteBar: rgba('#a8a29e'),
		accent: rgba(accent.light), accent2: rgba(accent.light), accentTint: rgba(accent.light, 0x1f), accentInk: rgba('#f1ede4'), neutral1: rgba('#78716c'), neutral2: rgba('#a8a29e'), neutral3: rgba('#d6d3d1'),
		panel: rgba('#e6e0d2'), field: rgba(accent.light), paper: rgba('#f1ede4')
	};
	const D: Record<string, number> = {
		ink: rgba('#e7e5e4'), link: rgba(accent.dark), muted: rgba('#a8a29e'), heading: rgba('#fafaf9'), rule: rgba('#44403c'), selection: rgba('#60a5fa', 0x66), codeBg: rgba('#24211e'), quoteBar: rgba('#78716c'),
		accent: rgba(accent.dark), accent2: rgba(accent.dark), accentTint: rgba(accent.dark, 0x24), accentInk: rgba('#1c1a18'), neutral1: rgba('#a8a29e'), neutral2: rgba('#78716c'), neutral3: rgba('#44403c'),
		panel: rgba('#24211e'), field: rgba(accent.dark), paper: rgba('#1c1a18')
	};
	for (const k of Object.keys(PAL2) as (keyof typeof PAL2)[]) {
		pal[PAL2[k]] = L[k];
		pal[PALETTE2_SIZE + PAL2[k]] = D[k];
	}
	for (let i = SYNTAX_BASE; i < PALETTE2_SIZE; i++) {
		const s = syntax[i - SYNTAX_BASE];
		pal[i] = s ? rgba(s.light) : L.ink;
		pal[PALETTE2_SIZE + i] = s ? rgba(s.dark) : D.ink;
	}
	return pal;
}

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

async function accentFor(slug: string): Promise<{ light: string; dark: string }> {
	try {
		const mod = await import(path.join(ROOT, 'src/lib/covers', `${slug}.ts`));
		const { accentOf } = await import(path.join(ROOT, 'src/lib/covers/accent.ts'));
		return accentOf(mod.cover);
	} catch {
		return { light: '#57534e', dark: '#d6d3d1' };
	}
}

function sidecar(dir: string): { accentHue?: number; hyphenExceptions?: string[] } {
	const f = path.join(dir, 'spread.json');
	return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
}

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

export interface BuildOpts { force?: boolean; only?: string; preview?: boolean; quiet?: boolean; lanes?: Lanes; thoughts?: string; outDir?: string }
export interface BuildResult { skipped: boolean; index: any; files: { name: string; bytes: number; brotli: number }[]; ms: number }

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
	for (const s of FONT_SPECS) add(path.join(ROOT, 'docs/upstream/reader/fonts', s.file));
	return h.digest('hex').slice(0, 16);
}

export async function buildMagazine(opts: BuildOpts = {}): Promise<BuildResult> {
	const t0 = performance.now();
	const log = (...a: unknown[]) => { if (!opts.quiet) console.log(...a); };
	const thoughts = opts.thoughts ?? THOUGHTS;
	const outDir = opts.outDir ?? OUT_DIR;
	fs.mkdirSync(outDir, { recursive: true });
	const stampFile = path.join(outDir, 'index.json');
	const lanes = opts.lanes ?? (await loadLanes());
	const stamp = opts.only ? '' : `${inputsHash(thoughts)}${opts.preview ? '+preview' : ''}`;
	if (!opts.force && stamp && fs.existsSync(stampFile)) {
		const prev = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
		const ok = prev.stamp === stamp && [prev.fonts, ...prev.articles.flatMap((a: any) => Object.values(a.bins).map((b: any) => b.file))].every((f: string) => fs.existsSync(path.join(outDir, f)));
		if (ok) return { skipped: true, index: prev, files: [], ms: performance.now() - t0 };
	}

	// ---- parse ----
	const files = fs.readdirSync(thoughts).sort().map((d) => path.join(thoughts, d, '+page.svx')).filter((f) => fs.existsSync(f) && (!opts.only || f.includes(`/${opts.only}/`)));
	const parsed: Parsed[] = [];
	const errors: string[] = [];
	for (const f of files) {
		try { parsed.push(await parseArticle(f)); } catch (e) { errors.push((e as Error).message); }
	}
	if (errors.length) throw new Error(`magazine build: ${errors.length} article(s) failed to parse:\n  ${errors.join('\n  ')}`);

	// ---- distill gate (before any layout work, so a stale review fails fast) ----
	const states = new Map<string, DistillState>();
	for (const p of parsed) {
		try {
			const st = gateDistill(p, lanes);
			states.set(p.slug, st);
			if (st === 'unreviewed' && !opts.preview) log(`magazine: ${p.slug}: distill block is unreviewed, production build opens on the full text layer`);
			if (p.distill && lanes.distill) {
				const lint = lanes.distill.lintDistill(p.distill, p.body, p.distill.figures);
				if (lint.length) errors.push(`${p.file}: distill lint:\n    ${lint.join('\n    ')}`);
			}
		} catch (e) { errors.push((e as Error).message); }
	}
	if (errors.length) throw new Error(`magazine build failed:\n  ${errors.join('\n  ')}`);

	// ---- images and palette ----
	const images = new ImageStore();
	for (const p of parsed) for (const src of collectImageSrcs(p.blocks)) await images.add(src, p.file);
	const pairs = new Map<string, number>();
	for (const p of parsed) for (const [k, v] of p.shikiPairs) pairs.set(k, (pairs.get(k) ?? 0) + v);
	const { syntax, idx: shikiIdx } = quantiseSyntax(pairs);

	// ---- layout ----
	const fonts = new FontSet();
	const union = new GlyphTableBuilder();
	const missing = new Set<string>();
	type Built = { p: Parsed; cls: MagClass; bytes: Uint8Array; spreadLayers: number[]; words: number; distilled: DistillState; templates: number[]; text: Uint8Array };
	const built: Built[] = [];
	for (const p of parsed) {
		const dir = path.dirname(p.file);
		const side = sidecar(dir);
		const accent = await accentFor(p.slug);
		const voice: Voice = lanes.voices?.voiceFor(p.slug) ?? { hue: side.accentHue ?? 265, wdth: 85, wght: 600 };
		const palette = lanes.palette ? lanes.palette.paletteFor(side.accentHue ?? voice.hue, syntax) : fallbackPalette(accent, syntax);
		const state = states.get(p.slug) ?? 'none';
		const useDistilled = state === 'reviewed' || (state === 'unreviewed' && !!opts.preview);
		for (const cls of MAG_CLASSES) {
			const env: Env = { fonts, union, extra: new GlyphTableBuilder(), cls, shikiIdx, images, strings: new StringSink(), text: new TextSink(), slug: p.slug, missing };
			try {
				const figFile = path.join(dir, 'figures.ts');
				const figures = fs.existsSync(figFile) ? await lanes.figures.loadFigures(figFile, env) : new Map<string, FigureArt>();
				if (fs.existsSync(figFile) && lanes.stubs.includes('figures')) log(`magazine: ${p.slug}: figures.ts present but the fig lane is not merged; figures skipped`);
				const spreads: SpreadContent[] = [];
				if (useDistilled && p.distill) {
					for (const id of p.distill.figures) if (!figures.has(id) && !lanes.stubs.includes('figures')) throw new Error(`${p.file}: distill figure "${id}" is not in figures.ts`);
					spreads.push(lanes.planner.planDistilled(env, { distill: p.distill, figures, palette, voice, title: p.meta.title, slug: p.slug }));
				}
				for (const b of p.blocks) if (b.t === 'fig' && !figures.has(b.id) && !lanes.stubs.includes('figures')) throw new Error(`${p.file}:${b.line}: ::fig id "${b.id}" is not in figures.ts`);
				spreads.push(...lanes.planner.planFullText(env, p.blocks, figures, { slug: p.slug, palette, voice }));
				const ctx: EmitContext = {
					widthClass: cls.id, sheetW: cls.sheetW, marginOuter: cls.marginX, marginSpine: cls.marginX - 1, gutter: 1.2, extra: env.extra, union,
					text: env.text.bytes(), strings: env.strings.bytes(), palette, digitSets: []
				};
				const r = emitMagazine(spreads, ctx, `${p.file} [${cls.name}]`);
				built.push({ p, cls, bytes: r.bytes, spreadLayers: r.spreadLayers, words: wordCount(p.blocks), distilled: useDistilled ? state : 'none', templates: spreads.map((s) => s.meta.template), text: ctx.text });
			} catch (e) { errors.push(`${p.file}: ${(e as Error).message}`); }
		}
	}
	if (missing.size) errors.push(`characters with no glyph in the chosen font (the build fails closed):\n    ${[...missing].join('\n    ')}`);
	if (errors.length) throw new Error(`magazine build failed:\n  ${errors.join('\n  ')}`);

	// ---- write ----
	const outFiles: BuildResult['files'] = [];
	const write = (name: string, bytes: Uint8Array) => {
		fs.writeFileSync(path.join(outDir, name), bytes);
		const e = { name, bytes: bytes.length, brotli: zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
		outFiles.push(e);
		return e;
	};
	const table = union.finish();
	const fontsBytes = packFontsBin(table, fonts.fonts.map((f) => f.info), Uint32Array.from(union.tag.map((t) => Number(t[0]))), Uint32Array.from(union.tag.map((t) => Number(t[1]))));
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
		version: 2, magic: 'RDR2', stamp, preview: !!opts.preview, stubs: lanes.stubs, fonts: fontsName, fontsBytes: fe.bytes, fontsBrotli: fe.brotli, glyphs: union.count,
		templates: TEMPLATE_IDS, classes: MAG_CLASSES.map((c) => ({ id: c.id, name: c.name, sheetW: c.sheetW, sheetH: c.sheetH })), articles, images: images.byId
	};
	if (!opts.only) {
		const keep = new Set([fontsName, 'index.json', ...articles.flatMap((a) => Object.values(a.bins).map((b: any) => b.file))]);
		for (const f of fs.readdirSync(outDir)) if (f.endsWith('.bin') && !keep.has(f)) fs.rmSync(path.join(outDir, f));
		fs.writeFileSync(stampFile, JSON.stringify(index, null, '\t'));
	} else fs.writeFileSync(path.join(outDir, 'index.partial.json'), JSON.stringify(index, null, '\t'));
	const ms = performance.now() - t0;
	log(`magazine: ${articles.length} articles, ${union.count} union glyphs, ${(ms / 1000).toFixed(1)} s${lanes.stubs.length ? `, STUB lanes: ${lanes.stubs.join(', ')}` : ''}`);
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
