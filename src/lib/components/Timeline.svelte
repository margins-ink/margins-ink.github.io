<script lang="ts">
	import { thoughts, type Thought } from '$lib/thoughts';
	import { REPO_URL } from '$lib/github';
	import { renderTitle } from '$lib/title';
	import GitHubLogo from './GitHubLogo.svelte';

	type Group = { key: string; label: string; items: Thought[] };

	const MONTHS = [
		'January', 'February', 'March', 'April', 'May', 'June',
		'July', 'August', 'September', 'October', 'November', 'December'
	];

	function groupByMonth(items: Thought[]): Group[] {
		const dated = items.filter((t) => t.date);
		const undated = items.filter((t) => !t.date);

		const groups: Group[] = [];
		for (const item of dated) {
			const d = new Date(item.date!);
			const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
			const last = groups[groups.length - 1];
			if (last && last.key === key) {
				last.items.push(item);
			} else {
				groups.push({
					key,
					label: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
					items: [item]
				});
			}
		}
		if (undated.length) {
			groups.push({ key: 'undated', label: 'Undated', items: undated });
		}
		return groups;
	}

	function dayOf(date: string | undefined): string {
		if (!date) return '';
		const d = new Date(date);
		return String(d.getUTCDate()).padStart(2, '0');
	}

	const groups = groupByMonth(thoughts);
</script>

<div class="page">
	<header class="masthead">
		<h1 class="name">Margins</h1>
	</header>

	<section class="index">
		{#each groups as group (group.key)}
			<section class="group">
				<h2 class="group-label">{group.label}</h2>
				<ul class="entries">
					{#each group.items as item (item.route)}
						<li class="entry" class:draft={item.status === 'WIP'}>
							<a class="row" href={item.route}>
								<span class="day">{dayOf(item.date)}</span>
								<span class="title">{@html renderTitle(item.title)}</span>
								{#if item.status === 'WIP'}
									<span class="status">draft</span>
								{/if}
								<span class="reading-time">{item.readingTime} min</span>
							</a>
						</li>
					{/each}
				</ul>
			</section>
		{/each}
	</section>

	<footer class="colophon">
		<p>
			The most interesting things happen in the margins. Fermat wrote there that he had a proof too
			long to fit. The Talmud builds itself out of generations of commentary in the space around the
			text. Critical annotated editions of difficult books let you read with eyes open. Dense pages
			become legible through the notes that surround them.
		</p>
		<p>
			Margins respond to what is already on the page. They offer another angle, push back, think
			different.
		</p>
		<p class="meta">
			<a class="meta-link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
				<GitHubLogo size={12} />
				<span>Source on GitHub</span>
			</a>
		</p>
	</footer>
</div>

<style>
	.page {
		width: 100%;
		max-width: 100%;
		padding: 2rem 0 6rem;
	}

	.masthead {
		margin-bottom: 3.5rem;
	}

	.name {
		font-size: 1.375rem;
		font-weight: 550;
		letter-spacing: -0.025em;
		margin: 0;
		color: var(--text-primary);
		line-height: 1.3;
	}

	.index {
		display: flex;
		flex-direction: column;
		gap: 2.75rem;
	}

	.group-label {
		font-size: 0.6875rem;
		font-weight: 500;
		color: var(--text-quaternary);
		text-transform: uppercase;
		letter-spacing: 0.12em;
		margin: 0 0 0.75rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.entries {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.entry {
		margin: 0;
		padding: 0;
	}

	.entry.draft {
		opacity: 0.5;
		transition: opacity 0.15s ease;
	}

	.entry.draft:hover {
		opacity: 1;
	}

	.row {
		display: flex;
		align-items: baseline;
		gap: 0.875rem;
		padding: 0.55rem 0.5rem;
		margin: 0 -0.5rem;
		border-radius: 4px;
		text-decoration: none;
		color: var(--text-secondary);
		transition: background-color 0.15s ease, color 0.15s ease;
	}

	.row:hover {
		background-color: var(--background-secondary);
	}

	.day {
		flex-shrink: 0;
		width: 1.75rem;
		font-family: var(--font-mono);
		font-size: 0.75rem;
		color: var(--text-quaternary);
		font-variant-numeric: tabular-nums;
		text-align: right;
	}

	.title {
		flex: 1;
		min-width: 0;
		font-size: 0.9375rem;
		font-weight: 450;
		color: var(--text-primary);
		letter-spacing: -0.01em;
		line-height: 1.4;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.row:hover .title {
		color: var(--text-primary);
	}

	.title :global(code) {
		font-size: 0.85em;
		padding: 0.1em 0.3em;
	}

	.status {
		flex-shrink: 0;
		font-size: 0.625rem;
		font-weight: 500;
		color: var(--text-quaternary);
		text-transform: uppercase;
		letter-spacing: 0.08em;
	}

	.reading-time {
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 0.6875rem;
		color: var(--text-quaternary);
		font-variant-numeric: tabular-nums;
	}

	.colophon {
		margin-top: 6rem;
		max-width: 36rem;
		color: var(--text-quaternary);
		font-size: 0.8125rem;
		line-height: 1.65;
		letter-spacing: -0.005em;
	}

	.colophon p {
		margin: 0 0 0.85rem;
	}

	.colophon p:last-child {
		margin-bottom: 0;
	}

	.colophon p.meta {
		margin-top: 1.5rem;
	}

	.meta-link {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--text-quaternary);
		font-size: 0.75rem;
		text-decoration: none;
		transition: color 0.15s ease;
	}

	.meta-link:hover {
		color: var(--text-tertiary);
	}

	@media (max-width: 640px) {
		.page {
			padding: 1rem 0 4rem;
		}

		.masthead {
			margin-bottom: 2.5rem;
		}

		.name {
			font-size: 1.25rem;
		}

		.index {
			gap: 2rem;
		}

		.row {
			gap: 0.75rem;
		}

		.title {
			font-size: 0.875rem;
		}

		.reading-time {
			display: none;
		}

		.colophon {
			margin-top: 4rem;
			font-size: 0.78125rem;
		}
	}
</style>
