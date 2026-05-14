<script lang="ts">
	import FlowBox from './FlowBox.svelte';
	import FlowArrow from './FlowArrow.svelte';
</script>

<div class="flow-diagram">
	<FlowBox>
		<h3>1. You redraw everything each frame</h3>
	</FlowBox>

	<FlowArrow />

	<FlowBox>
		<h3>2. Ratatui diffs automatically</h3>
		<div class="buffers">
			<div class="buffer">
				<h4>Current Buffer</h4>
				<p>(just drawn)</p>
			</div>
			<FlowArrow bidirectional label="diff" />
			<div class="buffer">
				<h4>Previous Buffer</h4>
				<p>(last frame)</p>
			</div>
		</div>
	</FlowBox>

	<FlowArrow />

	<FlowBox>
		<h3>3. Only changes are sent to terminal</h3>
		<p>Cell (10,5): 'A' → 'B' ✓ &nbsp; Cell (10,6): 'X' → 'X' ✗ &nbsp; Cell (10,7): ' ' → '!' ✓</p>
	</FlowBox>
</div>

<style>
	.flow-diagram {
		display: flex;
		flex-direction: column;
		gap: 0;
		margin: 2rem 0;
		max-width: 100%;
	}

	.buffers {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-top: 1rem;
		justify-content: center;
	}

	.buffer {
		border: 1.5px solid currentColor;
		border-radius: 0.25rem;
		padding: 1rem;
		min-width: 140px;
	}

	.buffer h4 {
		margin: 0;
		font-size: 0.875rem;
		font-weight: 500;
	}

	.buffer p {
		margin: 0.25rem 0 0 0;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	@media (max-width: 640px) {
		.buffers {
			flex-direction: column;
		}

		.buffer {
			min-width: 100px;
		}
	}
</style>
