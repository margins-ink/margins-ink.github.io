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
			.text('The Hedonic Treadmill');

		// Baseline (rising) - dashed line
		const baselinePath = d3.line()
			.x((d) => xScale(d))
			.y((d) => yScale(40 + d * 0.3));

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
			.attr('y', yScale(40) - 5)
			.attr('font-size', '13px')
			.attr('fill', mutedColor)
			.text('Baseline (rising)');

		// Normal experiences (flat line)
		const normalY = 35;
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
			.attr('x', Math.max(width - 340, width * 0.5))
			.attr('y', yScale(normalY) - 10)
			.attr('font-size', '13px')
			.attr('fill', primaryColor)
			.text('Normal experiences');

		// Dopamine spikes (getting closer together)
		const spikes = [];
		let spikeX = 15;
		let spacing = 18;

		while (spikeX < 95 && spikes.length < 12) {
			spikes.push(spikeX);
			spikeX += spacing;
			spacing *= 0.75;
		}

		// Draw spikes
		spikes.forEach((x, i) => {
			const baseY = 40 + x * 0.3;
			const spikeHeight = 35;

			svg
				.append('line')
				.attr('x1', xScale(x))
				.attr('x2', xScale(x))
				.attr('y1', yScale(baseY))
				.attr('y2', yScale(baseY + spikeHeight))
				.attr('stroke', destructiveColor)
				.attr('stroke-width', 2.5)
				.attr('stroke-linecap', 'round')
				.attr('opacity', 0.8);

			// Label first 3 spikes
			if (i < 3) {
				const labels = ['Game', 'Porn', 'Social'];
				svg
					.append('text')
					.attr('x', xScale(x))
					.attr('y', yScale(baseY + spikeHeight) - 8)
					.attr('text-anchor', 'middle')
					.attr('font-size', '10px')
					.attr('fill', destructiveColor)
					.text(labels[i]);
			}
		});

		// Gap indicator
		const arrowX = 70;
		const arrowY1 = normalY;
		const arrowY2 = 40 + arrowX * 0.3;

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
			.text('Gap grows');
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
		As you consume infinite novelty (red spikes), your baseline tolerance rises. Spikes get more
		frequent as addiction progresses. Normal experiences fall below your baseline—they feel muted,
		empty.
	</p>
</div>
