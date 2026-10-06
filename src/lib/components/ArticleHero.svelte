<script lang="ts">
	import { thoughts } from '$lib/thoughts';
	import { createRoom } from '$lib/gpu/room/room';

	let { slug, live = $bindable(false) }: { slug: string; live?: boolean } = $props();

	let canvas = $state<HTMLCanvasElement>();

	$effect(() => {
		if (!canvas) return;
		let cancelled = false;
		let room: Awaited<ReturnType<typeof createRoom>> = null;
		createRoom(canvas, thoughts, () => {}, { focus: slug }).then((r) => {
			if (cancelled) return r?.destroy();
			room = r;
			live = r !== null;
		});
		return () => {
			cancelled = true;
			room?.destroy();
			live = false;
		};
	});
</script>

<canvas bind:this={canvas} aria-hidden="true" class:live></canvas>

<style>
	canvas {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		display: block;
		opacity: 0;
		transition: opacity 0.6s ease;
	}
	canvas.live {
		opacity: 1;
	}
</style>
