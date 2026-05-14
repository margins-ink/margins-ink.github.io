<script>
	import { onMount } from 'svelte';
	import * as d3 from 'd3';

	let container;

	onMount(() => {
		// Clear any existing SVG first
		d3.select(container).selectAll('*').remove();

		const margin = { top: 40, right: 40, bottom: 60, left: 60 };
		const width = Math.min(container.offsetWidth, 900) - margin.left - margin.right;
		const height = 400 - margin.top - margin.bottom;

		// Create SVG
		const svg = d3
			.select(container)
			.append('svg')
			.attr('width', width + margin.left + margin.right)
			.attr('height', height + margin.top + margin.bottom)
			.append('g')
			.attr('transform', `translate(${margin.left},${margin.top})`);

		// Get colors from CSS variables
		const computedStyle = getComputedStyle(document.documentElement);
		const primaryColor = computedStyle.getPropertyValue('--primary').trim() || '#3b82f6';
		const mutedColor = computedStyle.getPropertyValue('--muted-foreground').trim() || '#6b7280';
		const destructiveColor = computedStyle.getPropertyValue('--destructive').trim() || '#ef4444';
		const successColor = computedStyle.getPropertyValue('--success').trim() || '#10b981';
		const foregroundColor = computedStyle.getPropertyValue('--foreground').trim() || '#000000';

		// Scales
		const xScale = d3.scaleLinear().domain([0, 100]).range([0, width]);
		const yScale = d3.scaleLinear().domain([0, 100]).range([height, 0]);

		// Title
		svg
			.append('text')
			.attr('x', width / 2)
			.attr('y', -10)
			.attr('text-anchor', 'middle')
			.attr('font-size', '15px')
			.attr('font-weight', 'bold')
			.attr('fill', foregroundColor)
			.text('The Reverse Treadmill: Training Discomfort');

		// Baseline (lowering) - dashed line
		const baselinePath = d3.line()
			.x((d) => xScale(d))
			.y((d) => yScale(60 - d * 0.25));

		svg
			.append('path')
			.datum(d3.range(0, 101, 1))
			.attr('fill', 'none')
			.attr('stroke', mutedColor)
			.attr('stroke-width', 2)
			.attr('stroke-dasharray', '5,5')
			.attr('d', baselinePath);

		// Baseline label
		svg
			.append('text')
			.attr('x', 5)
			.attr('y', yScale(60) - 5)
			.attr('font-size', '13px')
			.attr('fill', mutedColor)
			.text('Baseline (lowering)');

		// Normal experiences (flat line)
		const normalY = 65;
		svg
			.append('line')
			.attr('x1', 0)
			.attr('x2', width)
			.attr('y1', yScale(normalY))
			.attr('y2', yScale(normalY))
			.attr('stroke', primaryColor)
			.attr('stroke-width', 2);

		// Normal experiences label
		svg
			.append('text')
			.attr('x', 5)
			.attr('y', yScale(normalY) + 20)
			.attr('font-size', '13px')
			.attr('fill', primaryColor)
			.text('Normal experiences (unchanged)');

		// Discomfort spikes (voluntary, getting more regular)
		const spikes = [10, 20, 30, 40, 50, 60, 70, 80, 90];

		// Draw discomfort spikes below baseline
		spikes.forEach((x, i) => {
			const baseY = 60 - x * 0.25;
			const spikeDepth = 25; // negative depth below baseline

			svg
				.append('line')
				.attr('x1', xScale(x))
				.attr('x2', xScale(x))
				.attr('y1', yScale(baseY))
				.attr('y2', yScale(baseY - spikeDepth))
				.attr('stroke', successColor)
				.attr('stroke-width', 2.5)
				.attr('stroke-linecap', 'round')
				.attr('opacity', 0.8);

			// Label first 3 spikes
			if (i < 3) {
				const labels = ['Cold', 'Fast', 'Early'];
				svg
					.append('text')
					.attr('x', xScale(x))
					.attr('y', yScale(baseY - spikeDepth) + 15)
					.attr('text-anchor', 'middle')
					.attr('font-size', '10px')
					.attr('fill', successColor)
					.text(labels[i]);
			}
		});

		// Gap indicator (shrinking gap)
		const arrowX = 70;
		const arrowY1 = normalY;
		const arrowY2 = 60 - arrowX * 0.25;

		// Vertical line
		svg
			.append('line')
			.attr('x1', xScale(arrowX))
			.attr('x2', xScale(arrowX))
			.attr('y1', yScale(arrowY1))
			.attr('y2', yScale(arrowY2))
			.attr('stroke', mutedColor)
			.attr('stroke-width', 1)
			.attr('opacity', 0.6);

		// Arrow heads
		const arrowSize = 5;
		svg
			.append('path')
			.attr(
				'd',
				`M ${xScale(arrowX) - arrowSize} ${yScale(arrowY1) + 8}
				 L ${xScale(arrowX)} ${yScale(arrowY1)}
				 L ${xScale(arrowX) + arrowSize} ${yScale(arrowY1) + 8}`
			)
			.attr('fill', 'none')
			.attr('stroke', mutedColor)
			.attr('stroke-width', 1)
			.attr('opacity', 0.6);

		svg
			.append('path')
			.attr(
				'd',
				`M ${xScale(arrowX) - arrowSize} ${yScale(arrowY2) - 8}
				 L ${xScale(arrowX)} ${yScale(arrowY2)}
				 L ${xScale(arrowX) + arrowSize} ${yScale(arrowY2) - 8}`
			)
			.attr('fill', 'none')
			.attr('stroke', mutedColor)
			.attr('stroke-width', 1)
			.attr('opacity', 0.6);

		// Gap label
		svg
			.append('text')
			.attr('x', xScale(arrowX) + 10)
			.attr('y', yScale((arrowY1 + arrowY2) / 2))
			.attr('font-size', '11px')
			.attr('fill', mutedColor)
			.text('Gap shrinks');

		// "Frog" task marker
		const frogX = 85;
		const frogY = 65; // at normal experience level
		const baselineAtFrog = 60 - frogX * 0.25;

		// Frog marker (circle)
		svg
			.append('circle')
			.attr('cx', xScale(frogX))
			.attr('cy', yScale(frogY))
			.attr('r', 5)
			.attr('fill', primaryColor)
			.attr('opacity', 0.7);

		// Frog label
		svg
			.append('text')
			.attr('x', xScale(frogX))
			.attr('y', yScale(frogY) + 18)
			.attr('text-anchor', 'middle')
			.attr('font-size', '11px')
			.attr('fill', primaryColor)
			.text('"Frog" task');

		// Arrow showing frog is now above baseline
		svg
			.append('line')
			.attr('x1', xScale(frogX + 3))
			.attr('x2', xScale(frogX + 3))
			.attr('y1', yScale(frogY) + 5)
			.attr('y2', yScale(baselineAtFrog) - 5)
			.attr('stroke', successColor)
			.attr('stroke-width', 1.5)
			.attr('stroke-dasharray', '3,3')
			.attr('opacity', 0.6);

		// "Now feels easy" label
		svg
			.append('text')
			.attr('x', xScale(frogX + 8))
			.attr('y', yScale((frogY + baselineAtFrog) / 2))
			.attr('font-size', '10px')
			.attr('fill', successColor)
			.text('Now feels easy');
	});
</script>

<style>
	.container {
		width: 100%;
		margin: 2rem 0;
		display: flex;
		flex-direction: column;
		align-items: center;
	}

	.svg-container {
		width: 100%;
		max-width: 900px;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--card);
		padding: 1rem;
	}

	.caption {
		margin-top: 1rem;
		font-size: 0.9rem;
		color: var(--muted-foreground);
		text-align: center;
		max-width: 700px;
		font-style: italic;
	}
</style>

<div class="container">
	<div class="svg-container" bind:this={container}></div>
	<p class="caption">
		Voluntary discomfort (green spikes) lowers your baseline tolerance. The same "frog" task that
		felt impossible now sits comfortably above your baseline—it feels easy by comparison. Normal
		experiences become restorative instead of requiring willpower.
	</p>
</div>
