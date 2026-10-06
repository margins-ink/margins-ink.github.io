<script lang="ts">
	import type { LayoutData } from './$types';
	import { page } from '$app/state';
	import { browser } from '$app/environment';
	import TableOfContents from '$lib/components/TableOfContents.svelte';
	import PageNav from '$lib/components/PageNav.svelte';
	import EraRail from '$lib/components/EraRail.svelte';
	import ArticleHero from '$lib/components/ArticleHero.svelte';
	import { thoughts } from '$lib/thoughts';
	import { accentFor, issue, longDate } from '$lib/theme';
	import { plainTitle, renderTitle } from '$lib/title';

	const { data, children }: { data: LayoutData; children: any } = $props();

	const currentPage = $derived.by(() => {
		if (!browser) return 1;
		const raw = page.url.searchParams.get('p');
		const n = raw ? parseInt(raw, 10) : 1;
		const max = data.pageCount ?? 1;
		if (!Number.isFinite(n) || n < 1) return 1;
		return n > max ? max : n;
	});

	const visibleToc = $derived(
		(data.toc ?? []).filter((h: { page?: number }) => !h.page || h.page === currentPage)
	);
	const isPaginated = $derived((data.pageCount ?? 1) > 1);
	const accent = $derived(data.slug ? accentFor(data.slug) : { light: '#57534e', dark: '#d6d3d1' });
	let heroLive = $state(false);
	const older = $derived(thoughts.find((t) => t.no === (data.no ?? 0) - 1));
	const newer = $derived(thoughts.find((t) => t.no === (data.no ?? 0) + 1));
</script>

<svelte:head>
	<title>{data.title ? plainTitle(data.title) : 'Andrew Gazelka'}</title>
</svelte:head>

{#if data.title}
	<div class="issue" style:--al={accent.light} style:--ad={accent.dark}>
		<div class="folio">
			<a href="/">Andrew Gazelka</a>
			<span>No. {issue(data.no ?? 0)}</span>
			<span>{data.date ? longDate(data.date) : ''}</span>
		</div>

		<header class="opener" class:hero={heroLive}>
			{#if data.slug}
				<div class="render"><ArticleHero slug={data.slug} bind:live={heroLive} /></div>
			{/if}
			<div class="numeral" aria-hidden="true">{issue(data.no ?? 0)}</div>
			<div class="opener-text">
				<h1>{@html renderTitle(data.title)}</h1>
				{#if data.dek}<p class="dek">{data.dek}</p>{/if}
				<p class="by">By Andrew Gazelka</p>
			</div>
		</header>

		<div class="spread" class:has-toc={visibleToc.length > 0}>
			<aside class="toc">
				{#if visibleToc.length > 0}<TableOfContents toc={visibleToc} />{/if}
			</aside>
			<article class="prose" data-current-page={currentPage}>
				{@render children?.()}
				{#if isPaginated}
					<PageNav {currentPage} pageCount={data.pageCount ?? 1} />
				{/if}
			</article>
			<aside class="era">
				<EraRail items={thoughts} active={data.slug} side="right" />
			</aside>
		</div>

		<nav class="more" aria-label="More pieces">
			{#if older}
				<a href={older.route}>
					<span class="k">Previous &middot; No. {issue(older.no)}</span>
					<span class="t">{@html renderTitle(older.title)}</span>
				</a>
			{:else}<span></span>{/if}
			{#if newer}
				<a class="r" href={newer.route}>
					<span class="k">Next &middot; No. {issue(newer.no)}</span>
					<span class="t">{@html renderTitle(newer.title)}</span>
				</a>
			{/if}
		</nav>
	</div>
{:else}
	{@render children?.()}
{/if}

<style>
	.issue {
		--acc: var(--al);
		padding: 1.25rem 0 6rem;
	}
	@media (prefers-color-scheme: dark) {
		.issue {
			--acc: var(--ad);
		}
	}
	.folio {
		display: flex;
		justify-content: space-between;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-tertiary);
		border-top: 3px solid var(--text-primary);
		border-bottom: 1px solid var(--text-primary);
		padding: 0.5rem 0;
	}
	.folio a {
		color: var(--text-primary);
		text-decoration: none;
		font-weight: 500;
	}

	.opener {
		display: grid;
		grid-template-columns: auto minmax(0, 1fr);
		gap: clamp(1rem, 4vw, 3.5rem);
		align-items: end;
		padding: 3rem 0 2.5rem;
		border-bottom: 1px solid var(--text-primary);
	}
	.opener {
		position: relative;
		isolation: isolate;
		min-height: min(70svh, 560px);
	}
	.render {
		position: absolute;
		inset: 0 calc(50% - 50vw);
		z-index: -2;
	}
	.opener.hero::before {
		content: '';
		position: absolute;
		inset: 0 calc(50% - 50vw);
		z-index: -1;
		background: linear-gradient(90deg, var(--background) 0%, var(--background) 38%, transparent 72%);
	}
	.opener.hero .numeral {
		display: none;
	}
	.opener.hero .opener-text {
		max-width: 38rem;
	}
	.numeral {
		font-family: var(--font-serif);
		font-weight: 800;
		font-size: clamp(7rem, 24vw, 19rem);
		line-height: 0.78;
		letter-spacing: -0.06em;
		color: var(--acc);
	}
	h1 {
		margin: 0 0 1.25rem;
		font-family: var(--font-serif);
		font-weight: 800;
		font-size: clamp(2.4rem, 6.2vw, 5rem);
		line-height: 0.96;
		letter-spacing: -0.035em;
		color: var(--text-primary);
		text-wrap: balance;
	}
	h1 :global(code) {
		font-size: 0.75em;
	}
	.dek {
		margin: 0 0 1.25rem;
		max-width: 34rem;
		font-family: var(--font-serif);
		font-style: italic;
		font-size: clamp(1.15rem, 2vw, 1.5rem);
		line-height: 1.35;
		color: var(--text-secondary);
	}
	.by {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}

	.spread {
		display: grid;
		grid-template-columns: minmax(0, 1fr);
		padding-top: 3rem;
	}
	.toc,
	.era {
		display: none;
	}
	.prose {
		min-width: 0;
		font-family: var(--font-serif);
		font-size: 1.2rem;
		line-height: 1.7;
		max-width: 40rem;
		margin: 0 auto;
		width: 100%;
		counter-reset: sec;
	}
	@media (min-width: 1180px) {
		.spread {
			grid-template-columns: 12rem minmax(0, 1fr) 5.5rem;
			gap: 3rem;
		}
		.toc,
		.era {
			display: block;
			position: sticky;
			top: 2rem;
			align-self: start;
		}
		.prose :global(pre) {
			max-width: none;
			width: calc(100% + 8rem);
		}
	}

	/* drop cap on the first paragraph of the first page */
	.prose[data-current-page='1'] :global(> p:first-of-type::first-letter),
	.prose[data-current-page='1'] :global(.page-section[data-page='1'] > p:first-of-type::first-letter) {
		float: left;
		font-weight: 800;
		font-size: 4.9em;
		line-height: 0.82;
		padding: 0.06em 0.1em 0 0;
		color: var(--acc);
	}
	.prose :global(h2) {
		counter-increment: sec;
		margin: 3.5rem 0 1rem;
		padding-top: 0.9rem;
		border-top: 3px solid var(--text-primary);
		font-family: var(--font-serif);
		font-size: 2rem;
		font-weight: 800;
		line-height: 1.08;
		letter-spacing: -0.025em;
	}
	.prose :global(h2::before) {
		content: counter(sec, decimal-leading-zero);
		display: block;
		margin-bottom: 0.5rem;
		font-family: var(--font-mono);
		font-size: 0.7rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		color: var(--acc);
	}
	.prose :global(h3) {
		font-family: var(--font-serif);
		font-size: 1.35rem;
		font-weight: 700;
		margin: 2.2rem 0 0.6rem;
	}
	.prose :global(blockquote) {
		margin: 2.5rem 0;
		padding: 0 0 0 1.25rem;
		border-left: 4px solid var(--acc);
		font-size: 1.6rem;
		font-style: italic;
		line-height: 1.25;
		color: var(--text-primary);
	}
	.prose :global(a) {
		color: inherit;
		text-decoration-color: var(--acc);
		text-decoration-thickness: 2px;
		text-underline-offset: 3px;
	}
	.prose :global(code),
	.prose :global(pre) {
		font-family: var(--font-mono);
		font-size: 0.82em;
		line-height: 1.55;
	}

	/* paginated posts */
	.prose :global(.page-section) {
		display: none;
	}
	.prose[data-current-page='1'] :global(.page-section[data-page='1']),
	.prose[data-current-page='2'] :global(.page-section[data-page='2']),
	.prose[data-current-page='3'] :global(.page-section[data-page='3']),
	.prose[data-current-page='4'] :global(.page-section[data-page='4']),
	.prose[data-current-page='5'] :global(.page-section[data-page='5']),
	.prose[data-current-page='6'] :global(.page-section[data-page='6']) {
		display: block;
	}

	.more {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 2rem;
		margin-top: 6rem;
		padding-top: 1.5rem;
		border-top: 3px solid var(--text-primary);
	}
	.more a {
		display: block;
		color: inherit;
		text-decoration: none;
	}
	.more .r {
		text-align: right;
		grid-column: 2;
	}
	.k {
		display: block;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--acc);
		margin-bottom: 0.4rem;
	}
	.t {
		display: block;
		font-family: var(--font-serif);
		font-size: 1.7rem;
		font-weight: 800;
		line-height: 1.05;
		letter-spacing: -0.02em;
	}
</style>
