// Debug dump: draws each sheet of a built article as SVG (and PNG with --png), straight from the
// binary (glyph outlines are rebuilt from the curve texels). Run:
//   bun scripts/reader/dump.ts <slug> [--class wide|narrow] [--png] [--out dir] [--dark]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { EXTRA_BIT, PALETTE_SIZE, readFontsBin, RectKind, unpackArticle, type GlyphTable } from '../../src/lib/reader/format';
import { contoursOf } from '../../src/lib/reader/slug-cpu';
import { ROOT } from './fonts';

const OUT = path.join(ROOT, 'static/reader');

const css = (px: number) => `rgba(${px & 255},${(px >> 8) & 255},${(px >> 16) & 255},${((px >>> 24) / 255).toFixed(3)})`;

export async function dump(slug: string, cls: 'wide' | 'narrow', outDir: string, png: boolean, dark: boolean) {
	const index = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
	const a = index.articles.find((x: any) => x.slug === slug);
	if (!a) throw new Error(`no article ${slug} in index.json`);
	const fonts = readFontsBin(fs.readFileSync(path.join(OUT, index.fonts)));
	const m = unpackArticle(fs.readFileSync(path.join(OUT, a.bins[cls].file)));
	fs.mkdirSync(outDir, { recursive: true });
	const pal = (i: number) => css(m.palette[(dark ? PALETTE_SIZE : 0) + i]);
	const paper = dark ? '#1c1a18' : '#f1ede4';
	const S = 22; // px per em
	const defs = new Map<number, string>();
	const pathOf = (gid: number) => {
		let d = defs.get(gid);
		if (d === undefined) {
			const t: GlyphTable = gid & EXTRA_BIT ? m.extra : fonts.table;
			const cs = contoursOf(t, (gid & ~EXTRA_BIT) >>> 0);
			d = cs.map((ct) => `M${ct[0][0]} ${-ct[0][1]}` + ct.map((q) => `Q${q[2]} ${-q[3]} ${q[4]} ${-q[5]}`).join('') + 'Z').join('');
			defs.set(gid, d);
		}
		return d;
	};
	const files: string[] = [];
	for (let pi = 0; pi < m.pages.length; pi++) {
		const pg = m.pages[pi];
		const body: string[] = [];
		const used = new Set<number>();
		body.push(`<rect width="${m.sheetW}" height="${m.sheetH}" fill="${paper}"/>`);
		const items = new Set<number>();
		for (let c = 0; c < m.gridCols * m.gridRows; c++) {
			const cell = m.cells[pi * m.gridCols * m.gridRows + c];
			for (let t = 0; t < cell.count; t++) items.add(m.items[cell.start + t]);
		}
		for (const it of items) {
			const type = it >>> 29, idx = it & 0x1fffffff;
			if (type === 1) {
				const r = m.rects[idx];
				const fill = r.kind === RectKind.codeBg || r.kind === RectKind.noteBox || r.kind === RectKind.inlineCodeBg ? pal(6) : r.kind === RectKind.quoteBar ? pal(7) : pal(r.kind === RectKind.mathRule ? 0 : 4);
				body.push(`<rect x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" fill="${fill}"/>`);
			} else if (type === 2) {
				const r = m.images[idx];
				body.push(`<rect x="${r.x0}" y="${r.y0}" width="${r.x1 - r.x0}" height="${r.y1 - r.y0}" fill="#9aa" opacity="0.5"/><text x="${(r.x0 + r.x1) / 2}" y="${(r.y0 + r.y1) / 2}" font-size="1" text-anchor="middle">image ${r.imageId}</text>`);
			}
		}
		for (const it of items) {
			if (it >>> 29 !== 0) continue;
			const g = m.glyphs[it & 0x1fffffff];
			used.add(g.glyphId);
			body.push(`<use href="#g${g.glyphId}" x="0" y="0" transform="translate(${g.x} ${g.y}) scale(${g.size})" fill="${pal(g.colour)}"/>`);
		}
		const defStr = [...used].map((id) => `<path id="g${id}" d="${pathOf(id)}"/>`).join('');
		const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${m.sheetW * S}" height="${m.sheetH * S}" viewBox="0 0 ${m.sheetW} ${m.sheetH}"><defs>${defStr}</defs>${body.join('')}</svg>`;
		const base = path.join(outDir, `${slug}.${cls}${dark ? '.dark' : ''}.${String(pi + 1).padStart(2, '0')}`);
		fs.writeFileSync(base + '.svg', svg);
		files.push(base + '.svg');
		if (png) { await sharp(Buffer.from(svg)).png().toFile(base + '.png'); files.push(base + '.png'); }
		void pg;
	}
	return files;
}

if (process.argv[1] && /scripts\/reader\/dump\.ts$/.test(process.argv[1])) {
	const a = process.argv.slice(2);
	const val = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : undefined; };
	const slug = a.find((x) => !x.startsWith('--') && a[a.indexOf(x) - 1] !== '--class' && a[a.indexOf(x) - 1] !== '--out');
	if (!slug) { console.error('usage: dump.ts <slug> [--class wide|narrow] [--png] [--dark] [--out dir]'); process.exit(1); }
	const files = await dump(slug, (val('--class') as any) ?? 'wide', val('--out') ?? path.join(os.tmpdir(), 'reader-dump'), a.includes('--png'), a.includes('--dark'));
	console.log(files.join('\n'));
}
