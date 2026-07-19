<script lang="ts">
	// Confabulation: the reported reason is a straight arrow between the same
	// two points the real computation wandered between. Hover reveals the
	// wandering path and fades the story.
	let { hovered = false }: { hovered?: boolean } = $props();
</script>

<svg viewBox="0 0 120 60" class:hovered>
	<defs>
		<marker
			id="conf-arrow"
			viewBox="0 0 8 8"
			refX="7"
			refY="4"
			markerWidth="5"
			markerHeight="5"
			orient="auto"
		>
			<path d="M0,0 L8,4 L0,8 Z" class="arrow-head" />
		</marker>
	</defs>

	<!-- endpoints: question and answer -->
	<circle cx="14" cy="30" r="2.4" class="endpoint" />
	<circle cx="106" cy="30" r="2.4" class="endpoint" />

	<!-- the story: clean, direct, confident -->
	<line x1="20" y1="30" x2="98" y2="30" class="story" marker-end="url(#conf-arrow)" />

	<!-- the computation: what actually happened -->
	<path
		d="M14 30 C 22 8, 30 52, 40 18 S 56 50, 66 12 S 84 54, 92 22 S 102 34, 106 30"
		pathLength="1"
		class="actual"
	/>
</svg>

<style>
	svg {
		width: 100%;
		height: 100%;
	}

	.endpoint {
		fill: var(--text-tertiary);
		opacity: 0.8;
	}

	.story {
		stroke: var(--text-tertiary);
		stroke-width: 1.3;
		opacity: 0.85;
		transition: opacity 0.4s ease;
	}

	.arrow-head {
		fill: var(--text-tertiary);
		opacity: 0.85;
		transition: opacity 0.4s ease;
	}

	.actual {
		fill: none;
		stroke: var(--text-quaternary);
		stroke-width: 1.1;
		stroke-dasharray: 1;
		stroke-dashoffset: 1;
		opacity: 0;
		transition:
			stroke-dashoffset 1.4s cubic-bezier(0.65, 0, 0.35, 1),
			opacity 0.3s ease;
	}

	svg.hovered .story {
		opacity: 0.2;
	}

	svg.hovered .arrow-head {
		opacity: 0.2;
	}

	svg.hovered .actual {
		stroke-dashoffset: 0;
		opacity: 0.9;
	}
</style>
