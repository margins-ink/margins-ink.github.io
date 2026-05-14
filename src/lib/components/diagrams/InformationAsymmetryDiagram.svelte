<script lang="ts">
	const parties = [
		{
			name: 'Submitter',
			knows: ['urgency', 'commercial value'],
			unknown: ['complexity', 'queue depth', 'fair rate']
		},
		{
			name: 'Reviewer',
			knows: ['complexity', 'their capacity'],
			unknown: ['willingness to pay']
		}
	];
</script>

<div class="diagram">
	{#each parties as party}
		<div class="row">
			<div class="party">{party.name}</div>
			<div class="divider"></div>
			<div class="info-col">
				<span class="label">knows</span>
				<span class="items">{party.knows.join(', ')}</span>
			</div>
			<div class="divider"></div>
			<div class="info-col">
				<span class="label muted">doesn't know</span>
				<span class="items muted">{party.unknown.join(', ')}</span>
			</div>
		</div>
	{/each}
	<div class="caption">information asymmetry</div>
</div>

<style>
	.diagram {
		margin: 2rem auto;
		max-width: 600px;
		font-family: var(--font-mono);
	}

	.row {
		display: flex;
		align-items: center;
		gap: 1.5rem;
		padding: 1.5rem 0;
	}

	.party {
		font-size: 1.1rem;
		font-weight: 600;
		min-width: 100px;
		color: var(--foreground);
	}

	.divider {
		width: 1px;
		height: 50px;
		background: var(--border);
	}

	.info-col {
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		min-width: 180px;
	}

	.label {
		font-size: 0.75rem;
		color: var(--muted-foreground);
	}

	.items {
		font-size: 0.9rem;
		color: var(--foreground);
	}

	.items.muted {
		color: var(--muted-foreground);
	}

	.caption {
		text-align: center;
		font-size: 0.8rem;
		color: var(--muted-foreground);
		margin-top: 1rem;
	}

	@media (max-width: 600px) {
		.row {
			flex-wrap: wrap;
			gap: 1rem;
		}

		.divider {
			display: none;
		}

		.info-col {
			min-width: 140px;
		}
	}
</style>
