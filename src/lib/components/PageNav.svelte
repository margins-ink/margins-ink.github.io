<script lang="ts">
	import { page } from '$app/stores';

	const { currentPage, pageCount }: { currentPage: number; pageCount: number } = $props();

	const basePath = $derived($page.url.pathname);
	const prevHref = $derived(currentPage > 1 ? `${basePath}?p=${currentPage - 1}` : null);
	const nextHref = $derived(currentPage < pageCount ? `${basePath}?p=${currentPage + 1}` : null);

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'ArrowLeft' && prevHref) {
			window.location.href = prevHref;
		} else if (e.key === 'ArrowRight' && nextHref) {
			window.location.href = nextHref;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<nav class="page-nav">
	{#if prevHref}
		<a href={prevHref} class="nav-btn prev">← Previous</a>
	{:else}
		<span class="nav-btn disabled">← Previous</span>
	{/if}

	<span class="page-indicator">{currentPage} / {pageCount}</span>

	{#if nextHref}
		<a href={nextHref} class="nav-btn next">Next →</a>
	{:else}
		<span class="nav-btn disabled">Next →</span>
	{/if}
</nav>

<style>
	.page-nav {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border);
	}

	.nav-btn {
		padding: 0.5rem 1rem;
		border-radius: var(--radius);
		font-size: 0.875rem;
		font-weight: 450;
		transition: all 0.15s ease;
	}

	.nav-btn:not(.disabled) {
		color: var(--text-secondary);
		background: var(--surface);
		border: 1px solid var(--border);
	}

	.nav-btn:not(.disabled):hover {
		color: var(--text-primary);
		border-color: var(--text-tertiary);
	}

	.nav-btn.disabled {
		color: var(--text-quaternary);
		cursor: not-allowed;
	}

	.page-indicator {
		font-size: 0.8125rem;
		color: var(--text-tertiary);
		font-variant-numeric: tabular-nums;
	}
</style>
