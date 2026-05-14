<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		text: string;
		speed?: number;
		onComplete?: () => void;
	}

	let { text, speed = 100, onComplete }: Props = $props();

	let displayText = $state('');
	let cursorVisible = $state(true);

	onMount(() => {
		let currentIndex = 0;

		const typingInterval = setInterval(() => {
			if (currentIndex < text.length) {
				displayText = text.slice(0, currentIndex + 1);
				currentIndex++;
			} else {
				clearInterval(typingInterval);
				onComplete?.();
			}
		}, speed);

		const cursorInterval = setInterval(() => {
			cursorVisible = !cursorVisible;
		}, 530);

		return () => {
			clearInterval(typingInterval);
			clearInterval(cursorInterval);
		};
	});
</script>

<div class="typing-container">
	<span class="typed-text">{displayText}</span>
	<span class="cursor" class:visible={cursorVisible}>|</span>
</div>

<style>
	.typing-container {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif;
		font-size: 1.0625rem;
		min-height: 1.75rem;
		text-align: left;
		color: #e8e8e4;
		line-height: 1.6;
		font-weight: 400;
	}

	.typed-text {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.cursor {
		opacity: 0;
		transition: opacity 0.1s;
		color: #999;
		font-weight: 300;
		margin-left: 1px;
	}

	.cursor.visible {
		opacity: 0.7;
	}

	@media (max-width: 640px) {
		.typing-container {
			font-size: 1rem;
		}
	}
</style>
