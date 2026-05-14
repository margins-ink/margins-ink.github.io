<script lang="ts">
	import type { Snippet } from 'svelte';

	const { children }: { children: Snippet } = $props();
</script>

<div class="flow-box">
	{@render children()}
</div>

<style>
	.flow-box {
		border: 2px solid currentColor;
		border-radius: 0.5rem;
		padding: 1.5rem;
		text-align: center;
	}

	.flow-box :global(h3) {
		margin: 0;
		font-size: 1rem;
		font-weight: 600;
	}

	.flow-box :global(p) {
		margin: 0.5rem 0 0 0;
		color: var(--text-muted);
		font-size: 0.875rem;
	}
</style>
