import { codeToHtml } from 'shiki';
import { escapeSvelte } from 'mdsvex';
import { visit } from 'unist-util-visit';

const MARKER = /^\{:([a-zA-Z0-9_+#-]+)\}/;

/**
 * Lets inline code specify a language with a trailing {:lang} marker.
 *
 *   `nix flake check`{:bash}  →  shiki-highlighted inline code
 *
 * Emits Svelte `{@html ...}` so whitespace inside spans survives the
 * compile-time whitespace pass (the block highlighter uses the same trick).
 */
export function remarkInlineShiki() {
	return async (tree) => {
		const targets = [];

		visit(tree, 'inlineCode', (node, index, parent) => {
			if (!parent || typeof index !== 'number') return;
			const next = parent.children[index + 1];
			if (!next || next.type !== 'text') return;
			const match = MARKER.exec(next.value);
			if (!match) return;
			targets.push({ node, parent, index, next, match });
		});

		const results = await Promise.all(
			targets.map(async ({ node, parent, index, next, match }) => {
				const lang = match[1];
				const html = await codeToHtml(node.value, {
					lang,
					themes: { light: 'github-light', dark: 'github-dark' },
					defaultColor: false
				});
				const m = /<code[^>]*>([\s\S]*?)<\/code>/.exec(html);
				const inner = m ? m[1] : node.value;
				const wrapped = `<code class="shiki shiki-inline shiki-themes github-light github-dark">${inner}</code>`;
				const escaped = escapeSvelte(wrapped);
				return {
					parent,
					index,
					next,
					marker: match[0],
					html: `{@html \`${escaped}\`}`
				};
			})
		);

		for (const { parent, index, next, marker, html } of results) {
			parent.children[index] = { type: 'html', value: html };
			next.value = next.value.slice(marker.length);
		}
	};
}
