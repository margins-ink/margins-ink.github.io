<script lang="ts">
	// Default - typing/writing effect
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<rect x="38" y="8" width="44" height="44" rx="3" class="doc" />
	<line x1="46" y1="20" x2="74" y2="20" class="line l1" />
	<line x1="46" y1="28" x2="68" y2="28" class="line l2" opacity="0.5" />
	<line x1="46" y1="36" x2="70" y2="36" class="line l3" opacity="0.35" />
	<line x1="46" y1="44" x2="62" y2="44" class="line l4" opacity="0.2" />
	<!-- Cursor -->
	<rect x="64" y="42" width="2" height="6" rx="0.5" class="cursor" />
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.doc {
		fill: none;
		stroke: var(--text-quaternary);
		stroke-width: 1.5;
		opacity: 0.5;
	}

	.line {
		stroke: var(--text-quaternary);
		stroke-width: 2;
		stroke-linecap: round;
	}

	.cursor {
		fill: var(--text-tertiary);
		opacity: 0;
		transition: opacity 0.2s ease;
	}

	svg.hovered .cursor {
		opacity: 0.7;
		animation: blink 0.8s step-end infinite;
	}

	svg.hovered .l1 {
		animation: typeLine 2s ease-out infinite;
	}

	svg.hovered .l2 {
		animation: typeLine 2s ease-out 0.3s infinite;
	}

	svg.hovered .l3 {
		animation: typeLine 2s ease-out 0.6s infinite;
	}

	svg.hovered .l4 {
		animation: typeLine 2s ease-out 0.9s infinite;
	}

	@keyframes blink {
		0%, 50% { opacity: 0.7; }
		51%, 100% { opacity: 0; }
	}

	@keyframes typeLine {
		0% { stroke-dasharray: 0 30; opacity: 0.3; }
		40% { stroke-dasharray: 30 0; opacity: 0.8; }
		100% { stroke-dasharray: 30 0; opacity: 0.5; }
	}
</style>
