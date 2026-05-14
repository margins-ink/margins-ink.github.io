<script lang="ts">
	interface Props {
		width?: number;
		height?: number;
	}

	let { width = 440, height = 200 }: Props = $props();

	const repos = [
		{ x: 0.78, y: 0.12, name: 'serde-rs/serde', amount: '$400' },
		{ x: 0.82, y: 0.36, name: 'tokio-rs/tokio', amount: '$180' },
		{ x: 0.78, y: 0.60, name: 'rust-lang/rust', amount: '$620' },
		{ x: 0.82, y: 0.84, name: 'unallocated', amount: '$800', muted: true }
	];

	const companyX = 0.18;
	const companyY = 0.5;
</script>

<svg {width} {height} viewBox="0 0 440 200" class="diagram">
	<rect
		x={companyX * 440 - 50}
		y={companyY * 200 - 40}
		width="100"
		height="80"
		rx="4"
		class="company-box"
	/>
	<text x={companyX * 440} y={companyY * 200 - 12} class="company-label">Acme Corp</text>
	<text x={companyX * 440} y={companyY * 200 + 8} class="budget-label">$2,000/mo</text>
	<text x={companyX * 440} y={companyY * 200 + 24} class="auto-label">auto-fund</text>

	{#each repos as repo}
		{@const endX = repo.x * 440}
		{@const endY = repo.y * 180 + 10}
		{@const startX = companyX * 440 + 50}
		{@const startY = companyY * 200}

		<path
			d="M {startX} {startY} C {startX + 50} {startY}, {endX - 70} {endY}, {endX - 55} {endY}"
			class="funding-line"
			class:muted={repo.muted}
		/>

		<circle cx={endX - 55} cy={endY} r="5" class="repo-node" class:muted={repo.muted} />
		<text x={endX - 42} y={endY - 8} class="repo-name" class:muted={repo.muted}>{repo.name}</text>
		<text x={endX - 42} y={endY + 8} class="repo-amount" class:muted={repo.muted}>{repo.amount}</text>
	{/each}
</svg>

<style>
	.diagram {
		display: block;
		margin: 2rem auto;
	}

	.company-box {
		fill: var(--background);
		stroke: var(--foreground);
		stroke-width: 2;
	}

	.company-label {
		fill: var(--foreground);
		font-family: var(--font-mono);
		font-size: 11px;
		text-anchor: middle;
		font-weight: 600;
	}

	.budget-label {
		fill: var(--foreground);
		font-family: var(--font-mono);
		font-size: 13px;
		text-anchor: middle;
		font-weight: 700;
	}

	.auto-label {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 9px;
		text-anchor: middle;
	}

	.funding-line {
		fill: none;
		stroke: var(--foreground);
		stroke-width: 1.5;
		opacity: 0.6;
	}

	.funding-line.muted {
		stroke: var(--muted-foreground);
		stroke-dasharray: 4 3;
		opacity: 0.4;
	}

	.repo-node {
		fill: var(--foreground);
	}

	.repo-node.muted {
		fill: var(--muted-foreground);
		opacity: 0.5;
	}

	.repo-name {
		fill: var(--foreground);
		font-family: var(--font-mono);
		font-size: 9px;
	}

	.repo-name.muted {
		fill: var(--muted-foreground);
	}

	.repo-amount {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
	}

	.repo-amount.muted {
		opacity: 0.6;
	}
</style>
