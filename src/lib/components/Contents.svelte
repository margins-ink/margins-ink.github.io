<script lang="ts">
	import { thoughts } from '$lib/thoughts';
	import { accentFor, coverFor, issue, shortDate } from '$lib/theme';
	import { renderTitle } from '$lib/title';
	import Room from './Room.svelte';
	import EraRail from './EraRail.svelte';

	const featured = thoughts.filter((t) => !t.archived);
	const archive = thoughts.filter((t) => t.archived);

	let live = $state(false);
	let active = $state(thoughts[0].slug);
	let list = $state<HTMLElement>();

	$effect(() => {
		if (!list) return;
		const seen = new Map<string, number>();
		const io = new IntersectionObserver(
			(entries) => {
				for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
				let best = '';
				let bestRatio = 0;
				for (const [id, r] of seen) if (r > bestRatio) [best, bestRatio] = [id, r];
				if (best) active = best;
			},
			{ rootMargin: '-35% 0px -35% 0px', threshold: [0, 0.5, 1] }
		);
		for (const el of document.querySelectorAll('[data-story]')) io.observe(el);
		return () => io.disconnect();
	});

	function jump(slug: string) {
		document.getElementById(slug)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
	}
</script>

<div class="page">
	<Room bind:live />

	<div class="body" class:hidden={live}>
		<aside class="rail-col"><EraRail items={thoughts} {active} side="left" onselect={jump} /></aside>
		<div class="contents" bind:this={list}>
			<h3 class="label">Pieces</h3>
			{#each featured as t (t.slug)}
				{@render row(t)}
			{/each}
			<h3 class="label archive" id="archive">Archive <span>common knowledge now, or I think differently</span></h3>
			{#each archive as t (t.slug)}
				{@render row(t)}
			{/each}
		</div>
	</div>
</div>

{#snippet row(t: (typeof thoughts)[number])}
	{@const a = accentFor(t.slug)}
	<a
		class="row"
		class:old={t.archived}
		id={t.slug}
		data-story
		href={t.route}
		style:--al={a.light}
		style:--ad={a.dark}
	>
		<span class="no">{issue(t.no)}</span>
		<span class="txt">
			<span class="title">{@html renderTitle(t.title)}</span>
			<span class="sub">{t.dek}</span>
		</span>
		<time datetime={t.date}>{shortDate(t.date)}</time>
	</a>
{/snippet}

<style>
	.page {
		padding: 0 0 8rem;
	}
	.body.hidden {
		display: none;
	}
	.body {
		display: grid;
		grid-template-columns: 5.5rem minmax(0, 1fr);
		gap: 2rem;
		align-items: start;
		padding-top: 1.5rem;
	}
	.rail-col {
		position: sticky;
		top: 2rem;
	}
	.label {
		margin: 0 0 0.25rem;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		font-weight: 500;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}
	.row {
		--acc: var(--al);
		display: grid;
		grid-template-columns: 3.5rem minmax(0, 1fr) auto;
		gap: 1.5rem;
		align-items: center;
		padding: 1.25rem 0;
		border-bottom: 1px solid var(--border-primary, rgba(128, 128, 128, 0.3));
		color: inherit;
		text-decoration: none;
	}
	.no {
		font-family: var(--font-serif);
		font-size: 2.75rem;
		font-weight: 800;
		line-height: 1;
		letter-spacing: -0.04em;
		color: var(--acc);
	}
	.title {
		display: block;
		font-family: var(--font-serif);
		font-size: 1.65rem;
		font-weight: 700;
		line-height: 1.1;
		letter-spacing: -0.02em;
		color: var(--text-primary);
		text-wrap: balance;
	}
	.title :global(code) {
		font-size: 0.8em;
	}
	.row.old .title {
		font-size: 1.3rem;
		font-weight: 600;
	}
	.label.archive {
		margin-top: 3rem;
	}
	.label span {
		margin-left: 0.75rem;
		text-transform: none;
		letter-spacing: 0;
		font-style: italic;
	}
	.row:hover .title {
		text-decoration: underline;
		text-decoration-color: var(--acc);
		text-decoration-thickness: 3px;
		text-underline-offset: 4px;
	}
	.sub {
		display: block;
		margin-top: 0.4rem;
		font-size: 0.9rem;
		line-height: 1.45;
		color: var(--text-tertiary);
	}
	time {
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--text-tertiary);
	}
	@media (prefers-color-scheme: dark) {
		.row {
			--acc: var(--ad);
		}
	}
	@media (max-width: 820px) {
		.body {
			grid-template-columns: minmax(0, 1fr);
		}
		.rail-col {
			display: none;
		}
		.row {
			grid-template-columns: 2.5rem minmax(0, 1fr);
		}
		time {
			display: none;
		}
	}
</style>
