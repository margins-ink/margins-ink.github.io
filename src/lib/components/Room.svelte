<script lang="ts">
	import { thoughts } from '$lib/thoughts';
	import { createRoom, type Floor, type Hotspot } from '$lib/gpu/room/room';

	let { live = $bindable(false) }: { live?: boolean } = $props();

	let canvas = $state<HTMLCanvasElement>();
	let world = $state<HTMLElement>();
	let failed = $state(false);
	let spots = $state<Hotspot[]>([]);
	let floors = $state<Floor[]>([]);
	let progress = $state(0);

	const titleOf = (id: string) => thoughts.find((t) => t.slug === id)?.title ?? id;
	const hrefOf = (id: string) => thoughts.find((t) => t.slug === id)?.route ?? '/';
	const floorCount = $derived(Math.max(floors.length, 1));
	const current = $derived(Math.round(progress * (floorCount - 1)));

	let room: Awaited<ReturnType<typeof createRoom>> = null;

	$effect(() => {
		if (!canvas) return;
		let cancelled = false;
		createRoom(canvas, thoughts, (s) => (spots = s)).then((r) => {
			if (cancelled) return r?.destroy();
			room = r;
			failed = r === null;
			live = r !== null;
			floors = r?.floors ?? [];
			onscroll();
		});
		return () => {
			cancelled = true;
			room?.destroy();
			room = null;
			live = false;
		};
	});

	function onscroll() {
		if (!world) return;
		const r = world.getBoundingClientRect();
		const span = Math.max(1, r.height - innerHeight);
		progress = Math.min(1, Math.max(0, -r.top / span));
		room?.setProgress(progress);
	}

	const ndc = (e: { clientX: number; clientY: number }) => {
		const r = canvas!.getBoundingClientRect();
		return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
	};

	// Trackpad pinch: Chrome/Firefox send wheel+ctrlKey, Safari sends gesture events.
	$effect(() => {
		const el = canvas;
		if (!el) return;
		const onwheel = (e: WheelEvent) => {
			if (!room) return;
			if (!e.ctrlKey) {
				// two-finger pan: while zoomed in, the scene moves instead of the page
				if (room.zoom <= 1.01) return;
				e.preventDefault();
				const r = el.getBoundingClientRect();
				room.panBy((-e.deltaX / r.width) * 2, (e.deltaY / r.height) * 2);
				return;
			}
			e.preventDefault();
			const [nx, ny] = ndc(e);
			room.zoomAt(Math.exp(-e.deltaY * 0.01), nx, ny);
		};
		let last = 1;
		const gs = (e: Event) => {
			e.preventDefault();
			last = 1;
		};
		const gc = (e: Event) => {
			e.preventDefault();
			const g = e as unknown as { scale: number; clientX: number; clientY: number };
			const [nx, ny] = ndc(g);
			room?.zoomAt(g.scale / last, nx, ny);
			last = g.scale;
		};
		// two-finger touch pinch and drag-to-pan when zoomed
		const pts = new Map<number, { x: number; y: number }>();
		let dist = 0;
		const down = (e: PointerEvent) => {
			pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pts.size === 2) {
				const [a, b] = [...pts.values()];
				dist = Math.hypot(a.x - b.x, a.y - b.y);
			}
		};
		const move = (e: PointerEvent) => {
			const p = pts.get(e.pointerId);
			if (!p || !room) return;
			const r = el.getBoundingClientRect();
			const dx = e.clientX - p.x;
			const dy = e.clientY - p.y;
			p.x = e.clientX;
			p.y = e.clientY;
			if (pts.size === 2) {
				const [a, b] = [...pts.values()];
				const d = Math.hypot(a.x - b.x, a.y - b.y);
				const [nx, ny] = ndc({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
				if (dist > 0) room.zoomAt(d / dist, nx, ny);
				dist = d;
			} else if (room.zoom > 1.01 && e.pointerType === 'mouse') {
				room.panBy((dx / r.width) * 2, -(dy / r.height) * 2);
			}
		};
		const up = (e: PointerEvent) => {
			pts.delete(e.pointerId);
			dist = 0;
		};
		const dbl = () => room?.resetView();
		el.addEventListener('wheel', onwheel, { passive: false });
		el.addEventListener('gesturestart', gs);
		el.addEventListener('gesturechange', gc);
		el.addEventListener('pointerdown', down);
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
		el.addEventListener('dblclick', dbl);
		return () => {
			el.removeEventListener('wheel', onwheel);
			el.removeEventListener('gesturestart', gs);
			el.removeEventListener('gesturechange', gc);
			el.removeEventListener('pointerdown', down);
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
			el.removeEventListener('dblclick', dbl);
		};
	});

	function go(k: number) {
		if (!world) return;
		const span = world.offsetHeight - innerHeight;
		const top = world.getBoundingClientRect().top + scrollY;
		scrollTo({ top: top + (k / Math.max(1, floorCount - 1)) * span, behavior: 'smooth' });
	}
</script>

<svelte:window {onscroll} />

<section
	class="world"
	class:failed
	bind:this={world}
	style:height="{Math.max(floorCount, 1) * 90 + 10}svh"
>
	<div class="stage">
		<canvas bind:this={canvas} aria-hidden="true"></canvas>
		{#if live}
			{#each spots as s (s.id)}
				<a
					class="spot"
					href={hrefOf(s.id)}
					aria-label={titleOf(s.id)}
					style:left="{s.x}px"
					style:top="{s.y}px"
					style:width="{s.w}px"
					style:height="{s.h}px"
				></a>
			{/each}
			<nav class="panel" aria-label="Floors">
				{#each floors as f, k}
					<button class:on={k === current} onclick={() => go(k)} aria-label={f.title}>
						<span class="n">{f.label}</span>
					</button>
				{/each}
			</nav>
		{/if}
	</div>
</section>

<style>
	.world {
		position: relative;
		width: 100vw;
		margin-left: calc(50% - 50vw);
		background: #1a1612;
	}
	.stage {
		position: sticky;
		top: 0;
		height: 100svh;
		overflow: hidden;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		touch-action: pan-y;
	}
	.spot {
		position: absolute;
		display: block;
		cursor: pointer;
	}
	.spot:focus-visible {
		outline: 2px solid #fff;
		outline-offset: 2px;
	}
	.panel {
		position: absolute;
		right: 1.25rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem;
		background: rgba(20, 17, 14, 0.38);
		backdrop-filter: blur(14px) saturate(1.3);
		-webkit-backdrop-filter: blur(14px) saturate(1.3);
		border: 1px solid rgba(233, 217, 179, 0.28);
		border-radius: 6px;
	}
	.panel button {
		min-width: 3.4rem;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: 1rem;
		border: 1px solid rgba(233, 217, 179, 0.35);
		background: rgba(35, 26, 18, 0.35);
		color: #f3e7c6;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		cursor: pointer;
	}
	.panel button.on {
		background: rgba(233, 217, 179, 0.85);
		color: #231a12;
		box-shadow: 0 0 10px rgba(233, 217, 179, 0.6);
	}
	.world.failed {
		display: none;
	}
</style>
