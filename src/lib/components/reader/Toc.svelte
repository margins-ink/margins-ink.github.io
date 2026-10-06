<script lang="ts">
	// Contents. Wide (viewport >= 1400 and room left of the column): a sticky list at the left. Otherwise a sheet opened by T or the
	// Bar's section name (slide-over on mid, bottom sheet on phone).
	import { onMount, tick } from 'svelte';
	import { fade } from 'svelte/transition';
	import { getReaderCtx } from '$lib/reading/ctx';

	const ctx = getReaderCtx();
	const { readingBlock, scale } = ctx;

	const items = ctx.headings.filter((h) => h.level === 2 || h.level === 3);
	const h2s = ctx.headings.filter((h) => h.level === 2);

	let viewW = $state(typeof window === 'undefined' ? 0 : window.innerWidth);
	let docLeft = $state(0);
	let sheet = $state(false);
	let nav = $state<HTMLElement>();
	let returnTo: HTMLElement | null = null;

	const room = $derived(Math.min(232, docLeft - 40));
	const sticky = $derived(viewW >= 1400 && room >= 150);

	const activeBlock = $derived.by(() => {
		const rb = $readingBlock;
		let a = -1;
		for (const h of items) if (h.block <= rb) a = h.block;
		return a;
	});

	function measure() {
		viewW = window.innerWidth;
		docLeft = ctx.doc?.getBoundingClientRect().left ?? 0;
	}

	function go(e: Event, h: (typeof items)[number]) {
		e.preventDefault();
		if (h.id) ctx.scrollToAnchor(h.id, { smooth: true, push: true });
		else ctx.scrollToBlock(h.block, true);
		if (!sticky) closeSheet(false);
	}

	function closeSheet(restore = true) {
		if (!sheet) return false;
		sheet = false;
		if (restore) returnTo?.focus({ preventScroll: true });
		returnTo = null;
		return true;
	}

	async function openSheet() {
		returnTo = document.activeElement as HTMLElement | null;
		sheet = true;
		await tick();
		(nav?.querySelector<HTMLElement>('a[aria-current="true"]') ?? nav?.querySelector<HTMLElement>('a'))?.focus({ preventScroll: true });
	}

	function toggle() {
		if (sticky) {
			(nav?.querySelector<HTMLElement>('a[aria-current="true"]') ?? nav?.querySelector<HTMLElement>('a'))?.focus({ preventScroll: true });
		} else if (sheet) closeSheet();
		else void openSheet();
	}

	function onNavKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && sheet) { e.preventDefault(); closeSheet(); }
	}

	// scale changes the column width, so re-measure after Reader has applied the geometry
	$effect(() => {
		void $scale;
		requestAnimationFrame(() => requestAnimationFrame(measure));
	});

	onMount(() => {
		measure();
		ctx.toggleContents = toggle;
		const handler = () => closeSheet();
		ctx.closeStack.push(handler);
		window.addEventListener('resize', measure);
		const ro = ctx.doc ? new ResizeObserver(measure) : null;
		if (ctx.doc) ro?.observe(ctx.doc);
		return () => {
			window.removeEventListener('resize', measure);
			ro?.disconnect();
			if (ctx.toggleContents === toggle) ctx.toggleContents = undefined;
			const i = ctx.closeStack.indexOf(handler);
			if (i >= 0) ctx.closeStack.splice(i, 1);
		};
	});
</script>

{#snippet list()}
	<ol class="rc-toc-list">
		{#each items as h (h.block)}
			{@const active = h.block === activeBlock}
			<li class="rc-toc-item" data-level={h.level}>
				<a
					href={h.id ? `#${h.id}` : '#'}
					class="rc-toc-link"
					class:active
					aria-current={active ? 'true' : undefined}
					onclick={(e) => go(e, h)}
				>
					{#if h.level === 2}<span class="rc-toc-num" aria-hidden="true">{String(h2s.findIndex((x) => x.block === h.block) + 1).padStart(2, '0')}</span>{/if}
					<span>{h.text}</span>
				</a>
			</li>
		{/each}
	</ol>
{/snippet}

{#if items.length > 0}
	{#if sticky}
		<nav class="rc-toc" aria-label="Contents" style:width={`${room}px`} style:left={`${Math.max(16, docLeft - room - 24)}px`} bind:this={nav}>
			<div class="rc-toc-head">Contents</div>
			{@render list()}
		</nav>
	{:else if sheet}
		<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
		<div class="rc-scrim rc-toc-scrim" onclick={() => closeSheet()} transition:fade|global={{ duration: ctx.reduced() ? 0 : 140 }}></div>
		<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
		<nav class="rc-toc-sheet" aria-label="Contents" bind:this={nav} onkeydown={onNavKey} data-class={ctx.widthClass()}>
			<div class="rc-toc-head">
				<span>Contents</span>
				<button type="button" class="rc-btn" aria-label="Close contents" onclick={() => closeSheet()}>
					<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
				</button>
			</div>
			{@render list()}
		</nav>
	{/if}
{/if}
