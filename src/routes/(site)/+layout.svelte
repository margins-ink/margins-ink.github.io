<script lang="ts">
	import '../../app.css';
	import Navbar from '$lib/components/Navbar.svelte';
	import type { LayoutData } from './$types';

	const { data, children }: { data?: LayoutData; children: any } = $props();
</script>

<svelte:head>
	{#if data?.title}
		<title>{data.title}</title>
	{/if}
</svelte:head>

<Navbar />

<div class="m-20" style="max-width: var(--content-max-width); margin: 0 auto; padding-top: 5rem;">
	{@render children?.()}
</div>
