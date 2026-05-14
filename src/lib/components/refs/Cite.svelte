<script lang="ts">
	import { getRefs } from './index.js';
	let { id }: { id: string } = $props();
	const refs = getRefs();
	const i = refs.findIndex((r) => r.id === id);
	const ref = i >= 0 ? refs[i] : null;
</script>

{#if ref}<sup class="cite"
		><a href={`#ref-${id}`} title={ref.title}>[{i + 1}]</a></sup
	>{:else}<sup class="cite cite-missing" title={`unknown ref: ${id}`}>[?]</sup>{/if}

<style>
	.cite {
		font-size: 0.75em;
		line-height: 0;
	}

	.cite a {
		text-decoration: none;
		color: var(--accent, var(--text-tertiary));
		padding: 0 1px;
	}

	.cite a:hover {
		text-decoration: underline;
	}

	.cite-missing {
		color: var(--accent-warning, #b45309);
	}
</style>
