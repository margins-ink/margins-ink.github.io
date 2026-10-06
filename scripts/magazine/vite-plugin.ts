// Runs `bun scripts/magazine/build.ts` at dev/build start (warm start = a hash of the sources).
// Production build (`vite build`): fails closed if a lane is still a stub. Dev: `--preview` so unreviewed
// distill blocks draw; they never reach a production build (docs/MAGAZINE.md 1.7).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export function magazine(): Plugin {
	let serve = false;
	return {
		name: 'magazine-build',
		configResolved(c) { serve = c.command === 'serve'; },
		buildStart() {
			const r = spawnSync('bun', ['scripts/magazine/build.ts', ...(serve ? ['--preview'] : [])], { stdio: 'inherit' });
			if (r.status !== 0) this.error('magazine build failed (see output above)');
			if (!serve) {
				const idx = JSON.parse(fs.readFileSync(path.join('static/magazine/index.json'), 'utf8'));
				if (idx.stubs?.length) this.error(`magazine: production build with stub lanes (${idx.stubs.join(', ')}); merge them first`);
				if (idx.preview) this.error('magazine: static/magazine/index.json came from a --preview build; rerun without --preview');
			}
		}
	};
}
