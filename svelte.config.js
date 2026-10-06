import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { frontmatterOnly } from './src/lib/frontmatter-preprocess.js';

const config = {
	// Route .svx files are reading SOURCE (scripts/magazine); SvelteKit only sees their frontmatter (no body in the DOM).
	preprocess: [frontmatterOnly(), vitePreprocess()],
	kit: {
		adapter: adapter({
			pages: 'build',
			assets: 'build',
			fallback: '404.html',
			precompress: false,
			strict: true
		}),
		prerender: {
			handleHttpError: ({ path, referrer, message, status }) => {
				// Hidden thoughts (visible: false in frontmatter) intentionally 404.
				// Skip them instead of failing the whole build.
				if (status === 404) {
					console.warn(`prerender skipped ${path} (404 from ${referrer ?? 'unknown'})`);
					return;
				}
				throw new Error(message);
			}
		}
	},
	extensions: ['.svelte', '.svx']
};

export default config;
