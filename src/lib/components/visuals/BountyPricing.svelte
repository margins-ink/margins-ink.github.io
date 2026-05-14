<script lang="ts">
	// Bounties approach a closed center and dissipate before they land.
	// Money in motion; the thing that needs solving stays untouched.
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<!-- The closed thing money cannot enter -->
	<circle cx="60" cy="30" r="6" class="core" />

	<!-- $ marks: present at the periphery, never arriving -->
	<text class="dollar tl" x="18" y="22">$</text>
	<text class="dollar tr" x="102" y="22">$</text>
	<text class="dollar bl" x="18" y="48">$</text>
	<text class="dollar br" x="102" y="48">$</text>
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.core {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.5;
		opacity: 0.85;
	}

	.dollar {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 11px;
		font-weight: 500;
		fill: var(--text-quaternary);
		text-anchor: middle;
		dominant-baseline: middle;
		opacity: 0.6;
	}

	svg.hovered .tl {
		animation: approach-tl 3s ease-in-out infinite;
	}
	svg.hovered .tr {
		animation: approach-tr 3s ease-in-out 0.75s infinite;
	}
	svg.hovered .bl {
		animation: approach-bl 3s ease-in-out 1.5s infinite;
	}
	svg.hovered .br {
		animation: approach-br 3s ease-in-out 2.25s infinite;
	}

	@keyframes approach-tl {
		0%, 100% { transform: translate(0, 0); opacity: 0.6; }
		55% { transform: translate(28px, 5px); opacity: 0; }
		56% { transform: translate(0, 0); opacity: 0; }
	}
	@keyframes approach-tr {
		0%, 100% { transform: translate(0, 0); opacity: 0.6; }
		55% { transform: translate(-28px, 5px); opacity: 0; }
		56% { transform: translate(0, 0); opacity: 0; }
	}
	@keyframes approach-bl {
		0%, 100% { transform: translate(0, 0); opacity: 0.6; }
		55% { transform: translate(28px, -12px); opacity: 0; }
		56% { transform: translate(0, 0); opacity: 0; }
	}
	@keyframes approach-br {
		0%, 100% { transform: translate(0, 0); opacity: 0.6; }
		55% { transform: translate(-28px, -12px); opacity: 0; }
		56% { transform: translate(0, 0); opacity: 0; }
	}
</style>
