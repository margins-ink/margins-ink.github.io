Personal site for Andrew Gazelka.

We use pnpm; NEVER use npm

Make sure always use current date (get with CLI command)

## SvelteKit Patterns

To break layout inheritance (avoid parent layouts like navbar), use **route groups** `(parentheses)`:
- Wrap main site in `(site)/` group with its own layout
- Keep root layout minimal (just global CSS)
- Other routes like `lmllmtfy/` sit at root level with their own layouts
- Route groups don't affect URL paths - `(site)/thoughts/` → `/thoughts/`
- This is the idiomatic SvelteKit way, NOT using CSS hacks or `+layout@.svelte`

**IMPORTANT**: When using `import.meta.glob()` with route groups, you MUST escape parentheses:
- ❌ Wrong: `import.meta.glob('/src/routes/(site)/**/*.svx')`
- ✅ Correct: `import.meta.glob('/src/routes/\\(site\\)/**/*.svx')`
- See: https://github.com/sveltejs/kit/issues/6239

## Article card visuals

Each thought has a small SVG visual on its card (`src/lib/components/visuals/`). The visual is an emblem of the article's thesis. State one specific idea per visual.

Most of the existing visuals lean too generic: stock "queue → workers → done", "table with rows", "hub with spokes" abstractions all converge to the same shape across articles and stop carrying meaning. The look becomes mood lighting instead of an image.

Aim for:
- One legible idea per visual. If you cannot summarize it in a sentence ("a name pointing to a hash inside a cycle", "typed input, blob output"), the visual is too generic.
- Domain iconography over filler geometry. A coin, a hash, a glyph from the article's subject reads instantly. Three faded rounded rectangles do not.
- Animation that demonstrates the thesis. The hover state should reveal the behavior the article describes, not just pulse for motion.
- Restraint. Few shapes, monochrome (`--text-tertiary` / `--text-quaternary`). One accent only if it carries meaning.

Each visual is a `<svg viewBox="0 0 120 60">` Svelte component with `let { hovered = false }: { hovered?: boolean } = $props();`. Width and height fill the container. Register in `src/lib/components/visuals/index.ts` and `src/lib/thoughts.ts:visualMap`.

## Writing thoughts

Posts in `src/routes/(site)/thoughts/` share a consistent voice. The rules below are in priority order. The first two override everything else.

### Restating is evil

Every sentence must add new information. This is the highest-priority rule and the easiest to violate without noticing. If a paragraph closes by rephrasing how it opened, cut the close. If a section opens by recapping the previous section, cut the open. A list followed by a sentence summarizing the list: cut the summary. A punchy thesis followed by "that's it" or "and that's the point" or "so really, X is just Y": cut the trailing line. The reader spent attention reading the second copy of the idea; they learned nothing on that pass, and worse, the repetition tells them the writer didn't trust them to retain the first one.

Test every sentence: delete it. Does the reader lose anything they cannot recover from earlier context? If no, delete it for real.

Common restatement shapes to hunt:
- "X. That's it." after stating X.
- "The interface is the thing. The substrate is implementation detail." right after arguing exactly that across two paragraphs.
- The first sentence of section N+1 rewording the last sentence of section N.
- A claim made abstractly, then again with a concrete example, then again with a closing aphorism: keep at most two of those.
- A phrase ("the verbs are the contract", "content addressing", "the wall") repeated as a thematic refrain across multiple sections. Refrains feel literary; they read as filler.

End each section on the last new thing said. Do not button up. Do not recap. Do not echo.

### Guide the reader

A post is an argument; each paragraph is a step in it. The transitions between paragraphs and sections should answer "why this next?", not just "and now this other thing." Every section break is a promise that the next section advances the argument, not that it covers another aspect of the same topic.

Concrete practices:
- After the thesis, the reader should be able to predict the *kind* of move that comes next (a concrete example, a counter-case, a reframe, a consequence). Make the move sharply. Don't meander.
- Each section title should describe a step in the argument, not a category. "Disk is not in the contract" is a step. "Storage" is a category. Prefer the step.
- When introducing a new concept, name what the reader is supposed to do with it. The Berlin-and-Kay color study isn't trivia; it's there so the reader transfers the lesson to the next paragraph. Make the transfer explicit.
- The final section delivers the strongest claim, not the calmest one. Most posts should end on a sentence the reader could quote.

### Absolutes need citations

Empirical claims that quantify over people, programs, or behavior ("always", "never", "no program", "everyone", "almost nobody", "every developer") need either a primary-source citation or a narrower restatement. A broad uncited claim reads as bluffing. The reader notices once; the post loses authority on every adjacent sentence.

Two valid moves when you catch yourself reaching for one:

- **Narrow the scope.** Replace "almost no program uses advisory locks correctly" with the specific failure mode you can actually point at: "`flock` ownership semantics on Linux were broken enough that the kernel shipped open-file-description locks in 2014 as a fcntl variant ([LWN, 2014](https://lwn.net/Articles/586904/))." Concrete, falsifiable, sourced.
- **Cite the source.** If the broad claim is load-bearing and the source is famous enough to recognize, keep the claim and link the evidence. "The bias-to-variance tradeoff is universal ([Geman et al., 1992](...))" is fine; "The bias-to-variance tradeoff is universal" alone is not.

Prefer narrowing when the source isn't doing argumentative work. Architectural claims about a specific system ("flecs modules don't have to coordinate") don't need citations because the architecture itself is the citation: the manual link in the prose carries it. Empirical claims about the world ("most developers use feature X") always do.

### Interact with edge cases

Deep learning happens at the boundary of the frame, not in its middle. A reader who can recite the rule has memorized it; a reader who can predict what the rule does at its edges has internalized it. Every post should poke at its own claim from the side: cases the rule almost covers, cases that look like exceptions but aren't, cases that genuinely break it.

Practices:
- After the main argument lands, walk through 3-5 edge cases the reader is likely to have privately worried about. Name the worry, then answer it.
- Don't strawman the edge case. State it in the form a smart skeptic would state it, then engage. "What about device files? `/dev/null` accepts writes that go nowhere — that breaks 'write then read returns the bytes.'" Good. "What about people who say filesystems are about disk? They're wrong." Bad.
- Distinguish three flavors: cases that confirm the rule once you look closely, cases that the rule was never claiming to cover, and cases that actually break the rule. Saying which is which is the work.
- A genuine break is more useful than ten confirmations. Find it. Acknowledge it. Either narrow the claim or explain why the break is acceptable.

The reader's model updates when their private "but what about X?" gets answered before they have to ask. That moment is what the post is for.

### Thesis

Every post takes a familiar abstraction and shows the frame around it is not load-bearing. "Nix is fundamentally a DAG" → it isn't. "IFD is an anti-pattern" → only in CppNix. "Filesystem means disk" → no, it means an API. The interesting move is identifying which assumption the reader is making invisibly, then pulling it out from under them.

### Structure

First sentence states the thesis or the question that produces it. No "let me set up what X is" preamble. Cover the strict definition once, early. Spend the body stripping inherited assumptions one at a time, each section pulling a different one. Close with the implication the strip-down unlocks. Never close with a summary.

### Voice

- Opinionated. State the position; trust the reader to evaluate it.
- Concrete over abstract. Name the function (`fsync`, `ecs_get`), the project (Flecs, Snix), the person (Sander Mertens). Specific nouns carry more weight than careful hedging.
- Link to primary sources: man pages, kernel docs, GitHub repos, Wikipedia for stable references. Don't fabricate URLs. If a deep link is uncertain, link the parent (repo root, Wikipedia article).
- Code blocks where the code earns its place. A snippet showing the actual API call beats a paragraph describing it.
- Short paragraphs. Hard breaks between ideas. No transition sentences whose only job is to bridge.

### Forbidden tics

- No em-dashes or `--` substitutes. Period, colon, parenthesis, or split.
- No "X, not Y" contrast pattern. Split into two sentences or just state X.
- No "it's worth noting," "here's the thing," "I'd be happy to," or any LLM verbal tic.
- No decorative emoji.
- No hedging that exists only to soften the claim.

### Links and references

Every post links generously to primary sources. The reader is more likely to trust a claim with a man page or paper next to it; they're also more likely to keep reading because the link is an offer, not a demand. Two kinds of link belong in a post:

1. **Inline links** (`[text](url)`) for in-flow references where the link target is one of many supporting details. Use for: man pages, RFC sections, GitHub repos, Wikipedia articles, documentation pages. Pick the most specific stable URL. If a deep link is uncertain, fall back to the parent.
2. **Numbered references** for sources that carry weight in the argument and deserve a permanent slot at the bottom of the post. Use for: foundational papers, named studies, primary specs, citations the reader might want to come back to. These render as `[N]` inline, link to a list at the bottom, and use the components in `$lib/components/refs`.

Reference component usage:

```svelte
<script>
	import { useRefs, Cite, References } from '$lib/components/refs';
	useRefs([
		{ id: 'posix', title: 'IEEE Std 1003.1-2017 (POSIX)', url: 'https://pubs.opengroup.org/onlinepubs/9699919799/' },
		{ id: 'berlin-kay', title: 'Berlin & Kay, Basic Color Terms: Their Universality and Evolution (1969)', url: 'https://en.wikipedia.org/wiki/Basic_Color_Terms:_Their_Universality_and_Evolution' }
	]);
</script>

POSIX<Cite id="posix" /> standardizes the API surface ...

<References />
```

`useRefs` registers the array via context. `<Cite id="..." />` renders a clickable `[N]` superscript that scrolls to the matching list entry; the number is the ref's position in the array, so define refs in citation order. `<References />` renders the list at the bottom; place it after the closing prose of the post.

Rules:
- Don't fabricate URLs. If unsure, link the parent (repo root, Wikipedia article, docs index).
- Inline links for casual support; numbered refs for sources the post stands on.
- Every numbered ref must be cited at least once in the prose. Unused entries are dead weight.
- A claim that needs sourcing and isn't sourced is a weak claim. Find the source or weaken the claim.

### Cross-pollination

Earlier posts are fair game to link. The thoughts form a connected argument. A new post on filesystems can lean on `/thoughts/nix-cycles` for the content-addressing thread; a post on IFD can point at `/thoughts/snuon` if escaping comes up. When the link is natural, take it. Don't force it.

### The reader

A technical peer. Familiar with Unix, one or two systems languages, one or two databases. Will Google a term they don't know. Does not need "the X command (which does Y)" parentheticals for well-known tools. Hates being explained at.

## PR Artifacts

Create animated diagrams explaining PRs/changes at `src/routes/artifact/{org}/{repo}/{pr#}/+page.svelte`:
- Path includes PR number (e.g., `artifact/drafted-ai/greenfield/422/`)
- Self-contained SvelteKit page with animations
- Use Svelte 5 runes (`$state`, `$props`)
- Include: problem visualization, before/after architecture, edge cases handled, files changed
- Dark theme (zinc-950 background), auto-play animations on mount
- Uses `+layout@.svelte` to break inheritance from root layout (no app.css)
- Custom `artifact.css` with Tailwind-like utility classes (no Tailwind dep)
