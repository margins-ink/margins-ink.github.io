<script lang="ts">
	// One API surface, many backings. The verbs are the contract; the
	// substrate is implementation detail. On hover, the same call fans out.
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" preserveAspectRatio="xMidYMid meet" class:hovered>
	<!-- API surface -->
	<g class="api">
		<rect x="22" y="11" width="76" height="10" rx="2" class="api-bg" />
		<text x="60" y="16.5" class="api-label">read / write / fsync</text>
	</g>

	<!-- Substrate row, evenly spaced, well inside the viewBox -->
	<g class="substrate">
		<rect x="16" y="39" width="16" height="10" rx="2" class="sub-bg" />
		<text x="24" y="45.5" class="sub-label">disk</text>
	</g>
	<g class="substrate">
		<rect x="40" y="39" width="16" height="10" rx="2" class="sub-bg" />
		<text x="48" y="45.5" class="sub-label">ram</text>
	</g>
	<g class="substrate">
		<rect x="64" y="39" width="16" height="10" rx="2" class="sub-bg" />
		<text x="72" y="45.5" class="sub-label">net</text>
	</g>
	<g class="substrate">
		<rect x="88" y="39" width="16" height="10" rx="2" class="sub-bg" />
		<text x="96" y="45.5" class="sub-label">ecs</text>
	</g>

	<!-- Fan-out lines: API bottom-center to each substrate top-center -->
	<line x1="60" y1="21" x2="24" y2="39" class="edge" />
	<line x1="60" y1="21" x2="48" y2="39" class="edge" />
	<line x1="60" y1="21" x2="72" y2="39" class="edge" />
	<line x1="60" y1="21" x2="96" y2="39" class="edge" />

	<!-- Moving dots: one API call, four dispatches -->
	<circle r="1.4" class="dot d0" cx="60" cy="21" />
	<circle r="1.4" class="dot d1" cx="60" cy="21" />
	<circle r="1.4" class="dot d2" cx="60" cy="21" />
	<circle r="1.4" class="dot d3" cx="60" cy="21" />
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
		overflow: visible;
	}

	.api-bg,
	.sub-bg {
		fill: none;
		stroke: var(--text-tertiary);
		stroke-width: 1.1;
		opacity: 0.7;
	}

	.api-label {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 5px;
		font-weight: 500;
		fill: var(--text-tertiary);
		text-anchor: middle;
		dominant-baseline: middle;
	}

	.sub-label {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 5.5px;
		font-weight: 500;
		fill: var(--text-tertiary);
		text-anchor: middle;
		dominant-baseline: middle;
	}

	.edge {
		stroke: var(--text-quaternary);
		stroke-width: 0.8;
		opacity: 0.45;
	}

	.dot {
		fill: var(--text-primary);
		opacity: 0;
	}

	svg.hovered .d0 {
		animation: fan0 1.8s cubic-bezier(0.65, 0, 0.35, 1) infinite;
	}
	svg.hovered .d1 {
		animation: fan1 1.8s cubic-bezier(0.65, 0, 0.35, 1) infinite 0.05s;
	}
	svg.hovered .d2 {
		animation: fan2 1.8s cubic-bezier(0.65, 0, 0.35, 1) infinite 0.1s;
	}
	svg.hovered .d3 {
		animation: fan3 1.8s cubic-bezier(0.65, 0, 0.35, 1) infinite 0.15s;
	}

	@keyframes fan0 {
		0% { transform: translate(0, 0); opacity: 0; }
		15% { opacity: 0.9; }
		70%, 100% { transform: translate(-36px, 23px); opacity: 0; }
	}
	@keyframes fan1 {
		0% { transform: translate(0, 0); opacity: 0; }
		15% { opacity: 0.9; }
		70%, 100% { transform: translate(-12px, 23px); opacity: 0; }
	}
	@keyframes fan2 {
		0% { transform: translate(0, 0); opacity: 0; }
		15% { opacity: 0.9; }
		70%, 100% { transform: translate(12px, 23px); opacity: 0; }
	}
	@keyframes fan3 {
		0% { transform: translate(0, 0); opacity: 0; }
		15% { opacity: 0.9; }
		70%, 100% { transform: translate(36px, 23px); opacity: 0; }
	}
</style>
