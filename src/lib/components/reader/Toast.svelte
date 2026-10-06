<script lang="ts">
	// Renders ctx.toastMsg for 1.6 s in a polite live region.
	import { fly } from 'svelte/transition';
	import { getReaderCtx } from '$lib/reading/ctx';

	const ctx = getReaderCtx();
	const { toastMsg } = ctx;

	let shown = $state<{ msg: string; id: number } | null>(null);
	let timer: ReturnType<typeof setTimeout> | undefined;

	$effect(() => {
		const m = $toastMsg;
		clearTimeout(timer);
		shown = m;
		if (m) timer = setTimeout(() => { shown = null; }, 1600);
		return () => clearTimeout(timer);
	});
</script>

<div class="rc-toast-region" role="status" aria-live="polite" aria-atomic="true">
	{#if shown}
		{#key shown.id}
			<div class="rc-toast" transition:fly|global={{ y: 8, duration: ctx.reduced() ? 0 : 140 }}>{shown.msg}</div>
		{/key}
	{/if}
</div>
