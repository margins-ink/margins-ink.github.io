<script lang="ts">
	import '../../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';
	import World from '$lib/components/World.svelte';
	import Reader from '$lib/components/Reader.svelte';
	import { thoughtBySlug } from '$lib/thoughts';
	import { goto } from '$app/navigation';

	const { data, children }: { data?: LayoutData; children: any } = $props();

	const isLanding = $derived(page.url.pathname === '/');

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
	{#if data?.title}
		<title>{data.title}</title>
	{/if}
</svelte:head>

{#if worldOn}
	<World />
{:else if readerSlug}
	{#key readerSlug}
		<Reader mode="only" slug={readerSlug} onClose={leave} />
	{/key}
{/if}

<div class="shell" class:landing={isLanding} inert={readerSlug !== null && !worldOn} aria-hidden={readerSlug !== null && !worldOn ? true : undefined}>
	{@render children?.()}
</div>

<style>
	:global(body) {
		max-width: none;
		padding: 0;
	}
	.shell {
		width: min(1120px, calc(100vw - 3rem));
		margin: 0 auto;
	}
</style>
