<script lang="ts">
</script>

<div class="diagram">
	<div class="comparison">
		<div class="pr large">
			<div class="lines">500</div>
			<div class="unit">lines</div>
			<div class="type">IDE refactor</div>
			<div class="effort easy">5 min</div>
		</div>

		<div class="operator">
			<span class="label">lines</span>
			<span class="symbol">≠</span>
			<span class="label">effort</span>
		</div>

		<div class="pr small">
			<div class="lines">1</div>
			<div class="unit">line</div>
			<div class="type">mutex change</div>
			<div class="effort hard">1 hour</div>
		</div>
	</div>
</div>

<style>
	.diagram {
		margin: 2rem auto;
		font-family: var(--font-mono);
	}

	.comparison {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2rem;
	}

	.pr {
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 1rem 1.5rem;
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.pr.small {
		border-color: var(--foreground);
		border-width: 2px;
	}

	.pr.large {
		padding: 1.5rem 2rem;
	}

	.lines {
		font-size: 2rem;
		font-weight: 700;
		color: var(--foreground);
	}

	.pr.small .lines {
		font-size: 1.5rem;
	}

	.unit {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.type {
		font-size: 0.8rem;
		color: var(--muted-foreground);
		font-style: italic;
		margin-top: 0.5rem;
	}

	.effort {
		margin-top: 1rem;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.effort.easy {
		color: var(--muted-foreground);
	}

	.effort.hard {
		color: var(--foreground);
	}

	.operator {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.25rem;
	}

	.operator .label {
		font-size: 0.7rem;
		color: var(--muted-foreground);
	}

	.operator .symbol {
		font-size: 2rem;
		font-weight: 700;
		color: var(--foreground);
	}

	@media (max-width: 500px) {
		.comparison {
			gap: 1rem;
		}

		.pr {
			padding: 0.75rem 1rem;
		}

		.lines {
			font-size: 1.5rem;
		}
	}
</style>
