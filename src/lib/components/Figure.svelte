<script lang="ts">
	let {
		src,
		alt,
		caption,
		wide = false
	}: { src: string; alt: string; caption?: string; wide?: boolean } = $props();
</script>

<figure class:wide>
	<img {src} {alt} loading="lazy" />
	{#if caption}<figcaption>{caption}</figcaption>{/if}
</figure>

<style>
	figure {
		margin: 1.75rem 0;
	}

	figure.wide {
		margin-left: calc(-1 * var(--prose-pad, 0));
		margin-right: calc(-1 * var(--prose-pad, 0));
	}

	img {
		width: 100%;
		height: auto;
		display: block;
		border: 1px solid var(--text-quaternary);
		border-radius: 6px;
	}

	figcaption {
		margin-top: 0.6rem;
		font-size: 0.85rem;
		line-height: 1.4;
		color: var(--text-tertiary);
		text-align: center;
		font-style: italic;
	}
</style>
