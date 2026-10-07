// Dev hot reload of film scripts: an edit of src/routes/(site)/thoughts/<slug>/film.flecs is sent to the browser as `film:reload { slug, src }`
// (src/lib/film/source.ts applies it in place, keeping the film time) and the default module update (a full page reload) is suppressed.
// Library templates (world/scene/film/lib) are baked into world.wasm: change them, `bun run build:world`, and vite reloads the page.
import fs from 'node:fs';
import type { Plugin } from 'vite';

const FILM = /\/thoughts\/([^/]+)\/film\.flecs$/;

export function filmHot(): Plugin {
	return {
		name: 'film-hot',
		apply: 'serve',
		handleHotUpdate({ file, server }) {
			const m = FILM.exec(file);
			if (!m) return;
			server.ws.send({ type: 'custom', event: 'film:reload', data: { slug: m[1], src: fs.readFileSync(file, 'utf8') } });
			return [];
		}
	};
}
