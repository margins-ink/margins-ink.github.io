<svg
	class="routing"
	viewBox="0 0 440 540"
	xmlns="http://www.w3.org/2000/svg"
	aria-labelledby="routing-title routing-desc"
	role="img"
>
	<title id="routing-title">How the implement DAG picks a reviewer</title>
	<desc id="routing-desc">
		A vertical flowchart showing the steps the implement DAG runs before
		opening a pull request: list the file's recent committers via git log,
		look each handle up in the playbook's people pages, read the strengths
		page end-to-end, reframe the PR's beneficiary sentence in the reviewer's
		voice, then open the PR with the resolved reviewer.
	</desc>

	<defs>
		<marker id="rarrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto" markerUnits="strokeWidth">
			<path d="M0,0 L0,8 L7,4 z" fill="currentColor" />
		</marker>
	</defs>

	<!-- 1. file path changed -->
	<g class="event">
		<rect x="110" y="10" width="220" height="40" rx="20" />
		<text x="220" y="35" text-anchor="middle" class="primary">file path changed</text>
	</g>
	<line x1="220" y1="54" x2="220" y2="78" stroke="currentColor" marker-end="url(#rarrow)" />

	<!-- 2. git log -->
	<g class="step">
		<rect x="20" y="82" width="400" height="46" rx="6" />
		<text x="220" y="106" text-anchor="middle" class="code">git log --pretty='%an &lt;%ae&gt;' --since='180 days ago' -- &lt;path&gt;</text>
		<text x="220" y="122" text-anchor="middle" class="meta">top recent committers, ranked</text>
	</g>
	<line x1="220" y1="132" x2="220" y2="156" stroke="currentColor" marker-end="url(#rarrow)" />

	<!-- 3. playbook lookup -->
	<g class="step">
		<rect x="20" y="160" width="400" height="46" rx="6" />
		<text x="220" y="184" text-anchor="middle" class="code">playbook/src/routes/people/&lt;handle&gt;/+page.svx</text>
		<text x="220" y="200" text-anchor="middle" class="meta">resolve GitHub identity, surface ownership</text>
	</g>
	<line x1="220" y1="210" x2="220" y2="234" stroke="currentColor" marker-end="url(#rarrow)" />

	<!-- 4. read strengths page -->
	<g class="step">
		<rect x="20" y="238" width="400" height="60" rx="6" />
		<text x="220" y="259" text-anchor="middle" class="primary bold">read strengths page end-to-end</text>
		<text x="220" y="276" text-anchor="middle" class="meta">summary + every dated signal</text>
		<text x="220" y="290" text-anchor="middle" class="meta">what shape of PR this human calls a good catch</text>
	</g>
	<line x1="220" y1="302" x2="220" y2="326" stroke="currentColor" marker-end="url(#rarrow)" />

	<!-- 5. reframe -->
	<g class="step highlight">
		<rect x="20" y="330" width="400" height="60" rx="6" />
		<text x="220" y="351" text-anchor="middle" class="primary bold">reframe beneficiary sentence</text>
		<text x="220" y="368" text-anchor="middle" class="meta">in the language the reviewer's page uses</text>
		<text x="220" y="382" text-anchor="middle" class="meta">validation shaped around their review style</text>
	</g>
	<line x1="220" y1="394" x2="220" y2="418" stroke="currentColor" marker-end="url(#rarrow)" />

	<!-- 6. PR opened -->
	<g class="terminal">
		<rect x="60" y="422" width="320" height="56" rx="20" />
		<text x="220" y="446" text-anchor="middle" class="primary bold">PR opened</text>
		<text x="220" y="464" text-anchor="middle" class="meta">body framed in reviewer's voice, reviewer assigned</text>
	</g>
</svg>

<style>
	.routing {
		display: block;
		max-width: 540px;
		margin: 2.75rem auto;
		color: var(--text-primary);
	}

	.routing text {
		fill: currentColor;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
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

	.code {
		font-size: 11px;
		font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
	}

	.event rect {
		fill: none;
		stroke: currentColor;
		stroke-width: 1;
		stroke-dasharray: 4 3;
		opacity: 0.7;
	}

	.step rect {
		fill: none;
		stroke: currentColor;
		stroke-width: 1.25;
	}

	.step.highlight rect {
		fill: currentColor;
		fill-opacity: 0.05;
		stroke-width: 1.5;
	}

	.terminal rect {
		fill: currentColor;
		fill-opacity: 0.08;
		stroke: currentColor;
		stroke-width: 1.5;
	}
</style>
