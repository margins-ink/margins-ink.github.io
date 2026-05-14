<script lang="ts">
	import FlowBox from './FlowBox.svelte';
	import FlowArrow from './FlowArrow.svelte';
</script>

<div class="dependency-graph">
	<!-- Components layer -->
	<div class="components-row">
		<div class="component-box">
			<h4>Component A</h4>
			<code>f(width)</code>
			<p>→ Array2&lt;Cell&gt;</p>
		</div>
		<div class="component-box">
			<h4>Component B</h4>
			<code>f(width)</code>
			<p>→ Array2&lt;Cell&gt;</p>
		</div>
		<div class="component-box">
			<h4>Component C</h4>
			<code>f(width, data)</code>
			<p>→ Array2&lt;Cell&gt;</p>
		</div>
	</div>

	<FlowArrow />

	<!-- Buffer layer -->
	<FlowBox>
		<h3>ScrollView Buffer</h3>
		<p>Concatenated Array2&lt;Cell&gt; from all components</p>
	</FlowBox>

	<FlowArrow />

	<!-- Display layer -->
	<FlowBox>
		<h3>Display</h3>
		<code>clip(Buffer, scroll_offset, viewport_height)</code>
	</FlowBox>
</div>

<style>
	.dependency-graph {
		display: flex;
		flex-direction: column;
		gap: 0;
		margin: 2rem 0;
		max-width: 100%;
	}

	.components-row {
		display: flex;
		gap: 1rem;
		justify-content: center;
		flex-wrap: wrap;
	}

	.component-box {
		border: 1.5px solid currentColor;
		border-radius: 0.375rem;
		padding: 1rem;
		text-align: center;
		min-width: 140px;
		flex: 1;
		max-width: 200px;
	}

	.component-box h4 {
		margin: 0 0 0.5rem 0;
		font-size: 0.875rem;
		font-weight: 600;
	}

	.component-box code {
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	.component-box p {
		margin: 0.25rem 0 0 0;
		font-size: 0.75rem;
		color: var(--text-muted);
	}

	@media (max-width: 640px) {
		.components-row {
			flex-direction: column;
			align-items: stretch;
		}

		.component-box {
			max-width: 100%;
		}
	}
</style>
