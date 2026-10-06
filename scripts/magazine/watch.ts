// Resident preview server (docs/MAGAZINE.md section 7): keeps the build pipeline (harfbuzz, fonts, glyph tables)
// loaded, watches the authoring files, and pushes re-laid RDR2 binaries to the preview page over a WebSocket.
//
//   bun --hot scripts/magazine/watch.ts [--port 5179] [--fixture]
//   (--hot reloads edited scripts/magazine modules in place and keeps this process, its socket and the caches;
//    plain `bun` also works, but then a change to templates/*.ts or voices.ts needs a restart because Bun caches imports)
//   in another shell: bunx vite tools/magazine-preview   (Vite, outside the site routes so it breaks independently)
//
// Producer contract (owned by the `compile` lane; the seam is here so the lanes stay disjoint). If
// scripts/magazine/build.ts exports
//     buildForPreview(req: BuildReq): Promise<BuildResult>
// it is used; otherwise (or with --fixture) tools/magazine-preview/fixture.ts serves a built-in ifd-shaped spread.
// `article` is an RDR2 binary (src/lib/magazine/format.ts), `fonts` the shared fonts.bin (RDF1), `meta` optional
// frame rectangles and per-line Knuth-Plass ratios for the `frames=1` overlay.
//
// Wire protocol. client -> server: text JSON {"type":"want","reqs":[BuildReq, ...]} (replaces the client's
// subscription; every file change re-runs it). server -> client: text JSON header then one binary frame:
//   {"type":"fonts","hash":"..."}                         + RDF1 bytes (only when the hash changed for this client)
//   {"type":"article","key":"<slug|cls|template|layer>","ms":<build ms>,"changedAt":<epoch ms or 0>,"meta":{...}}  + RDR2 bytes
//   {"type":"error","key":"...","message":"..."}          (no binary frame; the page shows it, nothing is half-drawn)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Meta } from '../../tools/magazine-preview/fixture';

export interface BuildReq {
	slug: string;
	cls: 'wide' | 'narrow';
	/** force one template (variant grid); omitted = the article's declared one */
	template?: string;
	layer: 'distilled' | 'full';
}
export interface BuildResult { fonts: Uint8Array; article: Uint8Array; meta?: Meta }
export type BuildFn = (req: BuildReq) => Promise<BuildResult>;

export const reqKey = (r: BuildReq) => `${r.slug}|${r.cls}|${r.template ?? ''}|${r.layer}`;

const ROOT = path.resolve(import.meta.dir, '../..');
const WATCH = [
	{ dir: path.join(ROOT, 'src/routes/(site)/thoughts'), match: /(\+page\.svx|figures\.ts|spread\.json)$/ },
	{ dir: path.join(ROOT, 'scripts/magazine/templates'), match: /\.ts$/ },
	{ dir: path.join(ROOT, 'scripts/magazine'), match: /(voices|palette)\.ts$/ }
];

export async function loadBuild(forceFixture: boolean): Promise<{ fn: BuildFn; source: string }> {
	if (!forceFixture) {
		try {
			const mod = await import(/* @vite-ignore */ './build.ts');
			if (typeof mod.buildForPreview === 'function') return { fn: mod.buildForPreview as BuildFn, source: 'scripts/magazine/build.ts' };
		} catch {
			// no compile lane yet: fall through to the fixture
		}
	}
	const { buildFixture } = await import('../../tools/magazine-preview/fixture');
	return { fn: async (r) => buildFixture(r.slug, r.cls === 'wide' ? 0 : 1), source: 'fixture' };
}

interface Sock { reqs: BuildReq[]; fontsHash: string }

export interface Watch { port: number; stop(): void; rebuild(changedAt?: number): Promise<void>; source: string }

export async function createWatch(opts: { port?: number; fixture?: boolean; watchFiles?: boolean } = {}): Promise<Watch> {
	const { fn, source } = await loadBuild(!!opts.fixture);
	const cache = new Map<string, Promise<{ r: BuildResult; ms: number; hash: string }>>();
	const socks = new Set<import('bun').ServerWebSocket<Sock>>();
	let stamp = 0;

	const build = (req: BuildReq) => {
		const k = `${stamp}:${reqKey(req)}`;
		let p = cache.get(k);
		if (!p) {
			p = (async () => {
				const t0 = performance.now();
				const r = await fn(req);
				return { r, ms: performance.now() - t0, hash: crypto.createHash('sha1').update(r.fonts).digest('hex').slice(0, 12) };
			})();
			cache.set(k, p);
			p.catch(() => cache.delete(k));
		}
		return p;
	};

	async function serve(ws: import('bun').ServerWebSocket<Sock>, changedAt: number) {
		await Promise.all(ws.data.reqs.map(async (req) => {
			const key = reqKey(req);
			try {
				const { r, ms, hash } = await build(req);
				if (hash !== ws.data.fontsHash) {
					ws.data.fontsHash = hash;
					ws.send(JSON.stringify({ type: 'fonts', hash }));
					ws.send(r.fonts);
				}
				ws.send(JSON.stringify({ type: 'article', key, ms, changedAt, meta: r.meta ?? null }));
				ws.send(r.article);
			} catch (e) {
				ws.send(JSON.stringify({ type: 'error', key, message: (e as Error).message }));
			}
		}));
	}

	const rebuild = async (changedAt = Date.now()) => {
		stamp++;
		cache.clear();
		await Promise.all([...socks].map((ws) => serve(ws, changedAt)));
	};

	const server = Bun.serve<Sock>({
		port: opts.port ?? 5179,
		fetch(req, srv) {
			const u = new URL(req.url);
			if (u.pathname === '/ws' && srv.upgrade(req, { data: { reqs: [], fontsHash: '' } })) return;
			if (u.pathname === '/health') return Response.json({ ok: true, source, clients: socks.size, stamp });
			return new Response('magazine preview watch: connect a WebSocket to /ws', { status: 404 });
		},
		websocket: {
			open(ws) { socks.add(ws); },
			close(ws) { socks.delete(ws); },
			message(ws, m) {
				if (typeof m !== 'string') return;
				let msg: { type?: string; reqs?: BuildReq[] };
				try { msg = JSON.parse(m); } catch { return; }
				if (msg.type !== 'want' || !Array.isArray(msg.reqs)) return;
				if (msg.reqs.length > 12) { ws.send(JSON.stringify({ type: 'error', key: '', message: 'at most 12 requests per client' })); return; }
				ws.data.reqs = msg.reqs;
				void serve(ws, 0);
			}
		}
	});

	const watchers: fs.FSWatcher[] = [];
	if (opts.watchFiles !== false) {
		let timer: ReturnType<typeof setTimeout> | null = null;
		let first = 0;
		for (const w of WATCH) {
			if (!fs.existsSync(w.dir)) continue;
			watchers.push(fs.watch(w.dir, { recursive: true }, (_ev, name) => {
				if (!name || !w.match.test(String(name))) return;
				if (!timer) first = Date.now();
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => { timer = null; void rebuild(first); }, 25); // coalesce editor save bursts
			}));
		}
	}

	return { port: server.port as number, source, rebuild, stop() { for (const w of watchers) w.close(); server.stop(true); } };
}

if (import.meta.main) {
	const a = process.argv.slice(2);
	const pi = a.indexOf('--port');
	const w = await createWatch({ port: pi >= 0 ? Number(a[pi + 1]) : 5179, fixture: a.includes('--fixture') });
	console.log(`magazine watch: ws://localhost:${w.port}/ws  producer: ${w.source}`);
}
