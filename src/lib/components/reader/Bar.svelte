<script lang="ts">
	// Slim sticky top bar: article title, current section (crossfades), reading time left, Aa and close.
	// The progress rail is drawn by the page pass, not here.
	import { fade, fly } from 'svelte/transition';
	import { getReaderCtx } from '$lib/reading/ctx';

	const ctx = getReaderCtx();
	const { readingBlock, progress, aaOpen, foldExpanded } = ctx;

	const title = ctx.meta?.title ?? '';
	const h2s = ctx.headings.filter((h) => h.level === 2);
	const dur = ctx.reduced() ? 0 : 160;

	const sectionLabel = $derived.by(() => {
		const rb = $readingBlock;
		if (rb < 0) return '';
		let h = ctx.headings.find((x) => x.block === rb);
		if (!h) {
			for (const x of ctx.headings) if (x.block <= rb) h = x;
		}
		if (!h) return '';
		const n = h2s.findIndex((x) => x.block === h!.block);
		return n >= 0 ? `${String(n + 1).padStart(2, '0')} ${h.text}` : h.text;
	});

	const minLeft = $derived.by(() => {
		const m = ctx.meta;
		if (!m || ctx.widthClass() === 2) return 0;
		const words = ($foldExpanded ? m.wordsFull : m.wordsBrief) || m.wordsFull || m.wordsBrief;
		if (!words) return 0;
		return Math.max(0, Math.ceil(((1 - $progress) * words) / 230));
	});

	function close() {
		for (let i = ctx.closeStack.length - 1; i >= 0; i--) if (ctx.closeStack[i]()) return;
		ctx.closeArticle();
	}
</script>

<header class="rc-bar">
	<span class="rc-bar-title">{title}</span>
	<div class="rc-bar-mid">
		{#key sectionLabel}
			{#if sectionLabel}
				<button
					type="button"
					class="rc-bar-section"
					aria-label={`Current section: ${sectionLabel}. Open contents`}
					onclick={() => ctx.toggleContents?.()}
					in:fly|global={{ y: 6, duration: dur }}
					out:fade|global={{ duration: dur }}
				>{sectionLabel}</button>
			{/if}
		{/key}
	</div>
	<div class="rc-bar-end">
		{#if minLeft > 0}<span class="rc-bar-time" aria-hidden="true">{minLeft} min left</span>{/if}
		<button
			type="button"
			id="reader-aa-btn"
			class="rc-btn rc-aa-btn"
			aria-label="Text size"
			aria-haspopup="dialog"
			aria-expanded={$aaOpen}
			aria-controls="reader-aa-menu"
			onclick={() => aaOpen.update((v) => !v)}
		>
			<span aria-hidden="true"><span class="rc-aa-s">A</span><span class="rc-aa-l">A</span></span>
		</button>
		<button type="button" class="rc-btn rc-close-btn" aria-label="Close article" onclick={close}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
		</button>
	</div>
</header>
