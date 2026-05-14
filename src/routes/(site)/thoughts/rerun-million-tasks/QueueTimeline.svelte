<script lang="ts">
	import { onMount, onDestroy } from 'svelte';

	type Image = {
		id: number;
		status: 'queued' | 'processing' | 'done';
		progress: number;
		workerId: number | null;
	};

	const IMAGE_COUNT = 10;
	const WORKER_COUNT = 2;
	const TICK_MS = 50;
	const TICKS_TO_COMPLETE = 30;

	let images = $state<Image[]>([]);
	let intervalId: number | null = null;
	let autoStarted = $state(false);

	onMount(() => {
		reset();
		// Auto-start after a short delay for visual effect
		setTimeout(() => {
			if (!autoStarted) {
				autoStarted = true;
				startProcessing();
			}
		}, 500);
	});

	onDestroy(() => {
		if (intervalId) clearInterval(intervalId);
	});

	function reset() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
		images = Array.from({ length: IMAGE_COUNT }, (_, i) => ({
			id: i,
			status: 'queued',
			progress: 0,
			workerId: null
		}));
		autoStarted = false;
	}

	function startProcessing() {
		if (intervalId) return;

		intervalId = setInterval(() => {
			// Find which workers are busy
			const busyWorkers = new Set(
				images.filter(img => img.status === 'processing').map(img => img.workerId)
			);

			// Find available workers
			const availableWorkers: number[] = [];
			for (let w = 0; w < WORKER_COUNT; w++) {
				if (!busyWorkers.has(w)) availableWorkers.push(w);
			}

			// Find queued images
			const queuedIndices = images
				.map((img, idx) => ({ img, idx }))
				.filter(({ img }) => img.status === 'queued')
				.map(({ idx }) => idx);

			// Assign available workers to queued images
			const assignments = new Map<number, number>();
			for (let i = 0; i < Math.min(availableWorkers.length, queuedIndices.length); i++) {
				assignments.set(queuedIndices[i], availableWorkers[i]);
			}

			let anyWork = false;

			images = images.map((img, idx) => {
				// Start new work
				if (assignments.has(idx)) {
					anyWork = true;
					return { ...img, status: 'processing' as const, progress: 1, workerId: assignments.get(idx)! };
				}

				// Progress existing work
				if (img.status === 'processing') {
					anyWork = true;
					const newProgress = img.progress + 1;
					if (newProgress >= TICKS_TO_COMPLETE) {
						return { ...img, status: 'done' as const, progress: 0, workerId: null };
					}
					return { ...img, progress: newProgress };
				}

				if (img.status === 'queued') anyWork = true;
				return img;
			});

			if (!anyWork) {
				if (intervalId) clearInterval(intervalId);
				intervalId = null;
			}
		}, TICK_MS) as unknown as number;
	}

	// Derived values for display
	let queuedImages = $derived(images.filter(img => img.status === 'queued'));
	let processingImages = $derived(images.filter(img => img.status === 'processing'));
	let doneImages = $derived(images.filter(img => img.status === 'done'));

	// Workers with their current task
	let workers = $derived(
		Array.from({ length: WORKER_COUNT }, (_, w) => {
			const img = processingImages.find(img => img.workerId === w);
			return { id: w, image: img ?? null };
		})
	);
</script>

<div class="timeline">
	<div class="pipeline">
		<!-- Queue -->
		<div class="stage">
			<div class="stage-header">
				<span class="stage-label">Queue</span>
				<span class="stage-count">{queuedImages.length}</span>
			</div>
			<div class="queue-items">
				{#each queuedImages.slice(0, 6) as img (img.id)}
					<div class="queue-item">
						<span class="img-icon">🖼</span>
						<span class="img-id">{img.id}</span>
					</div>
				{/each}
				{#if queuedImages.length > 6}
					<div class="queue-more">+{queuedImages.length - 6}</div>
				{/if}
				{#if queuedImages.length === 0}
					<div class="empty">empty</div>
				{/if}
			</div>
		</div>

		<!-- Arrow -->
		<div class="arrow">→</div>

		<!-- Workers -->
		<div class="stage workers">
			<div class="stage-header">
				<span class="stage-label">Workers</span>
				<span class="stage-count">{processingImages.length}/{WORKER_COUNT}</span>
			</div>
			<div class="worker-list">
				{#each workers as worker (worker.id)}
					<div class="worker" class:busy={worker.image !== null}>
						<span class="worker-label">W{worker.id}</span>
						{#if worker.image}
							{@const pct = (worker.image.progress / TICKS_TO_COMPLETE) * 100}
							<div class="worker-task">
								<div class="worker-progress" style="width: {pct}%"></div>
								<span class="img-icon">🖼</span>
								<span class="img-id">{worker.image.id}</span>
							</div>
						{:else}
							<div class="worker-idle">idle</div>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Arrow -->
		<div class="arrow">→</div>

		<!-- Done -->
		<div class="stage">
			<div class="stage-header">
				<span class="stage-label">Done</span>
				<span class="stage-count">{doneImages.length}</span>
			</div>
			<div class="done-items">
				{#each doneImages.slice(-4) as img (img.id)}
					<div class="done-item">
						<span class="img-icon">✓</span>
						<span class="img-id">{img.id}</span>
					</div>
				{/each}
				{#if doneImages.length > 4}
					<div class="done-more">+{doneImages.length - 4}</div>
				{/if}
				{#if doneImages.length === 0}
					<div class="empty">—</div>
				{/if}
			</div>
		</div>
	</div>

	<div class="controls">
		<button class="btn" onclick={reset}>Reset</button>
		<button class="btn" onclick={startProcessing} disabled={intervalId !== null}>Start</button>
	</div>
</div>

<style>
	.timeline {
		background: var(--background-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin: 1.5rem 0;
	}

	.pipeline {
		display: flex;
		align-items: stretch;
		gap: 0.5rem;
	}

	.arrow {
		display: flex;
		align-items: center;
		color: var(--text-quaternary);
		font-size: 1.25rem;
		padding: 0 0.25rem;
	}

	.stage {
		flex: 1;
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.5rem;
		min-height: 80px;
	}

	.stage.workers {
		flex: 1.2;
	}

	.stage-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.5rem;
		padding-bottom: 0.375rem;
		border-bottom: 1px solid var(--border);
	}

	.stage-label {
		font-size: 0.625rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-tertiary);
	}

	.stage-count {
		font-size: 0.6875rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}

	/* Queue items */
	.queue-items, .done-items {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}

	.queue-item, .done-item {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		background: var(--background-secondary);
		border: 1px solid var(--border);
		border-radius: 3px;
		padding: 0.2rem 0.35rem;
		font-size: 0.5625rem;
	}

	.done-item {
		opacity: 0.6;
	}

	.queue-more, .done-more {
		font-size: 0.5625rem;
		color: var(--text-quaternary);
		padding: 0.2rem 0.25rem;
	}

	.img-icon {
		font-size: 0.625rem;
	}

	.img-id {
		font-weight: 500;
		color: var(--text-secondary);
	}

	.empty {
		font-size: 0.5625rem;
		color: var(--text-quaternary);
		font-style: italic;
		padding: 0.25rem;
	}

	/* Workers */
	.worker-list {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}

	.worker {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.375rem;
		background: var(--background-secondary);
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
		display: flex;
		align-items: center;
		gap: 0.25rem;
		background: var(--surface);
		border-radius: 3px;
		padding: 0.2rem 0.35rem;
		overflow: hidden;
	}

	.worker-progress {
		position: absolute;
		left: 0;
		top: 0;
		bottom: 0;
		background: var(--text-primary);
		opacity: 0.1;
		transition: width 0.05s linear;
	}

	.worker-task .img-icon,
	.worker-task .img-id {
		position: relative;
		z-index: 1;
	}

	.worker-idle {
		flex: 1;
		font-size: 0.5625rem;
		color: var(--text-quaternary);
		font-style: italic;
	}

	/* Controls */
	.controls {
		display: flex;
		gap: 0.5rem;
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.btn {
		background: var(--surface);
		color: var(--text-secondary);
		border: 1px solid var(--border);
		padding: 0.25rem 0.5rem;
		border-radius: 4px;
		font-size: 0.625rem;
		font-weight: 500;
		cursor: pointer;
		font-family: var(--font-sans);
	}

	.btn:hover:not(:disabled) {
		background: var(--background-secondary);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	@media (max-width: 560px) {
		.pipeline {
			flex-direction: column;
		}
		.arrow {
			transform: rotate(90deg);
			justify-content: center;
		}
	}
</style>
