<script lang="ts">
	import { onDestroy } from 'svelte';
	import NumberFlow from '@number-flow/svelte';

	// Naive approach: uses status flags (queued, processing, done)
	// Problem: can't re-queue processing tasks without double-processing
	type NaiveImage = {
		id: number;
		status: 'queued' | 'processing' | 'done';
		progress: number;
		workerId: number | null;
		// Track which model version processed this (for visualization)
		modelVersion: number;
	};

	// Generation approach: uses generation numbers
	// Running tasks complete their gen, then auto-queue for new gen
	type GenImage = {
		id: number;
		targetGen: number;
		completedGen: number;
		progress: number;
		workerId: number | null;
		// The generation this task was picked up with
		pickedGen: number;
	};

	const IMAGE_COUNT = 6;
	const WORKER_COUNT = 2;
	const TICK_MS = 60;
	const TICKS_TO_COMPLETE = 25;

	// State for both approaches
	let naiveImages = $state<NaiveImage[]>(initNaive());
	let genImages = $state<GenImage[]>(initGen());

	// Track model version for naive (just for visualization)
	let naiveModelVersion = $state(1);
	// Track stale images (processed with old model after update)
	let staleCount = $state(0);

	// Generation counter for gen approach
	let currentGen = $state(0);

	let intervalId: number | null = null;

	onDestroy(() => {
		if (intervalId) clearInterval(intervalId);
	});

	function initNaive(): NaiveImage[] {
		return Array.from({ length: IMAGE_COUNT }, (_, i) => ({
			id: i,
			status: 'done',
			progress: 0,
			workerId: null,
			modelVersion: 0
		}));
	}

	function initGen(): GenImage[] {
		return Array.from({ length: IMAGE_COUNT }, (_, i) => ({
			id: i,
			targetGen: 0,
			completedGen: 0,
			progress: 0,
			workerId: null,
			pickedGen: 0
		}));
	}

	function reset() {
		if (intervalId) {
			clearInterval(intervalId);
			intervalId = null;
		}
		naiveImages = initNaive();
		genImages = initGen();
		naiveModelVersion = 1;
		currentGen = 0;
		staleCount = 0;
	}

	function deployNewModel() {
		// Increment model version
		naiveModelVersion++;
		currentGen++;

		// NAIVE APPROACH: Re-queue completed tasks, but can't touch processing ones
		// This is the bug: processing tasks will complete with OLD model
		const processingCount = naiveImages.filter(img => img.status === 'processing').length;

		naiveImages = naiveImages.map(img => {
			if (img.status === 'processing') {
				// Can't re-queue - would cause double processing
				// These will complete with STALE model!
				return img;
			}
			// Re-queue everything else
			return { ...img, status: 'queued' as const, progress: 0, workerId: null };
		});

		// GENERATION APPROACH: Just bump target generation
		// Processing tasks will complete their current gen, then auto-queue for new gen
		genImages = genImages.map(img => ({ ...img, targetGen: currentGen }));

		if (!intervalId) startProcessing();
	}

	function startProcessing() {
		intervalId = setInterval(() => {
			let anyWork = false;

			// Process NAIVE images
			{
				const busyWorkers = new Set(
					naiveImages.filter(img => img.status === 'processing').map(img => img.workerId)
				);
				const availableWorkers: number[] = [];
				for (let w = 0; w < WORKER_COUNT; w++) {
					if (!busyWorkers.has(w)) availableWorkers.push(w);
				}

				const queuedIndices = naiveImages
					.map((img, idx) => ({ img, idx }))
					.filter(({ img }) => img.status === 'queued')
					.map(({ idx }) => idx);

				const assignments = new Map<number, number>();
				for (let i = 0; i < Math.min(availableWorkers.length, queuedIndices.length); i++) {
					assignments.set(queuedIndices[i], availableWorkers[i]);
				}

				naiveImages = naiveImages.map((img, idx) => {
					if (assignments.has(idx)) {
						anyWork = true;
						return {
							...img,
							status: 'processing' as const,
							progress: 1,
							workerId: assignments.get(idx)!,
							modelVersion: naiveModelVersion
						};
					}

					if (img.status === 'processing') {
						anyWork = true;
						const newProgress = img.progress + 1;
						if (newProgress >= TICKS_TO_COMPLETE) {
							// Check if this completed with a stale model
							if (img.modelVersion < naiveModelVersion) {
								staleCount++;
							}
							return { ...img, status: 'done' as const, progress: 0, workerId: null };
						}
						return { ...img, progress: newProgress };
					}

					if (img.status === 'queued') anyWork = true;
					return img;
				});
			}

			// Process GENERATION images
			{
				const busyWorkers = new Set(
					genImages.filter(img => img.progress > 0).map(img => img.workerId)
				);
				const availableWorkers: number[] = [];
				for (let w = 0; w < WORKER_COUNT; w++) {
					if (!busyWorkers.has(w)) availableWorkers.push(w);
				}

				// Find images that need work (target > completed) and aren't currently processing
				const needsWorkIndices = genImages
					.map((img, idx) => ({ img, idx }))
					.filter(({ img }) => img.targetGen > img.completedGen && img.progress === 0)
					.map(({ idx }) => idx);

				const assignments = new Map<number, number>();
				for (let i = 0; i < Math.min(availableWorkers.length, needsWorkIndices.length); i++) {
					assignments.set(needsWorkIndices[i], availableWorkers[i]);
				}

				genImages = genImages.map((img, idx) => {
					if (assignments.has(idx)) {
						anyWork = true;
						return {
							...img,
							progress: 1,
							workerId: assignments.get(idx)!,
							pickedGen: img.targetGen
						};
					}

					if (img.progress > 0) {
						anyWork = true;
						const newProgress = img.progress + 1;
						if (newProgress >= TICKS_TO_COMPLETE) {
							// Complete this generation
							const newCompletedGen = img.pickedGen;
							// If target was bumped while processing, we need to run again
							// The image will automatically be picked up again since target > completed
							return { ...img, progress: 0, workerId: null, completedGen: newCompletedGen };
						}
						return { ...img, progress: newProgress };
					}

					if (img.targetGen > img.completedGen) anyWork = true;
					return img;
				});
			}

			if (!anyWork) {
				if (intervalId) clearInterval(intervalId);
				intervalId = null;
			}
		}, TICK_MS) as unknown as number;
	}

	// Derived stats
	let naiveProcessing = $derived(naiveImages.filter(img => img.status === 'processing').length);
	let naiveQueued = $derived(naiveImages.filter(img => img.status === 'queued').length);
	let naiveDone = $derived(naiveImages.filter(img => img.status === 'done').length);

	let genProcessing = $derived(genImages.filter(img => img.progress > 0).length);
	let genQueued = $derived(genImages.filter(img => img.targetGen > img.completedGen && img.progress === 0).length);
	let genDone = $derived(genImages.filter(img => img.completedGen >= img.targetGen && img.completedGen > 0).length);

	// Workers for visualization
	let naiveWorkers = $derived(
		Array.from({ length: WORKER_COUNT }, (_, w) => {
			const img = naiveImages.find(img => img.status === 'processing' && img.workerId === w);
			return { id: w, image: img ?? null };
		})
	);

	let genWorkers = $derived(
		Array.from({ length: WORKER_COUNT }, (_, w) => {
			const img = genImages.find(img => img.progress > 0 && img.workerId === w);
			return { id: w, image: img ?? null };
		})
	);
</script>

<div class="comparison">
	<div class="controls">
		<button class="btn primary" onclick={deployNewModel}>
			Deploy New Model v{naiveModelVersion + 1}
		</button>
		<button class="btn" onclick={reset}>Reset</button>
		<span class="hint">Click while processing to see the difference!</span>
	</div>

	<div class="side-by-side">
		<!-- Naive Approach -->
		<div class="approach" class:has-problem={staleCount > 0}>
			<div class="approach-header">
				<span class="approach-title">Status Flags</span>
				{#if staleCount > 0}
					<span class="badge bad">{staleCount} stale</span>
				{/if}
			</div>

			<div class="workers">
				{#each naiveWorkers as worker (worker.id)}
					<div class="worker" class:busy={worker.image !== null}>
						<span class="worker-label">W{worker.id}</span>
						{#if worker.image}
							{@const pct = (worker.image.progress / TICKS_TO_COMPLETE) * 100}
							{@const isStale = worker.image.modelVersion < naiveModelVersion}
							<div class="worker-task" class:stale={isStale}>
								<div class="progress-bar" style="width: {pct}%"></div>
								<span class="task-id">{worker.image.id}</span>
								{#if isStale}
									<span class="stale-badge">v{worker.image.modelVersion}</span>
								{/if}
							</div>
						{:else}
							<span class="idle">idle</span>
						{/if}
					</div>
				{/each}
			</div>

			<div class="queue-section">
				<div class="queue-label">Queue ({naiveQueued})</div>
				<div class="queue-items">
					{#each naiveImages.filter(img => img.status === 'queued').slice(0, 4) as img (img.id)}
						<span class="queue-item">{img.id}</span>
					{/each}
					{#if naiveQueued > 4}
						<span class="more">+{naiveQueued - 4}</span>
					{/if}
					{#if naiveQueued === 0}
						<span class="empty">empty</span>
					{/if}
				</div>
			</div>

			<div class="stats">
				<span><NumberFlow value={naiveProcessing} /> processing</span>
				<span><NumberFlow value={naiveDone} /> done</span>
			</div>

			{#if staleCount > 0}
				<div class="problem-callout">
					In-flight tasks completed with old model!
				</div>
			{/if}
		</div>

		<!-- Generation Approach -->
		<div class="approach good">
			<div class="approach-header">
				<span class="approach-title">Generation Numbers</span>
				<span class="badge gen">gen {currentGen}</span>
			</div>

			<div class="workers">
				{#each genWorkers as worker (worker.id)}
					<div class="worker" class:busy={worker.image !== null}>
						<span class="worker-label">W{worker.id}</span>
						{#if worker.image}
							{@const pct = (worker.image.progress / TICKS_TO_COMPLETE) * 100}
							{@const willRerun = worker.image.pickedGen < worker.image.targetGen}
							<div class="worker-task" class:will-rerun={willRerun}>
								<div class="progress-bar" style="width: {pct}%"></div>
								<span class="task-id">{worker.image.id}</span>
								<span class="gen-info">{worker.image.pickedGen}→{worker.image.targetGen}</span>
							</div>
						{:else}
							<span class="idle">idle</span>
						{/if}
					</div>
				{/each}
			</div>

			<div class="queue-section">
				<div class="queue-label">Queue ({genQueued})</div>
				<div class="queue-items">
					{#each genImages.filter(img => img.targetGen > img.completedGen && img.progress === 0).slice(0, 4) as img (img.id)}
						<span class="queue-item">{img.id}</span>
					{/each}
					{#if genQueued > 4}
						<span class="more">+{genQueued - 4}</span>
					{/if}
					{#if genQueued === 0}
						<span class="empty">empty</span>
					{/if}
				</div>
			</div>

			<div class="stats">
				<span><NumberFlow value={genProcessing} /> processing</span>
				<span><NumberFlow value={genDone} /> done</span>
			</div>

			<div class="success-callout">
				In-flight tasks complete, then auto-requeue for new model.
			</div>
		</div>
	</div>
</div>

<style>
	.comparison {
		background: var(--background-secondary);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 1rem;
		margin: 1.5rem 0;
	}

	.controls {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-bottom: 1rem;
		flex-wrap: wrap;
	}

	.btn {
		background: var(--surface);
		color: var(--text-secondary);
		border: 1px solid var(--border);
		padding: 0.375rem 0.75rem;
		border-radius: 5px;
		font-size: 0.75rem;
		font-weight: 500;
		cursor: pointer;
		font-family: var(--font-sans);
	}

	.btn:hover { opacity: 0.8; }

	.btn.primary {
		background: var(--text-primary);
		color: var(--background);
		border: none;
	}

	.hint {
		font-size: 0.6875rem;
		color: var(--text-quaternary);
		font-style: italic;
		margin-left: auto;
	}

	.side-by-side {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 1rem;
	}

	.approach {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0.75rem;
	}

	.approach.has-problem {
		border-color: rgba(239, 68, 68, 0.4);
	}

	.approach.good {
		border-color: rgba(34, 197, 94, 0.3);
	}

	.approach-header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 0.75rem;
		padding-bottom: 0.5rem;
		border-bottom: 1px solid var(--border);
	}

	.approach-title {
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--text-secondary);
	}

	.badge {
		font-size: 0.5625rem;
		padding: 0.125rem 0.375rem;
		border-radius: 3px;
		font-weight: 500;
	}

	.badge.bad {
		background: rgba(239, 68, 68, 0.15);
		color: #ef4444;
	}

	.badge.gen {
		background: var(--background-secondary);
		color: var(--text-secondary);
	}

	/* Workers */
	.workers {
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		margin-bottom: 0.75rem;
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
		justify-content: space-between;
		gap: 0.375rem;
		background: var(--surface);
		border-radius: 3px;
		padding: 0.25rem 0.375rem;
		overflow: hidden;
	}

	.worker-task.stale {
		border: 1px solid rgba(239, 68, 68, 0.4);
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
		transition: width 0.06s linear;
	}

	.task-id {
		position: relative;
		z-index: 1;
		font-size: 0.5625rem;
		font-weight: 500;
		color: var(--text-secondary);
	}

	.stale-badge {
		position: relative;
		z-index: 1;
		font-size: 0.5rem;
		color: #ef4444;
		font-weight: 500;
	}

	.gen-info {
		position: relative;
		z-index: 1;
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

	/* Queue */
	.queue-section {
		margin-bottom: 0.5rem;
	}

	.queue-label {
		font-size: 0.5625rem;
		color: var(--text-tertiary);
		margin-bottom: 0.25rem;
	}

	.queue-items {
		display: flex;
		gap: 0.25rem;
		flex-wrap: wrap;
	}

	.queue-item {
		font-size: 0.5rem;
		background: var(--background-secondary);
		border: 1px solid var(--border);
		padding: 0.125rem 0.25rem;
		border-radius: 2px;
		color: var(--text-secondary);
	}

	.more, .empty {
		font-size: 0.5rem;
		color: var(--text-quaternary);
		padding: 0.125rem 0.25rem;
	}

	.empty {
		font-style: italic;
	}

	/* Stats */
	.stats {
		display: flex;
		gap: 0.75rem;
		font-size: 0.5625rem;
		color: var(--text-tertiary);
		padding-top: 0.5rem;
		border-top: 1px solid var(--border);
	}

	/* Callouts */
	.problem-callout {
		margin-top: 0.5rem;
		font-size: 0.5625rem;
		color: #ef4444;
		padding: 0.375rem;
		background: rgba(239, 68, 68, 0.1);
		border-radius: 3px;
	}

	.success-callout {
		margin-top: 0.5rem;
		font-size: 0.5625rem;
		color: #22c55e;
		padding: 0.375rem;
		background: rgba(34, 197, 94, 0.1);
		border-radius: 3px;
	}

	@media (max-width: 560px) {
		.side-by-side {
			grid-template-columns: 1fr;
		}
		.hint {
			display: none;
		}
	}
</style>
