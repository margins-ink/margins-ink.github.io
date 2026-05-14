<script lang="ts">
	import type { Snippet } from 'svelte';

	interface Props {
		children: Snippet;
	}

	let { children }: Props = $props();
</script>

<div class="search-box">
	{@render children()}
</div>

<style>
	.search-box {
		background: var(--background);
		border: 2px solid var(--accent);
		border-radius: 8px;
		padding: 1rem 1.5rem;
		box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
	}
</style>
