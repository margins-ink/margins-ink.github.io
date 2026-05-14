<script lang="ts">
	import CopyButton from '$lib/components/CopyButton.svelte';

	let query = $state('');
	let generatedLink = $state('');

	function generateLink() {
		if (!query.trim()) return;
		const baseUrl = window.location.origin;
		generatedLink = `${baseUrl}/lmllmtfy?q=${encodeURIComponent(query)}`;
	}

	function handleKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			generateLink();
		}
	}
</script>

<svelte:head>
	<title>Generate LMLLMTFY Link</title>
</svelte:head>

<div class="page">
	<div class="content">
		<h1>Let Me LLM That For You</h1>
		<p class="subtitle">Generate a link to teach someone how to ask Claude</p>

		<div class="input-group">
			<input
				type="text"
				bind:value={query}
				onkeydown={handleKeydown}
				placeholder="How do I use Claude?"
				class="query-input"
				autofocus
			/>
		</div>

		<button onclick={generateLink} class="generate-btn" disabled={!query.trim()}>
			Generate Link
		</button>

		{#if generatedLink}
			<div class="result-section">
				<div class="link-wrapper">
					<input
						type="text"
						readonly
						value={generatedLink}
						class="result-input"
						onclick={(e) => e.currentTarget.select()}
					/>
					<CopyButton text={generatedLink} />
				</div>

				<a href={generatedLink} target="_blank" rel="noopener noreferrer" class="preview-link">
					Preview →
				</a>
			</div>
		{/if}
	</div>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem 1rem;
		background: var(--background);
	}

	.content {
		max-width: 650px;
		width: 100%;
	}

	h1 {
		font-size: 2rem;
		font-weight: 400;
		margin-bottom: 0.5rem;
		color: var(--foreground);
		text-align: center;
		letter-spacing: -0.02em;
	}

	.subtitle {
		text-align: center;
		color: oklch(0.5 0.02 40);
		margin-bottom: 2.5rem;
		font-size: 0.95rem;
	}

	.input-group {
		margin-bottom: 1rem;
	}

	.query-input {
		width: 100%;
		padding: 0.875rem 1.125rem;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 1rem;
		border: 1.5px solid oklch(0.4 0.01 40);
		border-radius: 8px;
		background: var(--background);
		color: var(--foreground);
		transition: border-color 0.2s;
	}

	.query-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.generate-btn {
		width: 100%;
		padding: 0.875rem 1.5rem;
		font-family: system-ui, -apple-system, sans-serif;
		font-size: 0.95rem;
		font-weight: 500;
		background: var(--accent);
		color: var(--background);
		border: none;
		border-radius: 8px;
		cursor: pointer;
		transition: all 0.15s;
	}

	.generate-btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.generate-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.result-section {
		margin-top: 2rem;
		padding-top: 2rem;
		border-top: 1px solid oklch(0.4 0.01 40);
	}

	.link-wrapper {
		display: flex;
		gap: 0.5rem;
		margin-bottom: 1rem;
	}

	.result-input {
		flex: 1;
		padding: 0.75rem 1rem;
		font-family: 'Fira Code', monospace;
		font-size: 0.85rem;
		border: 1.5px solid oklch(0.4 0.01 40);
		border-radius: 8px;
		background: var(--background);
		color: var(--foreground);
		cursor: text;
	}

	.preview-link {
		display: inline-block;
		color: var(--accent);
		text-decoration: none;
		font-size: 0.9rem;
		transition: opacity 0.15s;
	}

	.preview-link:hover {
		opacity: 0.8;
	}

	@media (max-width: 640px) {
		h1 {
			font-size: 1.5rem;
		}

		.result-input {
			font-size: 0.75rem;
		}
	}
</style>
