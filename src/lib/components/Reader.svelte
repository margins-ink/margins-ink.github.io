<script lang="ts">
	// Thin mount: the reader is plain TypeScript (src/lib/reading/reader.ts); Svelte only owns the element's lifetime.
	import { onMount } from 'svelte';
	import { createReader, type ReaderHandle } from '$lib/reading/reader';
	import type { Reading } from '$lib/reading/abi';

	let { slug, mode, fromWorld = false, reading, onClose }: { slug: string; mode: 'only' | 'world'; fromWorld?: boolean; reading?: Reading; onClose?: () => void } = $props();
	let el: HTMLDivElement;
	let handle: ReaderHandle | undefined;

	onMount(() => {
		handle = createReader(el, { slug, mode, fromWorld, reading, onClose });
		return () => handle?.dispose();
	});
	$effect(() => {
		handle?.setSlug(slug);
	});
</script>

<div bind:this={el}></div>
