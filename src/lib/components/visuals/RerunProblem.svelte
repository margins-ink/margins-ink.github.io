<script lang="ts">
	// Many tasks, most quietly complete. A few never settle.
	// Scale + stragglers — the shape of the rerun problem.
	let { hovered = false }: { hovered?: boolean } = $props();

	const cols = 18;
	const rows = 5;
	const dx = 6;
	const dy = 9;
	const ox = 8;
	const oy = 12;

	// Two stuck positions, picked by hand for visual balance
	const stuckIdx = new Set([cols * 1 + 5, cols * 3 + 12]);

	const tasks = Array.from({ length: rows * cols }, (_, i) => ({
		cx: ox + (i % cols) * dx,
		cy: oy + Math.floor(i / cols) * dy,
		stuck: stuckIdx.has(i),
		// deterministic pseudo-random delay so the field shimmers
		delay: ((i * 137) % 1600) / 1000
	}));
</script>

<svg viewBox="0 0 120 60" class:hovered>
	{#each tasks as t}
		{#if t.stuck}
			<circle cx={t.cx} cy={t.cy} r="1.7" class="stuck" />
		{:else}
			<circle
				cx={t.cx}
				cy={t.cy}
				r="0.95"
				class="task"
				style:animation-delay="{t.delay}s"
			/>
		{/if}
	{/each}
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.task {
		fill: var(--text-quaternary);
		opacity: 0.35;
	}

	.stuck {
		fill: var(--text-tertiary);
		opacity: 0.95;
		transform-box: fill-box;
		transform-origin: center;
	}

	svg.hovered .task {
		animation: shimmer 1.6s ease-in-out infinite;
	}

	svg.hovered .stuck {
		animation: jitter 0.75s ease-in-out infinite;
	}

	@keyframes shimmer {
		0%, 100% { opacity: 0.25; }
		20% { opacity: 0.75; }
		55% { opacity: 0.4; }
	}

	@keyframes jitter {
		0%, 100% { opacity: 0.85; transform: translate(0, 0) scale(1); }
		25% { transform: translate(0.4px, -0.3px) scale(1.15); opacity: 1; }
		50% { opacity: 0.95; transform: translate(-0.3px, 0.3px) scale(1); }
		75% { transform: translate(0.2px, 0.2px) scale(1.1); opacity: 1; }
	}
</style>
