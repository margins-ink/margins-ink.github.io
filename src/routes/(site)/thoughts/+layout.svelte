<script lang="ts">
	import type { LayoutData } from './$types';
	import ConstructionTape from '$lib/components/ConstructionTape.svelte';
	import TableOfContents from '$lib/components/TableOfContents.svelte';
	import PageNav from '$lib/components/PageNav.svelte';
	import Byline from '$lib/components/Byline.svelte';
	import { plainTitle } from '$lib/title';

	const { data, children }: { data: LayoutData; children: any } = $props();

	const hasToc = $derived(data.toc && data.toc.length > 0);
	const isPaginated = $derived((data.pageCount ?? 1) > 1);
</script>

<svelte:head>
	{#if data.title}
		<title>{plainTitle(data.title)} | Margins</title>
	{:else}
		<title>Margins</title>
	{/if}
</svelte:head>

{#if data.status === 'WIP'}
	<ConstructionTape />
{/if}

<div class="thought-layout" class:has-toc={hasToc}>
	{#if hasToc}
		<aside class="toc-sidebar">
			<TableOfContents toc={data.toc} />
		</aside>
	{/if}
	<article class="thought-content" data-current-page={data.currentPage ?? 1}>
		{#if data.username}
			<Byline username={data.username} date={data.date} readingTime={data.readingTime} />
		{/if}
		{@render children?.()}
		{#if isPaginated}
			<PageNav currentPage={data.currentPage ?? 1} pageCount={data.pageCount ?? 1} />
		{/if}
	</article>
</div>

<style>
	.thought-layout {
		display: block;
	}

	.thought-content {
		min-width: 0;
	}

	/* Hide non-current pages */
	.thought-content :global(.page-section) {
		display: none;
	}

	.thought-content[data-current-page='1'] :global(.page-section[data-page='1']),
	.thought-content[data-current-page='2'] :global(.page-section[data-page='2']),
	.thought-content[data-current-page='3'] :global(.page-section[data-page='3']),
	.thought-content[data-current-page='4'] :global(.page-section[data-page='4']),
	.thought-content[data-current-page='5'] :global(.page-section[data-page='5']),
	.thought-content[data-current-page='6'] :global(.page-section[data-page='6']),
	.thought-content[data-current-page='7'] :global(.page-section[data-page='7']),
	.thought-content[data-current-page='8'] :global(.page-section[data-page='8']),
	.thought-content[data-current-page='9'] :global(.page-section[data-page='9']),
	.thought-content[data-current-page='10'] :global(.page-section[data-page='10']) {
		display: block;
	}

	.toc-sidebar {
		display: none;
	}

	/* Show sidebar on wide screens */
	@media (min-width: 1100px) {
		.thought-layout.has-toc {
			display: grid;
			grid-template-columns: 200px 1fr;
			gap: 3rem;
			margin-left: -232px;
		}

		.toc-sidebar {
			display: block;
		}

		/* Let code blocks break out of prose width for 100 char lines (~780px) */
		.thought-content :global(pre) {
			max-width: none;
			width: calc(100% + 140px);
		}
	}
</style>
