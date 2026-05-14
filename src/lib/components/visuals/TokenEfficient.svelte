<script lang="ts">
	// Verbose → Compact transformation - compression effect
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<!-- Verbose JSON (faded) -->
	<g class="verbose-group">
		<text x="16" y="18" class="brace">{"{"}</text>
		<rect x="22" y="20" width="20" height="5" rx="1" class="verbose v1" />
		<rect x="22" y="28" width="16" height="5" rx="1" class="verbose v2" opacity="0.25" />
		<rect x="22" y="36" width="18" height="5" rx="1" class="verbose v3" opacity="0.2" />
		<text x="16" y="50" class="brace">{"}"}</text>
	</g>

	<!-- Arrow -->
	<line x1="48" y1="30" x2="58" y2="30" class="arrow" />

	<!-- Compact block -->
	<g class="compact-group">
		<rect x="64" y="14" width="44" height="32" rx="3" class="compact" />
		{#each [0, 1, 2] as row}
			{#each [0, 1, 2, 3, 4] as col}
				<rect
					x={68 + col * 8}
					y={18 + row * 10}
					width="6"
					height="6"
					rx="1"
					class="data d-{row}-{col}"
					opacity={0.3 + ((row + col) % 3) * 0.2}
				/>
			{/each}
		{/each}
	</g>
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.brace {
		font-family: var(--font-mono);
		font-size: 12px;
		fill: var(--text-quaternary);
		opacity: 0.3;
		transition: opacity 0.4s ease;
	}

	.verbose {
		fill: var(--text-quaternary);
		opacity: 0.3;
		transition: transform 0.4s ease, opacity 0.4s ease, width 0.4s ease;
	}

	.arrow {
		stroke: var(--text-quaternary);
		stroke-width: 1.5;
		opacity: 0.4;
	}

	.compact {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.5;
		opacity: 0.5;
		transition: opacity 0.3s ease;
	}

	.data {
		fill: var(--text-tertiary);
		transition: opacity 0.2s ease;
	}

	.verbose-group {
		transition: opacity 0.4s ease;
	}

	svg.hovered .verbose-group {
		opacity: 0.4;
	}

	svg.hovered .v1 { transform: translateX(8px) scaleX(0.5); }
	svg.hovered .v2 { transform: translateX(12px) scaleX(0.4); opacity: 0.15; }
	svg.hovered .v3 { transform: translateX(16px) scaleX(0.3); opacity: 0.1; }

	svg.hovered .compact {
		opacity: 0.8;
	}

	svg.hovered .data {
		animation: fillIn 0.8s ease forwards;
	}

	svg.hovered .d-0-0 { animation-delay: 0s; }
	svg.hovered .d-0-1 { animation-delay: 0.05s; }
	svg.hovered .d-0-2 { animation-delay: 0.1s; }
	svg.hovered .d-0-3 { animation-delay: 0.15s; }
	svg.hovered .d-0-4 { animation-delay: 0.2s; }
	svg.hovered .d-1-0 { animation-delay: 0.1s; }
	svg.hovered .d-1-1 { animation-delay: 0.15s; }
	svg.hovered .d-1-2 { animation-delay: 0.2s; }
	svg.hovered .d-1-3 { animation-delay: 0.25s; }
	svg.hovered .d-1-4 { animation-delay: 0.3s; }
	svg.hovered .d-2-0 { animation-delay: 0.2s; }
	svg.hovered .d-2-1 { animation-delay: 0.25s; }
	svg.hovered .d-2-2 { animation-delay: 0.3s; }
	svg.hovered .d-2-3 { animation-delay: 0.35s; }
	svg.hovered .d-2-4 { animation-delay: 0.4s; }

	@keyframes fillIn {
		0% { opacity: 0.3; }
		50% { opacity: 0.9; }
		100% { opacity: 0.7; }
	}
</style>
