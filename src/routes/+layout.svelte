<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';

	let { children } = $props();

	// SvelteKit's route announcer writes the page title into an aria-live div after every navigation. The page has no DOM text
	// (WebGPU only; docs/READING.md), so drop it the moment it appears.
	onMount(() => {
		if (import.meta.env.DEV) void import('$lib/dev/errors').then((m) => m.installDevErrors());
		const drop = () => document.getElementById('svelte-announcer')?.remove();
		drop();
		const mo = new MutationObserver(drop);
		mo.observe(document.body, { childList: true, subtree: true });
		return () => mo.disconnect();
	});
</script>

{@render children()}
