<script lang="ts">
	interface Comment {
		author: string;
		role?: 'Author' | 'Member' | 'Owner';
		avatar?: string;
		timestamp: string;
		content: string;
	}

	let {
		title,
		number,
		status = 'closed',
		repo,
		branch,
		comments
	}: {
		title: string;
		number: number;
		status?: 'open' | 'closed' | 'merged';
		repo: string;
		branch: string;
		comments: Comment[];
	} = $props();

	const statusColors = {
		open: '#238636',
		closed: '#da3633',
		merged: '#8957e5'
	};

	const statusLabels = {
		open: 'Open',
		closed: 'Closed',
		merged: 'Merged'
	};
</script>

<div class="github-pr">
	<div class="pr-header">
		<h3 class="pr-title">
			{title}
			<span class="pr-number">#{number}</span>
		</h3>
		<div class="pr-meta">
			<span class="pr-status" style="background: {statusColors[status]}">
				{statusLabels[status]}
			</span>
			<span class="pr-branch">{branch} → {repo}</span>
		</div>
	</div>

	<div class="pr-comments">
		{#each comments as comment}
			<div class="comment">
				<div class="comment-header">
					<span class="comment-author">
						{comment.author}
						{#if comment.role}
							<span class="author-role">{comment.role}</span>
						{/if}
					</span>
					<span class="comment-timestamp">{comment.timestamp}</span>
				</div>
				<div class="comment-body">
					{@html comment.content}
				</div>
			</div>
		{/each}
	</div>
</div>

<style>
	.github-pr {
		background: var(--card);
		border: 1px solid var(--border);
		border-radius: 8px;
		margin: 2rem 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial,
			sans-serif;
		font-size: 0.875rem;
		overflow: hidden;
	}

	.pr-header {
		padding: 1rem 1.25rem;
		border-bottom: 1px solid var(--border);
		background: var(--muted);
	}

	.pr-title {
		font-size: 1.25rem;
		font-weight: 600;
		margin: 0 0 0.5rem 0;
		color: var(--foreground);
	}

	.pr-number {
		color: var(--muted-foreground);
		font-weight: 400;
	}

	.pr-meta {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-wrap: wrap;
	}

	.pr-status {
		display: inline-flex;
		align-items: center;
		padding: 0.25rem 0.75rem;
		border-radius: 2rem;
		font-size: 0.75rem;
		font-weight: 600;
		color: white;
		text-transform: uppercase;
	}

	.pr-branch {
		color: var(--muted-foreground);
		font-family: var(--font-mono);
		font-size: 0.8rem;
	}

	.pr-comments {
		padding: 1rem;
	}

	.comment {
		border: 1px solid var(--border);
		border-radius: 6px;
		margin-bottom: 1rem;
		overflow: hidden;
	}

	.comment:last-child {
		margin-bottom: 0;
	}

	.comment-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 0.75rem 1rem;
		background: var(--muted);
		border-bottom: 1px solid var(--border);
	}

	.comment-author {
		font-weight: 600;
		color: var(--foreground);
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.author-role {
		display: inline-block;
		padding: 0.125rem 0.5rem;
		border-radius: 2rem;
		font-size: 0.7rem;
		font-weight: 600;
		background: var(--accent);
		color: var(--accent-foreground);
		text-transform: uppercase;
	}

	.comment-timestamp {
		color: var(--muted-foreground);
		font-size: 0.8rem;
	}

	.comment-body {
		padding: 1rem;
		line-height: 1.6;
		color: var(--foreground);
	}

	.comment-body :global(p) {
		margin: 0 0 0.75rem 0;
	}

	.comment-body :global(p:last-child) {
		margin-bottom: 0;
	}

	.comment-body :global(ul) {
		margin: 0.5rem 0;
		padding-left: 1.5rem;
	}

	.comment-body :global(li) {
		margin-bottom: 0.25rem;
	}

	.comment-body :global(code) {
		background: var(--code-bg);
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
		font-family: var(--font-mono);
		font-size: 0.85em;
	}

	@media (max-width: 640px) {
		.pr-header {
			padding: 0.75rem 1rem;
		}

		.pr-title {
			font-size: 1.1rem;
		}

		.comment-header {
			flex-direction: column;
			align-items: flex-start;
			gap: 0.25rem;
		}

		.comment-body {
			padding: 0.75rem;
			font-size: 0.85rem;
		}
	}
</style>
