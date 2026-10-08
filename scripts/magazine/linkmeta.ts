// Link preview metadata, fetched at BUILD time (never at read time, never fails the build).
// Every external href (and every /thoughts/<slug> href) found in the posts gets { title, description }:
// external ones from the page's <title>, og:title, og:description (5 s timeout), in-site article links from the post's own frontmatter.
// Results are cached in docs/upstream/linkmeta.json with the fetch date; a cached entry is reused (LINKMETA_REFRESH=1 refetches all),
// a failed one is retried once its entry is a day old. The per-article subset is baked into static/magazine/index.json (articles[].links).
import fs from 'node:fs';
import path from 'node:path';

export interface LinkMeta { title: string; description: string; ok: boolean; fetched: string }
export type LinkMetaCache = { version: 1; links: Record<string, LinkMeta> };

export const CACHE_FILE = path.resolve(import.meta.dir, '../../docs/upstream/linkmeta.json');
const TIMEOUT_MS = 5000, RETRY_FAILED_MS = 24 * 3600 * 1000;

/** external http(s) hrefs and /thoughts/<slug> hrefs of a post's source (markdown links, autolinks and href="..." attributes), without fragments, in first-seen order */
export function collectLinks(src: string): { external: string[]; articles: string[] } {
	const ext = new Set<string>(), art = new Set<string>();
	const re = /\]\(\s*<?([^)\s>]+)|href=["']([^"']+)["']|<(https?:\/\/[^>\s]+)>/g;
	for (const m of src.matchAll(re)) {
		const u = (m[1] ?? m[2] ?? m[3] ?? '').trim();
		if (/^https?:\/\//i.test(u)) ext.add(u);
		else if (/^\/thoughts\/[^#?\s]+/.test(u)) art.add(u.replace(/[#?].*$/, '').replace(/\/$/, ''));
	}
	return { external: [...ext], articles: [...art] };
}

const decode = (s: string) => s
	.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
	.replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
	.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, n) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' } as Record<string, string>)[n]);
const clean = (s: string) => decode(s).replace(/\s+/g, ' ').trim();

/** title and description of an HTML document: og:title over <title>, og:description over meta description (pure, tested) */
export function parseHtmlMeta(html: string): { title: string; description: string } {
	const head = html.slice(0, 200_000);
	const meta = (key: string): string => {
		for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
			const tag = m[0];
			const name = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
			if (name !== key) continue;
			const c = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
			const v = clean(c?.[1] ?? c?.[2] ?? '');
			if (v) return v;
		}
		return '';
	};
	const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '';
	return { title: meta('og:title') || meta('twitter:title') || clean(t), description: meta('og:description') || meta('description') || meta('twitter:description') };
}

async function fetchOne(url: string): Promise<LinkMeta> {
	const fetched = new Date().toISOString();
	try {
		const ctl = new AbortController();
		const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
		const res = await fetch(url, { signal: ctl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (compatible; andrewgazelka-site-linkmeta)', accept: 'text/html,application/xhtml+xml' } });
		const type = res.headers.get('content-type') ?? '';
		const body = res.ok && /html|xml/i.test(type) ? await res.text() : '';
		clearTimeout(timer);
		if (!body) return { title: '', description: '', ok: false, fetched };
		const { title, description } = parseHtmlMeta(body);
		return { title, description, ok: !!title, fetched };
	} catch {
		return { title: '', description: '', ok: false, fetched };
	}
}

export function readCache(file = CACHE_FILE): LinkMetaCache {
	try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); if (c?.version === 1) return c; } catch { /* none yet */ }
	return { version: 1, links: {} };
}

/** resolve every url: cache first, fetch the missing or stale-failed ones (8 at a time), write the cache. Never throws. */
export async function resolveLinkMeta(urls: string[], opts: { file?: string; refresh?: boolean; log?: (m: string) => void } = {}): Promise<Record<string, LinkMeta>> {
	const file = opts.file ?? CACHE_FILE;
	const cache = readCache(file);
	const refresh = opts.refresh ?? process.env.LINKMETA_REFRESH === '1';
	const todo = urls.filter((u) => {
		const e = cache.links[u];
		return refresh || !e || (!e.ok && Date.now() - Date.parse(e.fetched) > RETRY_FAILED_MS);
	});
	try {
		for (let i = 0; i < todo.length; i += 8) {
			await Promise.all(todo.slice(i, i + 8).map(async (u) => { cache.links[u] = await fetchOne(u); }));
		}
		if (todo.length) {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const sorted = Object.fromEntries(Object.entries(cache.links).sort(([a], [b]) => (a < b ? -1 : 1)));
			fs.writeFileSync(file, JSON.stringify({ version: 1, links: sorted }, null, '\t') + '\n');
			opts.log?.(`linkmeta: fetched ${todo.length} (${todo.filter((u) => cache.links[u].ok).length} ok), ${urls.length} links`);
		}
	} catch (e) { opts.log?.(`linkmeta: ${(e as Error).message} (ignored)`); }
	return cache.links;
}

/** per-article baked map: external urls from the cache, /thoughts/<slug> from `articles` (slug -> title, dek) */
export function bakeLinks(src: string, cache: Record<string, LinkMeta>, articles: Map<string, { title: string; dek: string }>): Record<string, { t: string; d: string }> {
	const { external, articles: arts } = collectLinks(src);
	const out: Record<string, { t: string; d: string }> = {};
	for (const u of external) { const e = cache[u]; if (e?.ok) out[u] = { t: e.title, d: e.description }; }
	for (const u of arts) { const a = articles.get(u.replace(/^\/thoughts\//, '')); if (a) out[u] = { t: a.title, d: a.dek }; }
	return out;
}

if (process.argv[1] && /linkmeta\.ts$/.test(process.argv[1])) {
	const root = path.resolve(import.meta.dir, '../../src/routes/(site)/thoughts');
	const urls = new Set<string>();
	for (const d of fs.readdirSync(root)) { const f = path.join(root, d, '+page.svx'); if (fs.existsSync(f)) collectLinks(fs.readFileSync(f, 'utf8')).external.forEach((u) => urls.add(u)); }
	resolveLinkMeta([...urls], { refresh: process.argv.includes('--refresh'), log: console.log }).then((l) => console.log(`${urls.size} external links, ${Object.values(l).filter((e) => e.ok).length} with metadata`));
}
