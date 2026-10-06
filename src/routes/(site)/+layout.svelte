<script lang="ts">
	import '../../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';
	import World from '$lib/components/World.svelte';
	import Reader from '$lib/components/Reader.svelte';
	import { thoughtBySlug } from '$lib/thoughts';
	import { SITE } from '$lib/meta';
	import { goto } from '$app/navigation';

	const { data }: { data: LayoutData } = $props();

	const meta = $derived(data.meta);

	// A cold load of /thoughts/<slug> is reader-only: no room, no bake, no probes, no elevator, only the page pass (docs/READING.md).
	// The world mounts the first time the reader is left; from then on reading is in-world.
	const slugOf = (p: string) => {
		const m = /^\/thoughts\/([^/]+)\/?$/.exec(p);
		return m && thoughtBySlug(m[1]) ? m[1] : null;
	};
	let worldOn = $state(slugOf(page.url.pathname) === null);
	const readerSlug = $derived(slugOf(page.url.pathname));
	function leave() {
		worldOn = true;
		void goto('/');
	}
	$effect(() => {
		if (readerSlug === null) worldOn = true;
	});
</script>

<svelte:head>
	<title>{meta.title}</title>
	<meta name="description" content={meta.description} />
	<link rel="canonical" href={meta.canonical} />
	<meta property="og:site_name" content={SITE} />
	<meta property="og:type" content={meta.type} />
	<meta property="og:title" content={meta.title} />
	<meta property="og:description" content={meta.description} />
	<meta property="og:url" content={meta.canonical} />
	{#if meta.published}<meta property="article:published_time" content={meta.published} />{/if}
	<meta name="twitter:card" content="summary" />
	<meta name="twitter:title" content={meta.title} />
	<meta name="twitter:description" content={meta.description} />
</svelte:head>

{#if worldOn}
	<World />
{:else if readerSlug}
	{#key readerSlug}
		<Reader mode="only" slug={readerSlug} onClose={leave} />
	{/key}
{/if}
