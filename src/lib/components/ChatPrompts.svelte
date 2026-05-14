<script lang="ts">
	let { prompts }: { prompts: string[] } = $props();

	let copiedIndex = $state<number | null>(null);
	let resetTimer: ReturnType<typeof setTimeout> | null = null;

	async function copy(prompt: string, index: number) {
		try {
			await navigator.clipboard.writeText(prompt);
			copiedIndex = index;
			if (resetTimer) clearTimeout(resetTimer);
			resetTimer = setTimeout(() => {
				copiedIndex = null;
			}, 1500);
		} catch (err) {
			console.error('Failed to copy prompt:', err);
		}
	}
</script>

{#if prompts && prompts.length > 0}
	<ul class="chat-prompts" aria-label="Prompts to ask">
		{#each prompts as prompt, i}
			<li>
				<button type="button" onclick={() => copy(prompt, i)}>
					<span class="text">{prompt}</span>
					<span class="hint" aria-hidden="true">
						{copiedIndex === i ? 'copied' : 'copy'}
					</span>
				</button>
			</li>
		{/each}
	</ul>
{/if}

<style>
	.chat-prompts {
		list-style: none;
		margin: 0 0 2.5rem;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		font-size: 0.9375rem;
	}

	button {
		display: inline-flex;
		align-items: baseline;
		gap: 0.6rem;
		padding: 0;
		margin: 0;
		background: none;
		border: none;
		font: inherit;
		text-align: left;
		color: var(--text-tertiary);
		cursor: pointer;
		transition: color 0.15s ease;
	}

	button:hover,
	button:focus-visible {
		color: var(--text-primary);
		outline: none;
	}

	.hint {
		font-size: 0.75rem;
		color: var(--text-quaternary);
		opacity: 0;
		transition: opacity 0.15s ease;
		font-variant: all-small-caps;
		letter-spacing: 0.05em;
	}

	button:hover .hint,
	button:focus-visible .hint {
		opacity: 1;
	}
</style>
