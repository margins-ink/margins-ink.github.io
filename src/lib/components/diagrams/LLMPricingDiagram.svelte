<script lang="ts">
	const factors = [
		{ label: 'base (lines, files)', value: '$40' },
		{ label: 'complexity (auth layer)', value: '+$30' },
		{ label: 'repo activity premium', value: '+$15' }
	];
</script>

<div class="diagram">
	<div class="estimate-box">
		<div class="title">LLM estimate</div>

		{#each factors as factor}
			<div class="factor">
				<span class="label">{factor.label}</span>
				<span class="value">{factor.value}</span>
			</div>
		{/each}

		<div class="divider"></div>

		<div class="total">
			<span class="label">suggested</span>
			<span class="value">$85</span>
		</div>
	</div>

	<div class="arrow">→</div>

	<div class="result-box">
		<div class="result-label">bounty</div>
		<div class="result-value">$85</div>
	</div>
</div>

<div class="confidence">72% confidence</div>

<style>
	.diagram {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 2rem;
		margin: 2rem auto;
		font-family: var(--font-mono);
	}

	.estimate-box {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1.25rem 1.5rem;
		min-width: 220px;
	}

	.title {
		font-weight: 600;
		font-size: 0.9rem;
		margin-bottom: 1rem;
		color: var(--foreground);
	}

	.factor {
		display: flex;
		justify-content: space-between;
		gap: 2rem;
		padding: 0.4rem 0;
	}

	.factor .label {
		font-size: 0.8rem;
		color: var(--muted-foreground);
	}

	.factor .value {
		font-size: 0.8rem;
		color: var(--foreground);
	}

	.divider {
		height: 1px;
		background: var(--border);
		margin: 0.75rem 0;
	}

	.total {
		display: flex;
		justify-content: space-between;
		gap: 2rem;
	}

	.total .label {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--foreground);
	}

	.total .value {
		font-size: 1rem;
		font-weight: 700;
		color: var(--foreground);
	}

	.arrow {
		font-size: 2rem;
		color: var(--foreground);
	}

	.result-box {
		background: var(--foreground);
		color: var(--background);
		border-radius: 4px;
		padding: 1.25rem 2rem;
		text-align: center;
	}

	.result-label {
		font-size: 0.85rem;
		margin-bottom: 0.25rem;
	}

	.result-value {
		font-size: 1.75rem;
		font-weight: 700;
	}

	.confidence {
		text-align: center;
		font-family: var(--font-mono);
		font-size: 0.8rem;
		color: var(--muted-foreground);
		margin-top: 0.5rem;
	}

	@media (max-width: 550px) {
		.diagram {
			flex-direction: column;
			gap: 1rem;
		}

		.arrow {
			transform: rotate(90deg);
		}
	}
</style>
