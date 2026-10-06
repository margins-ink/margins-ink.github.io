// Reader build: every thoughts/*/+page.svx -> static/reader/<slug>.<class>.<hash>.bin, fonts.<hash>.bin
// and index.json. Run: `bun scripts/reader/build.ts [--force] [--only slug] [--md file.md]`.
// Also called from scripts/reader/vite-plugin.ts at build/dev start.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { packArticle, packFontsBin, PALETTE_SIZE } from '../../src/lib/reader/format';
import { FontSet, GlyphTableBuilder, ROOT, FONT_SPECS } from './fonts';
import { parseArticle, type Parsed } from './parse';
import { CLASSES, layoutArticle, makePalette, StringSink, TextSink, type Env } from './layout';
import { collectImageSrcs, ImageStore, OUT_DIR } from './images';

const THOUGHTS = path.join(ROOT, 'src/routes/(site)/thoughts');
const sha = (b: Buffer | Uint8Array | string) => crypto.createHash('sha1').update(b).digest('hex').slice(0, 10);

export interface BuildOpts { force?: boolean; only?: string; md?: string; quiet?: boolean }
export interface BuildResult {
	skipped: boolean;
	index: any;
	files: { name: string; bytes: number; brotli: number }[];
	ms: number;
}

function hexRGB(h: string) { return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]; }

/** Greedy palette quantisation: the 16 most-used shiki [light,dark] pairs; the rest map to the nearest. */
function quantise(pairs: Map<string, number>) {
	const entries = [...pairs.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
	const reps = entries.slice(0, PALETTE_SIZE - 8).map(([k]) => k);
	const dist = (a: string, b: string) => {
		const [al, ad] = a.split('|').map(hexRGB), [bl, bd] = b.split('|').map(hexRGB);
		return al.reduce((s, v, i) => s + (v - bl[i]) ** 2, 0) + ad.reduce((s, v, i) => s + (v - bd[i]) ** 2, 0);
	};
	const idx = new Map<string, number>();
	for (const [k] of entries) {
		let best = 0, bd = Infinity;
		reps.forEach((r, i) => { const d = dist(k, r); if (d < bd) { bd = d; best = i; } });
		idx.set(k, 8 + best);
	}
	const syntax = reps.map((r) => { const [light, dark] = r.split('|'); return { light, dark }; });
	return { syntax, idx };
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

export function inputsHash(): string {
	const h = crypto.createHash('sha1');
	const add = (f: string) => { h.update(f); h.update(fs.readFileSync(f)); };
	for (const d of fs.readdirSync(THOUGHTS)) { const f = path.join(THOUGHTS, d, '+page.svx'); if (fs.existsSync(f)) add(f); }
	for (const f of fs.readdirSync(path.join(ROOT, 'scripts/reader')).sort()) if (f.endsWith('.ts') && f !== 'dump.ts' && f !== 'validate.ts') add(path.join(ROOT, 'scripts/reader', f));
	add(path.join(ROOT, 'src/lib/reader/format.ts'));
	for (const s of FONT_SPECS) add(path.join(ROOT, 'docs/upstream/reader/fonts', s.file));
	for (const f of fs.readdirSync(path.join(ROOT, 'static/posts')).sort()) h.update(f + fs.statSync(path.join(ROOT, 'static/posts', f)).size);
	return h.digest('hex').slice(0, 16);
}

export async function buildReader(opts: BuildOpts = {}): Promise<BuildResult> {
	const t0 = performance.now();
	const log = (...a: unknown[]) => { if (!opts.quiet) console.log(...a); };
	fs.mkdirSync(OUT_DIR, { recursive: true });
	const stampFile = path.join(OUT_DIR, 'index.json');
	const stamp = opts.md || opts.only ? '' : inputsHash();
	if (!opts.force && stamp && fs.existsSync(stampFile)) {
		const prev = JSON.parse(fs.readFileSync(stampFile, 'utf8'));
		const ok = prev.stamp === stamp && [prev.fonts, ...prev.articles.flatMap((a: any) => Object.values(a.bins).map((b: any) => b.file))].every((f: string) => fs.existsSync(path.join(OUT_DIR, f)));
		if (ok) return { skipped: true, index: prev, files: [], ms: performance.now() - t0 };
	}

	// ---- parse ----
	const files = opts.md
		? [path.resolve(opts.md)]
		: fs.readdirSync(THOUGHTS).sort().map((d) => path.join(THOUGHTS, d, '+page.svx')).filter((f) => fs.existsSync(f) && (!opts.only || f.includes(`/${opts.only}/`)));
	const parsed: Parsed[] = [];
	const errors: string[] = [];
	for (const f of files) {
		try {
			const p = await parseArticle(f);
			parsed.push(p); // hidden posts (visible: false) are built too and flagged in index.json
		} catch (e) {
			errors.push((e as Error).message);
		}
	}
	if (errors.length) throw new Error(`reader build: ${errors.length} article(s) failed to parse:\n  ${errors.join('\n  ')}`);

	// ---- images ----
	const images = new ImageStore();
	for (const p of parsed) for (const src of collectImageSrcs(p.blocks)) await images.add(src, p.file);

	// ---- palette ----
	const pairs = new Map<string, number>();
	for (const p of parsed) for (const [k, v] of p.shikiPairs) pairs.set(k, (pairs.get(k) ?? 0) + v);
	const { syntax, idx: shikiIdx } = quantise(pairs);

	// ---- layout ----
	const fonts = new FontSet();
	const union = new GlyphTableBuilder();
	const missing = new Set<string>();
	const built: { p: Parsed; cls: number; model: ReturnType<typeof packArticleInput>; pageCount: number; plain: string; accent: { light: string; dark: string } }[] = [];
	for (const p of parsed) {
		const accent = await accentFor(p.slug);
		const palette = makePalette(accent, syntax);
		for (const cls of CLASSES) {
			const env: Env = { fonts, union, extra: new GlyphTableBuilder(), cls, shikiIdx, images, strings: new StringSink(), text: new TextSink(), slug: p.slug, missing };
			try {
				const b = layoutArticle(env, p, palette);
				built.push({ p, cls: cls.id, model: b.model, pageCount: b.pageCount, plain: b.plainText, accent });
			} catch (e) {
				errors.push(`${p.file}: ${(e as Error).message}`);
			}
		}
	}
	if (missing.size) errors.push(`characters with no glyph in the chosen font (the reader fails closed):\n    ${[...missing].join('\n    ')}`);
	if (errors.length) throw new Error(`reader build failed:\n  ${errors.join('\n  ')}`);

	// ---- write ----
	const outFiles: BuildResult['files'] = [];
	const write = (name: string, bytes: Uint8Array) => {
		fs.writeFileSync(path.join(OUT_DIR, name), bytes);
		const e = { name, bytes: bytes.length, brotli: zlib.brotliCompressSync(bytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length };
		outFiles.push(e);
		return e;
	};
	const table = union.finish();
	const glyphFont = Uint32Array.from(union.tag.map((t) => Number(t[0])));
	const glyphSrc = Uint32Array.from(union.tag.map((t) => Number(t[1])));
	const fontsBytes = packFontsBin(table, fonts.fonts.map((f) => f.info), glyphFont, glyphSrc);
	const fontsName = `fonts.${sha(fontsBytes)}.bin`;
	const fe = write(fontsName, fontsBytes);

	const articles: any[] = [];
	for (const p of parsed) {
		const accent = built.find((b) => b.p === p)!.accent;
		const bins: Record<string, any> = {};
		const pageCount: Record<string, number> = {};
		for (const cls of CLASSES) {
			const b = built.find((x) => x.p === p && x.cls === cls.id)!;
			const bytes = packArticle(b.model as any);
			const name = `${p.slug}.${cls.id === 0 ? 'wide' : 'narrow'}.${sha(bytes)}.bin`;
			const e = write(name, bytes);
			bins[cls.id === 0 ? 'wide' : 'narrow'] = { file: name, bytes: e.bytes, brotli: e.brotli };
			pageCount[cls.id === 0 ? 'wide' : 'narrow'] = b.pageCount;
		}
		articles.push({ slug: p.slug, title: p.meta.title, dek: p.meta.dek, date: p.meta.date, hidden: !p.meta.visible, accent, pageCount, bins });
	}
	const index = {
		version: 1,
		stamp,
		fonts: fontsName,
		fontsBytes: fe.bytes,
		fontsBrotli: fe.brotli,
		glyphs: union.count,
		classes: CLASSES.map((c) => ({ ...c, name: c.id === 0 ? 'wide' : 'narrow' })),
		articles,
		images: images.byId
	};
	if (!opts.md && !opts.only) {
		// drop stale hashed outputs
		const keep = new Set([fontsName, 'index.json', ...articles.flatMap((a) => Object.values(a.bins).map((b: any) => b.file))]);
		for (const f of fs.readdirSync(OUT_DIR)) if (f.endsWith('.bin') && !keep.has(f)) fs.rmSync(path.join(OUT_DIR, f));
		fs.writeFileSync(stampFile, JSON.stringify(index, null, '\t'));
	} else {
		fs.writeFileSync(path.join(OUT_DIR, opts.md ? 'index.fixture.json' : 'index.partial.json'), JSON.stringify(index, null, '\t'));
	}
	const ms = performance.now() - t0;
	log(`reader: ${articles.length} articles, ${union.count} union glyphs, ${(ms / 1000).toFixed(1)} s`);
	for (const f of outFiles) log(`  ${f.name.padEnd(48)} ${String(f.bytes).padStart(8)} B  brotli ${String(f.brotli).padStart(7)} B`);
	return { skipped: false, index, files: outFiles, ms };
}

type packArticleInput = Parameters<typeof packArticle>[0];

if (process.argv[1] && /scripts\/reader\/build\.ts$/.test(process.argv[1])) {
	const a = process.argv.slice(2);
	const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
	buildReader({ force: a.includes('--force'), only: val('--only'), md: val('--md') })
		.then((r) => { if (r.skipped) console.log('reader: up to date (use --force to rebuild)'); })
		.catch((e) => { console.error(e.message); process.exit(1); });
}
