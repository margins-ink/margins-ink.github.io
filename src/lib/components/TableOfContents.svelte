<script lang="ts">
	import { onMount } from 'svelte';

	interface TocItem {
		id: string;
		text: string;
		level: number;
	}

	const { toc }: { toc: TocItem[] } = $props();

	let activeId = $state<string | null>(null);

	onMount(() => {
		const headings = toc.map((item) => document.getElementById(item.id)).filter(Boolean) as HTMLElement[];
		if (headings.length === 0) return;

		// Track which headings are currently visible
		const visibleHeadings = new Set<string>();

		// Set initial active heading based on scroll position
		const updateActiveFromScroll = () => {
			// Find the heading closest to the top of the viewport
			let closestHeading: HTMLElement | null = null;
			let closestDistance = Infinity;

			for (const heading of headings) {
				const rect = heading.getBoundingClientRect();
				// Consider headings that are above or near the top of viewport
				const distance = Math.abs(rect.top - 100);
				if (rect.top <= 150 && distance < closestDistance) {
					closestDistance = distance;
					closestHeading = heading;
				}
			}

			// If no heading is near top, use first visible or first heading
			if (!closestHeading) {
				closestHeading = headings.find((h) => visibleHeadings.has(h.id)) || headings[0];
			}

			if (closestHeading) {
				activeId = closestHeading.id;
			}
		};

		const observer = new IntersectionObserver(
			(entries) => {
				entries.forEach((entry) => {
					if (entry.isIntersecting) {
						visibleHeadings.add(entry.target.id);
					} else {
						visibleHeadings.delete(entry.target.id);
					}
				});
				updateActiveFromScroll();
			},
			{
				rootMargin: '-80px 0px -60% 0px',
				threshold: 0
			}
		);

		headings.forEach((heading) => observer.observe(heading));

		// Initial update
		updateActiveFromScroll();

		return () => observer.disconnect();
	});
</script>

{#if toc && toc.length > 0}
	<nav class="toc">
		<ul>
			{#each toc as item}
				<li class="level-{item.level}" class:active={activeId === item.id}>
					<a href="#{item.id}" onclick={() => (activeId = item.id)}>{item.text}</a>
				</li>
			{/each}
		</ul>
	</nav>
{/if}

<style>
	.toc {
		position: sticky;
		top: 5rem;
		max-height: calc(100vh - 10rem);
		overflow-y: auto;
		padding-right: 1rem;
	}

	.toc ul {
		margin: 0;
		padding: 0;
		list-style: none;
		border-left: 1px solid var(--border);
	}

	.toc li {
		margin: 0;
		line-height: 1.5;
	}

	.toc li.level-3 {
		padding-left: 0.75rem;
	}

	.toc a {
		display: block;
		padding: 0.375rem 0 0.375rem 1rem;
		color: var(--text-quaternary);
		text-decoration: none;
		font-size: 0.8125rem;
		transition: all 0.15s ease;
		border-left: 2px solid transparent;
		margin-left: -1px;
	}

	.toc a:hover {
		color: var(--text-secondary);
	}

	.toc li.active > a {
		color: var(--text-primary);
		border-left-color: var(--text-primary);
	}
</style>
