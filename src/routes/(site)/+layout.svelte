<script lang="ts">
	import '../../app.css';
	import { page } from '$app/state';
	import type { LayoutData } from './$types';
	import World from '$lib/components/World.svelte';

	const { data, children }: { data?: LayoutData; children: any } = $props();

	const isLanding = $derived(page.url.pathname === '/');
</script>

<svelte:head>
	{#if data?.title}
		<title>{data.title}</title>
	{/if}
</svelte:head>

<World />

<div class="shell" class:landing={isLanding}>
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
