<script lang="ts">
	// Three content-addressed hashes in a cycle. A `name` pointer
	// orbits between them: "the binding moves; the hashes don't."
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<defs>
		<marker
			id="nx-arrow"
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

	<!-- Cyclic edges: a4f → 7bc → c12 → a4f -->
	<path d="M37 17 Q60 4 83 17" class="edge" marker-end="url(#nx-arrow)" />
	<path d="M90 30 Q84 47 68 46" class="edge" marker-end="url(#nx-arrow)" />
	<path d="M52 46 Q36 47 30 30" class="edge" marker-end="url(#nx-arrow)" />

	<!-- Three hash nodes -->
	<g class="node n0">
		<circle cx="28" cy="22" r="9" class="hash-bg" />
		<text x="28" y="24.5" class="hash">a4f</text>
	</g>
	<g class="node n1">
		<circle cx="92" cy="22" r="9" class="hash-bg" />
		<text x="92" y="24.5" class="hash">7bc</text>
	</g>
	<g class="node n2">
		<circle cx="60" cy="46" r="9" class="hash-bg" />
		<text x="60" y="48.5" class="hash">c12</text>
	</g>

	<!-- Name pointer: a label that resolves to whichever hash it currently points at -->
	<g class="pointer">
		<text class="ptr-label" y="-13">name</text>
		<line x1="0" y1="-10" x2="0" y2="-3" class="ptr-arm" />
		<circle r="2" class="ptr-dot" />
	</g>
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.edge {
		fill: none;
		stroke: var(--text-quaternary);
		stroke-width: 1.1;
		opacity: 0.55;
	}

	.arrow-head {
		fill: var(--text-quaternary);
		opacity: 0.7;
	}

	.hash-bg {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.3;
		opacity: 0.7;
	}

	.hash {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 6px;
		font-weight: 500;
		letter-spacing: 0.02em;
		fill: var(--text-tertiary);
		opacity: 0.95;
		text-anchor: middle;
		dominant-baseline: middle;
	}

	.pointer {
		transform: translate(28px, 22px);
		transition: transform 0.45s cubic-bezier(0.4, 0, 0.2, 1);
	}

	.ptr-dot {
		fill: var(--text-primary);
		opacity: 0.9;
	}

	.ptr-arm {
		stroke: var(--text-primary);
		stroke-width: 1;
		opacity: 0.55;
	}

	.ptr-label {
		font-family: var(--font-sans);
		font-size: 5.5px;
		font-weight: 500;
		fill: var(--text-primary);
		text-anchor: middle;
		opacity: 0.95;
	}

	svg.hovered .pointer {
		animation: orbit 3.6s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	@keyframes orbit {
		0%, 22% {
			transform: translate(28px, 22px);
		}
		33%, 55% {
			transform: translate(92px, 22px);
		}
		66%, 88% {
			transform: translate(60px, 46px);
		}
		100% {
			transform: translate(28px, 22px);
		}
	}
</style>
