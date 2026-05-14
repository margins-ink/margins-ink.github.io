<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>Let Me LLM That For You</title>
	<meta name="description" content="Let Me LLM That For You - Learn to ask Claude" />
</svelte:head>

{@render children()}

<style>
	:global(body) {
		background: #262624;
		margin: 0;
		padding: 0;
		overflow-x: hidden;
	}
</style>
