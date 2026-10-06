// Runs `bun scripts/reader/build.ts` at dev/build start. The build skips itself when the input stamp
// matches static/reader/index.json, so a warm start costs a hash of the sources.
import { spawnSync } from 'node:child_process';
import type { Plugin } from 'vite';

export function reader(): Plugin {
	return {
		name: 'reader-build',
		buildStart() {
			const r = spawnSync('bun', ['scripts/reader/build.ts'], { stdio: 'inherit' });
			if (r.status !== 0) this.error('reader build failed (see output above)');
		}
	};
}
