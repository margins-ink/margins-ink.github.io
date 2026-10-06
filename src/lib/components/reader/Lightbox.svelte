<script lang="ts">
	// Image lightbox: dim overlay with the largest tier, FLIP from the block rect (instant under reduced motion), focus trap,
	// Esc or click closes, focus returns to the image button, alt text as the caption.
	import { onMount, tick } from 'svelte';
	import { INPUT } from '$lib/reading/abi';
	import { loadIndex } from '$lib/reading/load';
	import { getReaderCtx } from '$lib/reading/ctx';

	const ctx = getReaderCtx();
	const EASE = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
	const MS = 320;

	let open = $state(false);
	let closing = $state(false);
	let src = $state('');
	let alt = $state('');
	let fit = $state({ x: 0, y: 0, w: 0, h: 0 });
	let wrap = $state<HTMLElement>();
	let closeBtn = $state<HTMLButtonElement>();
	let source: { block: number; el: HTMLElement | null; rect: DOMRect } | null = null;
	let busy: Animation | null = null;

	async function urlFor(imageId: number): Promise<string> {
		const ix = await loadIndex();
		const im = ix.images?.find((i) => i.id === imageId);
		return im?.tiers[im.tiers.length - 1]?.url ?? '';
	}

	function computeFit(rect: DOMRect) {
		const vw = window.innerWidth, vh = window.innerHeight;
		const maxW = vw * 0.94, maxH = vh * 0.84;
		const ar = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1.5;
		let w = maxW, h = w / ar;
		if (h > maxH) { h = maxH; w = h * ar; }
		return { x: (vw - w) / 2, y: (vh - h) / 2 - vh * 0.02, w, h };
	}

	function flip(from: DOMRect, to: typeof fit, reverse: boolean): Animation | null {
		if (!wrap || ctx.reduced() || from.width <= 0) return null;
		const sx = from.width / to.w, sy = from.height / to.h;
		const dx = from.left - to.x, dy = from.top - to.y;
		const a = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`;
		const frames = reverse ? [{ transform: 'none' }, { transform: a }] : [{ transform: a }, { transform: 'none' }];
		return wrap.animate(frames, { duration: MS, easing: EASE, fill: 'both' });
	}

	async function openBox(block: number) {
		if (open) return;
		const el = ctx.layer?.blocks[block] ?? null;
		const btn = el?.querySelector<HTMLElement>('.image-btn') ?? null;
		if (!el || !btn) return;
		const id = Number(btn.dataset.image);
		const url = await urlFor(id);
		if (!url) return;
		source = { block, el: btn, rect: btn.getBoundingClientRect() };
		src = url;
		alt = btn.getAttribute('aria-label') ?? '';
		if (alt === 'Image') alt = '';
		fit = computeFit(source.rect);
		open = true;
		ctx.input(INPUT.open, block);
		if (ctx.scroller) ctx.scroller.inert = true;
		await tick();
		closeBtn?.focus({ preventScroll: true });
		busy = flip(source.rect, fit, false);
	}

	function done() {
		busy?.cancel();
		busy = null;
		open = false;
		closing = false;
		if (ctx.scroller) ctx.scroller.inert = false;
		ctx.input(INPUT.open, -1);
		const s = source;
		source = null;
		if (s?.el?.isConnected) s.el.focus({ preventScroll: true });
	}

	function close(): boolean {
		if (!open) return false;
		const s = source;
		closing = true;
		busy?.cancel();
		let a: Animation | null = null;
		if (s?.el?.isConnected) {
			const r = s.el.getBoundingClientRect();
			const inView = r.bottom > 0 && r.top < window.innerHeight;
			if (inView) a = flip(r, fit, true);
		}
		if (a) { busy = a; a.onfinish = done; }
		else done();
		return true;
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Escape') { e.preventDefault(); close(); }
		else if (e.key === 'Tab') { e.preventDefault(); closeBtn?.focus(); }
	}

	onMount(() => {
		ctx.openLightbox = (b: number) => { void openBox(b); };
		const handler = () => close();
		ctx.closeStack.push(handler);
		const onResize = () => { if (open && source) fit = computeFit(source.rect); };
		window.addEventListener('resize', onResize);
		return () => {
			window.removeEventListener('resize', onResize);
			ctx.openLightbox = undefined;
			const i = ctx.closeStack.indexOf(handler);
			if (i >= 0) ctx.closeStack.splice(i, 1);
			if (open && ctx.scroller) ctx.scroller.inert = false;
		};
	});
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events -->
	<div class="rc-lightbox" role="dialog" aria-modal="true" aria-label={alt || 'Image'} tabindex="-1" onkeydown={onKey} onclick={() => close()}>
		<div class="rc-lb-scrim" class:instant={ctx.reduced()} class:closing></div>
		<div
			class="rc-lb-img"
			bind:this={wrap}
			style:left={`${fit.x}px`}
			style:top={`${fit.y}px`}
			style:width={`${fit.w}px`}
			style:height={`${fit.h}px`}
		>
			<img {src} {alt} draggable="false" />
		</div>
		{#if alt}<p class="rc-lb-cap" style:top={`${fit.y + fit.h + 12}px`}>{alt}</p>{/if}
		<button bind:this={closeBtn} type="button" class="rc-btn rc-lb-close" aria-label="Close image" onclick={(e) => { e.stopPropagation(); close(); }}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
		</button>
	</div>
{/if}
