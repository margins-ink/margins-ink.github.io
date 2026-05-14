<script lang="ts">
	import { getRefs } from './index.js';
	const refs = getRefs();
</script>

{#if refs.length > 0}
	<section class="references">
		<h2>References</h2>
		<ol>
			{#each refs as ref}
				<li id={`ref-${ref.id}`}>
					<a href={ref.url} target="_blank" rel="noopener noreferrer">{ref.title}</a>{#if ref.note}<span
							class="note"
						>
							{ref.note}</span
						>{/if}
				</li>
			{/each}
		</ol>
	</section>
{/if}

<style>
	.references {
		margin-top: 3rem;
		padding-top: 1.5rem;
		border-top: 1px solid var(--border, var(--text-quaternary));
	}

	.references h2 {
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--text-tertiary);
	}

	.references ol {
		padding-left: 1.6em;
		margin: 0;
	}

	.references li {
		font-size: 0.92rem;
		line-height: 1.5;
		margin-bottom: 0.45rem;
		color: var(--text-secondary);
		scroll-margin-top: 5rem;
	}

	.references li:target {
		background: var(--bg-highlight, rgba(180, 145, 0, 0.12));
		transition: background 0.25s ease;
	}

	.references a {
		color: var(--text-primary);
		text-decoration: none;
		border-bottom: 1px solid var(--text-quaternary);
	}

	.references a:hover {
		border-bottom-color: var(--text-primary);
	}

	.note {
		color: var(--text-tertiary);
		font-size: 0.88em;
	}
</style>
