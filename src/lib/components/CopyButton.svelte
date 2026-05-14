<script lang="ts">
	interface Props {
		text: string;
	}

	let { text }: Props = $props();

	let copied = $state(false);

	async function copy() {
		try {
			await navigator.clipboard.writeText(text);
			copied = true;
			setTimeout(() => {
				copied = false;
			}, 2000);
		} catch (err) {
			console.error('Failed to copy:', err);
		}
	}
</script>

<button onclick={copy} class="copy-btn" title="Copy to clipboard">
	{copied ? '✓' : '📋'}
</button>

<style>
	.copy-btn {
		padding: 0.75rem 1rem;
		background: var(--accent);
		color: var(--background);
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-size: 1.2rem;
		transition: all 0.2s;
		min-width: 3rem;
	}

	.copy-btn:hover {
		background: oklch(0.55 0.1 60);
		transform: translateY(-2px);
	}
</style>
