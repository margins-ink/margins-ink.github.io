<script lang="ts">
	// Debugger - stepping through frames effect
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<!-- Stack frames -->
	{#each [0, 1, 2, 3] as i}
		<rect
			x="14"
			y={10 + i * 12}
			width="44"
			height="9"
			rx="1.5"
			class="frame f-{i}"
			class:active={i === 1}
			opacity={i === 1 ? 0.8 : 0.3 - i * 0.05}
		/>
	{/each}

	<!-- Breakpoint dot -->
	<circle cx="10" cy={10 + 1 * 12 + 4.5} r="3" class="breakpoint" />

	<!-- Arrow -->
	<line x1="62" y1="30" x2="70" y2="30" class="arrow" />

	<!-- Variable panel -->
	<rect x="74" y="12" width="36" height="36" rx="2" class="panel" />
	<line x1="80" y1="22" x2="102" y2="22" class="var v1" />
	<line x1="80" y1="30" x2="96" y2="30" class="var v2" opacity="0.5" />
	<line x1="80" y1="38" x2="99" y2="38" class="var v3" opacity="0.3" />
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.frame {
		fill: var(--text-quaternary);
		transition: opacity 0.3s ease, fill 0.3s ease;
	}

	.frame.active {
		fill: var(--text-tertiary);
	}

	.breakpoint {
		fill: var(--text-tertiary);
		opacity: 0.8;
		transition: opacity 0.2s ease;
	}

	.arrow {
		stroke: var(--text-quaternary);
		stroke-width: 1.5;
		opacity: 0.4;
	}

	.panel {
		fill: none;
		stroke: var(--text-quaternary);
		stroke-width: 1.5;
		opacity: 0.4;
	}

	.var {
		stroke: var(--text-quaternary);
		stroke-width: 2;
		stroke-linecap: round;
		transition: opacity 0.3s ease;
	}

	svg.hovered .breakpoint {
		animation: bpPulse 0.8s ease-in-out infinite;
	}

	svg.hovered .f-0 {
		animation: stepFrame 2s ease-in-out infinite;
	}

	svg.hovered .f-1 {
		animation: stepFrame 2s ease-in-out 0.5s infinite;
	}

	svg.hovered .f-2 {
		animation: stepFrame 2s ease-in-out 1s infinite;
	}

	svg.hovered .v1 {
		animation: varUpdate 1.5s ease-in-out infinite;
	}

	svg.hovered .v2 {
		animation: varUpdate 1.5s ease-in-out 0.3s infinite;
	}

	svg.hovered .v3 {
		animation: varUpdate 1.5s ease-in-out 0.6s infinite;
	}

	@keyframes bpPulse {
		0%, 100% { opacity: 0.8; r: 3; }
		50% { opacity: 1; r: 3.5; }
	}

	@keyframes stepFrame {
		0%, 40%, 100% { opacity: 0.25; fill: var(--text-quaternary); }
		20% { opacity: 0.8; fill: var(--text-tertiary); }
	}

	@keyframes varUpdate {
		0%, 100% { opacity: 0.5; }
		30% { opacity: 0.9; }
		60% { opacity: 0.5; }
	}
</style>
