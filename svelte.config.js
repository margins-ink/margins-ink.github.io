import { mdsvex, escapeSvelte } from 'mdsvex';
import adapter from '@sveltejs/adapter-cloudflare';
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
	kit: { adapter: adapter() },
	extensions: ['.svelte', '.svx']
};

export default config;
