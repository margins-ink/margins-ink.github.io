<script lang="ts">
	import type { Thought } from '$lib/thoughts';
	import { accentFor, shortDate } from '$lib/theme';

	let {
		items,
		active = '',
		side = 'left',
		onselect
	}: {
		items: Thought[];
		active?: string;
		/** Which side of the page the rail sits on; year labels face outward. */
		side?: 'left' | 'right';
		onselect?: (slug: string) => void;
	} = $props();

	const H = 520;
	const PAD = 18;
	const MIN_GAP = 17;

	const times = items.map((i) => +new Date(i.date));
	const tMax = Math.max(...times);
	const tMin = Math.min(...times);
	const span = Math.max(tMax - tMin, 1);
	// newest at the top, so scrolling down the page walks back in time
	const yOf = (t: number) => PAD + ((tMax - t) / span) * (H - PAD * 2);

	const dots = $derived.by(() => {
		const sorted = items
			.map((item) => ({ item, y: yOf(+new Date(item.date)), accent: accentFor(item.slug) }))
			.sort((a, b) => a.y - b.y);
		for (let k = 1; k < sorted.length; k++) {
			if (sorted[k].y - sorted[k - 1].y < MIN_GAP) sorted[k].y = sorted[k - 1].y + MIN_GAP;
		}
		return sorted;
	});

	const height = $derived(Math.max(H, dots[dots.length - 1].y + PAD));

	const y0 = new Date(tMin).getUTCFullYear();
	const y1 = new Date(tMax).getUTCFullYear();
	const years = Array.from({ length: y1 - y0 + 1 }, (_, k) => {
		const y = y0 + k;
		const a = Math.max(Date.UTC(y, 0, 1), tMin);
		const b = Math.min(Date.UTC(y + 1, 0, 1), tMax);
		return { y, mid: yOf((a + b) / 2), edge: Date.UTC(y, 0, 1) > tMin ? yOf(Date.UTC(y, 0, 1)) : null };
	});
</script>

<nav class="rail {side}" style:height="{height}px" aria-label="Timeline">
	<div class="line"></div>
	{#each years as yr (yr.y)}
		{#if yr.edge !== null}<div class="tick" style:top="{yr.edge}px"></div>{/if}
		<span class="year" style:top="{yr.mid}px">{yr.y}</span>
	{/each}
	{#each dots as d (d.item.slug)}
		<a
			class="dot"
			class:on={d.item.slug === active}
			style:top="{d.y}px"
			style:--dl={d.accent.light}
			style:--dd={d.accent.dark}
			href={onselect ? `#${d.item.slug}` : d.item.route}
			aria-current={d.item.slug === active ? 'true' : undefined}
			onclick={(e) => {
				if (onselect) {
					e.preventDefault();
					onselect(d.item.slug);
				}
			}}
		>
			<span class="flag"><b>{d.item.title}</b><i>{shortDate(d.item.date)}</i></span>
		</a>
	{/each}
</nav>

<style>
	.rail {
		position: relative;
		width: 5.5rem;
		font-family: var(--font-mono);
	}
	.line {
		position: absolute;
		top: 0;
		bottom: 0;
		left: 50%;
		width: 1px;
		background: var(--border);
	}
	.tick {
		position: absolute;
		left: calc(50% - 5px);
		width: 11px;
		height: 1px;
		background: var(--text-quaternary);
	}
	.year {
		position: absolute;
		transform: translateY(-50%);
		font-size: 0.6875rem;
		letter-spacing: 0.08em;
		color: var(--text-quaternary);
		writing-mode: vertical-rl;
		text-orientation: mixed;
	}
	.left .year {
		left: 0;
		transform: translateY(-50%) rotate(180deg);
	}
	.right .year {
		right: 0;
	}
	.dot {
		position: absolute;
		left: 50%;
		width: 9px;
		height: 9px;
		margin: -4.5px 0 0 -4.5px;
		background: var(--dl);
		outline: 2px solid var(--background);
		transition: transform 0.18s ease;
		z-index: 1;
	}
	.dot.on {
		transform: scale(1.7);
	}
	.dot:hover {
		transform: scale(1.5);
		z-index: 3;
	}
	@media (prefers-color-scheme: dark) {
		.dot {
			background: var(--dd);
		}
	}
	.flag {
		position: absolute;
		top: 50%;
		display: none;
		transform: translateY(-50%) scale(0.5882);
		white-space: nowrap;
		padding: 0.35rem 0.55rem;
		background: var(--text-primary);
		color: var(--background);
		font-size: 0.6875rem;
		line-height: 1.3;
		pointer-events: none;
	}
	.left .flag {
		left: 1.4rem;
	}
	.right .flag {
		right: 1.4rem;
	}
	.flag b {
		display: block;
		font-weight: 500;
	}
	.flag i {
		font-style: normal;
		opacity: 0.6;
	}
	.dot:hover .flag,
	.dot:focus-visible .flag {
		display: block;
	}
</style>
