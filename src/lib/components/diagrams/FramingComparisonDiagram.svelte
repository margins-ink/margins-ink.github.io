<script lang="ts">
	const comparisons = [
		{ old: 'queue priority auction', new: 'time-buyback' },
		{ old: 'adversarial negotiation', new: 'enabling benevolence' },
		{ old: '"what will they accept?"', new: '"worth their evening?"' }
	];
</script>

<div class="diagram">
	<div class="headers">
		<span class="header old">adversarial</span>
		<span class="header new">benevolent</span>
	</div>

	{#each comparisons as c}
		<div class="row">
			<span class="item old">{c.old}</span>
			<span class="arrow">→</span>
			<span class="item new">{c.new}</span>
		</div>
	{/each}
</div>

<style>
	.diagram {
		margin: 2rem auto;
		max-width: 500px;
		font-family: var(--font-mono);
	}

	.headers {
		display: flex;
		justify-content: space-between;
		padding: 0 1rem;
		margin-bottom: 1rem;
	}

	.header {
		font-size: 0.8rem;
		font-weight: 600;
	}

	.header.old {
		color: var(--muted-foreground);
	}

	.header.new {
		color: var(--foreground);
	}

	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.75rem 1rem;
		border-top: 1px dashed var(--border);
	}

	.row:last-child {
		border-bottom: 1px dashed var(--border);
	}

	.item {
		font-size: 0.85rem;
		flex: 1;
	}

	.item.old {
		color: var(--muted-foreground);
		text-align: left;
	}

	.item.new {
		color: var(--foreground);
		text-align: right;
	}

	.arrow {
		color: var(--muted-foreground);
		padding: 0 1rem;
		opacity: 0.5;
	}

	@media (max-width: 500px) {
		.item {
			font-size: 0.75rem;
		}

		.arrow {
			padding: 0 0.5rem;
		}
	}
</style>
