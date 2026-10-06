import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import Icons from 'unplugin-icons/vite';
import { magazine } from './scripts/magazine/vite-plugin';

export default defineConfig({
	plugins: [
		magazine(),
		sveltekit(),
		Icons({
			compiler: 'svelte',
		})
	],
	server: {
		allowedHosts: ['dev.com']
	}
});
