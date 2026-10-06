<script lang="ts">
	// Mounted by Reader into each code block's .copy-slot: language label plus a button that copies the exact source.
	import { onDestroy } from 'svelte';
	import { stringAt } from '$lib/magazine/format';
	import { getReaderCtx } from '$lib/reading/ctx';

	let { block, source }: { block: number; source: string } = $props();

	const ctx = getReaderCtx();
	const lang = (() => {
		const m = ctx.model;
		const b = m?.blocks[block];
		return m && b ? stringAt(m.strings, b.anchor) : '';
	})();

	let done = $state(false);
	let timer: ReturnType<typeof setTimeout> | undefined;

	async function copy() {
		try {
			if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(source);
			else legacyCopy(source);
		} catch {
			try { legacyCopy(source); } catch { ctx.toast('Copy failed'); return; }
		}
		done = true;
		clearTimeout(timer);
		timer = setTimeout(() => { done = false; }, 1200);
		ctx.toast('Copied');
	}

	function legacyCopy(text: string) {
		const ta = document.createElement('textarea');
		ta.value = text;
		ta.setAttribute('readonly', '');
		ta.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
		document.body.append(ta);
		ta.select();
		const ok = document.execCommand('copy');
		ta.remove();
		if (!ok) throw new Error('copy failed');
	}

	onDestroy(() => clearTimeout(timer));
</script>

<div class="rc-copy">
	{#if lang}<span class="rc-copy-lang" aria-hidden="true">{lang}</span>{/if}
	<button type="button" class="rc-btn rc-copy-btn" class:done aria-label={done ? 'Copied' : lang ? `Copy ${lang} code` : 'Copy code'} onclick={copy}>
		{#if done}
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.5l3.2 3.2L13 4.8" /></svg>
		{:else}
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.6" /><path d="M10.5 3.5v-.4A1.1 1.1 0 0 0 9.4 2H3.6A1.6 1.6 0 0 0 2 3.6v5.8A1.1 1.1 0 0 0 3.1 10.5h.4" /></svg>
		{/if}
	</button>
</div>
