<script lang="ts">
	import type { LayoutData } from './$types';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import ConstructionTape from '$lib/components/ConstructionTape.svelte';
	import TableOfContents from '$lib/components/TableOfContents.svelte';
	import PageNav from '$lib/components/PageNav.svelte';
	import Byline from '$lib/components/Byline.svelte';
	import ChatPrompts from '$lib/components/ChatPrompts.svelte';
	import Related from '$lib/components/Related.svelte';
	import { plainTitle } from '$lib/title';
	import { sourceFolderUrl } from '$lib/github';

	const { data, children }: { data: LayoutData; children: any } = $props();

	const sourceUrl = $derived(sourceFolderUrl(page.url.pathname));

	const currentPage = $derived.by(() => {
		if (!browser) return 1;
		const raw = page.url.searchParams.get('p');
		const n = raw ? parseInt(raw, 10) : 1;
		const max = data.pageCount ?? 1;
		if (!Number.isFinite(n) || n < 1) return 1;
		if (n > max) return max;
		return n;
	});

	const visibleToc = $derived(
		(data.toc ?? []).filter((h: { page?: number }) => !h.page || h.page === currentPage)
	);

	const hasToc = $derived(visibleToc.length > 0);
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
			<TableOfContents toc={visibleToc} />
		</aside>
	{/if}
	<article class="thought-content" data-current-page={currentPage}>
		{#if data.username}
			<Byline
				username={data.username}
				date={data.date}
				readingTime={data.readingTime}
				{sourceUrl}
			/>
		{/if}
		{#if currentPage === 1 && data.related && (data.related.users?.length || data.related.repos?.length)}
			<Related users={data.related.users} repos={data.related.repos} />
		{/if}
		{#if data.prompts && data.prompts.length > 0 && currentPage === 1}
			<ChatPrompts prompts={data.prompts} />
		{/if}
		{@render children?.()}
		{#if isPaginated}
			<PageNav {currentPage} pageCount={data.pageCount ?? 1} />
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
