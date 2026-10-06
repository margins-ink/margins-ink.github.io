<script lang="ts">
	// Control strip inside each interactive figure (play and pause, step, scrub slider, focus mode), the figure keyboard
	// (Left and Right step 0.25 s, Space plays or pauses, Home returns to the poster) and F for focus mode.
	// Strips are moved into the figure's element, so they sit with the figure and follow it on scroll.
	import { onMount } from 'svelte';
	import { get } from 'svelte/store';
	import { FigureMode } from '$lib/magazine/format';
	import { INPUT, RD, MAX_FIG_STATE } from '$lib/reading/abi';
	import { getReaderCtx } from '$lib/reading/ctx';

	const ctx = getReaderCtx();
	const model = ctx.model;
	const STEP = 0.25;

	interface Fig { i: number; block: number; mode: number; duration: number; poster: number; el: HTMLElement }
	const figs: Fig[] = [];
	if (model) {
		model.figures.forEach((f, i) => {
			const el = ctx.layer?.blocks[f.block];
			if (!el || f.mode === FigureMode.static || i >= MAX_FIG_STATE) return;
			figs.push({ i, block: f.block, mode: f.mode, duration: f.duration, poster: f.poster, el });
		});
	}

	let t = $state<number[]>([]);
	let playing = $state<boolean[]>([]);
	let focusFig = $state(-1); // block index of the figure in focus mode
	const scrubbing = new Set<number>();
	const timers = new Map<number, ReturnType<typeof setTimeout>>();
	let dragging = false;

	function into(node: HTMLElement, target: HTMLElement) {
		target.append(node);
		return { destroy() { node.remove(); } };
	}

	const byIndex = (i: number) => figs.find((f) => f.i === i);
	const byBlock = (b: number) => figs.find((f) => f.block === b);

	function beginScrub(i: number) { if (!scrubbing.has(i)) { scrubbing.add(i); ctx.input(INPUT.scrubBegin, i); } }
	function endScrub(i: number) {
		clearTimeout(timers.get(i));
		if (scrubbing.delete(i)) ctx.input(INPUT.scrubEnd, i, 0);
	}
	function scrubTo(f: Fig, v: number) {
		beginScrub(f.i);
		ctx.input(INPUT.scrubTo, f.i, Math.max(0, Math.min(f.duration, v)));
		clearTimeout(timers.get(f.i));
		if (!dragging) timers.set(f.i, setTimeout(() => endScrub(f.i), 320));
	}

	function toggle(f: Fig) {
		if (f.mode === FigureMode.once && !playing[f.i] && t[f.i] >= f.duration - 0.02) {
			ctx.input(INPUT.figureHome, f.i);
			ctx.input(INPUT.figurePlay, f.i, 1);
		} else ctx.input(INPUT.figurePlay, f.i, playing[f.i] ? 0 : 1);
	}
	const step = (f: Fig, d: number) => ctx.input(INPUT.figureStep, f.i, d);

	function setFocus(block: number) {
		focusFig = block;
		const root = ctx.root;
		if (root) {
			if (block >= 0) root.setAttribute('data-focus', 'fig'); else root.removeAttribute('data-focus');
		}
		for (const f of figs) f.el.classList.toggle('rc-focus', f.block === block);
		ctx.input(INPUT.open, block);
		if (block >= 0) ctx.scrollToBlock(block, !ctx.reduced());
	}

	function currentFigure(): Fig | undefined {
		return byBlock(get(ctx.focusBlock)) ?? byBlock(get(ctx.hoverBlock));
	}

	function onKey(e: KeyboardEvent) {
		if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
		const tg = e.target as HTMLElement | null;
		if (e.key.toLowerCase() === 'f') {
			if (tg?.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]')) return;
			const f = focusFig >= 0 ? byBlock(focusFig) : currentFigure();
			if (!f) return;
			e.preventDefault();
			setFocus(focusFig === f.block ? -1 : f.block);
			return;
		}
		// keys acting on a focused figure element itself (not on its buttons or slider)
		const f = figs.find((x) => x.el === tg);
		if (!f) return;
		if (e.key === 'ArrowLeft') { e.preventDefault(); step(f, -STEP); }
		else if (e.key === 'ArrowRight') { e.preventDefault(); step(f, STEP); }
		else if (e.key === 'Home') { e.preventDefault(); ctx.input(INPUT.figureHome, f.i); }
		else if (e.key === ' ' && f.mode !== FigureMode.scrub) { e.preventDefault(); toggle(f); }
	}

	function onSliderKey(e: KeyboardEvent) {
		if (e.key === 'Escape' && focusFig >= 0) { e.preventDefault(); setFocus(-1); }
	}

	onMount(() => {
		const doc = ctx.doc;
		const hovers: [Fig, (e: PointerEvent) => void, () => void][] = [];
		for (const f of figs) {
			const move = (e: PointerEvent) => {
				if (f.mode !== FigureMode.scrub || e.pointerType === 'touch') return;
				if ((e.target as HTMLElement).closest('.rc-fig')) return;
				const r = f.el.getBoundingClientRect();
				if (r.width <= 0) return;
				scrubTo(f, ((e.clientX - r.left) / r.width) * f.duration);
			};
			const leave = () => { endScrub(f.i); };
			f.el.addEventListener('pointermove', move);
			f.el.addEventListener('pointerleave', leave);
			hovers.push([f, move, leave]);
		}
		document.addEventListener('keydown', onKey);
		const handler = () => { if (focusFig < 0) return false; setFocus(-1); return true; };
		ctx.closeStack.push(handler);
		const up = () => { if (dragging) { dragging = false; for (const i of [...scrubbing]) endScrub(i); } };
		window.addEventListener('pointerup', up);

		// read figure clocks while any figure is on screen; update state only on change
		let raf = 0;
		let last = 0;
		const prev: number[] = [];
		const loop = (now: number) => {
			raf = requestAnimationFrame(loop);
			const rd = ctx.reading;
			if (!rd || now - last < 50) return;
			last = now;
			const st = rd.state();
			for (const f of figs) {
				if (st[RD.figBase + 2 * f.i + 1] === 0) continue;
				const v = st[RD.figBase + 2 * f.i];
				const moved = Math.abs(v - (prev[f.i] ?? v)) > 1e-4;
				prev[f.i] = v;
				if (Math.abs(v - (t[f.i] ?? -1)) > 0.005) t[f.i] = v;
				if ((playing[f.i] ?? false) !== moved) playing[f.i] = moved;
			}
		};
		raf = requestAnimationFrame(loop);

		return () => {
			cancelAnimationFrame(raf);
			document.removeEventListener('keydown', onKey);
			window.removeEventListener('pointerup', up);
			for (const [f, m, l] of hovers) { f.el.removeEventListener('pointermove', m); f.el.removeEventListener('pointerleave', l); f.el.classList.remove('rc-focus'); }
			for (const i of [...scrubbing]) endScrub(i);
			for (const tm of timers.values()) clearTimeout(tm);
			const i = ctx.closeStack.indexOf(handler);
			if (i >= 0) ctx.closeStack.splice(i, 1);
			ctx.root?.removeAttribute('data-focus');
		};
	});

	const fmt = (v: number | undefined) => (v ?? 0).toFixed(1);
</script>

{#each figs as f (f.i)}
	{@const v = t[f.i] ?? f.poster}
	<div class="rc-fig" use:into={f.el} role="group" aria-label="Figure controls" data-mode={f.mode}>
		{#if f.mode !== FigureMode.scrub}
			<button
				type="button"
				class="rc-btn"
				aria-label={playing[f.i] ? 'Pause figure' : 'Play figure'}
				onclick={() => toggle(f)}
			>
				{#if playing[f.i]}
					<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><rect x="4" y="3" width="3" height="10" rx="0.8" /><rect x="9" y="3" width="3" height="10" rx="0.8" /></svg>
				{:else}
					<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M5 3.2v9.6a.6.6 0 0 0 .9.5l7.4-4.8a.6.6 0 0 0 0-1L5.9 2.7a.6.6 0 0 0-.9.5z" /></svg>
				{/if}
			</button>
		{/if}
		<button type="button" class="rc-btn" aria-label="Step back 0.25 seconds" onclick={() => step(f, -STEP)}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M10 3.5L5.5 8l4.5 4.5" /></svg>
		</button>
		{#if f.mode === FigureMode.scrub}
			<input
				class="rc-scrub"
				type="range"
				min="0"
				max={f.duration}
				step="0.01"
				value={v}
				aria-label="Scrub figure"
				aria-valuetext={`${fmt(v)} of ${fmt(f.duration)} seconds`}
				onpointerdown={() => { dragging = true; }}
				oninput={(e) => scrubTo(f, e.currentTarget.valueAsNumber)}
				onkeydown={onSliderKey}
			/>
		{/if}
		<button type="button" class="rc-btn" aria-label="Step forward 0.25 seconds" onclick={() => step(f, STEP)}>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5L10.5 8 6 12.5" /></svg>
		</button>
		<button
			type="button"
			class="rc-btn"
			aria-label="Focus mode"
			aria-pressed={focusFig === f.block}
			onclick={() => setFocus(focusFig === f.block ? -1 : f.block)}
		>
			<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /></svg>
		</button>
	</div>
{/each}
