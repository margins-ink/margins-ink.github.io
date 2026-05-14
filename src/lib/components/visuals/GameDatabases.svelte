<script lang="ts">
	// ECS table - scanning/query effect
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<!-- Scan line -->
	<rect x="12" y="22" width="96" height="7" rx="1" class="scan" />

	<!-- Header row -->
	<rect x="12" y="10" width="96" height="8" rx="1.5" class="header" />

	<!-- Data rows -->
	{#each [0, 1, 2, 3] as row}
		<g class="row row-{row}">
			<rect x="12" y={22 + row * 10} width="18" height="7" rx="1" class="cell id" />
			<rect x="33" y={22 + row * 10} width="22" height="7" rx="1" class="cell" opacity={0.5 - row * 0.08} />
			<rect x="58" y={22 + row * 10} width="22" height="7" rx="1" class="cell" opacity={0.4 - row * 0.06} />
			<rect x="83" y={22 + row * 10} width="25" height="7" rx="1" class="cell" opacity={0.3 - row * 0.04} />
		</g>
	{/each}
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.header {
		fill: var(--text-quaternary);
		opacity: 0.25;
	}

	.cell {
		fill: var(--text-quaternary);
	}

	.cell.id {
		fill: var(--text-tertiary);
		opacity: 0.6;
	}

	.scan {
		fill: var(--text-tertiary);
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	svg.hovered .scan {
		opacity: 0.15;
		animation: scan 1.2s ease-in-out infinite;
	}

	@keyframes scan {
		0%, 100% { transform: translateY(0); }
		25% { transform: translateY(10px); }
		50% { transform: translateY(20px); }
		75% { transform: translateY(30px); }
	}
</style>
