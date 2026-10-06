import { appendFileSync, mkdirSync } from 'node:fs';
import type { Plugin } from 'vite';

const LOG = '/Volumes/Projects/tmp/site-browser-errors.log';

// Dev only: the browser overlay (src/lib/dev/errors.ts) POSTs each new error here; one JSON object per line.
export function devErrors(): Plugin {
	return {
		name: 'dev-errors',
		apply: 'serve',
		configureServer(server) {
			server.middlewares.use('/__dev-errors', (req, res) => {
				if (req.method !== 'POST') { res.statusCode = 405; res.end(); return; }
				let body = '';
				req.on('data', (c) => { body += c; if (body.length > 64_000) req.destroy(); });
				req.on('end', () => {
					try {
						mkdirSync('/Volumes/Projects/tmp', { recursive: true });
						appendFileSync(LOG, JSON.stringify(JSON.parse(body)) + '\n');
					} catch { /* bad payload: drop */ }
					res.statusCode = 204; res.end();
				});
			});
		}
	};
}
