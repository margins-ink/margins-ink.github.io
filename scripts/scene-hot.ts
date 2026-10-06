// Vite plugin (dev only): hot reload of world/scene/*.flecs. A saved script goes to the page over the HMR socket as
// `scene:reload { name, src, saved }`; src/lib/gpu/room/scene-hot.ts hands it to the Flecs world (`ecs_script_update`).
// The same plugin serves `virtual:scene-sources`, the current files, so a page load starts from disk and not from the
// copies baked into world.wasm. The production build never imports either (room.ts guards them with import.meta.env.DEV).
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Plugin } from 'vite';

/** SCENE_DIR points a private dev server (scripts/scene-hot-test.ts) at a copy, so a test never edits the shared tree */
const DIR = process.env.SCENE_DIR ?? resolve(import.meta.dirname, '../world/scene');
const VIRTUAL = 'virtual:scene-sources';
/** `12-decor.flecs` -> `decor` (the script name in world/src/scene.rs `SCRIPTS`) */
const nameOf = (file: string) => basename(file, '.flecs').replace(/^\d+-/, '');

function readAll(): Record<string, string> {
	return Object.fromEntries(
		readdirSync(DIR)
			.filter((f) => f.endsWith('.flecs'))
			.sort()
			.map((f) => [nameOf(f), readFileSync(join(DIR, f), 'utf8')])
	);
}

export function sceneHot(): Plugin {
	return {
		name: 'scene-hot',
		apply: 'serve',
		resolveId(id) {
			if (id === VIRTUAL) return `\0${VIRTUAL}`;
		},
		load(id) {
			if (id === `\0${VIRTUAL}`) return `export default ${JSON.stringify(readAll())};`;
		},
		configureServer(server) {
			server.watcher.add(DIR);
			server.watcher.on('change', (file) => {
				if (!file.endsWith('.flecs') || !file.startsWith(DIR)) return;
				const saved = Date.now();
				const mod = server.moduleGraph.getModuleById(`\0${VIRTUAL}`);
				if (mod) server.moduleGraph.invalidateModule(mod);
				server.ws.send({ type: 'custom', event: 'scene:reload', data: { name: nameOf(file), src: readFileSync(file, 'utf8'), saved } });
			});
		}
	};
}
