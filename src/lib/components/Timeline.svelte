<script lang="ts">
	import { thoughts } from '$lib/thoughts';
	import ArticleCard from './ArticleCard.svelte';
</script>

<div class="page">
	<header class="masthead">
		<h1 class="name">Margins</h1>
		<p class="bio">Writing about software, systems, and ideas.</p>
	</header>

	<section class="gallery">
		{#each thoughts as thought}
			<ArticleCard
				title={thought.title}
				route={thought.route}
				status={thought.status}
				visual={thought.visual}
				username={thought.username}
				readingTime={thought.readingTime}
			/>
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
	</footer>
</div>

<style>
	.page {
		width: 100%;
		max-width: 100%;
		padding: 2rem 0 6rem;
	}

	.masthead {
		margin-bottom: 3rem;
	}

	.name {
		font-size: 1.375rem;
		font-weight: 550;
		letter-spacing: -0.025em;
		margin: 0;
		color: var(--text-primary);
		line-height: 1.3;
	}

	.bio {
		font-size: 0.9375rem;
		color: var(--text-tertiary);
		margin: 0.375rem 0 0;
		font-weight: 400;
		letter-spacing: -0.01em;
	}

	.gallery {
		display: grid;
		grid-template-columns: repeat(2, 1fr);
		gap: 1.25rem;
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

	@media (max-width: 640px) {
		.page {
			padding: 1rem 0 4rem;
		}

		.name {
			font-size: 1.25rem;
		}

		.bio {
			font-size: 0.875rem;
		}

		.masthead {
			margin-bottom: 2rem;
		}

		.gallery {
			grid-template-columns: 1fr;
			gap: 1rem;
		}

		.colophon {
			margin-top: 4rem;
			font-size: 0.78125rem;
		}
	}
</style>
