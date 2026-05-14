<script lang="ts">
	import '../../app.css';
	import { page } from '$app/state';
	import Navbar from '$lib/components/Navbar.svelte';
	import type { LayoutData } from './$types';

	const { data, children }: { data?: LayoutData; children: any } = $props();

	// Landing is its own masthead; navbar would duplicate identity there.
	const isLanding = $derived(page.url.pathname === '/');
</script>

<svelte:head>
	{#if data?.title}
		<title>{data.title}</title>
	{/if}
</svelte:head>

{#if !isLanding}
	<Navbar />
{/if}

<div
	style="max-width: var(--content-max-width); margin: 0 auto; padding-top: {isLanding ? '0' : '5rem'};"
>
	{@render children?.()}
</div>
