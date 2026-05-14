<script lang="ts">
	interface Props {
		width?: number;
		height?: number;
	}

	let { width = 380, height = 160 }: Props = $props();

	const submitters = [
		{ y: 0.15, label: '$50' },
		{ y: 0.35, label: '$80' },
		{ y: 0.55, label: '$120' },
		{ y: 0.75, label: '$200' },
		{ y: 0.95, label: '$?' }
	];
</script>

<svg {width} {height} viewBox="0 0 380 160" class="diagram">
	<text x="45" y="12" class="section-label">submitters</text>

	{#each submitters as s, i}
		{@const y = s.y * 130 + 15}
		<rect x="20" y={y - 12} width="50" height="24" rx="3" class="submitter-box" />
		<text x="45" y={y + 4} class="bounty-label">{s.label}</text>

		<line x1="70" y1={y} x2="165" y2="80" class="flow-line" />
	{/each}

	<circle cx="190" cy="80" r="28" class="reviewer-node" />
	<text x="190" y="75" class="reviewer-label">sole</text>
	<text x="190" y="90" class="reviewer-label">reviewer</text>

	<text x="190" y="130" class="monopoly-label">monopoly</text>

	<line x1="218" y1="80" x2="280" y2="80" class="output-line" />
	<polygon points="280,74 280,86 294,80" class="arrow" />

	<rect x="300" y="65" width="60" height="30" rx="3" class="merge-box" />
	<text x="330" y="84" class="merge-label">merge</text>

	<text x="330" y="150" class="caption">pricing power = ?</text>
</svg>

<style>
	.diagram {
		display: block;
		margin: 2rem auto;
	}

	.section-label {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 9px;
		text-anchor: middle;
	}

	.submitter-box {
		fill: var(--background);
		stroke: var(--muted-foreground);
		stroke-width: 1;
	}

	.bounty-label {
		fill: var(--foreground);
		font-family: var(--font-mono);
		font-size: 10px;
		text-anchor: middle;
	}

	.flow-line {
		stroke: var(--muted-foreground);
		stroke-width: 1;
		opacity: 0.4;
	}

	.reviewer-node {
		fill: var(--foreground);
	}

	.reviewer-label {
		fill: var(--background);
		font-family: var(--font-mono);
		font-size: 9px;
		text-anchor: middle;
	}

	.monopoly-label {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 10px;
		text-anchor: middle;
		font-style: italic;
	}

	.output-line {
		stroke: var(--foreground);
		stroke-width: 2;
	}

	.arrow {
		fill: var(--foreground);
	}

	.merge-box {
		fill: var(--foreground);
	}

	.merge-label {
		fill: var(--background);
		font-family: var(--font-mono);
		font-size: 10px;
		text-anchor: middle;
	}

	.caption {
		fill: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 9px;
		text-anchor: middle;
	}
</style>
