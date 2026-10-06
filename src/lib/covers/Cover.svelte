<script lang="ts">
	import { COLS, ROWS, type Cover, type CoverPalette } from './types';

	let { cover, label = '' }: { cover: Cover; label?: string } = $props();

	// Merge horizontal runs of the same colour into single rects.
	function runs(pal: CoverPalette) {
		const out: { x: number; y: number; w: number; fill: string }[] = [];
		cover.rows.forEach((row, y) => {
			let x = 0;
			while (x < COLS) {
				const ch = row[x] ?? '.';
				if (ch === '.' || !pal.ink[ch]) {
					x++;
					continue;
				}
				let w = 1;
				while (row[x + w] === ch) w++;
				out.push({ x, y, w, fill: pal.ink[ch] });
				x += w;
			}
		});
		return out;
	}

	const light = $derived(runs(cover.light));
	const dark = $derived(runs(cover.dark));
</script>

<div class="cover" style:--bg-light={cover.light.bg} style:--bg-dark={cover.dark.bg}>
	<svg
		class="art light"
		viewBox="0 0 {COLS} {ROWS}"
		shape-rendering="crispEdges"
		role={label ? 'img' : 'presentation'}
		aria-label={label || undefined}
	>
		{#each light as r}<rect x={r.x} y={r.y} width={r.w} height="1" fill={r.fill} />{/each}
	</svg>
	<svg class="art dark" viewBox="0 0 {COLS} {ROWS}" shape-rendering="crispEdges" aria-hidden="true">
		{#each dark as r}<rect x={r.x} y={r.y} width={r.w} height="1" fill={r.fill} />{/each}
	</svg>
</div>

<style>
	.cover {
		background: var(--bg-light);
		aspect-ratio: 64 / 24;
		width: 100%;
		overflow: hidden;
		border-radius: 3px;
	}
	.art {
		display: block;
		width: 100%;
		height: 100%;
	}
	.dark {
		display: none;
	}
	@media (prefers-color-scheme: dark) {
		.cover {
			background: var(--bg-dark);
		}
		.light {
			display: none;
		}
		.dark {
			display: block;
		}
	}
</style>
