<script>
	export let images = [];
	export let alt = 'Photo';
	export let caption = '';
</script>

<div class="photo-stack">
	{#each images as image, i}
		<img src={image} {alt} class="photo photo-{i}" />
	{/each}
</div>
{#if caption}
	<p class="caption">{caption}</p>
{/if}

<style>
	.photo-stack {
		position: relative;
		width: 100%;
		max-width: 700px;
		margin: 1.5rem auto;
		height: 450px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.photo {
		position: absolute;
		max-width: 45%;
		height: auto;
		border-radius: 8px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
		transition: z-index 0.3s ease;
	}

	.photo-0 {
		transform: rotate(-8deg) translate(-70px, -30px);
		z-index: 1;
	}

	.photo-1 {
		transform: rotate(3deg) translate(0px, 20px);
		z-index: 2;
	}

	.photo-2 {
		transform: rotate(-4deg) translate(65px, -10px);
		z-index: 3;
	}

	.photo:hover {
		z-index: 10;
	}

	.caption {
		text-align: center;
		font-size: 0.9rem;
		color: var(--muted-foreground);
		margin-top: 0.5rem;
		font-style: italic;
	}

	@media (max-width: 900px) {
		.photo-stack {
			width: 100%;
			max-width: 500px;
			height: 350px;
		}

		.photo {
			max-width: 55%;
		}

		.photo-0 {
			transform: rotate(-6deg) translate(-40px, -20px);
		}

		.photo-1 {
			transform: rotate(2deg) translate(0px, 15px);
		}

		.photo-2 {
			transform: rotate(-3deg) translate(35px, -5px);
		}
	}
</style>
