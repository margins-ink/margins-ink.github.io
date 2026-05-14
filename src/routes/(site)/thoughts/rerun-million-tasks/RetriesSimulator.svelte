<script lang="ts">
	import { onDestroy } from 'svelte';
	import NumberFlow from '@number-flow/svelte';

	type ImageStatus = 'queued' | 'processing' | 'done' | 'dead';

	type Image = {
		id: number;
		status: ImageStatus;
		progress: number;
		workerId: number | null;
		attempts: number;
		failRate: number; // 0-1, probability of failure
		lastError: string | null;
	};

	const IMAGE_COUNT = 8;
	const WORKER_COUNT = 2;
	const TICK_MS = 50;
	const TICKS_TO_COMPLETE = 20;
	const MAX_RETRIES = 3;

	let images = $state<Image[]>(initImages());
	let intervalId: number | null = null;

	// Track events for the log
	let events = $state<{ type: 'success' | 'fail' | 'retry' | 'dlq'; imageId: number; attempt?: number }[]>([]);

	onDestroy(() => {
		if (intervalId) clearInterval(intervalId);
	});

	function initImages(): Image[] {
		return Array.from({ length: IMAGE_COUNT }, (_, i) => ({
			id: i,
			status: 'done',
			progress: 0,
			workerId: null,
			attempts: 0,
			// Make some images flaky for demonstration
			// Images 5, 6, 7 have increasing fail rates
			failRate: i === 7 ? 0.9 : i === 6 ? 0.6 : i === 5 ? 0.4 : 0,
			lastError: null
		}));
	}

	function reset() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
		images = initImages();
		events = [];
	}

	function processAll() {
		// Queue all images that are done (not dead)
		images = images.map(img => {
			if (img.status === 'dead') return img; // Keep dead images dead
			return { ...img, status: 'queued' as const, progress: 0, workerId: null, attempts: 0, lastError: null };
		});
		events = [];
		if (!intervalId) startProcessing();
	}

	function retryDead() {
		// Retry all dead images
		images = images.map(img => {
			if (img.status !== 'dead') return img;
			return { ...img, status: 'queued' as const, progress: 0, workerId: null, attempts: 0, lastError: null };
		});
		if (!intervalId) startProcessing();
	}

	function startProcessing() {
		intervalId = setInterval(() => {
			let anyWork = false;

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

			images = images.map((img, idx) => {
				// Start new work
				if (assignments.has(idx)) {
					anyWork = true;
					return {
						...img,
						status: 'processing' as const,
						progress: 1,
						workerId: assignments.get(idx)!
					};
				}

				// Progress existing work
				if (img.status === 'processing') {
					anyWork = true;
					const newProgress = img.progress + 1;

					if (newProgress >= TICKS_TO_COMPLETE) {
						// Task finished - determine success/failure
						const failed = Math.random() < img.failRate;

						if (failed) {
							const newAttempts = img.attempts + 1;

							if (newAttempts >= MAX_RETRIES) {
								// Dead letter queue
								events = [...events, { type: 'dlq', imageId: img.id }];
								return {
									...img,
									status: 'dead' as const,
									progress: 0,
									workerId: null,
									attempts: newAttempts,
									lastError: 'Max retries exceeded'
								};
							}

							// Retry
							events = [...events, { type: 'retry', imageId: img.id, attempt: newAttempts }];
							return {
								...img,
								status: 'queued' as const,
								progress: 0,
								workerId: null,
								attempts: newAttempts,
								lastError: 'Vectorization failed'
							};
						}

						// Success
						events = [...events, { type: 'success', imageId: img.id }];
						return {
							...img,
							status: 'done' as const,
							progress: 0,
							workerId: null,
							lastError: null
						};
					}

					return { ...img, progress: newProgress };
				}

				if (img.status === 'queued') anyWork = true;
				return img;
			});

			// Keep only recent events
			if (events.length > 12) {
				events = events.slice(-12);
			}

			if (!anyWork) {
				if (intervalId) clearInterval(intervalId);
				intervalId = null;
			}
		}, TICK_MS) as unknown as number;
	}

	// Derived stats
	let queued = $derived(images.filter(img => img.status === 'queued').length);
	let processing = $derived(images.filter(img => img.status === 'processing').length);
	let done = $derived(images.filter(img => img.status === 'done').length);
	let dead = $derived(images.filter(img => img.status === 'dead').length);
	let totalRetries = $derived(images.reduce((sum, img) => sum + img.attempts, 0));

	// Workers for visualization
	let workers = $derived(
		Array.from({ length: WORKER_COUNT }, (_, w) => {
			const img = images.find(img => img.status === 'processing' && img.workerId === w);
			return { id: w, image: img ?? null };
		})
	);
</script>

<div class="simulator">
	<div class="controls">
		<button class="btn" onclick={processAll}>Process All</button>
		{#if dead > 0}
			<button class="btn secondary" onclick={retryDead}>Retry Dead ({dead})</button>
		{/if}
		<button class="btn secondary" onclick={reset}>Reset</button>
	</div>

	<div class="stats-bar">
		<span class="stat"><NumberFlow value={queued} /> queued</span>
		<span class="stat"><NumberFlow value={processing} />/{WORKER_COUNT} processing</span>
		<span class="stat"><NumberFlow value={done} /> done</span>
		{#if totalRetries > 0}
			<span class="stat warning"><NumberFlow value={totalRetries} /> retries</span>
		{/if}
		{#if dead > 0}
			<span class="stat error"><NumberFlow value={dead} /> dead</span>
		{/if}
	</div>

	<div class="layout">
		<!-- Workers -->
		<div class="workers-section">
			<div class="section-label">Workers</div>
			<div class="workers">
				{#each workers as worker (worker.id)}
					<div class="worker" class:busy={worker.image !== null}>
						<span class="worker-label">W{worker.id}</span>
						{#if worker.image}
							{@const pct = (worker.image.progress / TICKS_TO_COMPLETE) * 100}
							<div class="worker-task" class:flaky={worker.image.failRate > 0}>
								<div class="progress-bar" style="width: {pct}%"></div>
								<span class="task-info">
									<span class="img-id">{worker.image.id}</span>
									{#if worker.image.attempts > 0}
										<span class="attempt-badge">try {worker.image.attempts + 1}</span>
									{/if}
								</span>
							</div>
						{:else}
							<span class="idle">idle</span>
						{/if}
					</div>
				{/each}
			</div>
		</div>

		<!-- Images -->
		<div class="images-section">
			<div class="section-label">Images (5-7 are flaky)</div>
			<div class="image-grid">
				{#each images as img (img.id)}
					<div
						class="image-card"
						class:processing={img.status === 'processing'}
						class:queued={img.status === 'queued'}
						class:done={img.status === 'done'}
						class:dead={img.status === 'dead'}
						class:flaky={img.failRate > 0}
					>
						<div class="image-header">
							<span class="img-id">{img.id}</span>
							{#if img.failRate > 0}
								<span class="flaky-indicator" title="{Math.round(img.failRate * 100)}% fail rate">
									{img.failRate >= 0.9 ? '💀' : img.failRate >= 0.5 ? '⚠️' : '❓'}
								</span>
							{/if}
						</div>
						<div class="image-status">
							{#if img.status === 'dead'}
								DLQ
							{:else if img.status === 'processing'}
								{#if img.attempts > 0}
									retry {img.attempts}
								{:else}
									running
								{/if}
							{:else if img.status === 'queued'}
								{#if img.attempts > 0}
									waiting (retry {img.attempts})
								{:else}
									waiting
								{/if}
							{:else}
								done
							{/if}
						</div>
						{#if img.status === 'processing'}
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

	<!-- Event log -->
	{#if events.length > 0}
		<div class="event-log">
			<div class="log-label">Events</div>
			<div class="log-items">
				{#each events.slice(-8) as event}
					<span class="log-item" class:success={event.type === 'success'} class:retry={event.type === 'retry'} class:dlq={event.type === 'dlq'}>
						{#if event.type === 'success'}
							✓ {event.imageId}
						{:else if event.type === 'retry'}
							↻ {event.imageId} (try {event.attempt})
						{:else if event.type === 'dlq'}
							☠ {event.imageId} → DLQ
						{/if}
					</span>
				{/each}
			</div>
		</div>
	{/if}

	<p class="hint">Images 5-7 have increasing failure rates. Watch retries and dead letter queue.</p>
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
		gap: 0.5rem;
		margin-bottom: 0.75rem;
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

	.btn.secondary {
		background: var(--surface);
		color: var(--text-secondary);
		border: 1px solid var(--border);
	}

	.stats-bar {
		display: flex;
		gap: 0.75rem;
		font-size: 0.6875rem;
		color: var(--text-tertiary);
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.stat {
		display: flex;
		gap: 0.25rem;
	}

	.stat.warning {
		color: #f59e0b;
	}

	.stat.error {
		color: #ef4444;
		font-weight: 500;
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
		width: 150px;
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

	.worker-task.flaky {
		border: 1px solid rgba(245, 158, 11, 0.3);
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

	.attempt-badge {
		font-size: 0.5rem;
		color: #f59e0b;
	}

	.idle {
		flex: 1;
		font-size: 0.5625rem;
		color: var(--text-quaternary);
		font-style: italic;
	}

	/* Images */
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
		opacity: 0.8;
	}

	.image-card.done {
		opacity: 0.5;
	}

	.image-card.dead {
		border-color: #ef4444;
		background: rgba(239, 68, 68, 0.05);
	}

	.image-card.flaky:not(.dead) {
		border-color: rgba(245, 158, 11, 0.4);
	}

	.image-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.125rem;
	}

	.image-header .img-id {
		font-weight: 600;
		color: var(--text-secondary);
	}

	.flaky-indicator {
		font-size: 0.625rem;
	}

	.image-status {
		color: var(--text-quaternary);
		font-size: 0.5rem;
	}

	.image-card.dead .image-status {
		color: #ef4444;
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

	/* Event log */
	.event-log {
		margin-top: 0.75rem;
		padding-top: 0.75rem;
		border-top: 1px solid var(--border);
	}

	.log-label {
		font-size: 0.5rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-quaternary);
		margin-bottom: 0.375rem;
	}

	.log-items {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem;
	}

	.log-item {
		font-size: 0.5rem;
		padding: 0.125rem 0.25rem;
		border-radius: 2px;
		background: var(--surface);
		color: var(--text-tertiary);
	}

	.log-item.success {
		color: #22c55e;
	}

	.log-item.retry {
		color: #f59e0b;
	}

	.log-item.dlq {
		color: #ef4444;
		font-weight: 500;
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
