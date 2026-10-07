// Runs `bun scripts/magazine/build.ts` at dev/build start (warm start = a hash of the sources).
// Production build (`vite build`): fails closed if a lane is still a stub. Dev: `--preview` so unreviewed
// distill blocks draw; they never reach a production build (docs/MAGAZINE.md 1.7).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

const THOUGHTS = path.resolve('src/routes/(site)/thoughts');

/** Every thoughts/<slug>/+page.svx that has no built article in static/magazine/index.json (or whose bins are missing), as messages. */
export function shelfProblems(): string[] {
	const idx = JSON.parse(fs.readFileSync('static/magazine/index.json', 'utf8'));
	const have = new Map<string, any>(idx.articles.map((a: any) => [a.slug, a]));
	const out: string[] = [];
	for (const d of fs.readdirSync(THOUGHTS).sort()) {
		if (!fs.existsSync(path.join(THOUGHTS, d, '+page.svx'))) continue;
		const a = have.get(d);
		if (!a) { out.push(`${d}: registered post has no article in static/magazine/index.json`); continue; }
		for (const b of Object.values<any>(a.bins)) if (!fs.existsSync(path.join('static/magazine', b.file))) out.push(`${d}: missing ${b.file}`);
	}
	return out;
}

export function magazine(): Plugin {
	let serve = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	return {
		name: 'magazine-build',
		configResolved(c) { serve = c.command === 'serve'; },
		// Dev: the build used to run only at server start, so a post added later had no article ("magazine: unknown article models").
		configureServer(server) {
			const build = () => {
				const r = spawnSync('bun', ['scripts/magazine/build.ts', '--preview'], { stdio: 'inherit' });
				server.config.logger.info(r.status === 0 ? 'magazine: rebuilt' : 'magazine: rebuild FAILED (see output above)');
				return r.status === 0;
			};
			const rebuild = () => {
				clearTimeout(timer);
				timer = setTimeout(() => { if (build()) server.ws.send({ type: 'custom', event: 'exhibit:reload', data: { reload: true } }); }, 400);
			};
			// a .flecs edit whose Frame did not change is pushed as text (exhibit:reload {slug, id, src}), no bin rebuild; the bin catches up after 5 s of quiet
			const frames = new Map<string, string>();
			let settle: ReturnType<typeof setTimeout> | undefined;
			const flecs = (f: string) => {
				const m = /\/thoughts\/([^/]+)\/exhibits\/([^/]+)\.flecs$/.exec(f);
				if (!m) return rebuild();
				const r = spawnSync('bun', ['scripts/magazine/exhibit.ts', '--check', f], { encoding: 'utf8' });
				if (r.status !== 0) { server.config.logger.error(`exhibit ${m[2]}: ${r.stderr}`); return; }
				const { frame, src } = JSON.parse(r.stdout) as { frame: [number, number]; src: string };
				const key = JSON.stringify(frame);
				const before = frames.get(f);
				frames.set(f, key);
				if (before !== key) return rebuild();
				server.ws.send({ type: 'custom', event: 'exhibit:reload', data: { slug: m[1], id: m[2], src } });
				clearTimeout(settle);
				settle = setTimeout(build, 5000);
			};
			const on = (f: string) => {
				if (!f.startsWith(THOUGHTS)) return;
				if (/\/exhibits\/[^/]+\.flecs$/.test(f)) flecs(f);
				else if (/\/(\+page\.svx|exhibits\/art\.ts|spread\.json)$/.test(f)) rebuild();
			};
			server.watcher.add(THOUGHTS);
			for (const ev of ['add', 'change', 'unlink'] as const) server.watcher.on(ev, on);
		},
		buildStart() {
			const r = spawnSync('bun', ['scripts/magazine/build.ts', ...(serve ? ['--preview'] : [])], { stdio: 'inherit' });
			if (r.status !== 0) {
				if (serve) this.warn('magazine build failed (see output above); serving the previous static/magazine');
				else this.error('magazine build failed (see output above)');
			}
			const bad = shelfProblems();
			if (bad.length) { if (serve) this.warn(`magazine shelf: ${bad.join('; ')}`); else this.error(`magazine shelf: ${bad.join('; ')}`); }
			if (!serve) {
				const idx = JSON.parse(fs.readFileSync(path.join('static/magazine/index.json'), 'utf8'));
				if (idx.stubs?.length) this.error(`magazine: production build with stub lanes (${idx.stubs.join(', ')}); merge them first`);
				if (idx.preview) this.error('magazine: static/magazine/index.json came from a --preview build; rerun without --preview');
			}
		}
	};
}
