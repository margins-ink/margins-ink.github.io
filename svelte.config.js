import { mdsvex, escapeSvelte } from 'mdsvex';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { codeToHtml } from 'shiki';
import { rehypePages } from './src/lib/rehype-pages.js';
import { remarkInlineShiki } from './src/lib/remark-inline-shiki.js';

const config = {
	preprocess: [
		vitePreprocess(),
		mdsvex({
			remarkPlugins: [remarkInlineShiki],
			rehypePlugins: [rehypePages],
			highlight: {
				highlighter: async (code, lang = 'text') => {
					const html = await codeToHtml(code, {
						lang,
						themes: {
							light: 'github-light',
							dark: 'github-dark'
						},
						defaultColor: false
					});
					const escaped = escapeSvelte(html);
					return `{@html \`${escaped}\` }`;
				}
			}
		})
	],
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
