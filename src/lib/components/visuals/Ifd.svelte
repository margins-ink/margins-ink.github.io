<script lang="ts">
	// IFD: eval pauses to build a derivation, reads the output, continues.
	// Two phases, one round trip. Hover animates the data crossing the boundary.
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<defs>
		<marker
			id="ifd-arrow"
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

	<!-- eval node (left) -->
	<g class="node">
		<rect x="10" y="20" width="30" height="20" rx="3" class="node-bg" />
		<text x="25" y="32.5" class="label">eval</text>
	</g>

	<!-- drv node (right) -->
	<g class="node">
		<rect x="80" y="20" width="30" height="20" rx="3" class="node-bg" />
		<text x="95" y="32.5" class="label">drv</text>
	</g>

	<!-- request: eval → drv (top arc) -->
	<path d="M40 26 Q60 14 80 26" class="edge req" marker-end="url(#ifd-arrow)" />
	<!-- response: drv → eval (bottom arc) -->
	<path d="M80 34 Q60 46 40 34" class="edge res" marker-end="url(#ifd-arrow)" />

	<!-- moving dot: eval pushes a build request, drv hands the result back -->
	<circle r="1.8" class="dot dot-req" />
	<circle r="1.8" class="dot dot-res" />
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.node-bg {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.2;
		opacity: 0.75;
	}

	.label {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 7px;
		font-weight: 500;
		fill: var(--text-tertiary);
		text-anchor: middle;
		dominant-baseline: middle;
	}

	.edge {
		fill: none;
		stroke: var(--text-quaternary);
		stroke-width: 1.1;
		opacity: 0.6;
	}

	.arrow-head {
		fill: var(--text-quaternary);
		opacity: 0.75;
	}

	.dot {
		fill: var(--text-primary);
		opacity: 0;
	}

	svg.hovered .dot {
		opacity: 0.9;
	}

	svg.hovered .dot-req {
		animation: travel-req 2.4s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	svg.hovered .dot-res {
		animation: travel-res 2.4s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}

	@keyframes travel-req {
		0% {
			transform: translate(40px, 26px);
			opacity: 0;
		}
		8% {
			opacity: 0.9;
		}
		42% {
			transform: translate(80px, 26px);
			opacity: 0.9;
		}
		50%, 100% {
			transform: translate(80px, 26px);
			opacity: 0;
		}
	}

	@keyframes travel-res {
		0%, 50% {
			transform: translate(80px, 34px);
			opacity: 0;
		}
		58% {
			opacity: 0.9;
		}
		92% {
			transform: translate(40px, 34px);
			opacity: 0.9;
		}
		100% {
			transform: translate(40px, 34px);
			opacity: 0;
		}
	}
</style>
