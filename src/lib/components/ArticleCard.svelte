<script lang="ts">
	import type { ComponentType } from 'svelte';
	import { Default } from './visuals';
	import { renderTitle } from '$lib/title';

	interface Props {
		title: string;
		route: string;
		status?: 'WIP' | 'complete';
		visual?: ComponentType;
		username?: string;
		readingTime: number;
	}

	const { title, route, status, visual = Default, username, readingTime }: Props = $props();
	const titleHtml = $derived(renderTitle(title));

	let hovered = $state(false);
</script>

<a
	href={route}
	class="card"
	class:draft={status === 'WIP'}
	onmouseenter={() => (hovered = true)}
	onmouseleave={() => (hovered = false)}
>
	<div class="visual-container">
		<svelte:component this={visual} {hovered} />
	</div>
	<div class="content">
		{#if username}
			<img
				class="avatar"
				src="https://github.com/{username}.png?size=80"
				alt="{username} avatar"
				loading="lazy"
				width="20"
				height="20"
			/>
		{/if}
		<div class="text-row">
			<div class="title-row">
				<h3 class="title">{@html titleHtml}</h3>
				{#if status === 'WIP'}
					<span class="status">Draft</span>
				{/if}
			</div>
			<span class="reading-time">{readingTime} min</span>
		</div>
	</div>
</a>

<style>
	.card {
		display: flex;
		flex-direction: column;
		text-decoration: none;
		border-radius: 8px;
		overflow: hidden;
		background: var(--surface);
		border: 1px solid var(--border);
		transition: all 0.2s ease;
	}

	.card:hover {
		border-color: var(--text-quaternary);
	}

	.card.draft {
		opacity: 0.55;
	}

	.card.draft:hover {
		opacity: 1;
	}

	.visual-container {
		aspect-ratio: 5 / 3;
		background: var(--background-secondary);
		padding: 1rem;
		transition: background 0.2s ease;
	}

	.card:hover .visual-container {
		background: var(--background);
	}

	.content {
		padding: 0.625rem 0.875rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.avatar {
		width: 18px;
		height: 18px;
		border-radius: 50%;
		flex-shrink: 0;
		background: var(--background-secondary);
	}

	.text-row {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 0.5rem;
		min-width: 0;
		flex: 1;
	}

	.title-row {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
		min-width: 0;
	}

	.title {
		font-size: 0.8125rem;
		font-weight: 450;
		color: var(--text-secondary);
		margin: 0;
		letter-spacing: -0.01em;
		line-height: 1.2;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.status {
		font-size: 0.625rem;
		font-weight: 500;
		color: var(--text-quaternary);
		background: var(--background-secondary);
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		flex-shrink: 0;
	}

	.reading-time {
		font-size: 0.6875rem;
		color: var(--text-quaternary);
		flex-shrink: 0;
	}
</style>
