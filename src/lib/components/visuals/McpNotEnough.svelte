<script lang="ts">
	// Typed input → fn → untyped blob. The blob is what breaks
	// composition: it can't slot into the next tool's typed input.
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<defs>
		<marker
			id="mcp-arrow"
			viewBox="0 0 8 8"
			refX="7"
			refY="4"
			markerWidth="5"
			markerHeight="5"
			orient="auto"
		>
			<path d="M0,0 L8,4 L0,8 Z" class="arrow-head" />
		</marker>
	</defs>

	<!-- Typed structured input: bordered box with three discrete fields -->
	<g class="typed">
		<rect x="6" y="18" width="22" height="24" rx="2" class="typed-frame" />
		<rect x="10" y="23" width="6" height="3" rx="0.6" class="field f0" />
		<rect x="18" y="23" width="6" height="3" rx="0.6" class="field f1" />
		<rect x="10" y="29" width="14" height="3" rx="0.6" class="field f2" />
		<rect x="10" y="35" width="9" height="3" rx="0.6" class="field f3" />
	</g>

	<!-- Arrow into tool -->
	<line x1="30" y1="30" x2="38" y2="30" class="edge" marker-end="url(#mcp-arrow)" />

	<!-- Tool / fn -->
	<g class="fn">
		<rect x="40" y="20" width="18" height="20" rx="2" class="fn-box" />
		<text x="49" y="33" class="fn-label">tool</text>
	</g>

	<!-- Arrow out -->
	<line x1="60" y1="30" x2="68" y2="30" class="edge" marker-end="url(#mcp-arrow)" />

	<!-- Untyped output blob: organic path, dashed outline -->
	<path
		class="blob"
		d="M76,18 Q84,12 92,14 Q103,12 106,22 Q112,28 107,36 Q105,46 95,46 Q84,49 78,42 Q70,38 72,30 Q70,22 76,18 Z"
	/>
	<text x="89" y="33" class="blob-q">?</text>
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.typed-frame {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.2;
		opacity: 0.75;
	}

	.field {
		fill: var(--text-tertiary);
		opacity: 0.7;
	}

	.edge {
		stroke: var(--text-quaternary);
		stroke-width: 1.1;
		opacity: 0.55;
	}

	.arrow-head {
		fill: var(--text-quaternary);
		opacity: 0.7;
	}

	.fn-box {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.2;
		opacity: 0.7;
	}

	.fn-label {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 6px;
		fill: var(--text-tertiary);
		text-anchor: middle;
		opacity: 0.85;
	}

	.blob {
		fill: var(--text-quaternary);
		fill-opacity: 0.12;
		stroke: var(--text-quaternary);
		stroke-width: 1.1;
		stroke-dasharray: 2.5 2.5;
		opacity: 0.85;
	}

	.blob-q {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 10px;
		font-weight: 500;
		fill: var(--text-quaternary);
		text-anchor: middle;
		dominant-baseline: middle;
		opacity: 0.6;
	}

	svg.hovered .f0 {
		animation: fieldPulse 1.6s ease-in-out infinite;
	}
	svg.hovered .f1 {
		animation: fieldPulse 1.6s ease-in-out 0.18s infinite;
	}
	svg.hovered .f2 {
		animation: fieldPulse 1.6s ease-in-out 0.36s infinite;
	}
	svg.hovered .f3 {
		animation: fieldPulse 1.6s ease-in-out 0.54s infinite;
	}

	.blob {
		transform-box: fill-box;
		transform-origin: 50% 50%;
	}

	svg.hovered .blob {
		animation: blobWobble 3.2s ease-in-out infinite;
	}

	svg.hovered .blob-q {
		animation: questionFade 3.2s ease-in-out infinite;
	}

	@keyframes fieldPulse {
		0%, 100% { opacity: 0.55; }
		50% { opacity: 0.95; }
	}

	@keyframes blobWobble {
		0%, 100% { transform: scale(1, 1) rotate(0deg); }
		25% { transform: scale(1.04, 0.96) rotate(1deg); }
		50% { transform: scale(0.97, 1.03) rotate(-1deg); }
		75% { transform: scale(1.03, 0.98) rotate(0.5deg); }
	}

	@keyframes questionFade {
		0%, 100% { opacity: 0.5; }
		50% { opacity: 0.8; }
	}
</style>
