<script lang="ts">
	import { onDestroy } from 'svelte';
	import NumberFlow from '@number-flow/svelte';

	type Image = {
		id: number;
		targetGen: number;
		completedGen: number;
		progress: number;
		workerId: number | null;
		// The generation captured when this task was picked up
		pickedGen: number;
	};

	const IMAGE_COUNT = 8;
	const WORKER_COUNT = 2;
	const TICK_MS = 50;
	const TICKS_TO_COMPLETE = 25;

	let generation = $state(0);
	let images = $state<Image[]>(
		Array.from({ length: IMAGE_COUNT }, (_, i) => ({
			id: i,
			targetGen: 0,
			completedGen: 0,
			progress: 0,
			workerId: null,
			pickedGen: 0
		}))
	);

	let intervalId: number | null = null;

	onDestroy(() => {
		if (intervalId) clearInterval(intervalId);
	});

	function rerunAll() {
		generation++;
		// Just bump target generation - that's it!
		// Processing images will complete their current gen, then automatically need work again
		images = images.map(img => ({ ...img, targetGen: generation }));
		if (!intervalId) startProcessing();
	}

	function startProcessing() {
		intervalId = setInterval(() => {
			let anyWork = false;

			// Find which workers are busy
			const busyWorkers = new Set(
				images.filter(img => img.progress > 0).map(img => img.workerId)
			);

			// Find available workers
			const availableWorkers: number[] = [];
			for (let w = 0; w < WORKER_COUNT; w++) {
				if (!busyWorkers.has(w)) availableWorkers.push(w);
			}

			// Find images that need work (target > completed) and aren't currently processing
			const needsWorkIndices = images
				.map((img, idx) => ({ img, idx }))
				.filter(({ img }) => img.targetGen > img.completedGen && img.progress === 0)
				.map(({ idx }) => idx);

			// Assign available workers to images that need work
			const assignments = new Map<number, number>();
			for (let i = 0; i < Math.min(availableWorkers.length, needsWorkIndices.length); i++) {
				assignments.set(needsWorkIndices[i], availableWorkers[i]);
			}

			images = images.map((img, idx) => {
				// Start new work - capture the target gen at pickup time
				if (assignments.has(idx)) {
					anyWork = true;
					return {
						...img,
						progress: 1,
						workerId: assignments.get(idx)!,
						pickedGen: img.targetGen
					};
				}

				// Progress existing work
				if (img.progress > 0) {
					anyWork = true;
					const newProgress = img.progress + 1;
					if (newProgress >= TICKS_TO_COMPLETE) {
						// Complete with the generation we picked up
						// If target was bumped while processing, target > completedGen still, so we'll run again
						return {
							...img,
							progress: 0,
							workerId: null,
							completedGen: img.pickedGen
						};
					}
					return { ...img, progress: newProgress };
				}

				// Image waiting in queue
				if (img.targetGen > img.completedGen) anyWork = true;
				return img;
			});

			if (!anyWork) {
				if (intervalId) clearInterval(intervalId);
				intervalId = null;
			}
		}, TICK_MS) as unknown as number;
	}

	// Derived stats
	let queued = $derived(images.filter(img => img.targetGen > img.completedGen && img.progress === 0).length);
	let processing = $derived(images.filter(img => img.progress > 0).length);
	let done = $derived(images.filter(img => img.completedGen >= img.targetGen && img.completedGen > 0).length);

	// Workers for visualization
	let workers = $derived(
		Array.from({ length: WORKER_COUNT }, (_, w) => {
			const img = images.find(img => img.progress > 0 && img.workerId === w);
			return { id: w, image: img ?? null };
		})
	);
</script>

<div class="simulator">
	<div class="controls">
		<button class="btn" onclick={rerunAll}>Rerun All</button>
		<div class="stats">
			<span class="stat"><NumberFlow value={queued} /> queued</span>
			<span class="stat"><NumberFlow value={processing} />/{WORKER_COUNT} processing</span>
			<span class="stat"><NumberFlow value={done} /> done</span>
			<span class="stat gen">gen <NumberFlow value={generation} /></span>
		</div>
	</div>

	<div class="layout">
		<!-- Workers section -->
		<div class="workers-section">
			<div class="section-label">Workers</div>
			<div class="workers">
				{#each workers as worker (worker.id)}
					<div class="worker" class:busy={worker.image !== null}>
						<span class="worker-label">W{worker.id}</span>
						{#if worker.image}
							{@const pct = (worker.image.progress / TICKS_TO_COMPLETE) * 100}
							{@const willRerun = worker.image.targetGen > worker.image.pickedGen}
							<div class="worker-task" class:will-rerun={willRerun}>
								<div class="progress-bar" style="width: {pct}%"></div>
								<span class="task-info">
									<span class="img-id">img {worker.image.id}</span>
									<span class="gen-badge">{worker.image.pickedGen}→{worker.image.targetGen}</span>
								</span>
							</div>
						{:else}
							<span class="idle">idle</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Images grid -->
		<div class="images-section">
			<div class="section-label">Images</div>
			<div class="image-grid">
				{#each images as img (img.id)}
					{@const needsWork = img.targetGen > img.completedGen}
					{@const isProcessing = img.progress > 0}
					{@const willRerun = isProcessing && img.targetGen > img.pickedGen}
					<div
						class="image-card"
						class:processing={isProcessing}
						class:queued={needsWork && !isProcessing}
						class:done={!needsWork && img.completedGen > 0}
						class:will-rerun={willRerun}
					>
						<div class="image-header">
							<span class="img-id">{img.id}</span>
							{#if isProcessing}
								<span class="worker-badge">W{img.workerId}</span>
							{/if}
						</div>
						<div class="gen-display">
							<span class="completed">{img.completedGen}</span>
							<span class="arrow">→</span>
							<span class="target">{img.targetGen}</span>
						</div>
						{#if isProcessing}
							{@const pct = (img.progress / TICKS_TO_COMPLETE) * 100}
							<div class="progress-track">
								<div class="progress-fill" style="width: {pct}%"></div>
							</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>
	</div>

	<p class="hint">Press "Rerun All" multiple times while processing. Generation bumps—running tasks complete then auto-requeue.</p>
</div>

<style>
	.simulator {
		background: var(--background-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin: 1.5rem 0;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 1rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.btn {
		background: var(--text-primary);
		color: var(--background);
		border: none;
		padding: 0.375rem 0.75rem;
		border-radius: 5px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		font-family: var(--font-sans);
	}

	.btn:hover { opacity: 0.8; }

	.stats {
		display: flex;
		gap: 0.75rem;
		font-size: 0.6875rem;
		color: var(--text-tertiary);
		flex-wrap: wrap;
	}

	.stat {
		display: flex;
		gap: 0.25rem;
	}

	.stat.gen {
		margin-left: auto;
		background: var(--surface);
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.layout {
		display: flex;
		gap: 1rem;
	}

	.section-label {
		font-size: 0.5625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-tertiary);
		margin-bottom: 0.5rem;
	}

	/* Workers */
	.workers-section {
		flex-shrink: 0;
		width: 160px;
	}

	.workers {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.worker {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
	}

	.worker.busy {
		border-color: var(--text-tertiary);
	}

	.worker-label {
		font-size: 0.5625rem;
		font-weight: 600;
		color: var(--text-tertiary);
		width: 1.25rem;
	}

	.worker-task {
		flex: 1;
		position: relative;
		background: var(--background-secondary);
		border-radius: 3px;
		padding: 0.25rem 0.375rem;
		overflow: hidden;
	}

	.worker-task.will-rerun {
		border: 1px solid rgba(59, 130, 246, 0.4);
	}

	.progress-bar {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: var(--text-primary);
		opacity: 0.1;
		transition: width 0.05s linear;
	}

	.task-info {
		position: relative;
		z-index: 1;
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	.task-info .img-id {
		font-size: 0.5rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.gen-badge {
		font-size: 0.5rem;
		color: var(--text-quaternary);
		font-variant-numeric: tabular-nums;
	}

	.idle {
		flex: 1;
		font-size: 0.5625rem;
		color: var(--text-quaternary);
		font-style: italic;
	}

	/* Images grid */
	.images-section {
		flex: 1;
	}

	.image-grid {
		display: grid;
		grid-template-columns: repeat(4, 1fr);
		gap: 0.375rem;
	}

	.image-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 0.375rem;
		font-size: 0.5625rem;
	}

	.image-card.processing {
		border-color: var(--text-tertiary);
	}

	.image-card.queued {
		border-color: var(--border);
		opacity: 0.8;
	}

	.image-card.done {
		opacity: 0.5;
	}

	.image-card.will-rerun {
		border-color: rgba(59, 130, 246, 0.5);
		background: rgba(59, 130, 246, 0.05);
	}

	.image-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.25rem;
	}

	.image-header .img-id {
		font-weight: 600;
		color: var(--text-secondary);
	}

	.worker-badge {
		font-size: 0.5rem;
		color: var(--text-tertiary);
		background: var(--background-secondary);
		padding: 0.0625rem 0.25rem;
		border-radius: 2px;
	}

	.gen-display {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		font-variant-numeric: tabular-nums;
	}

	.completed {
		color: var(--text-quaternary);
	}

	.arrow {
		color: var(--text-quaternary);
		font-size: 0.5rem;
	}

	.target {
		color: var(--text-secondary);
		font-weight: 500;
	}

	.progress-track {
		margin-top: 0.25rem;
		height: 3px;
		background: var(--background-secondary);
		border-radius: 1.5px;
		overflow: hidden;
	}

	.progress-fill {
		height: 100%;
		background: var(--text-primary);
		transition: width 0.05s linear;
	}

	.hint {
		margin: 0.75rem 0 0;
		font-size: 0.6875rem;
		color: var(--text-quaternary);
		font-style: italic;
	}

	@media (max-width: 560px) {
		.layout {
			flex-direction: column;
		}
		.workers-section {
			width: 100%;
		}
		.image-grid {
			grid-template-columns: repeat(2, 1fr);
		}
	}
</style>
