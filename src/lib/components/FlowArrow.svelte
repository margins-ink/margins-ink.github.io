<script lang="ts">
	const { bidirectional = false, label }: { bidirectional?: boolean; label?: string } = $props();
</script>

<div class="arrow-container">
	{#if label}
		<span class="label">{label}</span>
	{/if}
	<div class="arrow" class:bidirectional>
		{#if bidirectional}
			<svg viewBox="0 0 100 20" xmlns="http://www.w3.org/2000/svg">
				<!-- Top arrow pointing right -->
				<line x1="0" y1="5" x2="100" y2="5" stroke="currentColor" stroke-width="2" />
				<polygon points="100,5 94,2 94,8" fill="currentColor" />
				<!-- Bottom arrow pointing left -->
				<line x1="100" y1="15" x2="0" y2="15" stroke="currentColor" stroke-width="2" />
				<polygon points="0,15 6,12 6,18" fill="currentColor" />
			</svg>
		{:else}
			<svg viewBox="0 0 20 40" xmlns="http://www.w3.org/2000/svg">
				<line x1="10" y1="0" x2="10" y2="40" stroke="currentColor" stroke-width="2" />
				<polygon points="10,40 6,34 14,34" fill="currentColor" />
			</svg>
		{/if}
	</div>
</div>

<style>
	.arrow-container {
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 0.5rem;
		position: relative;
	}

	.arrow {
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.arrow:not(.bidirectional) {
		height: 2.5rem;
		width: 1.5rem;
	}

	.arrow.bidirectional {
		width: 6rem;
		height: 1.5rem;
	}

	.label {
		position: absolute;
		top: -0.5rem;
		background: var(--bg, white);
		padding: 0 0.25rem;
		font-size: 0.75rem;
	}

	svg {
		width: 100%;
		height: 100%;
	}
</style>
