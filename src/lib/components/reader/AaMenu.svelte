<script lang="ts">
	// Text-size menu opened by the Bar's Aa button: radio group over scaleSteps, plus "always show full text".
	import { onMount, tick } from 'svelte';
	import { scaleSteps } from '$lib/reading/metrics';
	import { getReaderCtx } from '$lib/reading/ctx';

	const ctx = getReaderCtx();
	const { scale, aaOpen } = ctx;

	let panel = $state<HTMLElement>();
	let alwaysFull = $state(false);
	try { alwaysFull = localStorage.getItem('reader:fold:all') === '1'; } catch { /* private mode */ }
	const hasFold = (ctx.model?.foldH ?? 0) > 0;

	const pct = (s: number) => `${Math.round(s * 100)} percent`;

	function close(restoreFocus = true) {
		if (!$aaOpen) return false;
		aaOpen.set(false);
		if (restoreFocus) document.getElementById('reader-aa-btn')?.focus({ preventScroll: true });
		return true;
	}

	function pick(i: number) {
		ctx.setScale(scaleSteps[Math.max(0, Math.min(scaleSteps.length - 1, i))]);
	}

	function onRadioKey(e: KeyboardEvent, i: number) {
		let n = i;
		if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = i + 1;
		else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = i - 1;
		else if (e.key === 'Home') n = 0;
		else if (e.key === 'End') n = scaleSteps.length - 1;
		else return;
		e.preventDefault();
		n = Math.max(0, Math.min(scaleSteps.length - 1, n));
		pick(n);
		panel?.querySelectorAll<HTMLElement>('[role=radio]')[n]?.focus();
	}

	function onPanelKey(e: KeyboardEvent) {
		if (e.key === 'Escape') { e.preventDefault(); close(); }
	}

	function setAlwaysFull(v: boolean) {
		alwaysFull = v;
		try { localStorage.setItem('reader:fold:all', v ? '1' : '0'); } catch { /* private mode */ }
		if (v) ctx.expandFold();
	}

	onMount(() => {
		const handler = () => close();
		ctx.closeStack.push(handler);
		const onDown = (e: PointerEvent) => {
			if (!$aaOpen) return;
			const t = e.target as Node;
			if (panel?.contains(t) || document.getElementById('reader-aa-btn')?.contains(t)) return;
			close(false);
		};
		document.addEventListener('pointerdown', onDown, true);
		return () => {
			document.removeEventListener('pointerdown', onDown, true);
			const i = ctx.closeStack.indexOf(handler);
			if (i >= 0) ctx.closeStack.splice(i, 1);
			aaOpen.set(false);
		};
	});

	// focus the current step when the menu opens
	$effect(() => {
		if (!$aaOpen) return;
		void tick().then(() => (panel?.querySelector<HTMLElement>('[role=radio][tabindex="0"]'))?.focus({ preventScroll: true }));
	});
</script>

{#if $aaOpen}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div class="rc-menu rc-aa-menu" id="reader-aa-menu" role="dialog" aria-label="Reading settings" bind:this={panel} onkeydown={onPanelKey}>
		<div class="rc-menu-label" id="reader-aa-label">Text size</div>
		<div class="rc-steps" role="radiogroup" aria-labelledby="reader-aa-label">
			{#each scaleSteps as s, i (s)}
				<button
					type="button"
					role="radio"
					class="rc-step"
					aria-checked={$scale === s}
					aria-label={pct(s)}
					tabindex={$scale === s ? 0 : -1}
					onclick={() => pick(i)}
					onkeydown={(e) => onRadioKey(e, i)}
				><span aria-hidden="true" style:font-size={`${Math.round(11 + i * 3)}px`}>A</span></button>
			{/each}
		</div>
		{#if hasFold}
			<label class="rc-check">
				<input type="checkbox" checked={alwaysFull} onchange={(e) => setAlwaysFull(e.currentTarget.checked)} />
				<span>Always show full text</span>
			</label>
		{/if}
	</div>
{/if}
