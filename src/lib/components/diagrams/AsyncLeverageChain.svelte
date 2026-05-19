<svg
	class="chain"
	viewBox="0 0 400 680"
	xmlns="http://www.w3.org/2000/svg"
	aria-labelledby="chain-title chain-desc"
	role="img"
>
	<title id="chain-title">Slack huddle to merged PR, the full chain</title>
	<desc id="chain-desc">
		A vertical flowchart with seven nodes. A Slack huddle ends; the focus DAG
		fires; it writes a playbook PR and creates Linear tickets labelled with
		[sym] implement; the implement DAG picks up the label and opens a PR; if
		CI stalls, the babysit DAG (running on a ten-minute cron) loops back and
		unsticks it; the PR merges into main.
	</desc>

	<defs>
		<marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
			<path d="M0,0 L0,8 L7,4 z" fill="currentColor" />
		</marker>
		<marker id="arrow-faint" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
			<path d="M0,0 L0,8 L7,4 z" fill="currentColor" opacity="0.55" />
		</marker>
	</defs>

	<!-- 1. Slack huddle ends (event) -->
	<g class="event">
		<rect x="100" y="10" width="200" height="44" rx="22" />
		<text x="200" y="32" text-anchor="middle" class="primary">Slack huddle ends</text>
		<text x="200" y="46" text-anchor="middle" class="meta">#focus channel</text>
	</g>
	<line x1="200" y1="58" x2="200" y2="88" stroke="currentColor" marker-end="url(#arrow)" />

	<!-- 2. focus DAG -->
	<g class="dag">
		<rect x="100" y="92" width="200" height="50" rx="6" />
		<text x="200" y="113" text-anchor="middle" class="primary bold">focus DAG</text>
		<text x="200" y="130" text-anchor="middle" class="meta">codex, reasoning_effort: high</text>
	</g>
	<line x1="200" y1="146" x2="200" y2="180" stroke="currentColor" marker-end="url(#arrow)" />

	<!-- 3. playbook PR + tickets (artifact) -->
	<g class="event">
		<rect x="60" y="184" width="280" height="60" rx="22" />
		<text x="200" y="206" text-anchor="middle" class="primary">playbook PR (focus page)</text>
		<text x="200" y="223" text-anchor="middle" class="primary">N Linear tickets</text>
		<text x="200" y="238" text-anchor="middle" class="meta">label: [sym] implement</text>
	</g>
	<line x1="200" y1="248" x2="200" y2="282" stroke="currentColor" marker-end="url(#arrow)" />

	<!-- 4. implement DAG -->
	<g class="dag">
		<rect x="100" y="286" width="200" height="50" rx="6" />
		<text x="200" y="307" text-anchor="middle" class="primary bold">implement DAG</text>
		<text x="200" y="324" text-anchor="middle" class="meta">linear webhook</text>
	</g>
	<line x1="200" y1="340" x2="200" y2="374" stroke="currentColor" marker-end="url(#arrow)" />

	<!-- 5. PR opened (event) -->
	<g class="event">
		<rect x="100" y="378" width="200" height="50" rx="22" />
		<text x="200" y="400" text-anchor="middle" class="primary">PR opened</text>
		<text x="200" y="416" text-anchor="middle" class="meta">auto-merge enabled</text>
	</g>

	<!-- Babysit feedback loop (side annotation) -->
	<g class="feedback">
		<!-- arrow from PR-opened down-right to babysit -->
		<path
			d="M 300 403 C 360 403 370 425 370 460"
			fill="none"
			stroke="currentColor"
			stroke-dasharray="3 3"
			opacity="0.55"
			marker-end="url(#arrow-faint)"
		/>
		<rect x="245" y="464" width="150" height="50" rx="6" />
		<text x="320" y="485" text-anchor="middle" class="primary">babysit DAG</text>
		<text x="320" y="502" text-anchor="middle" class="meta">cron */10, only if stalled</text>
		<!-- arrow from babysit back up-left to PR-opened -->
		<path
			d="M 245 478 C 200 478 180 460 180 440"
			fill="none"
			stroke="currentColor"
			stroke-dasharray="3 3"
			opacity="0.55"
			marker-end="url(#arrow-faint)"
		/>
		<text x="320" y="535" text-anchor="middle" class="meta">fix commit, watch CI</text>
	</g>

	<!-- Main arrow PR-opened -> merged -->
	<line x1="200" y1="432" x2="200" y2="600" stroke="currentColor" marker-end="url(#arrow)" />

	<!-- 6. merged into main (terminal) -->
	<g class="terminal">
		<rect x="100" y="604" width="200" height="50" rx="22" />
		<text x="200" y="635" text-anchor="middle" class="primary bold">merged into main</text>
	</g>
</svg>

<style>
	.chain {
		display: block;
		max-width: 460px;
		margin: 2.75rem auto;
		color: var(--text-primary);
	}

	.chain text {
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
		fill: currentColor;
	}

	.primary {
		font-size: 13px;
	}

	.bold {
		font-weight: 600;
	}

	.meta {
		font-size: 10.5px;
		opacity: 0.55;
	}

	.event rect {
		fill: none;
		stroke: currentColor;
		stroke-width: 1;
		stroke-dasharray: 4 3;
		opacity: 0.7;
	}

	.dag rect {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.5;
	}

	.terminal rect {
		fill: currentColor;
		fill-opacity: 0.08;
		stroke: currentColor;
		stroke-width: 1.5;
	}

	.feedback rect {
		fill: none;
		stroke: currentColor;
		stroke-width: 1;
		opacity: 0.7;
	}

	.feedback text {
		opacity: 0.85;
	}
</style>
