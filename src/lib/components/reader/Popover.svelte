<script lang="ts">
	// Citation popovers: hover (120 ms intent) or focus on a ref link whose target starts with #ref- shows a card with the
	// reference title and host. Esc closes. Refs come from the article's entry in the magazine index (`refs`).
	import { onMount } from 'svelte';
	import { LinkKind } from '$lib/magazine/format';
	import { loadIndex } from '$lib/reading/load';
	import { getReaderCtx } from '$lib/reading/ctx';

	interface Ref { id: string; title: string; url: string }

	const ctx = getReaderCtx();
	const OPEN_DELAY = 120;
	const CLOSE_DELAY = 160;

	let refs: Ref[] = [];
	let card = $state<HTMLElement>();
	let open = $state(false);
	let cur = $state<{ ref: Ref; anchor: HTMLElement } | null>(null);
	let pos = $state({ left: 0, top: 0, below: false });
	let openT: ReturnType<typeof setTimeout> | undefined;
	let closeT: ReturnType<typeof setTimeout> | undefined;

	const host = (u: string) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return u; } };

	function lookup(a: HTMLElement): Ref | null {
		if (Number(a.dataset.lk) !== LinkKind.ref) return null;
		const href = a.getAttribute('href') ?? '';
		if (!href.startsWith('#ref-')) return null;
		const id = decodeURIComponent(href.slice(1));
		const bare = id.replace(/^ref-/, '');
		return refs.find((r) => r.id === id || r.id === bare) ?? null;
	}

	function place(anchor: HTMLElement) {
		const r = anchor.getBoundingClientRect();
		const w = Math.min(320, window.innerWidth - 24);
		const left = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2));
		const below = r.top < 150;
		pos = { left, top: below ? r.bottom + 8 : r.top - 8, below };
	}

	function show(a: HTMLElement, immediate = false) {
		const ref = lookup(a);
		if (!ref) return;
		clearTimeout(closeT);
		if (cur?.anchor === a && open) return;
		clearTimeout(openT);
		const go = () => {
			hide(true);
			cur = { ref, anchor: a };
			place(a);
			open = true;
			a.setAttribute('aria-describedby', 'reader-popover');
		};
		if (immediate || open) go();
		else openT = setTimeout(go, OPEN_DELAY);
	}

	function hide(now = false) {
		clearTimeout(openT);
		clearTimeout(closeT);
		const run = () => {
			if (cur) cur.anchor.removeAttribute('aria-describedby');
			open = false;
		};
		if (now) run(); else closeT = setTimeout(run, CLOSE_DELAY);
	}

	const anchorOf = (t: EventTarget | null) => (t as HTMLElement | null)?.closest?.('a[data-lk]') as HTMLElement | null;

	onMount(() => {
		let dead = false;
		void loadIndex().then((ix) => {
			if (dead) return;
			const a = ix.articles.find((x) => x.slug === ctx.slug) as ({ refs?: Ref[] } | undefined);
			refs = a?.refs ?? [];
		}).catch(() => {});

		const doc = ctx.doc;
		const onOver = (e: Event) => { const a = anchorOf(e.target); if (a) show(a); };
		const onOut = (e: Event) => { if (anchorOf(e.target)) hide(); };
		const onFocus = (e: Event) => { const a = anchorOf(e.target); if (a) show(a, true); };
		const onBlur = (e: Event) => { if (anchorOf(e.target)) hide(true); };
		const onScroll = () => { if (open && cur) place(cur.anchor); };
		doc?.addEventListener('pointerover', onOver);
		doc?.addEventListener('pointerout', onOut);
		doc?.addEventListener('focusin', onFocus);
		doc?.addEventListener('focusout', onBlur);
		ctx.scroller?.addEventListener('scroll', onScroll, { passive: true });
		window.addEventListener('resize', onScroll);

		ctx.openPopover = (anchor: HTMLElement) => show(anchor, true);
		const handler = () => { if (!open) return false; hide(true); return true; };
		ctx.closeStack.push(handler);

		return () => {
			dead = true;
			clearTimeout(openT);
			clearTimeout(closeT);
			doc?.removeEventListener('pointerover', onOver);
			doc?.removeEventListener('pointerout', onOut);
			doc?.removeEventListener('focusin', onFocus);
			doc?.removeEventListener('focusout', onBlur);
			ctx.scroller?.removeEventListener('scroll', onScroll);
			window.removeEventListener('resize', onScroll);
			ctx.openPopover = undefined;
			const i = ctx.closeStack.indexOf(handler);
			if (i >= 0) ctx.closeStack.splice(i, 1);
		};
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
	id="reader-popover"
	class="rc-pop"
	class:open
	class:below={pos.below}
	role="group"
	aria-label="Reference"
	bind:this={card}
	style:left={`${pos.left}px`}
	style:top={`${pos.top}px`}
	onpointerenter={() => clearTimeout(closeT)}
	onpointerleave={() => hide()}
>
	{#if cur}
		<div class="rc-pop-title">{cur.ref.title}</div>
		<div class="rc-pop-foot">
			<span class="rc-pop-host">{host(cur.ref.url)}</span>
			<a class="rc-pop-open" href={cur.ref.url} target="_blank" rel="noopener noreferrer">Open</a>
		</div>
	{/if}
</div>
