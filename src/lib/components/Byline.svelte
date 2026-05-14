<script lang="ts">
	let {
		username,
		date,
		readingTime
	}: { username?: string; date?: string; readingTime?: number } = $props();

	function formatDate(d: string): string {
		const parsed = new Date(d);
		if (isNaN(parsed.getTime())) return d;
		return parsed.toLocaleDateString('en-US', {
			month: 'long',
			day: 'numeric',
			year: 'numeric'
		});
	}
</script>

{#if username}
	<header class="byline">
		<a
			class="author"
			href="https://github.com/{username}"
			target="_blank"
			rel="noopener noreferrer"
		>
			<img
				class="avatar"
				src="https://github.com/{username}.png?size=96"
				alt="{username} avatar"
				width="28"
				height="28"
				loading="lazy"
			/>
			<span class="name">{username}</span>
		</a>
		{#if date}
			<span class="sep">·</span>
			<time datetime={date}>{formatDate(date)}</time>
		{/if}
		{#if readingTime}
			<span class="sep">·</span>
			<span class="reading-time">{readingTime} min</span>
		{/if}
	</header>
{/if}

<style>
	.byline {
		display: flex;
		align-items: center;
		flex-wrap: wrap;
		gap: 0.5rem;
		font-size: 0.875rem;
		color: var(--text-tertiary);
		margin-bottom: 1.75rem;
	}

	.author {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		text-decoration: none;
		color: inherit;
	}

	.author:hover .name {
		color: var(--text-primary);
	}

	.avatar {
		border-radius: 50%;
		display: block;
	}

	.name {
		font-weight: 500;
		color: var(--text-secondary);
		transition: color 0.15s ease;
	}

	.sep {
		opacity: 0.5;
		user-select: none;
	}

	time,
	.reading-time {
		color: var(--text-tertiary);
	}
</style>
