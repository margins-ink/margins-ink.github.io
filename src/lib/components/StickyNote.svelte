<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<aside class="callout">
	<div class="callout-content">
		{@render children()}
	</div>
</aside>

<style>
	.callout {
		background: var(--background-secondary);
		padding: 0.875rem 1rem;
		margin: 1.25rem 0;
		font-size: 0.875rem;
		line-height: 1.65;
		border-radius: var(--radius);
		border-left: 2px solid var(--border);
	}

	.callout-content {
		color: var(--text-secondary);
	}

	.callout-content :global(p) {
		margin: 0;
	}

	.callout-content :global(p + p) {
		margin-top: 0.625rem;
	}

	.callout-content :global(code) {
		background: var(--surface);
	}
</style>