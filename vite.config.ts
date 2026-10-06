import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import Icons from 'unplugin-icons/vite';
import { magazine } from './scripts/magazine/vite-plugin';
import { sceneHot } from './scripts/scene-hot';
import { devErrors } from './scripts/dev-errors';

export default defineConfig({
	plugins: [
		devErrors(),
		magazine(),
		sceneHot(),
		sveltekit(),
		Icons({
			compiler: 'svelte',
		})
	],
	server: {
		allowedHosts: ['dev.com']
	}
});
