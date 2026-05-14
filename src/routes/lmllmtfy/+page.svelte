<script lang="ts">
	import { onMount } from 'svelte';
	import TypingAnimation from '$lib/components/TypingAnimation.svelte';

	let query = $state('');

	onMount(() => {
		const params = new URLSearchParams(window.location.search);
		query = params.get('q') || 'How do I use Claude?';
	});

	function handleTypingComplete() {
		setTimeout(() => {
			window.location.href = `https://claude.ai?q=${encodeURIComponent(query)}`;
		}, 1000);
	}
</script>

<svelte:head>
	<title>Let Me LLM That For You</title>
</svelte:head>

<div class="page">
	<div class="greeting">
		<span class="icon">✱</span> Let me LLM that for you, friend
	</div>

	<div class="search-container">
		<div class="search-box">
			<TypingAnimation text={query} onComplete={handleTypingComplete} />
		</div>
	</div>
</div>

<style>
	.page {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 0;
		margin: 0;
	}

	.greeting {
		font-size: 3.5rem;
		font-weight: 300;
		color: #e8e8e4;
		margin-top: 20vh;
		margin-bottom: 4rem;
		text-align: center;
		letter-spacing: -0.03em;
		line-height: 1.2;
	}

	.icon {
		color: #cc785c;
		font-size: 3rem;
		vertical-align: middle;
		display: inline-block;
	}

	.search-container {
		width: 100%;
		max-width: 1000px;
		padding: 0 2rem;
	}

	.search-box {
		background: #30302e;
		border: 1px solid #3c3c38;
		border-radius: 28px;
		padding: 1.5rem 2rem;
		min-height: 4rem;
		transition: all 0.2s;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
	}

	.search-box:focus-within {
		border-color: #4a4a44;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
	}

	@media (max-width: 768px) {
		.greeting {
			font-size: 2.25rem;
			margin-top: 15vh;
			margin-bottom: 3rem;
		}

		.icon {
			font-size: 2rem;
		}

		.search-container {
			padding: 0 1.5rem;
		}
	}

	@media (max-width: 640px) {
		.greeting {
			font-size: 1.75rem;
			margin-top: 12vh;
		}

		.icon {
			font-size: 1.5rem;
		}

		.search-container {
			padding: 0 1rem;
		}

		.search-box {
			padding: 1.25rem 1.5rem;
			border-radius: 24px;
		}
	}
</style>
