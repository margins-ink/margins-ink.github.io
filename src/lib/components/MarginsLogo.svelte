<script lang="ts">
	interface Props {
		size?: number;
		class?: string;
	}

	const { size = 24, class: className = '' }: Props = $props();
</script>

<svg
	viewBox="0 0 32 32"
	width={size}
	height={size}
	class={className}
	aria-label="Margins"
>
	<!-- Two blocks with a margin gap between them -->
	<rect x="4" y="4" width="10" height="24" rx="2" fill="currentColor" />
	<rect x="18" y="4" width="10" height="24" rx="2" fill="currentColor" />
</svg>
