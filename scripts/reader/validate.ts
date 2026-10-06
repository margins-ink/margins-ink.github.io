// Tiny CPU validator: loads built binaries from static/reader and checks them against the source.
//   bun scripts/reader/validate.ts [slug ...]
// Checks per article and width class (see the list in checkArticle). Exits 1 on any failure.
import fs from 'node:fs';
import path from 'node:path';
import { cstr, EXTRA_BIT, glyphCount, glyphRec, GlyphFlag, ItemType, LinkKind, readFontsBin, unpackArticle, type ArticleModel, type GlyphTable } from '../../src/lib/reader/format';
import { windingFromBands } from '../../src/lib/reader/slug-cpu';
import { ROOT } from './fonts';

const OUT = path.join(ROOT, 'static/reader');

/** Independent expectation: non-whitespace character count of the article's plain text, from the raw source. */
export function expectedNonSpace(source: string): { n: number; frontMatter: number } {
	let s = source;
	const fm = /^---\n([\s\S]*?)\n---\n/.exec(s);
	let frontMatter = 0;
	if (fm) {
		s = s.slice(fm[0].length);
		const title = /^title:\s*(.*)$/m.exec(fm[1])?.[1] ?? '';
		const dek = /^dek:\s*(.*)$/m.exec(fm[1])?.[1] ?? '';
		const unq = (t: string) => t.trim().replace(/^(["'])(.*)\1$/, '$2').replace(/`/g, '');
		frontMatter = (unq(title) + unq(dek)).replace(/\s/g, '').length;
	}
	let refsChars = 0;
	const script = /<script[\s\S]*?<\/script>/g;
	for (const sc of s.match(script) ?? []) {
		for (const m of sc.matchAll(/title:\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)) refsChars += (m[1] ?? m[2]).replace(/\\(.)/g, '$1').replace(/\s/g, '').length;
		for (const m of sc.matchAll(/url:\s*(?:"([^"]*)"|'([^']*)')/g)) refsChars += (m[1] ?? m[2]).replace(/\s/g, '').length;
	}
	const hasRefs = /<References\s*\/>/.test(s);
	s = s.replace(script, '');
	// code is verbatim: count it first so tag-like text inside it (<T>, <http://...>) is not stripped
	let codeChars = 0;
	s = s.replace(/^```[^\n]*\n([\s\S]*?)^```/gm, (_m, body: string) => { codeChars += body.replace(/\s/g, '').length; return '\n'; });
	s = s.replace(/`([^`\n]+)`/g, (_m, body: string) => { codeChars += body.replace(/\s/g, '').length; return ''; });
	s = s.replace(/<Cite[^>]*\/>/g, '[1]');
	s = s.replace(/<\/?[A-Za-z][^>]*>/g, '');
	s = s.replace(/^```.*$/gm, '');
	s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
	s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
	s = s.replace(/^#{1,6}\s+/gm, '');
	s = s.replace(/^>\s?/gm, '');
	s = s.replace(/^(\s*)[-*+]\s/gm, '$1• ');
	s = s.replace(/\*\*|\*/g, '').replace(/`/g, '').replace(/\{:[a-z0-9_+#-]+\}/gi, '');
	s = s.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, '$1$2');
	s = s.replace(/^---page---$/gm, '');
	let n = s.replace(/\s/g, '').length + codeChars;
	if (hasRefs) n += refsChars + 'References'.length;
	// reference markers: "[n] " per entry is part of the text, counted via refs entries
	if (hasRefs) n += (source.match(/\bid:\s*['"]/g) ?? []).length * 3;
	return { n, frontMatter };
}

interface Report { slug: string; cls: string; pages: number; glyphs: number; bytes: number; checks: string[]; errors: string[]; info: string[] }

function* codepoints(s: Uint8Array): Generator<[number, number]> {
	const dec = new TextDecoder();
	let i = 0;
	while (i < s.length) {
		const b = s[i];
		const len = b < 0x80 ? 1 : b < 0xe0 ? 2 : b < 0xf0 ? 3 : 4;
		yield [i, dec.decode(s.subarray(i, i + len)).codePointAt(0)!];
		i += len;
	}
}

function checkArticle(slug: string, cls: string, m: ArticleModel, fonts: ReturnType<typeof readFontsBin>, source: string, bytes: number): Report {
	const rep: Report = { slug, cls, pages: m.pages.length, glyphs: m.glyphs.length, bytes, checks: [], errors: [], info: [] };
	const ok = (name: string) => rep.checks.push(name);
	const fail = (msg: string) => rep.errors.push(msg);
	const nUnion = glyphCount(fonts.table), nExtra = glyphCount(m.extra);

	// 1. glyph ids resolve; glyph boxes inside the sheet (code lines may overflow the measure to the right)
	let codeOverflow = 0, badId = 0, outside = 0;
	const box = (gid: number) => {
		const t = gid & EXTRA_BIT ? m.extra : fonts.table;
		const i = (gid & ~EXTRA_BIT) >>> 0;
		return { r: glyphRec(t, i), t, i };
	};
	for (const g of m.glyphs) {
		const i = (g.glyphId & ~EXTRA_BIT) >>> 0;
		if (i >= (g.glyphId & EXTRA_BIT ? nExtra : nUnion)) { badId++; continue; }
		const { r } = box(g.glyphId);
		const x0 = g.x + r.x0 * g.size, x1 = g.x + r.x1 * g.size, y0 = g.y - r.y1 * g.size, y1 = g.y - r.y0 * g.size;
		const right = g.flags & GlyphFlag.code ? m.sheetW : m.marginX + m.measure + 0.5;
		if (g.flags & GlyphFlag.code && x1 > m.marginX + m.measure) codeOverflow++;
		if (x0 < 0 || x1 > right + (g.flags & GlyphFlag.code ? 1e9 : 0) || y0 < m.marginY - 3.5 || y1 > m.sheetH - m.marginY + 3.5) outside++;
	}
	badId ? fail(`${badId} glyph ids out of range`) : ok('glyph ids resolve');
	outside ? fail(`${outside} glyphs outside the page bounds`) : ok('glyphs inside page bounds');
	if (codeOverflow) rep.info.push(`${codeOverflow} code glyphs beyond the measure (clipped fixed-width block)`);

	// 2. rects and images inside the sheet
	const badRect = m.rects.filter((r) => r.x0 < -1e-3 || r.x1 > m.sheetW + 1e-3 || r.y0 < -1e-3 || r.y1 > m.sheetH + 1e-3).length;
	const badImg = m.images.filter((r) => r.x0 < m.marginX - 1e-3 || r.x1 > m.marginX + m.measure + 1e-3 || r.y0 < m.marginY - 1e-3 || r.y1 > m.sheetH - m.marginY + 1e-3).length;
	badRect || badImg ? fail(`${badRect} rects / ${badImg} images outside the sheet`) : ok('rects and images inside the sheet');

	// 3. lines: contiguous glyph ranges, monotone y inside each page
	let gcur = 0, lineBad = 0;
	for (const l of m.lines) { if (l.firstGlyph !== gcur) lineBad++; gcur += l.glyphCount; }
	if (gcur !== m.glyphs.length) lineBad++;
	let nonMono = 0;
	m.pages.forEach((p) => { for (let k = 1; k < p.lineCount; k++) if (m.lines[p.firstLine + k].yTop + 1e-4 < m.lines[p.firstLine + k - 1].yTop) nonMono++; });
	lineBad ? fail(`${lineBad} line/glyph range mismatches`) : ok('line ranges tile the glyph array');
	nonMono ? fail(`${nonMono} lines out of y order within a page`) : ok('lines y-ordered per page');

	// 4. reading order: char offsets non-decreasing (tables excepted; none in the corpus)
	let back = 0;
	for (let i = 1; i < m.glyphs.length; i++) if (m.glyphs[i].charOffset < m.glyphs[i - 1].charOffset) back++;
	back ? fail(`${back} glyphs break reading order (charOffset decreases)`) : ok('glyph order = reading order');

	// 5. every non-whitespace character of Text is under a glyph, and every glyph covers some text
	const offs = [...new Set(m.glyphs.map((g) => g.charOffset))].sort((a, b) => a - b);
	const mathAt = new Set(m.glyphs.filter((g) => g.flags & GlyphFlag.math).map((g) => g.charOffset));
	const nonSpaceAt: number[] = [];
	let nonSpace = 0;
	for (const [o, cp] of codepoints(m.text)) if (!/\s/u.test(String.fromCodePoint(cp))) { nonSpace++; nonSpaceAt.push(o); }
	let gi = 0, uncovered = 0, tooWide = 0, blank = 0;
	const spanCount = new Map<number, number>();
	for (const o of nonSpaceAt) {
		while (gi + 1 < offs.length && offs[gi + 1] <= o) gi++;
		if (!offs.length || o < offs[0]) { uncovered++; continue; }
		spanCount.set(offs[gi], (spanCount.get(offs[gi]) ?? 0) + 1);
	}
	for (const o of offs) {
		const c = spanCount.get(o) ?? 0;
		if (c === 0) blank++;
		else if (c > 4 && !mathAt.has(o)) tooWide++;
	}
	uncovered ? fail(`${uncovered} text characters before the first glyph`) : ok('no text before the first glyph');
	tooWide ? fail(`${tooWide} glyph clusters span more than 4 characters (a dropped character?)`) : ok('each non-math glyph covers 1-4 characters');
	blank ? fail(`${blank} glyphs map to whitespace only`) : ok('every glyph maps to visible text');

	// 6. independent source count
	const exp = expectedNonSpace(source);
	const bylineChars = 'AndrewGazelka'.length + 12; // "Mon D, YYYY · " bounds
	const expected = exp.n + exp.frontMatter + bylineChars;
	const dev = Math.abs(nonSpace - expected) / expected;
	rep.info.push(`text non-space chars ${nonSpace} vs source-derived ${expected} (${(dev * 100).toFixed(1)}%)`);
	dev > 0.05 ? fail(`text length differs from the source by ${(dev * 100).toFixed(1)}%`) : ok('text length matches source within 5%');

	// 7. grid: every glyph is listed in the cell containing its centre
	let gridMiss = 0;
	const cols = m.gridCols, rows = m.gridRows;
	m.pages.forEach((p, pi) => {
		const base = pi * cols * rows;
		for (let li = 0; li < p.lineCount; li++) {
			const ln = m.lines[p.firstLine + li];
			for (let k = 0; k < ln.glyphCount; k += Math.max(1, Math.floor(ln.glyphCount / 5))) {
				const gidx = ln.firstGlyph + k;
				const g = m.glyphs[gidx];
				if (g.x >= m.sheetW - 0.5) continue; // code overflow beyond the sheet: not in the grid by design
				const { r } = box(g.glyphId);
				const cx = Math.min(cols - 1, Math.max(0, Math.floor((g.x + ((r.x0 + r.x1) / 2) * g.size) / m.cellW)));
				const cy = Math.min(rows - 1, Math.max(0, Math.floor((g.y - ((r.y0 + r.y1) / 2) * g.size) / m.cellH)));
				const cell = m.cells[base + cy * cols + cx];
				let found = false;
				for (let t = 0; t < cell.count; t++) { const it = m.items[cell.start + t]; if (it >>> 29 === ItemType.glyph && (it & 0x1fffffff) === gidx) found = true; }
				if (!found) gridMiss++;
			}
		}
	});
	gridMiss ? fail(`${gridMiss} sampled glyphs missing from their grid cell`) : ok('grid cells list their glyphs');

	// 8. strings and links resolve
	let badStr = 0;
	for (const l of m.links) { const s = cstr(m.strings, l.offset); if (!s && l.kind !== LinkKind.anchor) badStr++; if (l.page >= m.pages.length) badStr++; }
	for (const a of m.anchors) if (!cstr(m.strings, a.idOffset)) badStr++;
	badStr ? fail(`${badStr} links/anchors with empty targets`) : ok('links and anchors resolve');

	// 9. band sanity: horizontal and vertical band walks agree on random interior points (200 per used glyph max 40 glyphs)
	const used = new Set(m.glyphs.map((g) => g.glyphId));
	let bandBad = 0, bandN = 0, sampled = 0;
	let seed = 12345;
	const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
	for (const gid of used) {
		if (sampled++ > 60) break;
		const { r, t, i } = box(gid);
		if (r.numCurves === 0) continue;
		for (let k = 0; k < 60; k++) {
			const px = r.x0 + rnd() * (r.x1 - r.x0), py = r.y0 + rnd() * (r.y1 - r.y0);
			const w = windingFromBands(t as GlyphTable, i, px, py);
			bandN++;
			if ((Math.abs(w.h) > 0) !== (Math.abs(w.v) > 0)) bandBad++;
		}
	}
	// near-boundary points legitimately disagree by an epsilon: allow 1%
	bandBad / Math.max(1, bandN) > 0.01 ? fail(`${bandBad}/${bandN} band samples disagree (h vs v)`) : ok(`band walks agree (${bandBad}/${bandN} boundary disagreements)`);
	return rep;
}

export async function validateAll(slugs: string[] = []): Promise<Report[]> {
	const index = JSON.parse(fs.readFileSync(path.join(OUT, 'index.json'), 'utf8'));
	const fonts = readFontsBin(fs.readFileSync(path.join(OUT, index.fonts)));
	const out: Report[] = [];
	for (const a of index.articles) {
		if (slugs.length && !slugs.includes(a.slug)) continue;
		const source = fs.readFileSync(path.join(ROOT, 'src/routes/(site)/thoughts', a.slug, '+page.svx'), 'utf8');
		for (const cls of ['wide', 'narrow']) {
			const bytes = fs.readFileSync(path.join(OUT, a.bins[cls].file));
			const m = unpackArticle(bytes);
			if (m.pages.length !== a.pageCount[cls]) { out.push({ slug: a.slug, cls, pages: m.pages.length, glyphs: 0, bytes: bytes.length, checks: [], errors: ['page count differs from index.json'], info: [] }); continue; }
			out.push(checkArticle(a.slug, cls, m, fonts, source, bytes.length));
		}
	}
	return out;
}

if (process.argv[1] && /scripts\/reader\/validate\.ts$/.test(process.argv[1])) {
	const reps = await validateAll(process.argv.slice(2));
	let bad = 0;
	for (const r of reps) {
		console.log(`${r.errors.length ? 'FAIL' : 'ok  '} ${r.slug.padEnd(26)} ${r.cls.padEnd(6)} pages ${String(r.pages).padStart(2)}  glyphs ${String(r.glyphs).padStart(6)}  ${String(r.bytes).padStart(7)} B  checks ${r.checks.length}`);
		for (const i of r.info) console.log(`       . ${i}`);
		for (const e of r.errors) { console.log(`       ! ${e}`); bad++; }
	}
	if (!reps.length) { console.error('no articles validated'); process.exit(1); }
	process.exit(bad ? 1 : 0);
}
