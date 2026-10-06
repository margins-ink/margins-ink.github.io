<script lang="ts">
	import { createAudio } from '$lib/audio';
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { thoughts, thoughtBySlug } from '$lib/thoughts';
	import { createRoom, type Room } from '$lib/gpu/room/room';
	import Reader from './Reader.svelte';
	import { worldState as ws } from '$lib/world.svelte';

	const audio = createAudio();
	let canvas = $state<HTMLCanvasElement>();
	let room = $state.raw<Room | null>(null);

	// The URL is the source of truth: /thoughts/<slug> is the reading state, everything else is the shelf.
	const slug = $derived.by(() => {
		const m = /^\/thoughts\/([^/]+)\/?$/.exec(page.url.pathname);
		return m && thoughtBySlug(m[1]) ? m[1] : null;
	});
	const reading = $derived(slug !== null);
	$effect(() => {
		ws.reading = slug;
	});

	const titleOf = (id: string) => thoughts.find((t) => t.slug === id)?.title ?? id;
	const hrefOf = (id: string) => thoughts.find((t) => t.slug === id)?.route ?? '/';
	const floorCount = $derived(Math.max(ws.floors.length, 1));
	const current = $derived(Math.round(ws.progress * (floorCount - 1)));

	let cold = true;
	$effect(() => {
		if (!canvas) return;
		let cancelled = false;
		createRoom(canvas, thoughts, (s) => {
			ws.spots = s;
		})
			.then((r) => {
				if (cancelled) return r?.destroy();
				room = r;
				ws.failed = r === null;
				ws.live = r !== null;
				if (!r) {
					console.error('world: createRoom returned null, the room is not live (see the room: error above)');
					delete document.documentElement.dataset.gpu;
				}
				ws.floors = r?.floors ?? [];
				if (r) r.setAudio(audio);
				r?.onReader((e) => {
					if (e.kind === 'opened') bookOpen = true;
					else if (e.kind === 'closed') bookOpen = false;
					else if (e.kind === 'sound') {
						// book.rs: arg = id << 8 | velocity 0..255; ids 0 grab, 1 whoosh (scroll), 2 paperTurn, 3 open, 4 close, 5 place
						const kinds = ['grab', 'scroll', 'paperTurn', 'open', 'close', 'place'] as const;
						const k = kinds[(e.arg >> 8) & 255];
						if (k) audio.event(k, (e.arg & 255) / 255);
					}
				});
				onscroll();
			})
			.catch((e) => {
				console.error('world:', e);
				ws.failed = true;
				delete document.documentElement.dataset.gpu;
			});
		return () => {
			cancelled = true;
			room?.destroy();
			room = null;
			ws.live = false;
		};
	});

	// route -> world. A cold load of /thoughts/<slug> snaps into the reading pose; later changes fly.
	$effect(() => {
		const r = room;
		const s = slug;
		if (!r) return;
		r.setReading(s, { snap: cold && s !== null });
		// reading pins the cab to its floor with the doors open
		r.hold(s !== null);
		cold = false;
		if (s === null) void restoreShelf();
	});
	/** the book finished opening: the page (Reader, same scene dimmed behind it) takes over */
	let bookOpen = $state(false);

	let canGoBack = $state(false);
	afterNavigate(({ from }) => {
		canGoBack = from !== null;
	});
	function close() {
		if (canGoBack) history.back();
		else void goto('/');
	}

	/** Landing scroll maps to the elevator; after an article closes put the scroll bar back where the elevator is. */
	async function restoreShelf() {
		await tick();
		const sp = document.getElementById('world-spacer');
		if (!sp) return;
		const span = Math.max(1, sp.offsetHeight - innerHeight);
		const want = ws.progress * span;
		if (Math.abs(scrollY - want) > 2) scrollTo({ top: sp.getBoundingClientRect().top + scrollY + want });
	}
	function onscroll() {
		if (reading) return;
		const sp = document.getElementById('world-spacer');
		if (!sp) return;
		const r = sp.getBoundingClientRect();
		const span = Math.max(1, r.height - innerHeight);
		ws.progress = Math.min(1, Math.max(0, -r.top / span));
		room?.setProgress(ws.progress);
	}
	function go(k: number) {
		const sp = document.getElementById('world-spacer');
		if (!sp) return;
		const span = sp.offsetHeight - innerHeight;
		scrollTo({ top: sp.getBoundingClientRect().top + scrollY + (k / Math.max(1, floorCount - 1)) * span, behavior: 'smooth' });
	}

	const ndc = (e: { clientX: number; clientY: number }) => {
		const r = canvas!.getBoundingClientRect();
		return [((e.clientX - r.left) / r.width) * 2 - 1, 1 - ((e.clientY - r.top) / r.height) * 2];
	};

	// shelf: wheel pan while zoomed, pinch and ctrl-wheel zoom. Reading is the Reader's native scroller, not the canvas.
	$effect(() => {
		const el = canvas;
		if (!el) return;
		const onwheel = (e: WheelEvent) => {
			if (!room || reading) return;
			if (!e.ctrlKey) {
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
		const pts = new Map<number, { x: number; y: number }>();
		let dist = 0;
		const down = (e: PointerEvent) => {
			void audio.resume();
			pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pts.size === 2) {
				const [a, b] = [...pts.values()];
				dist = Math.hypot(a.x - b.x, a.y - b.y);
			}
		};
		const move = (e: PointerEvent) => {
			const p = pts.get(e.pointerId);
			if (!room || !p) return;
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
			} else if (room.zoom > 1.01 && e.pointerType !== 'mouse') room.panBy((dx / r.width) * 2, -(dy / r.height) * 2);
		};
		const up = (e: PointerEvent) => {
			pts.delete(e.pointerId);
			dist = 0;
		};
		el.addEventListener('wheel', onwheel, { passive: false });
		el.addEventListener('gesturestart', gs);
		el.addEventListener('gesturechange', gc);
		el.addEventListener('pointerdown', down);
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
		el.addEventListener('dblclick', () => room?.resetView());
		return () => {
			el.removeEventListener('wheel', onwheel);
			el.removeEventListener('gesturestart', gs);
			el.removeEventListener('gesturechange', gc);
			el.removeEventListener('pointerdown', down);
			el.removeEventListener('pointermove', move);
			el.removeEventListener('pointerup', up);
			el.removeEventListener('pointercancel', up);
		};
	});
</script>

<svelte:window {onscroll} />

<div class="stage" class:live={ws.live} class:reading>
	<canvas bind:this={canvas} aria-hidden="true"></canvas>
	{#if ws.live && !reading}
		{#each ws.spots as s (s.id)}
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
	{/if}
</div>
{#if reading && slug && room && bookOpen}
	{#key slug}
		<Reader mode="world" {slug} fromWorld={canGoBack} reading={room.page} onClose={close} />
	{/key}
{/if}

<style>
	:global(html[data-gpu]) {
		background: #1a1612;
		scrollbar-width: none;
	}
	:global(html[data-gpu]::-webkit-scrollbar) {
		display: none;
	}
	.stage {
		position: fixed;
		inset: 0;
		z-index: 0;
		overflow: hidden;
		background: #1a1612;
		visibility: hidden;
	}
	.stage.live {
		visibility: visible;
	}
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		touch-action: pan-y;
	}
	.reading canvas {
		touch-action: none;
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
</style>
