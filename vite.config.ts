import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';
import Icons from 'unplugin-icons/vite';
import { reader } from './scripts/reader/vite-plugin';

export default defineConfig({
	plugins: [
		reader(),
		sveltekit(),
		Icons({
			compiler: 'svelte',
		})
	],
	server: {
		allowedHosts: ['dev.com']
	}
});
