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
	/** keyboard-selected shelf book (index into ws.spots), -1 none */
	let kbSpot = -1;
	/** the shelf book the Flecs hover spring is on (slug), pointer first, keyboard selection when the pointer is on no book */
	let hoverId: string | null = null;
	function setHover(id: string | null) {
		if (id === hoverId) return;
		hoverId = id;
		room?.setHover(id);
	}
	const kbId = () => (kbSpot >= 0 ? (ws.spots[Math.min(kbSpot, ws.spots.length - 1)]?.id ?? null) : null);

	// The URL is the source of truth: /thoughts/<slug> is the reading state, everything else is the shelf.
	const slug = $derived.by(() => {
		const m = /^\/thoughts\/([^/]+)\/?$/.exec(page.url.pathname);
		return m && thoughtBySlug(m[1]) ? m[1] : null;
	});
	const reading = $derived(slug !== null);
	$effect(() => {
		ws.reading = slug;
		if (slug !== null) setHover(null);
	});

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
					window.__gpuError?.();
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
				window.__gpuError?.();
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
	// Touch has no hover: once per session, 2 s after the landing page settles, the newest book opens and closes its cover once, slowly.
	// Any input (pointer, key, wheel, touch, scroll) cancels it. Desktop dev can force it with ?nudge.
	$effect(() => {
		const r = room;
		if (!r || reading || sessionStorage.getItem('nudged')) return;
		if (!matchMedia('(hover: none)').matches && !(import.meta.env.DEV && new URLSearchParams(location.search).has('nudge'))) return;
		let started = false;
		let timer = 0;
		const stop = () => {
			clearTimeout(timer);
			if (started) r.nudge(null);
			for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) removeEventListener(t, stop, true);
		};
		// the shelf's hit regions appear once the cab doors are open: poll for them for up to 12 s after the 2 s idle
		const t0 = performance.now();
		const fire = () => {
			const newest = [...thoughts].sort((a, b) => b.date.localeCompare(a.date)).find((t) => ws.spots.some((s) => s.id === t.slug));
			if (newest && ws.progress <= 0.02) {
				started = true;
				sessionStorage.setItem('nudged', '1');
				r.nudge(newest.slug);
			} else if (performance.now() - t0 < 14000 && ws.progress <= 0.02) timer = window.setTimeout(fire, 300);
		};
		timer = window.setTimeout(fire, 2000);
		for (const t of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) addEventListener(t, stop, { capture: true, passive: true });
		return stop;
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

	/** Send the cab to floor k at once (the page scroll is the elevator's input; the detents settle on k). */
	function goFloor(k: number) {
		const sp = document.getElementById('world-spacer');
		if (!sp) return;
		const span = Math.max(1, sp.offsetHeight - innerHeight);
		scrollTo({ top: sp.getBoundingClientRect().top + scrollY + (k / Math.max(1, floorCount - 1)) * span, behavior: 'instant' });
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
		// the scrollbar (GPU-drawn, gpu/room/rail.ts): thumb drag moves the cab continuously, release snaps to the nearest floor,
		// a tick sends the cab to that floor, the track pages
		let railPtr = -1;
		let swallow = false;
		const spacerTo = (y: number, behavior: ScrollBehavior) => {
			const sp = document.getElementById('world-spacer');
			if (sp) scrollTo({ top: sp.getBoundingClientRect().top + scrollY + y, behavior });
		};
		const local = (e: PointerEvent) => {
			const r = el.getBoundingClientRect();
			return { x: e.clientX - r.left, y: e.clientY - r.top };
		};
		const railDown = (e: PointerEvent) => {
			if (reading || !room || e.button !== 0) return false;
			const p = local(e);
			const h = room.rail.down(p.x, p.y);
			if (!h) return false;
			swallow = true;
			e.preventDefault();
			if (h.kind === 'thumb') {
				railPtr = e.pointerId;
				el.setPointerCapture(e.pointerId);
			} else if (h.kind === 'tick') spacerTo(room.rail.floorScroll(h.floor), 'instant');
			else spacerTo(h.scrollY, 'smooth');
			return true;
		};
		const down = (e: PointerEvent) => {
			if (railDown(e)) return;
			void audio.resume();
			pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
			if (pts.size === 2) {
				const [a, b] = [...pts.values()];
				dist = Math.hypot(a.x - b.x, a.y - b.y);
			}
		};
		const move = (e: PointerEvent) => {
			if (room && !reading) {
				const lp = local(e);
				if (e.pointerId === railPtr) {
					const sy = room.rail.drag(lp.y);
					if (sy !== null) spacerTo(sy, 'instant');
					return;
				}
				if (e.pointerType === 'mouse') room.rail.hover(lp);
			}
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
			if (e.pointerId === railPtr) {
				railPtr = -1;
				const sy = room?.rail.up();
				if (sy != null) spacerTo(sy, 'smooth');
				return;
			}
			pts.delete(e.pointerId);
			dist = 0;
		};
		// shelf books are hit regions of the canvas, not DOM links: click opens, the pointer shows where, Tab/arrows/Enter do the same by keyboard
		const spotAt = (e: { clientX: number; clientY: number }) => {
			if (reading) return undefined;
			const r = el.getBoundingClientRect();
			const x = e.clientX - r.left;
			const y = e.clientY - r.top;
			return ws.spots.find((s) => x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h);
		};
		const click = (e: MouseEvent) => {
			if (swallow) {
				swallow = false;
				return;
			}
			if (!reading && room && room.zoomLevel > 0.5) {
				// zoomed out: a floor of the cross-section is a hit region, the cab goes there
				const [nx, ny] = ndc(e);
				const k = room.floorAt(nx, ny);
				if (k >= 0) goFloor(k);
				return;
			}
			const s = spotAt(e);
			if (s) void goto(hrefOf(s.id));
		};
		const hover = (e: PointerEvent) => {
			const s = e.pointerType === 'mouse' ? spotAt(e) : undefined;
			el.style.cursor = s ? 'pointer' : '';
			if (e.pointerType === 'mouse') setHover(s?.id ?? kbId());
		};
		const key = (e: KeyboardEvent) => {
			if (reading || !ws.spots.length || e.metaKey || e.ctrlKey || e.altKey) return;
			const n = ws.spots.length;
			if (e.key === 'ArrowRight' || (e.key === 'Tab' && !e.shiftKey && kbSpot < n - 1)) kbSpot = Math.min(n - 1, kbSpot + 1);
			else if (e.key === 'ArrowLeft' || (e.key === 'Tab' && e.shiftKey && kbSpot > 0)) kbSpot = Math.max(0, kbSpot - 1);
			else if (e.key === 'Enter' && kbSpot >= 0) void goto(hrefOf(ws.spots[Math.min(kbSpot, n - 1)].id));
			else return;
			setHover(kbId());
			e.preventDefault();
		};
		// - and = pull the camera out of the cab and back in (no button, no hover target)
		const zoomKey = (e: KeyboardEvent) => {
			if (reading || !room || e.metaKey || e.ctrlKey || e.altKey) return;
			if (e.key === '-' || e.key === '_') room.zoomOutBy(0.06);
			else if (e.key === '=' || e.key === '+') room.zoomOutBy(-0.06);
			else return;
			e.preventDefault();
		};
		window.addEventListener('keydown', zoomKey);
		el.addEventListener('click', click);
		el.addEventListener('pointermove', hover);
		el.addEventListener('keydown', key);
		el.addEventListener('blur', () => {
			kbSpot = -1;
			setHover(null);
		});
		el.addEventListener('wheel', onwheel, { passive: false });
		el.addEventListener('gesturestart', gs);
		el.addEventListener('gesturechange', gc);
		el.addEventListener('pointerdown', down);
		el.addEventListener('pointermove', move);
		el.addEventListener('pointerup', up);
		el.addEventListener('pointercancel', up);
		el.addEventListener('pointerleave', () => {
			room?.rail.hover(null);
			setHover(kbId());
		});
		el.addEventListener('dblclick', () => room?.resetView());
		return () => {
			window.removeEventListener('keydown', zoomKey);
			el.removeEventListener('click', click);
			el.removeEventListener('pointermove', hover);
			el.removeEventListener('keydown', key);
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
	<canvas bind:this={canvas} aria-hidden="true" tabindex={reading ? -1 : 0}></canvas>
</div>
<!-- scroll length of the elevator: the canvas maps page scroll to the floor. Empty, no content. -->
{#if !reading}<div id="world-spacer" style:height="{Math.max(ws.floors.length, 4) * 90 + 10}svh"></div>{/if}
{#if reading && slug && room && bookOpen}
	{#key slug}
		<Reader mode="world" {slug} fromWorld={canGoBack} reading={room.page} onClose={close} />
	{/key}
{/if}

<style>
	:global(html) {
		background: #1a1612;
		scrollbar-width: none;
	}
	:global(html::-webkit-scrollbar) {
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
	canvas:focus {
		outline: none;
	}
</style>
