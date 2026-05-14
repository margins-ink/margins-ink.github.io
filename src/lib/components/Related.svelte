<script lang="ts">
	import GitHubLogo from './GitHubLogo.svelte';

	let {
		users = [],
		repos = []
	}: {
		users?: string[];
		repos?: string[];
	} = $props();

	const hasAny = $derived(users.length > 0 || repos.length > 0);
</script>

{#if hasAny}
	<section class="related" aria-label="Related GitHub references">
		<span class="label">Related</span>
		<ul>
			{#each users as user (user)}
				<li>
					<a
						class="chip user"
						href="https://github.com/{user}"
						target="_blank"
						rel="noopener noreferrer"
					>
						<img
							class="avatar"
							src="https://github.com/{user}.png?size=48"
							alt=""
							width="18"
							height="18"
							loading="lazy"
						/>
						<span>{user}</span>
					</a>
				</li>
			{/each}
			{#each repos as repo (repo)}
				<li>
					<a
						class="chip repo"
						href="https://github.com/{repo}"
						target="_blank"
						rel="noopener noreferrer"
					>
						<GitHubLogo size={13} />
						<span>{repo}</span>
					</a>
				</li>
			{/each}
		</ul>
	</section>
{/if}

<style>
	.related {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem 0.75rem;
		margin: -1rem 0 2rem;
		font-size: 0.8125rem;
		color: var(--text-tertiary);
	}

	.label {
		font-variant: all-small-caps;
		letter-spacing: 0.06em;
		color: var(--text-quaternary);
	}

	ul {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.1875rem 0.5rem 0.1875rem 0.25rem;
		border: 1px solid var(--border-subtle, rgba(127, 127, 127, 0.18));
		border-radius: 999px;
		color: var(--text-tertiary);
		text-decoration: none;
		transition:
			color 0.15s ease,
			border-color 0.15s ease,
			background-color 0.15s ease;
	}

	.chip.repo {
		padding-left: 0.5rem;
	}

	.chip:hover {
		color: var(--text-primary);
		border-color: var(--border-strong, rgba(127, 127, 127, 0.32));
		background-color: var(--surface-hover, rgba(127, 127, 127, 0.06));
	}

	.avatar {
		border-radius: 50%;
		display: block;
	}
</style>
