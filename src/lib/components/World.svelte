<script lang="ts">
	import { page } from '$app/state';
	import { afterNavigate, goto } from '$app/navigation';
	import { tick } from 'svelte';
	import { thoughts, thoughtBySlug } from '$lib/thoughts';
	import { createRoom, type Room, type LinkHit } from '$lib/gpu/room/room';
	import { worldState as ws } from '$lib/world.svelte';

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
				if (!r) delete document.documentElement.dataset.gpu;
				ws.floors = r?.floors ?? [];
				r?.onReader((e) => {
					if (e.kind === 'page') ws.page = e.arg;
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
		cold = false;
		if (s === null) void restoreShelf();
	});
	$effect(() => {
		ws.pages = room?.reading.pages ?? 0;
	});

	let canGoBack = false;
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

	function follow(l: LinkHit) {
		if (l.kind === 0) window.open(l.target, '_blank', 'noopener');
		else if (l.kind === 1 || l.kind === 2) room?.scrollToAnchor(l.target);
		else void goto(l.target);
	}

	// wheel, pinch, touch scroll, mouse hover and click
	$effect(() => {
		const el = canvas;
		if (!el) return;
		const onwheel = (e: WheelEvent) => {
			if (!room) return;
			if (!e.ctrlKey) {
				if (reading) {
					e.preventDefault();
					const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1;
					room.scrollByPx(e.deltaY * k);
					return;
				}
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
		const pts = new Map<number, { x: number; y: number }>();
		let dist = 0;
		let moved = 0;
		let samples: { t: number; y: number }[] = [];
		const down = (e: PointerEvent) => {
			pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			moved = 0;
			samples = [{ t: e.timeStamp, y: e.clientY }];
			if (pts.size === 2) {
				const [a, b] = [...pts.values()];
				dist = Math.hypot(a.x - b.x, a.y - b.y);
			}
		};
		const move = (e: PointerEvent) => {
			const p = pts.get(e.pointerId);
			if (!room) return;
			if (!p) {
				if (reading && e.pointerType === 'mouse') {
					const [nx, ny] = ndc(e);
					el.style.cursor = room.hoverAt(nx, ny)?.link ? 'pointer' : '';
				}
				return;
			}
			const r = el.getBoundingClientRect();
			const dx = e.clientX - p.x;
			const dy = e.clientY - p.y;
			p.x = e.clientX;
			p.y = e.clientY;
			moved += Math.abs(dx) + Math.abs(dy);
			if (pts.size === 2) {
				const [a, b] = [...pts.values()];
				const d = Math.hypot(a.x - b.x, a.y - b.y);
				const [nx, ny] = ndc({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
				if (dist > 0) room.zoomAt(d / dist, nx, ny);
				dist = d;
			} else if (e.pointerType === 'touch' && reading) {
				room.scrollByPx(-dy);
				samples.push({ t: e.timeStamp, y: e.clientY });
				samples = samples.filter((s) => e.timeStamp - s.t < 80);
			} else if (room.zoom > 1.01 && e.pointerType === 'mouse') {
				room.panBy((dx / r.width) * 2, -(dy / r.height) * 2);
			}
		};
		const up = (e: PointerEvent) => {
			if (e.pointerType === 'touch' && reading && pts.size === 1 && samples.length > 1) {
				const a = samples[0];
				const b = samples[samples.length - 1];
				if (b.t > a.t) room?.flingPx((-(b.y - a.y) / (b.t - a.t)) * 1000);
			}
			if (e.type === 'pointerup' && reading && room && moved < 6 && pts.size === 1) {
				const [nx, ny] = ndc(e);
				const h = room.hoverAt(nx, ny);
				if (h?.link) follow(h.link);
				else if (!h) close();
			}
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

	function onkeydown(e: KeyboardEvent) {
		if (!reading || !room || e.metaKey || e.ctrlKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(input|textarea|select)$/i.test(t.tagName))) return;
		const vh = innerHeight;
		const step: Record<string, number> = { ArrowDown: 60, ArrowUp: -60, PageDown: vh * 0.9, PageUp: -vh * 0.9, ' ': e.shiftKey ? -vh * 0.9 : vh * 0.9 };
		if (e.key === 'Escape') {
			e.preventDefault();
			close();
		} else if (e.key in step) {
			e.preventDefault();
			room.scrollByPx(step[e.key]);
		} else if (e.key === 'Home' || e.key === 'End') {
			e.preventDefault();
			room.scrollByPx(e.key === 'Home' ? -1e6 : 1e6);
		}
	}
</script>

<svelte:window {onscroll} {onkeydown} />

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
		<nav class="panel" aria-label="Floors">
			{#each ws.floors as f, k}
				<button class:on={k === current} onclick={() => go(k)} aria-label={f.title}>
					<span class="n">{f.label}</span>
				</button>
			{/each}
		</nav>
	{/if}
</div>
{#if reading && ws.live}
	<a class="back" href="/" onclick={(e) => (e.preventDefault(), close())}>Back to the shelf</a>
{/if}

<style>
	:global(html[data-gpu]) {
		background: #1a1612;
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
	.panel {
		position: absolute;
		right: 1.25rem;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.6rem;
		background: #14110e;
		border: 1px solid #5a4a33;
		border-radius: 6px;
	}
	.panel button {
		min-width: 3.4rem;
		height: 2rem;
		padding: 0 0.5rem;
		border-radius: 1rem;
		border: 1px solid #8a7550;
		background: #231a12;
		color: #e9d9b3;
		font-family: var(--font-mono);
		font-size: 0.72rem;
		cursor: pointer;
	}
	.panel button.on {
		background: #e9d9b3;
		color: #231a12;
		box-shadow: 0 0 10px rgba(233, 217, 179, 0.6);
	}
	/* keyboard users reach the close control; it is not drawn until focused */
	.back {
		position: fixed;
		left: 1rem;
		top: 1rem;
		z-index: 2;
		padding: 0.4rem 0.8rem;
		border-radius: 1rem;
		background: #e9d9b3;
		color: #231a12;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		clip-path: inset(50%);
		width: 1px;
		height: 1px;
		overflow: hidden;
	}
	.back:focus {
		clip-path: none;
		width: auto;
		height: auto;
	}
</style>
