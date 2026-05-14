<script lang="ts">
	let currentStep = $state(0);

	const steps = [
		{
			id: 'problem',
			title: 'The Problem: Sequential Batch Processing',
			description: 'Processing 100 images sequentially in a single request exceeds Cloudflare\'s 100s timeout',
			visual: 'timeout'
		},
		{
			id: 'old-flow',
			title: 'Old Architecture',
			description: 'Single batch message → Process 100 images one-by-one → Chain to next batch',
			visual: 'old-flow'
		},
		{
			id: 'new-flow',
			title: 'New Architecture: True Fanout',
			description: 'Cron enqueues 500 individual messages → Railway replicas process in parallel',
			visual: 'new-flow'
		},
		{
			id: 'flow-control',
			title: 'QStash Flow Control',
			description: 'Parallelism=50 limits concurrent requests to vectorizer service',
			visual: 'flow-control'
		},
		{
			id: 'edge-cases',
			title: 'Edge Cases Handled',
			description: 'Task cancellation, duplicate processing, completion detection',
			visual: 'edge-cases'
		},
		{
			id: 'straggler',
			title: 'Straggler Scenario',
			description: 'What happens when one slow image holds up completion?',
			visual: 'straggler'
		},
		{
			id: 'race-condition',
			title: 'Potential Race Condition',
			description: 'When last two images finish simultaneously, transaction timing can cause missed completion',
			visual: 'race-condition'
		},
		{
			id: 'capacity-gap',
			title: 'Capacity Underutilization',
			description: 'Straggler in batch causes idle workers while waiting for next cron tick',
			visual: 'capacity-gap'
		}
	];

	function nextStep() {
		if (currentStep < steps.length - 1) {
			currentStep++;
		}
	}

	function prevStep() {
		if (currentStep > 0) {
			currentStep--;
		}
	}
</script>

<svelte:head>
	<title>PR #422: Vectorization Fanout Fix | drafted-ai/greenfield</title>
</svelte:head>

<div class="min-h-screen bg-zinc-950 text-zinc-100 p-8">
	<header class="max-w-6xl mx-auto mb-8">
		<div class="flex items-center gap-2 text-sm text-zinc-500 mb-2">
			<span>drafted-ai/greenfield</span>
			<span>•</span>
			<span>PR #422</span>
		</div>
		<h1 class="text-3xl font-bold">Fix: HTTP 524 Timeouts in Revectorization</h1>
		<p class="text-zinc-400 mt-2">From sequential batch processing to parallel fanout</p>
	</header>

	<main class="max-w-6xl mx-auto">
		<!-- Step info -->
		<div class="mb-8">
			<h2 class="text-2xl font-semibold mb-2">{steps[currentStep].title}</h2>
			<p class="text-zinc-400">{steps[currentStep].description}</p>
		</div>

		<!-- Visualization area -->
		<div class="bg-zinc-900 rounded-xl p-8 min-h-500 relative overflow-hidden">
			{#if steps[currentStep].visual === 'timeout'}
				<div class="flex flex-col items-center justify-center h-full gap-8">
					<div class="flex items-center gap-4">
						<div class="w-32 h-20 bg-zinc-800 rounded-lg flex items-center justify-center border border-zinc-700">
							<span class="text-sm">QStash</span>
						</div>
						<svg class="w-12 h-12 text-zinc-600 animate-pulse" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M5 12h14M12 5l7 7-7 7"/>
						</svg>
						<div class="w-32 h-20 bg-zinc-800 rounded-lg flex items-center justify-center border border-zinc-700">
							<span class="text-sm">API</span>
						</div>
						<svg class="w-12 h-12 text-zinc-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M5 12h14M12 5l7 7-7 7"/>
						</svg>
						<div class="w-32 h-20 bg-zinc-800 rounded-lg flex items-center justify-center border-red animate-pulse">
							<span class="text-sm">100 images</span>
						</div>
					</div>
					<div class="flex items-center gap-4 text-red-400">
						<svg class="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<circle cx="12" cy="12" r="10"/>
							<path d="M12 6v6l4 2"/>
						</svg>
						<span class="text-xl font-mono">100+ seconds → HTTP 524 Timeout</span>
					</div>
					<div class="mt-4 p-4 bg-red-950\/30 border border-red-500\/30 rounded-lg max-w-md">
						<code class="text-red-400 text-sm">
							Error: Cloudflare timeout (524)<br/>
							Origin server took too long to respond
						</code>
					</div>
				</div>
			{:else if steps[currentStep].visual === 'old-flow'}
				<div class="flex flex-col items-center justify-center h-full gap-6">
					<div class="flex items-center gap-2">
						{#each Array(5) as _, i}
							<div
								class="w-16 h-16 bg-zinc-800 rounded border border-zinc-700 flex items-center justify-center text-xs process-old"
								style="animation-delay: {i * 0.3}s"
							>
								Batch {i + 1}
							</div>
							{#if i < 4}
								<svg class="w-6 h-6 text-zinc-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M5 12h14M12 5l7 7-7 7"/>
								</svg>
							{/if}
						{/each}
					</div>
					<div class="text-center text-zinc-500">
						<p>Each batch: 100 images x ~1s each = ~100s</p>
						<p class="text-red-400 mt-2">Sequential processing → Timeout</p>
					</div>
					<div class="grid grid-cols-10 gap-1 mt-4">
						{#each Array(100) as _, i}
							<div
								class="w-4 h-4 rounded-sm"
								style="background: {i < 30 ? '#22c55e' : i < 35 ? '#3b82f6' : '#27272a'}"
							></div>
						{/each}
					</div>
					<p class="text-sm text-zinc-500">Processing one by one... then timeout</p>
				</div>
			{:else if steps[currentStep].visual === 'new-flow'}
				<div class="flex flex-col items-center justify-center h-full gap-6">
					<div class="text-center mb-4">
						<span class="text-blue-400 font-mono">Cron (every 5 min)</span>
						<svg class="w-6 h-6 mx-auto mt-2 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
							<path d="M12 5v14M5 12l7 7 7-7"/>
						</svg>
					</div>
					<div class="flex items-center gap-4">
						<div class="w-24 h-16 bg-blue-500\/20 border border-blue-500\/50 rounded-lg flex items-center justify-center">
							<span class="text-sm text-blue-400">QStash</span>
						</div>
						<div class="flex flex-col gap-1">
							{#each Array(5) as _, i}
								<svg
									class="w-16 h-4 text-blue-400 fanout-arrow"
									style="animation-delay: {i * 0.1}s"
									viewBox="0 0 64 16"
									fill="none"
									stroke="currentColor"
									stroke-width="2"
								>
									<path d="M0 8h48M40 2l8 6-8 6"/>
								</svg>
							{/each}
						</div>
						<div class="grid grid-cols-3 gap-2">
							{#each Array(6) as _, i}
								<div
									class="w-20 h-12 bg-green-500\/20 border border-green-500\/50 rounded flex items-center justify-center text-xs text-green-400 appear-box"
									style="animation-delay: {0.5 + i * 0.1}s"
								>
									Replica {i + 1}
								</div>
							{/each}
						</div>
					</div>
					<div class="grid grid-cols-25 gap-half mt-4">
						{#each Array(500) as _, i}
							<div
								class="w-2 h-2 rounded-sm bg-green-500 process-new"
								style="animation-delay: {(i % 50) * 20}ms"
							></div>
						{/each}
					</div>
					<p class="text-sm text-green-400">500 images processed in parallel across replicas</p>
				</div>
			{:else if steps[currentStep].visual === 'flow-control'}
				<div class="flex flex-col items-center justify-center h-full gap-6">
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700">
						<h3 class="text-lg font-semibold mb-4 text-center">QStash Flow Control</h3>
						<div class="flex items-center gap-8">
							<div class="text-center">
								<div class="w-24 h-24 bg-blue-500\/20 border-2 border-blue-500 rounded-lg flex items-center justify-center mb-2">
									<span class="text-3xl font-bold text-blue-400">500</span>
								</div>
								<span class="text-sm text-zinc-400">Queued</span>
							</div>
							<div class="flex flex-col items-center">
								<svg class="w-16 h-8 text-zinc-500" viewBox="0 0 64 32" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M0 16h48M40 8l8 8-8 8"/>
								</svg>
								<span class="text-xs text-zinc-500 mt-1">parallelism=50</span>
							</div>
							<div class="text-center">
								<div class="w-24 h-24 bg-green-500\/20 border-2 border-green-500 rounded-lg flex items-center justify-center mb-2 relative">
									<span class="text-3xl font-bold text-green-400">50</span>
									<div class="absolute -top-2 -right-2 w-6 h-6 bg-green-500 rounded-full flex items-center justify-center">
										<svg class="w-4 h-4 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
											<path d="M5 12l5 5L20 7"/>
										</svg>
									</div>
								</div>
								<span class="text-sm text-zinc-400">Concurrent</span>
							</div>
							<div class="flex flex-col items-center">
								<svg class="w-16 h-8 text-zinc-500" viewBox="0 0 64 32" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M0 16h48M40 8l8 8-8 8"/>
								</svg>
							</div>
							<div class="text-center">
								<div class="w-24 h-24 bg-purple-500\/20 border-2 border-purple-500 rounded-lg flex items-center justify-center mb-2">
									<span class="text-2xl font-bold text-purple-400">Vec</span>
								</div>
								<span class="text-sm text-zinc-400">Vectorizer</span>
							</div>
						</div>
					</div>
					<div class="flex gap-4 mt-4">
						<div class="flex items-center gap-2">
							<div class="w-3 h-3 bg-blue-500 rounded-full"></div>
							<span class="text-sm text-zinc-400">Waiting in queue</span>
						</div>
						<div class="flex items-center gap-2">
							<div class="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
							<span class="text-sm text-zinc-400">Processing</span>
						</div>
						<div class="flex items-center gap-2">
							<div class="w-3 h-3 bg-zinc-600 rounded-full"></div>
							<span class="text-sm text-zinc-400">Completed</span>
						</div>
					</div>
				</div>
			{:else if steps[currentStep].visual === 'edge-cases'}
				<div class="grid grid-cols-3 gap-6 h-full p-4">
					<!-- Edge Case 1: Task Cancellation -->
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 flex flex-col edge-card" style="animation-delay: 0s">
						<div class="flex items-center gap-2 mb-4">
							<div class="w-8 h-8 bg-red-500\/20 rounded-lg flex items-center justify-center">
								<svg class="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M18 6L6 18M6 6l12 12"/>
								</svg>
							</div>
							<h3 class="font-semibold">Task Cancellation</h3>
						</div>
						<div class="flex-1 flex flex-col gap-2">
							<div class="text-sm text-zinc-400">When user cancels:</div>
							<ul class="text-xs text-zinc-500 space-y-1 ml-4 list-disc">
								<li>Task status → "cancelled"</li>
								<li>In-flight messages check status</li>
								<li>Skip processing if cancelled</li>
								<li>No wasted compute</li>
							</ul>
							<div class="mt-auto p-2 bg-zinc-900 rounded text-xs font-mono text-zinc-400">
								if (task.status === "cancelled")<br/>
								&nbsp;&nbsp;return; // skip
							</div>
						</div>
					</div>

					<!-- Edge Case 2: Duplicate Processing -->
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 flex flex-col edge-card" style="animation-delay: 0.1s">
						<div class="flex items-center gap-2 mb-4">
							<div class="w-8 h-8 bg-yellow-500\/20 rounded-lg flex items-center justify-center">
								<svg class="w-5 h-5 text-yellow-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2"/>
								</svg>
							</div>
							<h3 class="font-semibold">Idempotency</h3>
						</div>
						<div class="flex-1 flex flex-col gap-2">
							<div class="text-sm text-zinc-400">Prevent duplicate work:</div>
							<ul class="text-xs text-zinc-500 space-y-1 ml-4 list-disc">
								<li>Check needsVectorization flag</li>
								<li>Skip if already processed</li>
								<li>Upsert EvalResult (not insert)</li>
								<li>Safe for retries</li>
							</ul>
							<div class="mt-auto p-2 bg-zinc-900 rounded text-xs font-mono text-zinc-400">
								if (!image.needsVectorization)<br/>
								&nbsp;&nbsp;return; // already done
							</div>
						</div>
					</div>

					<!-- Edge Case 3: Completion Detection -->
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 flex flex-col edge-card" style="animation-delay: 0.2s">
						<div class="flex items-center gap-2 mb-4">
							<div class="w-8 h-8 bg-green-500\/20 rounded-lg flex items-center justify-center">
								<svg class="w-5 h-5 text-green-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
									<path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/>
								</svg>
							</div>
							<h3 class="font-semibold">Completion Detection</h3>
						</div>
						<div class="flex-1 flex flex-col gap-2">
							<div class="text-sm text-zinc-400">Know when done:</div>
							<ul class="text-xs text-zinc-500 space-y-1 ml-4 list-disc">
								<li>Each worker checks pending count</li>
								<li>Last one marks task complete</li>
								<li>Sets finishedAt timestamp</li>
								<li>UI shows duration</li>
							</ul>
							<div class="mt-auto p-2 bg-zinc-900 rounded text-xs font-mono text-zinc-400">
								if (pendingCount === 0)<br/>
								&nbsp;&nbsp;task.status = "completed"
							</div>
						</div>
					</div>
				</div>
			{:else if steps[currentStep].visual === 'straggler'}
				<div class="flex flex-col items-center justify-center h-full gap-6">
					<div class="text-center mb-2">
						<span class="text-zinc-400 text-sm">Single slow image doesn't block others</span>
					</div>

					<!-- Timeline visualization -->
					<div class="w-full max-w-4xl">
						<div class="relative">
							<!-- Time axis -->
							<div class="absolute left-0 right-0 top-1/2 h-px bg-zinc-700"></div>

							<!-- Fast images -->
							<div class="flex flex-col gap-2 mb-8">
								{#each Array(5) as _, i}
									<div class="flex items-center gap-4">
										<span class="text-xs text-zinc-500 w-20">Image {i + 1}</span>
										<div
											class="h-6 bg-green-500/30 border border-green-500/50 rounded straggler-bar"
											style="width: {60 + Math.random() * 40}px; animation-delay: {i * 0.1}s"
										>
											<div class="h-full bg-green-500/50 rounded animate-pulse" style="width: 100%"></div>
										</div>
										<svg class="w-5 h-5 text-green-400 straggler-check" style="animation-delay: {0.5 + i * 0.1}s" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
											<path d="M5 12l5 5L20 7"/>
										</svg>
									</div>
								{/each}

								<!-- Straggler -->
								<div class="flex items-center gap-4">
									<span class="text-xs text-orange-400 w-20">Straggler</span>
									<div
										class="h-6 bg-orange-500/30 border border-orange-500/50 rounded straggler-bar-slow"
										style="width: 280px"
									>
										<div class="h-full bg-orange-500/50 rounded straggler-progress"></div>
									</div>
									<svg class="w-5 h-5 text-orange-400 straggler-check-slow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
										<path d="M5 12l5 5L20 7"/>
									</svg>
								</div>
							</div>
						</div>
					</div>

					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 max-w-lg">
						<h3 class="font-semibold mb-3 text-green-400">Why this works</h3>
						<ol class="text-sm text-zinc-400 space-y-2 list-decimal ml-4">
							<li>Fast images complete, each checks pendingCount</li>
							<li>pendingCount &gt; 0 (straggler still pending)</li>
							<li>Fast workers exit without marking complete</li>
							<li>Straggler finishes, checks pendingCount = 0</li>
							<li class="text-green-400">Straggler marks task complete</li>
						</ol>
					</div>
				</div>
			{:else if steps[currentStep].visual === 'race-condition'}
				<div class="flex flex-col items-center justify-center h-full gap-6">
					<div class="bg-red-950/30 border border-red-500/30 rounded-xl p-4 max-w-lg">
						<div class="flex items-center gap-2 mb-2">
							<svg class="w-5 h-5 text-red-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
							</svg>
							<span class="font-semibold text-red-400">Potential Bug</span>
						</div>
						<p class="text-sm text-zinc-400">When last two images finish simultaneously, both may see pendingCount=1</p>
					</div>

					<!-- Race condition timeline -->
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 w-full max-w-3xl">
						<div class="flex gap-8">
							<!-- Worker A timeline -->
							<div class="flex-1">
								<div class="text-center mb-4 text-blue-400 font-semibold">Worker A (Image 499)</div>
								<div class="space-y-3">
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0s">
										<div class="w-3 h-3 bg-blue-500 rounded-full"></div>
										<span class="text-xs text-zinc-400">Process image</span>
									</div>
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0.3s">
										<div class="w-3 h-3 bg-blue-500 rounded-full"></div>
										<span class="text-xs text-zinc-400">Transaction: set needsVectorization=false</span>
									</div>
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0.6s">
										<div class="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>
										<span class="text-xs text-yellow-400">Check pendingCount... sees 1?</span>
									</div>
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0.9s">
										<div class="w-3 h-3 bg-zinc-600 rounded-full"></div>
										<span class="text-xs text-zinc-500">Exit (doesn't complete task)</span>
									</div>
								</div>
							</div>

							<!-- Divider -->
							<div class="w-px bg-zinc-700"></div>

							<!-- Worker B timeline -->
							<div class="flex-1">
								<div class="text-center mb-4 text-purple-400 font-semibold">Worker B (Image 500)</div>
								<div class="space-y-3">
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0.1s">
										<div class="w-3 h-3 bg-purple-500 rounded-full"></div>
										<span class="text-xs text-zinc-400">Process image</span>
									</div>
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0.4s">
										<div class="w-3 h-3 bg-purple-500 rounded-full"></div>
										<span class="text-xs text-zinc-400">Transaction: set needsVectorization=false</span>
									</div>
									<div class="flex items-center gap-2 race-step" style="animation-delay: 0.7s">
										<div class="w-3 h-3 bg-yellow-500 rounded-full animate-pulse"></div>
										<span class="text-xs text-yellow-400">Check pendingCount... sees 1?</span>
									</div>
									<div class="flex items-center gap-2 race-step" style="animation-delay: 1.0s">
										<div class="w-3 h-3 bg-zinc-600 rounded-full"></div>
										<span class="text-xs text-zinc-500">Exit (doesn't complete task)</span>
									</div>
								</div>
							</div>
						</div>
					</div>

					<div class="grid grid-cols-2 gap-4 w-full max-w-3xl">
						<div class="bg-red-950/20 border border-red-500/30 rounded-lg p-4">
							<h4 class="font-semibold text-red-400 mb-2">Result</h4>
							<p class="text-xs text-zinc-400">Task stuck in "running" state forever. No worker marks it complete.</p>
						</div>
						<div class="bg-green-950/20 border border-green-500/30 rounded-lg p-4">
							<h4 class="font-semibold text-green-400 mb-2">Mitigation</h4>
							<p class="text-xs text-zinc-400">Cron runs every 5 min and will create a new task or complete the existing one based on actual pending count.</p>
						</div>
					</div>

					<div class="bg-zinc-900 rounded-lg p-4 max-w-2xl">
						<code class="text-xs text-zinc-400 whitespace-pre">// Current code at consumers.ts:485-499
const pendingCount = await prisma.trainingImage.count(&#123;
  where: &#123; needsVectorization: true &#125;,
&#125;);
if (pendingCount === 0) &#123;
  // Both workers might miss this check!
  task.status = "completed";
&#125;</code>
					</div>
				</div>
			{:else if steps[currentStep].visual === 'capacity-gap'}
				<div class="flex flex-col items-center justify-center h-full gap-6">
					<div class="bg-orange-950/30 border border-orange-500/30 rounded-xl p-4 max-w-xl">
						<div class="flex items-center gap-2 mb-2">
							<svg class="w-5 h-5 text-orange-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
								<circle cx="12" cy="12" r="10"/>
								<path d="M12 6v6l4 2"/>
							</svg>
							<span class="font-semibold text-orange-400">Wasted Capacity</span>
						</div>
						<p class="text-sm text-zinc-400">With 10,000 images: cron enqueues 500, workers idle for ~4 min waiting for next cron</p>
					</div>

					<!-- Timeline visualization -->
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 w-full max-w-4xl">
						<div class="flex items-center gap-2 mb-4 text-sm text-zinc-500">
							<span>Timeline (not to scale)</span>
						</div>

						<!-- Time markers -->
						<div class="flex justify-between text-xs text-zinc-600 mb-2">
							<span>0:00</span>
							<span>0:10</span>
							<span>1:00</span>
							<span>5:00</span>
						</div>

						<!-- Capacity bar -->
						<div class="relative h-16 bg-zinc-900 rounded-lg overflow-hidden mb-4">
							<!-- Active processing -->
							<div class="absolute left-0 top-0 h-full bg-green-500/30 border-r border-green-500" style="width: 8%">
								<div class="h-full flex items-center justify-center text-xs text-green-400">
									499 done
								</div>
							</div>
							<!-- Straggler only -->
							<div class="absolute top-0 h-full bg-orange-500/20 border-r border-orange-500" style="left: 8%; width: 12%">
								<div class="h-full flex items-center justify-center text-xs text-orange-400">
									1 straggler
								</div>
							</div>
							<!-- Idle gap -->
							<div class="absolute top-0 h-full bg-red-500/10 capacity-gap-pulse" style="left: 20%; width: 60%">
								<div class="h-full flex items-center justify-center text-xs text-red-400">
									IDLE - waiting for cron
								</div>
							</div>
							<!-- Next batch -->
							<div class="absolute right-0 top-0 h-full bg-blue-500/30" style="width: 20%">
								<div class="h-full flex items-center justify-center text-xs text-blue-400">
									Next batch
								</div>
							</div>
						</div>

						<!-- Worker slots visualization -->
						<div class="grid grid-cols-50 gap-px">
							{#each Array(50) as _, i}
								<div class="h-4 rounded-sm capacity-slot" style="animation-delay: {i * 20}ms"></div>
							{/each}
						</div>
						<div class="text-xs text-zinc-500 mt-2 text-center">50 worker slots (parallelism limit)</div>
					</div>

					<!-- Stats -->
					<div class="grid grid-cols-3 gap-4 w-full max-w-3xl">
						<div class="bg-zinc-900 rounded-lg p-4 text-center">
							<div class="text-2xl font-bold text-green-400">~10s</div>
							<div class="text-xs text-zinc-500">Batch processing time</div>
						</div>
						<div class="bg-zinc-900 rounded-lg p-4 text-center">
							<div class="text-2xl font-bold text-red-400">~4 min</div>
							<div class="text-xs text-zinc-500">Idle time per batch</div>
						</div>
						<div class="bg-zinc-900 rounded-lg p-4 text-center">
							<div class="text-2xl font-bold text-orange-400">~4%</div>
							<div class="text-xs text-zinc-500">Capacity utilization</div>
						</div>
					</div>

					<!-- Solutions -->
					<div class="bg-zinc-800 rounded-xl p-6 border border-zinc-700 w-full max-w-3xl">
						<h3 class="font-semibold mb-4 text-zinc-300">Potential Solutions</h3>
						<div class="grid grid-cols-2 gap-4">
							<div class="bg-zinc-900 rounded-lg p-3">
								<div class="text-sm font-medium text-blue-400 mb-1">Self-enqueue pattern</div>
								<p class="text-xs text-zinc-500">Each worker enqueues next pending image after finishing</p>
							</div>
							<div class="bg-zinc-900 rounded-lg p-3">
								<div class="text-sm font-medium text-purple-400 mb-1">Shorter cron interval</div>
								<p class="text-xs text-zinc-500">*/1 * * * * instead of */5 * * * *</p>
							</div>
							<div class="bg-zinc-900 rounded-lg p-3">
								<div class="text-sm font-medium text-green-400 mb-1">Larger batch size</div>
								<p class="text-xs text-zinc-500">CRON_FANOUT_SIZE = 2000+ to keep queue full</p>
							</div>
							<div class="bg-zinc-900 rounded-lg p-3">
								<div class="text-sm font-medium text-orange-400 mb-1">Callback chain</div>
								<p class="text-xs text-zinc-500">Last message triggers next batch enqueue</p>
							</div>
						</div>
					</div>

					<div class="bg-zinc-900 rounded-lg p-4 max-w-2xl">
						<code class="text-xs text-zinc-400 whitespace-pre">// Current: CRON_FANOUT_SIZE = 500, cron every 5 min
// With parallelism=50, batch drains in ~10s
// Then 4+ minutes of nothing until next cron tick</code>
					</div>
				</div>
			{/if}
		</div>

		<!-- Controls -->
		<div class="controls-container">
			<div class="controls-inner">
				<button
					onclick={prevStep}
					disabled={currentStep === 0}
					class="nav-btn"
					aria-label="Previous step"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<path d="M15 18l-6-6 6-6"/>
					</svg>
				</button>

				<div class="step-indicators">
					{#each steps as step, i}
						<button
							onclick={() => currentStep = i}
							class="step-dot"
							class:active={i === currentStep}
							class:completed={i < currentStep}
							aria-label="Go to step {i + 1}"
						></button>
					{/each}
				</div>

				<button
					onclick={nextStep}
					disabled={currentStep === steps.length - 1}
					class="nav-btn"
					aria-label="Next step"
				>
					<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
						<path d="M9 18l6-6-6-6"/>
					</svg>
				</button>
			</div>
		</div>

		<!-- Summary stats -->
		<div class="grid grid-cols-4 gap-4 mt-8">
			<div class="bg-zinc-900 rounded-xl p-4 text-center">
				<div class="text-3xl font-bold text-red-400">100s+</div>
				<div class="text-sm text-zinc-500">Old: Time per batch</div>
			</div>
			<div class="bg-zinc-900 rounded-xl p-4 text-center">
				<div class="text-3xl font-bold text-green-400">~2s</div>
				<div class="text-sm text-zinc-500">New: Time per image</div>
			</div>
			<div class="bg-zinc-900 rounded-xl p-4 text-center">
				<div class="text-3xl font-bold text-blue-400">50x</div>
				<div class="text-sm text-zinc-500">Parallelism</div>
			</div>
			<div class="bg-zinc-900 rounded-xl p-4 text-center">
				<div class="text-3xl font-bold text-purple-400">500</div>
				<div class="text-sm text-zinc-500">Images per cron</div>
			</div>
		</div>

		<!-- Files changed -->
		<div class="mt-8 bg-zinc-900 rounded-xl p-6">
			<h3 class="text-lg font-semibold mb-4">Files Changed</h3>
			<div class="space-y-2 font-mono text-sm">
				<div class="flex items-center gap-2">
					<span class="text-green-400">+175</span>
					<span class="text-zinc-400">apps/api-v2/src/routes/training/consumers.ts</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-green-400">+39</span>
					<span class="text-zinc-400">apps/api-v2/src/routes/training/qstash.ts</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-yellow-400">~87</span>
					<span class="text-zinc-400">apps/api-v2/src/routes/training/revectorize.ts</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-green-400">+3</span>
					<span class="text-zinc-400">apps/api-v2/src/routes/webhooks/qstash.ts</span>
				</div>
				<div class="flex items-center gap-2">
					<span class="text-green-400">+24</span>
					<span class="text-zinc-400">training-monitor/src/components/layout/header-layout.tsx</span>
				</div>
			</div>
		</div>
	</main>
</div>

<style>
	.controls-container {
		display: flex;
		justify-content: center;
		margin-top: 2rem;
	}

	.controls-inner {
		display: flex;
		align-items: center;
		gap: 1rem;
		padding: 0.5rem;
		background: rgba(24, 24, 27, 0.8);
		backdrop-filter: blur(12px);
		border: 1px solid rgba(63, 63, 70, 0.5);
		border-radius: 9999px;
	}

	.nav-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.5rem;
		height: 2.5rem;
		background: transparent;
		border: none;
		border-radius: 50%;
		color: #a1a1aa;
		transition: all 0.2s ease;
		cursor: pointer;
	}

	.nav-btn:hover:not(:disabled) {
		background: rgba(63, 63, 70, 0.5);
		color: #fafafa;
	}

	.nav-btn:active:not(:disabled) {
		transform: scale(0.95);
	}

	.nav-btn:disabled {
		opacity: 0.25;
		cursor: not-allowed;
	}

	.step-indicators {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0 0.5rem;
	}

	.step-dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		border: none;
		background: #3f3f46;
		cursor: pointer;
		transition: all 0.3s ease;
		padding: 0;
	}

	.step-dot:hover {
		background: #52525b;
		transform: scale(1.2);
	}

	.step-dot.completed {
		background: #3b82f6;
	}

	.step-dot.active {
		background: #60a5fa;
		box-shadow: 0 0 12px rgba(96, 165, 250, 0.5);
		transform: scale(1.3);
	}

	.min-h-500 {
		min-height: 500px;
	}

	.gap-half {
		gap: 2px;
	}

	.border-red {
		border: 1px solid rgb(239 68 68 / 0.5);
	}

	.process-old {
		animation: processOld 1.5s ease-in-out infinite;
	}

	@keyframes processOld {
		0%, 100% { opacity: 0.5; transform: scale(1); }
		50% { opacity: 1; transform: scale(1.05); border-color: #3b82f6; }
	}

	.fanout-arrow {
		animation: fanout 1s ease-out forwards;
		opacity: 0;
		transform: translateX(-10px);
	}

	@keyframes fanout {
		to { opacity: 1; transform: translateX(0); }
	}

	.appear-box {
		animation: appear 0.5s ease-out forwards;
		opacity: 0;
		transform: scale(0.8);
	}

	@keyframes appear {
		to { opacity: 1; transform: scale(1); }
	}

	.process-new {
		animation: processNew 2s ease-out forwards;
		opacity: 0.3;
	}

	@keyframes processNew {
		0% { opacity: 0.3; }
		50% { opacity: 1; background: #22c55e; }
		100% { opacity: 0.6; background: #166534; }
	}

	.edge-card {
		animation: slideUp 0.5s ease-out forwards;
		opacity: 0;
		transform: translateY(20px);
	}

	@keyframes slideUp {
		to { opacity: 1; transform: translateY(0); }
	}

	.straggler-bar {
		animation: stragglerBar 0.5s ease-out forwards;
		opacity: 0;
		transform: scaleX(0);
		transform-origin: left;
	}

	@keyframes stragglerBar {
		to { opacity: 1; transform: scaleX(1); }
	}

	.straggler-check {
		animation: stragglerCheck 0.3s ease-out forwards;
		opacity: 0;
		transform: scale(0);
	}

	@keyframes stragglerCheck {
		to { opacity: 1; transform: scale(1); }
	}

	.straggler-bar-slow {
		animation: stragglerBarSlow 3s ease-out forwards;
		opacity: 1;
	}

	@keyframes stragglerBarSlow {
		0% { transform: scaleX(0); transform-origin: left; }
		100% { transform: scaleX(1); transform-origin: left; }
	}

	.straggler-progress {
		animation: stragglerProgress 3s ease-out forwards;
		width: 0;
	}

	@keyframes stragglerProgress {
		0% { width: 0; }
		100% { width: 100%; }
	}

	.straggler-check-slow {
		animation: stragglerCheckSlow 0.3s ease-out 3s forwards;
		opacity: 0;
		transform: scale(0);
	}

	@keyframes stragglerCheckSlow {
		to { opacity: 1; transform: scale(1); }
	}

	.race-step {
		animation: raceStep 0.4s ease-out forwards;
		opacity: 0;
		transform: translateX(-10px);
	}

	@keyframes raceStep {
		to { opacity: 1; transform: translateX(0); }
	}

	.grid-cols-50 {
		grid-template-columns: repeat(50, minmax(0, 1fr));
	}

	.capacity-slot {
		animation: capacitySlot 3s ease-out forwards;
		background: #22c55e;
	}

	@keyframes capacitySlot {
		0% { background: #22c55e; }
		20% { background: #22c55e; }
		25% { background: #3f3f46; }
		100% { background: #3f3f46; }
	}

	.capacity-gap-pulse {
		animation: capacityGapPulse 2s ease-in-out infinite;
	}

	@keyframes capacityGapPulse {
		0%, 100% { background: rgba(239, 68, 68, 0.1); }
		50% { background: rgba(239, 68, 68, 0.2); }
	}
</style>
