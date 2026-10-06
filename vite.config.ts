import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import Icons from 'unplugin-icons/vite';
import { magazine } from './scripts/magazine/vite-plugin';
import { sceneHot } from './scripts/scene-hot';

export default defineConfig({
	plugins: [
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
