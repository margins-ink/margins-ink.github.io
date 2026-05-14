import { visit } from 'unist-util-visit';
import { toString } from 'hast-util-to-string';

/**
 * Rehype plugin that:
 * 1. Splits content by ---page--- markers into sections
 * 2. Extracts TOC with page numbers for each heading
 * 3. Exports pageCount and toc metadata
 */
export function rehypePages() {
	return (tree) => {
		// First pass: extract all headings with their positions
		const headingPositions = [];
		let nodeIndex = 0;

		for (const node of tree.children) {
			if (node.type === 'raw' && node.value?.includes('<script')) {
				nodeIndex++;
				continue;
			}

			visit({ type: 'root', children: [node] }, 'element', (el) => {
				if (el.tagName === 'h2' || el.tagName === 'h3') {
					const text = toString(el);
					const id = slugify(text);
					const level = parseInt(el.tagName.charAt(1), 10);

					el.properties = el.properties || {};
					el.properties.id = id;

					headingPositions.push({ id, text, level, nodeIndex });
				}
			});
			nodeIndex++;
		}

		// Second pass: split by page delimiters
		const pages = [];
		let currentPage = [];
		let currentNodeIndex = 0;

		for (const node of tree.children) {
			if (node.type === 'raw' && node.value?.includes('<script')) {
				currentNodeIndex++;
				continue;
			}

			const isDelimiter =
				node.type === 'element' &&
				node.tagName === 'p' &&
				node.children?.[0]?.value?.trim() === '---page---';

			if (isDelimiter) {
				if (currentPage.length > 0) {
					pages.push({ nodes: currentPage, startIndex: currentNodeIndex - currentPage.length });
					currentPage = [];
				}
			} else {
				currentPage.push(node);
			}
			currentNodeIndex++;
		}

		if (currentPage.length > 0) {
			pages.push({ nodes: currentPage, startIndex: currentNodeIndex - currentPage.length });
		}

		// No pagination if only one page
		if (pages.length <= 1) {
			// Still export toc without page numbers for non-paginated content
			const toc = headingPositions.map(({ id, text, level }) => ({ id, text, level }));
			if (toc.length > 0) {
				const scriptContent = `export const toc = ${JSON.stringify(toc)};`;
				injectModuleScript(tree, scriptContent);
			}
			return;
		}

		// Assign page numbers to headings
		const toc = headingPositions.map((h) => {
			let page = 1;
			for (let i = 0; i < pages.length; i++) {
				const pageStart = pages[i].startIndex;
				const pageEnd = pageStart + pages[i].nodes.length;
				if (h.nodeIndex >= pageStart && h.nodeIndex < pageEnd) {
					page = i + 1;
					break;
				}
			}
			return { id: h.id, text: h.text, level: h.level, page };
		});

		// Build new tree with sections
		const scripts = tree.children.filter(
			(n) => n.type === 'raw' && n.value?.includes('<script')
		);

		const sections = pages.map((page, i) => ({
			type: 'element',
			tagName: 'section',
			properties: { className: ['page-section'], 'data-page': String(i + 1) },
			children: page.nodes
		}));

		tree.children = [...scripts, ...sections];

		// Export pageCount and toc
		const scriptContent = `export const pageCount = ${pages.length};\nexport const toc = ${JSON.stringify(toc)};`;
		injectModuleScript(tree, scriptContent);
	};
}

function injectModuleScript(tree, content) {
	let found = false;
	visit(tree, 'raw', (node) => {
		if (node.value?.includes('context="module"')) {
			node.value = node.value.replace('</script>', `\n\t${content}\n</script>`);
			found = true;
		}
	});

	if (!found) {
		tree.children.unshift({
			type: 'raw',
			value: `<script lang="ts" context="module">\n\t${content}\n</script>\n`
		});
	}
}

function slugify(text) {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/(^-|-$)/g, '');
}
