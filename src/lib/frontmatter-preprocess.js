// Svelte preprocessor for route .svx files: keep ONLY the YAML frontmatter (exported as `metadata`), drop the body.
// The article source stays in the .svx (scripts/magazine reads it from disk and draws it with WebGPU); SvelteKit
// must never render it to the DOM, so the page component it compiles to is empty. Head tags come from `metadata`.
import YAML from 'yaml';

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** @returns {import('svelte/compiler').PreprocessorGroup} */
export function frontmatterOnly() {
	return {
		name: 'frontmatter-only',
		markup({ content, filename }) {
			if (!filename?.endsWith('.svx')) return;
			const m = FRONTMATTER.exec(content);
			const metadata = m ? (YAML.parse(m[1]) ?? {}) : {};
			return { code: `<script module>\n\texport const metadata = ${JSON.stringify(metadata)};\n</script>\n` };
		}
	};
}
