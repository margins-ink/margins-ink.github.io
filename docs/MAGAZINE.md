# MAGAZINE: articles as graphic magazine spreads, drawn in WebGPU

Status: design, 2026-10-06. Replaces the "one plain column per sheet" layout of `docs/READER.md` (sections 2 and 3.1). Everything else in READER.md stays: Slug analytic text evaluated in the tracer's primary-hit albedo, persistent world canvas, URL routing, hidden DOM for a11y and SEO, Flecs as owner of runtime state. No code was written or run for this document; every number below marked "est." is an estimate to be measured, every licence marked "read" was read from the upstream text on 2026-10-06.

Constraint set (Andrew): each article is laid out like a graphic magazine spread, not a web column; drawn by WebGPU (no HTML, no flex); real diagrams (vector, GPU-drawn, animated where it teaches); pull quotes, drop caps, multi-column grids, marginalia, big numerals, full-bleed figures; rhythm varies per article. No WebGPU fallback.

## Direction update (2026-10-06, Andrew): overrides every conflicting passage below

1. **One sans family, no serif mix.** Inter (variable, body and UI) plus one tight display sans, Instrument Sans (section 3.1). Newsreader, Fraunces, Instrument Serif, Big Shoulders and Caveat are removed. SF Pro cannot be embedded.
2. **Brevity: most text does not matter in the AGI era.** Each piece opens as a **distilled spread** (one 80x56 em spread, about 150 to 250 words counting diagram labels: thesis headline, one or two animated diagrams that carry the argument, a pull quote, at most 3 short captions). The full post is kept as a collapsed **full text layer**, still GPU-drawn, reached by a deliberate gesture (section 4.5). The hidden DOM copy is unchanged and always holds the whole post; the author's text is never deleted or rewritten, only a distilled view is added on top (section 1.7).
3. **Fewer, bolder templates** built around diagram plus headline (section 1.3: 6 templates, not 12).
4. **IFD ("IFD is fine") is the first end-to-end article**; its concrete distilled spread is section 2.6. Wave 1 lanes match (section 8).

Consequences already applied below: the book of spreads in section 4.1 now means distilled spread first, full text on request; drop caps, small caps, marginalia leaders and the planner's rhythm presets are out of v1 (they were sized for a long magazine feature); the rest of the engine (K-P, track solver, figures, shader, preview loop) stays because the full text layer and the figures still need it.

## 0. What exists and what changes

Exists (read in the tree): `scripts/reader/{parse,layout,fonts,geom,math,images,build,validate,dump}.ts` build one binary per article and width class (`src/lib/reader/format.ts`, magic `RDR1`); layout is a min-raggedness DP per paragraph, one column, sheet 40x56 em (measure 30), `LINE_H = 1.6`, grid cells 6 x 1.6 em listing items (glyph | rect | image); `src/lib/gpu/room/reader.wgsl.ts` evaluates glyphs, rects and images in `albedo_of` for sheets stacked vertically and scrolled; `reader.ts` uploads and hit-tests.

Changes:
1. Unit of reading becomes the **spread** (two facing 40x56 em sheets = 80x56 em, aspect 1.43), not a scrolled stack. Narrow class (portrait) shows one 28x56 sheet per "spread" using narrow variants of the same templates.
2. Layout stops being "paragraphs into one measure" and becomes "typed blocks placed into named frames of a grid template", with Knuth-Plass line breaking inside each frame.
3. Items gain two new kinds: **vector paths** (filled Slug-style, stroked by analytic distance) and **animated groups** (channels). Diagrams are authored per article and compiled to these.
4. Binary becomes `RDR2` (section 1.6). The old column layout (`layout.ts` column placement, sheet stack scroll in `reader.wgsl.ts` / `reader.ts`) is deleted in the same change that lands the new path (house rule: one pass, no old arm behind a switch). Shaping, fonts, math, images, parse and band building are reused as they are.

## 1. Layout model

### 1.1 Research and decisions

| Question | Candidates (licence read) | Decision |
|---|---|---|
| Line breaking | Knuth-Plass 1981 (algorithm, no licence issue); `tex-linebreak` (robertknight): `package.json` says MIT, but the repo has no LICENSE file and GitHub reports `license: null`, so not usable until the author confirms; TeX's own is not importable | **Write our own** K-P in TS (about 250 lines) from the paper. Boxes and glue come from our harfbuzz-shaped words, so we need a custom box model anyway (hanging punctuation, drop-cap exclusion, per-line widths). |
| Hyphenation | `hypher` (typst; MIT and Apache-2.0, read), Liang patterns `hyph-en-us.tex` (Kuiken 1990/2004/2005: "copying and distribution ... permitted in any medium without royalty provided the notice is preserved", read) | Port Liang's algorithm (about 80 lines) at build time, load `hyph-en-us.tex` patterns, keep the notice in `docs/upstream/magazine/hyph/`. Exceptions list per article in `spread.json`. |
| Grid / constraint engine | Taffy (MIT, read; Rust, flex and grid), Yoga (MIT, C++), Cassowary ports (kasuari MIT/Apache, cassowary.js BSD) | **Write our own track solver**, about 150 lines: tracks are `fixed | fr | fit`, areas span tracks, a one-pass "fr after fixed" resolve like CSS grid. We do not need flex, wrapping or a general constraint solver; the hard part is typographic fitting (1.4), which none of them do. Taffy/Cassowary would add a dependency and still leave the real work to us. Revisit only if a template needs inequality constraints between areas (none today). |
| Graph layout for diagrams | `dagre` (MIT, read), `elkjs` (EPL-2.0, read: weak copyleft, avoid) | `dagre` at build time for DAG-style figures only; everything else is hand-placed coordinates. |
| Directive syntax in .svx | `remark-directive` (MIT, read) | Use it; directives map to mdast nodes, and a handler maps each to semantic HTML (`figure`, `aside`, `blockquote`) for the hidden DOM so mdsvex output stays valid. |

No GPL or AGPL anywhere. harfbuzzjs, opentype.js, MathJax, sharp stay as in READER.md.

### 1.2 The spread grid (baseline geometry)

Units are em of the body size, y down, same as today. One spread = 80 x 56 em.
- Baseline grid: `LINE_H = 1.6` em; 35 baselines per sheet height minus margins (top margin 5 em = 3.125 baselines is rounded to 3 baselines = 4.8 em; bottom margin 4 baselines for the folio line). Every body baseline in every frame is a multiple of 1.6 em from the sheet top (acceptance A1). Display type, figures and rules snap to half-baselines.
- Columns: each sheet has 6 columns, gutter 1.2 em, outer margin 4.5 em, inner (spine) margin 3.5 em: live width 32 em, column 4.33 em, 2 columns = 9.87 em, 3 columns = 15.4 em (about 34 characters of Newsreader at body size: the magazine measure), 6 columns = 32 em (about 70 characters, the essay measure). A spread is 12 columns; areas may cross the spine (spans 6-7) only for full-bleed items.
- Bleed: a figure or colour field with the `bleed` flag extends to the spread edge (0 margin) on the sides declared.
- Safe zone: no text within 1.5 em of the spine (the page bow and gutter shadow, section 4.4, darken it) or 2 em of the sheet edge.

### 1.3 Templates: named layouts written as ASCII art

A template is a pure data object in `scripts/magazine/templates/*.ts`, selected per spread. The areas are drawn as a character map over the 12 x N grid so a human can see the page:

```ts
// scripts/magazine/templates/duo.ts   (distilled layer)
export const duo = template('duo', {
  cols: 12,                                  // 6 + 6, spine between col 6 and 7
  rows: ['3b', '9b', 'fr', '3b', '4b'],      // top margin, headline band, diagrams, captions, folio
  areas: `
    . . . . . . | . . . . . .
    H H H H H H | D D D D D D                // H headline, D definition + deck (display sans over Inter)
    A A A A A A | B B B B B B                // A diagram 1, B diagram 2 (may bleed across the spine and down)
    a a a a a a | b b b b b b                // captions
    . . . . . . | . . . . . Q`,              // Q pull quote on a tinted field, | marks the spine
  slots: {
    H: { type: 'head',     font: 'display', size: 7.5, lines: [1, 3] },
    D: { type: 'deck',     font: 'body', size: 1.4 },
    A: { type: 'figure',   bleed: ['left'] },
    B: { type: 'figure',   bleed: ['right'] },
    a: { type: 'caption',  font: 'label', size: 0.78 },
    b: { type: 'caption',  font: 'label', size: 0.78 },
    Q: { type: 'pullquote', font: 'display', size: 2.4 }
  },
  budget: { words: [150, 250] }              // enforced on the whole distilled spread
})
```

The full-text templates use the same shape with `body` slots (threaded frames, Knuth-Plass, `align: 'justify'` or `'ragged'`, hyphenation) in place of the distilled slots.

Slot types: `head` (headline, display sans, 1 to 3 lines, `wdth` and `wght` set per article), `deck` (standfirst or definition), `body` (threaded frames, full layer only), `figure`, `pullquote`, `numeral`, `caption`, `code`, `folio`, `rule`, `field` (colour block). `aside` stays as a type for later but no v1 template uses it. A frame may have a `shape` for run-around (rect, or a polygon from a figure's declared `wrap` contour).

The library, v1 after the 2026-10-06 direction (6 templates; the 12-template library of the first draft is deleted, more templates are data, not code). Four **distilled** templates, each a headline plus diagram composition on the 12-column spread, and two **full-text** templates:

| Name | Layer | Spread | Use |
|---|---|---|---|
| `duo` | distilled | Headline and definition top-left (display sans, 6 columns wide); diagram 1 on the left sheet, diagram 2 on the right sheet and across the spine, pull quote bottom-right on a tinted field, a caption under each diagram | default; two-diagram arguments (ifd) |
| `solo` | distilled | One full-bleed diagram over both sheets and the spine, headline overprinted top-left on the field, quote and up to 3 captions in a bottom strip | one big diagram carries it (hyperion, optimal-parkour) |
| `compare` | distilled | Left and right sheets are two versions of one diagram or listing, headline as a strip across the top, quote in the spine gutter strip | A versus B pieces (mcp-not-enough) |
| `numerals` | distilled | 3 to 5 giant numerals in the display sans with labels, one small diagram, headline and quote | benchmark and numbers pieces (snuon) |
| `text` | full | 3 columns per sheet (2 on the narrow class), figures inline across 3 to 6 columns with a caption, running head and folio | the whole post, default |
| `text-code` | full | 8-column measure for code on a `panel` field with the prose in a narrow column beside it | code-heavy sections |

Gone from v1: `opener`, `essay`, `feature`, `lead-figure`, `wide-figure`, `pullquote-break`, `sidebar`, `gallery`, `closer` (their jobs are done by `duo` and `solo` for the front and by `text` for the rest). Narrow class: one 28x56 em sheet; each template has an `-n` variant (same slot names).

### 1.4 Fitting text into frames (the engine)

For each spread the engine runs:
1. **Track solve**: resolve rows and columns (fixed first, `fr` shares the rest, `fit` takes content height) into rectangles per area.
2. **Exclusions**: drop caps, pull quotes with `wrap`, figures with `wrap` contours, and marginalia produce per-line intervals `(x0, x1)` removed from a frame, sampled at each baseline. A frame is therefore a function `lineIndex -> [x0, x1]`.
3. **Knuth-Plass** (own implementation, Knuth and Plass 1981, "Breaking Paragraphs into Lines"): boxes = shaped words, glue (space = 0.25 em, stretch 0.12 em, shrink 0.08 em for justified; ragged uses zero stretch plus a finishing glue of infinite stretch), penalties (discretionary hyphen 50, forced breaks at `---`), flagged penalties (two hyphens in a row 3000 demerits), fitness classes (very loose, loose, normal, tight; a 3000-demerit jump between incompatible classes), `tolerance = 2` first pass, `3` second pass, `looseness` available per paragraph. The line width is supplied per line by the frame function, so a drop cap or a wrapped quote needs no special case. Active nodes are pruned per the paper (adjustment ratio below -1 or demerit > best + threshold), so a 300-line article section is milliseconds.
4. **Microtypography** (full text layer): optical margin alignment (hang quotes and hyphens up to 70% of their width, period and comma 40%), `liga`, `kern` always, tabular figures (`tnum`, check the feature exists in the stored Inter and Instrument Sans instances; unverified) for numerals, fixed non-breaking glue before units. No small caps.
5. **Copyfit**: if the threaded frames overflow or underflow, within the template's `fit` ranges try, in order: tighter or looser tracking (+/- 0.5%), leading (+/- 2% in half-baseline steps only when the template says `leading` is free, never for body, so the baseline grid survives), `looseness` -1 or +1 on the last paragraph, then a pull quote or numeral insertion for underflow (`fill:` candidates declared by the author). If still wrong, the planner (1.5) picks another template or moves the break to the next spread.
6. **Marginalia** (deferred, not in v1): the spring relaxation (about 40 lines) is kept as a design note; `Cite` references stay an end list in the full text layer, as in the post today.
7. **Drop caps** (deferred, not in v1): Inter body text starts flush; the display sans headline carries the opening.

### 1.5 Choosing templates: the distilled spread is declared, the full text is planned

The distilled spread is always declared (one `distill` block, section 1.7). Only the full text layer is planned.

In the .svx (remark-directive, fail closed on unknown names, file:line in the error), only what the full text layer needs:
```
::fig{id="eval-timeline" place="inline"}      // places figures.ts entry "eval-timeline" in the full text
:::code-wide
...
:::
```
Plain .svx with no directives still lays out (all auto), so no article breaks. `::spread`, `::pullquote`, `::numeral` and `:::aside` directives of the first draft are removed: the distilled block is the one place that picks quote, numerals and templates.

Sidecar `spread.json` (optional, next to the .svx): `{ "accentHue": 265, "display": { "wdth": 80, "wght": 600 }, "hyphenExceptions": [] }`.

Full-text planner: a greedy fill of `text` and `text-code` spreads in reading order with the K-P and copyfit costs of 1.4, widow, orphan and heading-at-bottom penalties, and the figure distance penalty (a figure within 1 spread of its first reference). No beam search, rhythm presets or seed: with two full-text templates the search space is trivial (est. under 30 ms per article). The rhythm presets (`andante`, `staccato`, `crescendo`) of the first draft are deleted.

### 1.6 Binary `RDR2` (delta against `RDR1`)

Little endian, u32 aligned, one storage buffer, as before. Kept: header, fonts table (shared `fonts.bin`), glyph instances, rect, image, line, link, anchor, text tables. Changed or added:
```
Spreads[]    {layer (0 distilled, 1 full text), x_em (spread origin on the table), w_em, h_em, template id, firstItem, itemCount,
              gridCols, gridRows, firstCell, tone RGB565, materialMask, accentIdx}
Grid         cell 6 x 1.6 em over 80 x 56 em: 13 x 35 cells per spread; cell lists dilated by 0.25 em,
             and for animated items by the swept bound over the whole timeline
Items[]      u32: [type:4 | index:28]  types: glyph, rect, image, shape, path, stroke, group, numeral
Shapes[]     analytic primitives: rrect, circle, line, arrow-head, hatch; no curves, cheapest path
Paths[]      filled contours: quadratic curve texels + bands, same layout as glyph entries
              (a path is a glyph with a colour, a transform and an optional group)
Strokes[]    {firstSeg, segCount, width_em, cap/join flags, dash {on, off, phase_chan}, trim {t0_chan, t1_chan},
              colourIdx, group}; segments are quadratics with cumulative arc length (f32) per segment
Groups[]     {parent, chan tx, ty, rot, scale, opacity}   // channel index or -1 for constant
Chans[]      per figure: keyframe tables {t, v, ease} compiled from tracks; evaluated on the CPU per frame
Figures[]    {id, firstChan, chanCount, duration_s, mode (loop|once|scrub|static), poster_t, alt text offset,
              bounds, spread}
Palette[]    32 entries x (light, dark) = 8 reserved ink/rule/etc. as before, then accent, accent-2, accent-tint,
             accent-ink, 3 diagram neutrals, panel, field, ... per article (section 3.2)
```
Channel values are uploaded each frame as one `array<f32, 256>` in a small uniform (1 KB) only while a spread with figures is visible. Estimated article size: text as before (about 150 KB brotli for a 1400-word post) plus 10 to 40 KB per figure; fonts budget in 3.1.

### 1.7 The distilled layer: what it is and how it is authored

**Principle.** The post is the source of truth and is never edited by this system. The distilled spread is a view: headline, one or two figures, one quote, at most 3 captions, plus a one-sentence definition when the topic needs it. Everything in it is either a verbatim substring of the post or flagged as synthesised and reviewed. The full post is the second layer (4.5); the hidden DOM carries the whole post exactly as today, so SEO, find-in-page and a11y are unchanged. Distilled strings add no text that is not in the post (figure `alt` and `describe` already live in the hidden DOM per 2.3).

**The `distill` block** lives in the post's .svx frontmatter (the copy sits next to the text it quotes and is reviewed in the same diff; figures stay in `figures.ts`):
```yaml
distill:
  template: duo                       # duo | solo | compare | numerals
  headline: "IFD is fine"
  definition: "Import From Derivation: during evaluation, ..."   # optional, one sentence
  deck: "The case against import-from-derivation is a case against CppNix's evaluator, not against the idea."
  figures: [eval-timeline, eval-graph]            # 1 or 2 ids from figures.ts, in slot order
  quote: { text: "The IFD ban was a polite way ...", from: "The frame is the evaluator" }   # from = section heading
  captions: [ { fig: eval-timeline, text: "..." }, { fig: eval-graph, text: "..." }, { fig: eval-graph, text: "..." } ]   # at most 3
  synth: []                           # paths of strings that are NOT verbatim from the post, e.g. ["headline"]
  review: { by: andrewgazelka, at: 2026-10-07, post_sha: "<sha256 of the post body>" }
```

**Authoring flow.**
1. A Sonnet agent reads the post and the figure list and writes the block (`pnpm distill <slug>`, a script that calls the agent and prints a diff, never writes `review`). Brief: pick the thesis from the post's own words, choose the 1 or 2 figures that carry the argument (writing a new figure into `figures.ts` is a separate task), pick the one quote (an author sentence or an attributed source quote from the post), write captions from post sentences, reuse sentences verbatim, no new claims, no numbers that are not in the post.
2. Andrew reviews the diff; approval is writing `review: { by, at, post_sha }`. The build refuses a distilled spread whose `review.post_sha` does not match the current post body (a post edit forces a re-review; the stale spread is not shipped), and an unreviewed block renders only on the preview page, never in the production build.
3. Build-time lint (fail closed): every string not listed in `synth` must occur in the post body after Markdown stripping and whitespace normalisation (this is the "exact copy drawn only from the post" check); word count of headline, definition, deck, quote, captions and figure labels: error below 100 or above 250, warning below 150; at most 3 captions and 2 figures; every figure passes the 2.3 lints at its `poster` frame; `figure` ids exist.
4. Controls (verification law): a planted caption that is not in the post must fail the substring check; a block with a wrong `post_sha` must fail; a 4th caption must fail.

**What the distilled layer is not.** It is not a summary generated at read time and it is not a replacement for the post: no LLM runs in the browser, the strings are static, in git, and reviewed. A piece without a `distill` block opens straight on its full text layer (first `text` spread) so nothing is blocked on distillation.

## 2. Diagram system

### 2.1 Principle

A figure is a small scene of shapes, paths, strokes, text and groups with keyframe tracks. It is authored per article as `figures.ts` next to the `.svx` (type-checked data, comments allowed, loops allowed for repeated elements; the module is evaluated by the build in a sandboxed pure context: no I/O, no `Date`, no `Math.random`, a seeded `rng(seed)` is provided). It is compiled at build time to the item kinds in 1.6 and drawn in the tracer's primary hit like glyphs, with time as a uniform. No SVG, no DOM, no per-frame JS geometry.

### 2.2 Drawing model (how the shader draws it)

- **Fills**: contours of quadratic Beziers with the same band acceleration and winding-number coverage as glyphs (the existing Slug evaluator, parameterised by a path index). Even-odd and non-zero both supported (flag).
- **Strokes**: analytic distance to a quadratic Bezier (closed-form cubic root solve, per segment; coverage = `clamp(0.5 - (d - w/2) / pxWidth, 0, 1)` with the same plane-differential `pxWidth` as text). Round caps and joins come free from distance; butt caps and square caps from the arc-length parameter at the endpoints; miter is not offered (authors use round or bevel). Per-segment cumulative arc length gives, from the closest-point parameter, an arc-length coordinate `s`; **trim** (draw-on) is `s in [t0*L, t1*L]`, **dash** is `fract((s + phase)/period) < on`, so a "flowing" dashed line is one phase channel.
- **Arrows**: an arrowhead is a shape item placed at the path end with the tangent from the last segment; it follows the trim end (position = point at `s = t1*L`), so draw-on carries the head.
- **Moving dots (packets, tokens, a search frontier)**: a `dot` item with `along: pathId` and a channel `u in [0,1]`; the shader walks the segment prefix table (binary search over at most 16 segments) to the point. Up to 32 dots per figure share one path through a `stagger` field, so a dataflow with 40 packets is one item.
- **Text**: shaped at build (labels are glyph instances with a group); live numbers use the `numeral` odometer (a digit strip clipped to its cell, driven by a channel).
- **Groups** carry translate, rotate, scale and opacity from channels; a child's cell-grid entry uses the swept bound over the timeline, so animation never leaves its cell (compile fails if the swept bound exceeds 24 items per cell; split or reduce).
- **Colour**: palette indices only (so light and dark flip with a uniform), plus `mix(a, b, chan)` for state changes (an edge turning from muted to accent).
- **Cost control**: figure items are evaluated only in the primary-hit albedo, only when the pixel falls inside the figure's bounds rect (one rect test per figure first), and only on visible spreads; LOD below 3 px/em draws the figure's compiled tone. Target: p95 frame unchanged within 1.25x of the text-only baseline (acceptance A4).

### 2.3 Time, loops and reduced motion

- `time: { duration: 12, mode: 'loop' | 'once' | 'scrub' | 'static', poster: 7.5 }`. `once` starts when more than 60% of the figure's bounds is on a settled spread; `scrub` ties time to the spread-turn progress or to a hover-drag on the figure; `loop` pauses when its spread is not current (Flecs `FigureClock` system gates on `Spread.f`).
- Every figure declares `poster`: the time at which the still frame is complete and readable. Used for `prefers-reduced-motion`, for the print/overview contact sheet, for the prerendered static poster and for screenshots in acceptance. A figure that is unreadable at `poster` fails the build lint.
- `describe`: a required text of at least 40 characters (what the figure shows and concludes) plus `alt` for the hidden DOM; build fails without both.
- Focus: double-click or `F` on a figure frames it to fit (camera tween, 4.4) and shows a play/pause/scrub control drawn as shapes in the figure's bottom strip; arrow keys step 0.25 s.

### 2.4 The format

```ts
// src/routes/(site)/thoughts/ifd/figures.ts
import { figure, rrect, text, path, arrow, dots, track } from '$lib/magazine/dsl'

export default {
  'eval-timeline': figure({
    size: [72, 26],                                    // em; the placement template scales to its frame
    time: { duration: 14, mode: 'loop', poster: 11 },
    describe: 'Two timelines of one build. CppNix stops evaluating while a derivation builds; Snix keeps evaluating other work and finishes first.',
    alt: 'Gantt chart comparing CppNix and Snix evaluation of the same build.',
    palette: { cpp: 'muted', snix: 'accent', build: 'neutral2' },
    nodes: [
      text('CppNix', { at: [0, 5], font: 'label' }),
      rrect('e1', { at: [8, 3], size: [10, 4], fill: 'ink' , label: 'eval' }),
      rrect('b1', { at: [18, 3], size: [18, 4], fill: 'neutral2', label: 'build (evaluator waits)', hatch: true }),
      // ...
    ],
    paths: [ path('wall', 'M 18 1 L 18 12', { stroke: { w: 0.18, color: 'accent', dash: [0.6, 0.4] } }) ],
    tracks: [
      track('e1.size.x', [[0, 0], [1.2, 10]], 'outCubic'),
      track('wall.trim.t1', [[7, 0], [8, 1]], 'inOutSine'),
      track('playhead.x', [[0, 0], [14, 72]], 'linear')
    ]
  })
}
```
Compilation steps (in `scripts/magazine/fig/`): validate against the schema (unknown keys fail), run `dagre` when `layout: { engine: 'dagre', rankdir, ranksep, nodesep }` is present (edges become cubic splines, converted to quadratics at 1/4096 em like glyphs), convert shapes and paths to the item kinds, shape text with harfbuzz into glyph instances, sample tracks into keyframe tables, compute swept bounds and cell lists, run the lint (all text inside its figure, no label-over-label overlap at `poster`, contrast: graphics 3:1, text 4.5:1 against the panel in light and dark, at most 24 items per cell).

### 2.5 Concrete diagram specs (existing articles; ifd first, the others queue behind it)

Colour names are palette slots (section 3.2). All sizes in em of the figure's own box; each figure ships with a `describe` string.

1. **`ifd/eval-timeline` and `ifd/eval-graph`: the two distilled diagrams of the first article.** Full specs in 2.6 (they replace the single timeline of the first draft; the invented "45% earlier" numeral is removed because the post states no such number).
2. **`hyperion/server-dataflow`: "one world, 100,000 players" (lead-figure, loop 10 s, poster 6 s).** Left: a dense field of 300 tiny player dots (a seeded scatter, one `dots` item) on the sheet. Middle: 8 proxy boxes (fan-in); right: one `Game server (Flecs ECS)` block with 4 worker lanes inside it. Edges: dashed arrows from dot clusters to the proxies (phase channel = flow), thick arrows proxy to server. Packets: 40 dots moving along those paths, staggered, colour-coded by direction (inbound accent, outbound ink). A pulse ring expands from the server each tick (50 ms scaled to 1 s so it is visible), with the label `tick`. The big numeral `100,000` sits as an outline numeral behind the figure at 14 em in neutral. Components: 1 dots scatter, 8+1 rrects, 16 arrows, 2 dot-flows, 1 ring, 1 numeral.
3. **`notes-on-errors/context-onion`: "what a signature promises" (feature, once, poster 8 s).** Left: a call stack of 4 frames (`main`, `run`, `load_config`, `read_file`) as stacked rrects. An error value starts at `read_file` as a small shape (`io::Error`) and travels up: at each frame boundary a ring (a stroked circle, radius grows) is added around it with text `.context("...")`, producing nested rings (the onion) that stay; at `main` the full onion unfolds to the right into a labelled list (a stroke-connected callout column: "failed to parse config, at config.toml, caused by: No such file"). Right: a small DAG (dagre, rankdir LR) of conversions `io::Error -> AppError -> Box<dyn Error> -> anyhow::Error` whose edges light up (colour mix channel) in step with the frames. Components: 4 rrects, 5 rings, 4 text callouts, 4 dagre nodes and 3 edges.
4. **`mcp-not-enough/typed-pipe`: "output schema versus no output schema" (split-compare, loop 12 s, poster 9 s).** Left sheet: MCP: `agent -> tool call -> opaque text blob -> agent parses it again`. The blob is drawn as a grey noisy block (hatch shape); a "token meter" bar under it grows with each hop. Right sheet: shell: `gh api | from json | where state == open | select number title | to nuon`; the data is drawn as a small table (4 rows x 3 columns of rects) flowing along the pipe; at `where` rows fade out (opacity channel) and at `select` a column slides off; the right meter ends at one third of the left. Both sides share one axis for the meter so the comparison is literal. Components: 2 pipelines of 4 boxes, 2 tables (24 rects each), 2 meters, 20 arrows.
5. **`optimal-parkour/hybrid-astar`: "search with a Dijkstra heuristic" (wide-figure, loop 16 s, poster 14 s).** A top-down 18 x 9 grid of blocks (rects with a height shading), start and goal markers, gaps and walls. Phase 1 (0-6 s): a Dijkstra distance field floods from the goal, drawn as a heatmap whose cells appear in distance order (opacity track per cell by compile-time loop, 162 cells). Phase 2 (6-14 s): Hybrid A* expands from the start: each expanded state is a short arc (a stroked quadratic, the real "jump" primitive, 3 jump lengths) drawn on in expansion order (trim channels staggered), the frontier highlighted in accent; the final path thickens (stroke width channel) and a player dot runs it. A small legend and a numeral counter `nodes expanded: 61 versus 4,318` (odometer). Components: 162 rrects, up to 90 arcs (compiled from a seeded search run in `figures.ts`: the search is simulated at build, authored data not a hand drawing), 1 dot, 2 numerals.
6. **`nushell-tui/agent-loop`: "a cycle an agent can drive" (feature, loop 8 s, poster 6 s).** A closed cycle of four nodes on a circle: `agent`, `typed command (nu)`, `terminal app (gdb)`, `screen snapshot`. Cycle edges are stroked quadratic arcs with a continuously flowing dash (phase channel, 1 revolution per 8 s) and one accent dot circulating; at `terminal app` the node shows a tiny terminal glyph grid (a 20 x 6 cell mono text, with the cursor blinking on a 0.5 s square channel) and at `screen snapshot` a typed table collapses from the same text (rows fly in). Centre: a numeral odometer `step` counting 1..4 per loop with the current node highlighted (colour-mix channel). Components: 4 rrects, 4 arcs, 1 dot, 1 text grid (120 glyphs, labels), 1 numeral.

Spare candidates (add when the article gets a spread): `gpt4-hals-and-rest-libs/layer-stack` (thick HAL stack versus thin 1:1 wrapper, layers collapse), `rust-named-parameters/builder-states` (typestate DAG with required fields turning on), `snuon/token-bars` (token count bars for JSON, NUON, SNUON with an odometer).

Mapping for items 2 to 6 under the new template set: `lead-figure` and `wide-figure` become `solo`, `split-compare` becomes `compare`, `feature` becomes `duo` (second diagram optional), and big numerals are set in Instrument Sans. Each of those articles also needs its own `distill` block (1.7) before it ships; they do not block ifd.

### 2.6 The first article: "IFD is fine", distilled spread (end to end)

Source: `src/routes/(site)/thoughts/ifd/+page.svx` as of 2026-10-06 (title "IFD is fine", dated 2026-05-13). Template `duo`, accent hue 265, display `wdth 80 wght 600`. Every string below is a verbatim substring of the post (the lint in 1.7 checks it, after Markdown and `<Cite>` stripping); `synth` is empty. The diagram label words are all post words (`eval`, `build`, `CppNix`, `Snix`, `thunk`, `request`, `yields`, `resumes`, `stops`, `waits`).

```
 ┌───────────────────────────── left sheet ─────────────────────────────┬──────────────────────────── right sheet ────────────────────────────┐
 │                                                                        │ Import From Derivation: during evaluation, the Nix language asks for │
 │ IFD is fine            (display sans, 7.5 em, 1 line)                  │ a path whose bytes depend on a derivation's output.                  │
 │                                                                        │ The case against import-from-derivation is a case against CppNix's   │
 │                                                                        │ evaluator, not against the idea.                                     │
 │ [ A: eval-timeline ]                                                   │ [ B: eval-graph ]                                                    │
 │ CppNix  ▮eval▮░build░▮eval▮░build░▮eval▮                               │      (eval)──(eval)──(eval)                                          │
 │ Snix    ▮eval▮▮eval▮▮eval▮▮eval▮▮eval▮▮eval▮                           │        │       │ ╲                                                   │
 │         ░build░  ░build░ (concurrent bars)                             │      [build] [build] (eval)  (nodes appear as eval finds them)       │
 │ cap A: When a thunk demands ... resumes.                               │ cap B1: Eval and build are nodes ... yields.   cap B2: ... returns.  │
 │                                                                        │ ┌ quote field ──────────────────────────────────────────────────────┐ │
 │                                                                        │ └ "The IFD ban was a polite way ..." ────────────────────────────────┘ │
 └────────────────────────────────────────────────────────────────────────┴──────────────────────────────────────────────────────────────────────┘
```

**Exact copy (the whole distilled text layer).**

| Slot | Text (verbatim from the post) | Words |
|---|---|---|
| headline | `IFD is fine` (the post title) | 3 |
| definition | `Import From Derivation: during evaluation, the Nix language asks for a path whose bytes depend on a derivation's output.` (first sentence of the post, citation mark dropped) | 19 |
| deck | `The case against import-from-derivation is a case against CppNix's evaluator, not against the idea.` (the post `dek` frontmatter) | 14 |
| caption A | `When a thunk demands the contents of ${drv}/foo, the evaluator stops, calls out to the daemon, waits for the build, resumes.` ("What blocking actually means in CppNix"; the code span is shown in the mono face) | 21 |
| caption B1 | `Eval and build are nodes in one graph. The graph grows as eval discovers more of it. A thunk that needs a build emits a request and yields.` ("Snix moves the wall") | 28 |
| caption B2 | `A thunk nobody forces is a derivation nobody builds.` ("Edge cases"; reads as the payoff of the growing graph: only what is demanded is built) | 10 |
| quote | `The IFD ban was a polite way to say "the reference evaluator cannot handle this yet." The phrasing outlived the constraint.` attribution label `IFD is fine` (last section, "The frame is the evaluator") | 21 |
| diagram labels | `CppNix`, `Snix`, `eval` (x2 kinds shown once each in the legend), `build`, `stops`, `waits`, `resumes`, `thunk`, `request`, `yields` (legend and node labels counted once each) | about 18 |

Total about 134 words counting labels (hand count: 3 + 19 + 14 + 21 + 28 + 10 + 21 + about 18; the lint in 1.7 recounts). That sits under the 150 target on purpose rather than padding with a longer caption: the lint treats 100 to 250 as pass, warns below 150, and Andrew decides at review whether to swap caption B2 for the 34-word sentence it came from ("A flake that produces a hundred derivations ... continues as each one returns.", also verbatim) to land near 160. Update 1.7 step 3 accordingly.

**Diagram A, `eval-timeline` ("the evaluator waits", on the left sheet, `loop` 12 s, `poster` 9 s, size 36 x 20 em).**
- Two lanes. Lane `CppNix`: `eval`, a hatched `build` block where the evaluator is idle (hatched = nothing evaluates), `eval`, hatched `build`, `eval`. Lane `Snix`: `eval` blocks run back to back with no gap; each build the evaluator asked for is a thin bar on a third strip below the lane, running concurrently, tied to the `eval` block that requested it by a draw-on arrow (stroke trim).
- Playhead sweeps left to right (linear 12 s); blocks fill as it passes (width tracks). On lane `CppNix` the playhead pauses visibly at each hatched block (the track holds, the hatch crawls via dash phase) and the labels `stops`, `waits`, `resumes` appear at the start, middle and end of the first hatched block (opacity tracks). Lane `Snix` finishes before lane `CppNix` ends because it never stops: the figure shows this as geometry only (the Snix lane ends earlier on the shared axis); no percentage and no "done X% earlier" text, since the post gives no number.
- Components: 8 rrects on lane CppNix (with hatch), 7 on lane Snix, 4 build bars, 4 arrows, 1 playhead, 5 labels. Palette: `cpp` muted ink, `snix` accent, `build` neutral2. `poster`: playhead at the end, all blocks filled, labels shown.
- Reading it with no motion (reduced motion, poster): hatched gaps on one lane and none on the other say the thesis.

**Diagram B, `eval-graph` ("one graph that grows", on the right sheet, `loop` 14 s, `poster` 11 s, size 36 x 20 em).**
- Nodes: `eval` thunks as circles, `build` nodes as squares, edges as quadratic strokes. dagre (`rankdir` LR) lays out the final graph (about 9 eval nodes and 6 build nodes); the first frame shows 2 nodes, and the rest appear in discovery order (opacity and trim tracks), so the graph visibly grows.
- At t = 3 s one `thunk` node dims and a dot travels along its edge to a `build` node (label `request`, then `yields` while it is dimmed); the other eval nodes keep appearing while the `build` square fills (progress track). At t = 8 s the square completes, a dot travels back and the thunk lights up in accent (colour-mix track, label `resumes`). Several build squares run at once from t = 9 s (the "fires every build it discovered in parallel" beat), each returning and resuming its thunk.
- Components: 9 circles, 6 squares, 15 edges (dagre, converted to quadratics), 12 travelling dots (2 `dots` items), 4 labels. `poster`: full graph, all nodes lit.

**Pull quote**: the `Q` field is a tinted `field` colour block (3.2) with the quote in the display sans at 2.4 em and the attribution `IFD is fine` as a caption-size label.

**Acceptance for this article** (all in section 6, then run once at the Wave 2 merge): distilled lint passes with controls; both figures pass A3 at 3 times; screenshot of the spread in light and dark at 1440x900 and 390x844 to `docs/upstream/magazine/shots/`; A4 gesture test reaches the full text layer and comes back; hidden DOM text equals the post (A6).

## 3. Typography and art direction

### 3.1 Type system and licences (rewritten 2026-10-06: one sans family, no serif)

All faces are SIL OFL 1.1; the full licence text of each was read (Inter, Fira Code and Noto Emoji already sit in `docs/upstream/reader/fonts/`; Instrument Sans and Geist read from `google/fonts` rev `7085eb89a950e85db5b166b7a58d414544b4140c` on 2026-10-06). We ship outlines compiled into curve data inside binaries, not font files; OFL text and copyright lines go into the colophon and `docs/upstream/magazine/fonts/`. None of the copyright lines below declares a Reserved Font Name (read: the Inter and Instrument Sans files define the term in the preamble only), so subsetting and converting to outline tables is permitted; the Font Software is not sold by itself (not a legal opinion; low risk).

| Role | Face (variable axes used) | Licence read | Notes |
|---|---|---|---|
| Body and UI (text, labels, folios, captions, diagram text) | **Inter** variable, axes `opsz` 14 to 32 and `wght` 100 to 900 (METADATA.pb read). Body: opsz 14, wght 400; labels: opsz 14, wght 500, caps at +0.06 em; italic from the italic file if the full layer needs it | OFL 1.1, "Copyright 2020 The Inter Project Authors (https://github.com/rsms/inter)", no RFN | Already in the pipeline (`Inter.ttf`, sha256 29160a80...). |
| Display (headlines, big numerals, quote text) | **Instrument Sans** variable, axes `wdth` 75 to 100 and `wght` 400 to 700 (METADATA.pb read) | OFL 1.1, "Copyright 2022 The Instrument Sans Project Authors (https://github.com/Instrument/instrument-sans)", no RFN | The one tight display sans: `wdth` 75 to 85 gives a condensed, tight headline from the same file, the per-article voice knob is `wdth` and `wght` (3.2). |
| Code | Fira Code (400, 500) | OFL 1.1 (in tree) | Unchanged. |
| Fallback glyphs | Noto Emoji | OFL 1.1 (in tree) | Unchanged. |

Candidates considered for the display slot (licence read for each): **Inter Display** (the `opsz` 32 end of the same Inter variable file, so zero extra bytes and perfect harmony with the body; the fallback if Instrument Sans looks wrong next to Inter, a one-line change since it is only an instance setting); **Geist** (OFL 1.1, "Copyright 2024 The Geist Project Authors (https://github.com/vercel/geist-font.git)"; wght 100 to 900 only, no width axis; spare). Pick: Instrument Sans, because the width axis gives the tight headline the brief asks for without a second serif or a heavy weight. Axis ranges of Geist were not read (unverified beyond the licence header).

Removed from the earlier draft: Newsreader, Fraunces, Instrument Serif, Big Shoulders Display, Caveat, Space Grotesk, Bricolage Grotesque and DM Serif Display (not used).

**SF Pro cannot be embedded.** Apple's font licence allows the Apple Font "solely for creating mock-ups of user interfaces to be used in software products running on Apple's iOS, OS X or tvOS", and states "You may not embed the Apple Font in any software programs or other products" (Sections 2A and 2B, as quoted from https://developer.apple.com/fonts/ on 2026-10-06; reported through a page summariser, so the exact licence PDF text must be read and stored in `docs/upstream/magazine/fonts/SF-NOT-USED.md` by the `type` lane before this is repeated elsewhere). The site is a WebGPU canvas drawing outline tables, so a system font stack (`-apple-system`) is also not possible: the shader needs outline curves, which the browser does not expose for system fonts. Inter is the legal substitute (a neutral UI sans under OFL).

Budget: only used glyph ids are emitted, per instance. Inter 2 instances (body 400, label 500; about 250 glyphs each), Instrument Sans 1 to 2 instances (about 120 glyphs), Fira Code 1: est. at or below the current `fonts.bin`, and the four removed serif and display families shrink it (est. -150 to -300 KB brotli; limit 900 KB, acceptance A7; to be measured). Variable instancing uses `hb.Variation` at build exactly as READER.md stage 1 does. Check at the `type` lane: `tnum`, `liga`, `kern` exist in the stored files (unverified).

Scale: one ratio, 1.333 (the pieces are punchy), from 1 em body: caption 0.78, body 1, deck 1.4, quote 2.4, headline 5 to 9 (display), numeral 12 to 20. Leading 1.6 body; display leading 0.92 to 1.05 in half-baseline steps.

### 3.2 Colour, accent per article, light and dark

Every article defines one hue; the palette is generated in OKLCH at build, light and dark columns, so the shader only flips a uniform:
- Paper: light `oklch(0.965 0.012 h)` (warm, tinted 1 to 2% by the article hue), dark `oklch(0.20 0.012 h)`. Ink: light `oklch(0.20 0.01 h)`, dark `oklch(0.93 0.008 h)`. Contrast floors from READER.md stay (12:1 light, 9:1 dark for body).
- Accent: light `oklch(0.52 0.19 h)`, dark `oklch(0.76 0.15 h)`; accent-2 = hue + 40 degrees at C 0.12; accent-tint = accent at 12% over paper; accent-ink = text on an accent field (paper in light, deep ink in dark). Diagram neutrals: three greys at L 0.55/0.70/0.85 (light) and mirrored (dark). `field` = the full-bleed colour block: light accent at L 0.52, dark accent at L 0.30 (so a dark-mode opener is a deep tinted slab, not an inverted photo).
- Gamut: C is capped per hue to stay inside sRGB; a build check converts every palette entry and fails on clipping.

| Article | Hue h | Display voice (Instrument Sans) and mood |
|---|---|---|
| ifd (first) | 265 | `wdth 80 wght 600`; cool, precise; template `duo` |
| hyperion | 148 | `wdth 75 wght 700`; loud; `solo`, big numerals |
| notes-on-errors | 28 | `wdth 90 wght 600`; `duo` |
| mcp-not-enough | 78 | `wdth 85 wght 700`; `compare` |
| nushell-tui | 195 | `wdth 85 wght 500`; `duo` |
| optimal-parkour | 330 | `wdth 80 wght 500`; `solo` |
| snuon | 350 | `wdth 75 wght 700`; `numerals` |
| rust-named-parameters | 55 | `wdth 90 wght 600`; `duo` |
| gpt4-hals-and-rest-libs | 295 | `wdth 85 wght 600`; `compare` |
| commit, initial-thought (hidden) | 205, 120 | no distilled block: open on the full text layer |

Rhythm now comes from accent hue, `wdth`/`wght` and template choice; two articles never share hue and template and voice together. Only ifd is specified end to end here; the other rows are placeholders until each gets a `distill` block.

### 3.3 Details that make it a magazine

Few and bold: a giant tight headline, a tinted quote field, hairline rules at 0.5 px, folios and running heads in Inter caps at 0.72 em, captions as labels tied to their diagram, code blocks on a `panel` field with a left accent bar. The distilled spread is poster-like, the full text layer is plain and quiet (no drop caps, small caps, marginalia or section numerals in v1).

## 4. Reading interaction in 3D

### 4.1 Turn versus scroll: decision

The article is a **book of spreads** with two layers (4.5): spread 0 is the distilled spread, spreads 1 to N are the full text. The page-turn is the unit inside the full layer, and wheel and swipe scrub it. Not a scrolled stack. On the distilled spread wheel and swipe do not turn to the full text (4.5).
- State: `Spread.f` (float, 0 = first spread). Releasing snaps to the nearest integer with a critically damped spring (omega 11 rad/s). The hit rule: a flick (velocity above 1.2 spreads/s) goes one spread in the flick direction; otherwise nearest wins.
- Input mapping: horizontal trackpad swipe or drag from the outer margin scrubs `f` directly (page curls with the pointer); vertical wheel accumulates `f += deltaY / 900 px` with the same magnet and the same flick rule, so a mouse wheel notch ticks one spread per 3 notches; arrows, space, shift-space, PgUp/PgDn, Home/End; click on the outer 12% of a sheet turns; `O` or clicking the folio opens the **overview** (lay-flat: all spreads of the article in a contact grid with posters of figures and the planner's template names, hover enlarges, click flies to it).
- No inner scroll within a spread: the planner guarantees fit. This is the cost of the format and the reason overflow is a build error.
- Narrow class (portrait): one sheet per spread, same input, vertical swipe turns; templates have `narrow` variants (same slot names, different areas).
- URL: `/thoughts/<slug>#s3` for spread 3; `?p=N` maps to the spread containing old page N; heading anchors map to the spread that contains them (`Anchors[]` gets a spread index).

### 4.2 Zoom and figure focus

Zoom stays what READER.md describes (a real re-trace window, 1x to 6x, `sc.view`). When zoom is above 1.15 the wheel pans and turning is by key or edge click only; a visible chip (shape item) in the folio shows `zoom 3.2x`, reset on `0`. `F` or double-click on a figure animates the camera to frame the figure bounds at fit (the figure is drawn at 1x in its own box; the spread stays lit around it), pauses nothing, and reveals the scrub strip; Escape or double-click returns. Double-click elsewhere resets zoom.

### 4.3 Links, hover, selection

Link hit-testing is as READER.md 3.6 with spread coordinates. Hover: a 2 px underline draws on over 120 ms (a stroke with a trim channel), the glyphs tint to accent; internal links (to another article) also raise a marginal card (shape + label) with the title and date of the target; external links show the host in the folio line. Selection (drag, long press, copy, find) is unchanged except frames define reading order: threads read in frame order, asides after their anchor paragraph, captions after their figure; `Lines[]` carry a frame id. Marginalia and figure labels are selectable and copy as text.

### 4.4 How a spread is lit

The sheets are real geometry in the tracer, lit by the analytic reading light of READER.md 3.1 plus physical cues that make it an object:
- Open book: the two sheets are not coplanar; each is rotated about the spine by `bow = 2.5 degrees` toward the viewer so the spine sits lowest and the lamp's gradient differs per sheet; plus an analytic gutter shadow (ambient occlusion `1 - 0.18 * exp(-d / 1.6 em)` within the sheet, `d` the distance from the spine) multiplied into the illumination term, not the albedo.
- Page turn: the turning leaf is 8 planar strips hinged along the spine, each rotated cumulatively to approximate a cylinder bend (radius shrinks as the corner lifts); strips are registered in `objs` as kind-10 boxes while turning so `cs` casts their soft shadow onto the page below; the back face shows the next spread's left sheet through the same evaluator (`page_trace` returns the face and sheet). At rest, 2 sheets are traced (broadphase: spread index), during a turn 3 sheets plus 8 strips.
- Materials per region (`materialMask` in `Spreads[]`): `matte` (text pages, paper grain), `coated` (figure pages: a faint clearcoat lobe, specular 0.04, so the lamp leaves a soft sheen over full-bleed figures), `field` (flat colour with very low grain). Optional `foil` for big numerals (v2, one extra environment fetch; not in the first wave).
- Light and dark follow the OS colour scheme via the existing uniform; dark mode lowers the lamp to 0.6 and keeps paper luminance in the same 0.07 to 0.12 display-linear range for dark paper, ink 0.82 to 0.9; images get the 0.9 multiply from READER.md; accent fields are the `field` colour of 3.2.
- Backdrop dims and the room darkens as in READER.md (`readingBlend`).

### 4.5 The full text layer: collapsed, still GPU-drawn, deliberate gesture

- Default state on opening `/thoughts/<slug>`: the distilled spread alone, `layer = 0`. Under it, at the outer bottom corner of the right sheet, a **Full text tab** is drawn as shapes: a curled page corner with the label `Full text` and the word count (computed at build, not typed). Nothing of the full text is visible or laid out on screen.
- Opening gestures (any one, all deliberate): drag the corner past 25% of the sheet width (the page peels, release below the threshold snaps shut); click or tap the tab; press `T` or Enter; a deep link `#full` or `#full/s3`. Wheel, trackpad scroll and swipe on the distilled spread never open it: they give a short rubber-band bounce and pulse the tab once, so a stray scroll cannot bury the distilled view.
- Inside the full layer: the usual turning (4.1), `text` and `text-code` spreads, figures inline. Closing: `T`, Escape, Home, or the tab on spread 1; all return to spread 0 with the same page-turn animation reversed. `Spread.f` addresses both layers (0 is distilled, 1 is the first full text spread).
- Data: one `RDR2` binary per article and width class with `layer` on each `Spreads[]` entry; layer-1 items are uploaded to the GPU buffer on first open (est.: no cost to the distilled first paint; measure in A4, keep the A7 size budget over the whole file). The hidden DOM always holds the full post (its text, headings, links and figure `alt`/`describe`), so find-in-page, crawlers and screen readers never need the gesture; focusing a link or finding text inside the DOM opens the full layer at the matching spread.
- The author's text is never deleted: the full layer renders every block of the post, and the `validate` text-equality check (A1) runs on the full layer as before.

## 5. Flecs ownership (what the Scene keeps)

Flecs owns every piece of runtime state; JS holds strings, GPU resources and pure evaluation.
Components (additions to READER.md section 5): `Spread { f, target, vel, layer }`, `Corner { drag, open }` (the peel gesture), `Turn { progress, dir, grabbed }`, `Figure { id, t, rate, mode, focus }` as children of the Spread entity, `Overview { t }`, `Materials`. Systems: `SpreadSpring` (the magnet), `TurnProgress`, `FigureClock` (advances `t` only for figures on the current or turning spread, honours `loop/once/scrub/static` and reduced motion), `SpreadCull` (which two sheets enter `objs`), `PackObjs` (existing). Exports added to the wasm interface: `spread_goto(n)`, `spread_by(df)`, `spread_grab(dir)`, `spread_release(vel)`, `figure_focus(id)`, `figure_seek(id, t)`, `overview_set(b)`, `figure_clock_ptr()`. The tracks themselves (keyframe tables) are data in the binary; `src/lib/magazine/chan.ts` is a pure `evalChannels(table, t, out)`; it reads `Figure.t` from the wasm pointer. Reduced motion forces `mode = static` with `t = poster`.

## 6. Tests and acceptance

Each check names its control (verification law: a check without a failing control proves nothing).

- **A1 layout invariants** (`scripts/magazine/validate.ts`, extends `scripts/reader/validate.ts`): for all 11 posts, both width classes, every spread: glyph boxes inside their frame; no glyph/figure/aside box overlap (rect intersection, 0.05 em tolerance); body baselines on the 1.6 em grid (all within 0.01 em); no widow or orphan (2 lines), no heading in the last two baselines of a frame; hyphens: no 3 consecutive; K-P adjustment ratio over a frame: 95% of lines within [-1, 1], max 2.0; ink coverage per spread 9% to 38% unless the template says `air`; text equality with the source modulo whitespace and with the hidden DOM (inherited). Controls: remove glue shrink (must fail the ratio check), place a pull quote overlapping a frame (must fail overlap), shift one baseline by 0.3 em (must fail grid).
- **A2 planner quality**: every article of 5 or more spreads uses at least 4 distinct templates; no template twice running unless declared; the first spread is `opener`, the last is `closer` (or declared); every figure within one spread of its first reference. Determinism: two runs produce byte-identical binaries.
- **A3 figures**: (a) schema and lint pass for all 6 specs; (b) CPU reference vs GPU: render each figure at 3 times (0, mid, poster) with the real evaluator via the preview page, compare against `src/lib/magazine/figure-cpu.ts` (extends `slug-cpu.ts` with stroke distance, dashes, trim, groups), mean absolute luminance difference at most 2%, no pixel region above 25% difference larger than 3 x 3 px; (c) animation checks: trim values monotone, dots stay on their path (distance to path below 0.02 em), `once` mode reaches `poster` state at `t = duration`; static frame equals `poster` render; (d) crispness: a stroke at zoom 1, 2, 4, 6 has a 10 to 90% edge transition of at most 1.5 device px. Controls: swap two control points (CPU vs GPU diff must fire), raster the figure to a texture and bilinear-upscale (crispness must fail), delete a channel (animation check must fail).
- **A4 interaction and performance** (CDP, Chrome headless with `emulateMedia`): wheel sequences settle on an integer `f`; flick rule; arrows; click-edge turn; `#s3` deep link boots on spread 3; zoom 4x pan then turn rules; link table hit-test for every link of every spread; figure focus enter and exit return the exact previous pose. Frame time: 600 frames of a continuous turn scrub plus 600 frames of a figure-dense spread playing, at 1440x900 on a 120 Hz display: p95 GPU frame at most 8.3 ms and no frame above 16.7 ms; text-plus-figures at most 1.25x the paper-only baseline taken in the same session; at least 5 runs, median and spread, each number printed with background GPU utilisation (`ioreg ... "Device Utilization %"`) and `uptime` load; discard runs where background moved more than 10 points.
- **A5 visuals**: screenshot every spread of ifd, hyperion, notes-on-errors, mcp-not-enough in light and dark and the 6 figures at poster to `docs/upstream/magazine/shots/` with the commit sha; computed contrast (paper/ink 12:1 light, 9:1 dark; graphics 3:1; text in figures 4.5:1); human review of a contact sheet is part of the acceptance (layout quality is not a unit test). No clipped glyph at the sheet edge in either class (1440x900 and 390x844).
- **A6 a11y and SEO**: hidden DOM contains all text and each figure's `alt` and `describe`; Lighthouse or axe zero serious violations per prerendered route; reduced motion shows `poster` frames and a 150 ms crossfade turn; `prefers-contrast: more` swaps accents to ink with underlines.
- **A7 budgets**: `fonts.bin` at most 900 KB brotli; any article at most 400 KB brotli; warm build adds at most 15 s; one spread lays out in at most 150 ms warm.

## 7. Fast loop and preview page

Goal: from saving a file to seeing a re-laid spread in about 1 s (est.: layout 150 ms warm, WebSocket push 5 ms, render 16 ms; measure and record before and after).
- Resident process `bun scripts/magazine/watch.ts` keeps harfbuzz, fonts, hyphenation trie and glyph tables loaded. It watches `*.svx`, `figures.ts`, `spread.json`, `templates/*.ts`, `voices.ts`; on change it re-runs only the affected spread range (the planner caches per spread by hash of its block range and template) and pushes the new `RDR2` slice over a local WebSocket.
- Preview page `tools/magazine-preview/index.html` (Vite, not part of the site routes, so it can break independently): one flat orthographic WebGPU render of a single spread using the same WGSL evaluator module as the room (`magazine.wgsl.ts` exports the evaluator as a function block both the tracer and the preview include) with paper albedo and a stubbed light (flat, optional gutter shadow, optional bow gradient). Query: `?slug=ifd&spread=3&class=wide&dark=1&t=poster|4.2&zoom=2&grid=1&frames=1`. `grid=1` overlays the baseline grid and columns, `frames=1` the frame rectangles with their flow order and the K-P adjustment ratio per line as a left-edge tint (red above 1.5). Keys: arrows (spread), `T` (time scrub, drag), `D` (dark), `Z` (zoom), `V` (variant grid).
- Variant grid: `?variants=feature,lead-figure,wide-figure` renders the same spread in N templates in one sheet (decide cheap, confirm expensive); `/overview` contact sheet of all spreads of all articles; the same sheet is a PNG via headless CDP for the acceptance screenshots.
- Fidelity ladder (same binary at every rung): CPU dump to PNG (`scripts/reader/dump.ts` extended, no GPU) -> preview page (flat) -> room reading pose in the lab route -> full world.
- Figure tuning: `?fig=eval-timeline&t=3.0` shows one figure at time `t`, `&play=1` plays it, `&sheet=0,3,6,9,12` renders 5 times in one sheet.

## 8. Staged plan and lane split

House rules apply: lanes write and commit in their own worktree and run nothing; the root merges, builds once, runs the validate and visual batches once; the old column layout is deleted in the same merge. Check `uptime` before launching (stop adding above load 40).

**Wave 0 (one lane, short, contract first):**
- Lane `contract` owns `src/lib/magazine/format.ts` (RDR2 reader and writer, f16, records from 1.6), `src/lib/magazine/types.ts` (Figure, Channel, Template, Voice types), `src/lib/magazine/dsl.ts` (the `figure`, `rrect`, `path`, `track` helper signatures, types only plus pure builders). Deliverable: a hand-written sample `RDR2` buffer in a test and the type-checked DSL, so every other lane codes against bytes and types, not prose.

**Wave 1 (all parallel, disjoint files):**
| Lane | Owns (create or edit only these) | Delivers |
|---|---|---|
| `text` | `scripts/magazine/kp.ts`, `hyph.ts`, `microtype.ts`, `dropcap.ts`, `tests/kp.test.ts`, `docs/upstream/magazine/hyph/` | K-P with per-line widths, hyphenation, hanging punctuation, drop caps; unit tests incl. planted controls |
| `grid` | `scripts/magazine/grid.ts`, `templates/*.ts`, `planner.ts`, `marginalia.ts`, `frames.ts`, `tests/planner.test.ts` | track solver, 12 templates, Viterbi planner, copyfit, marginalia |
| `compile` | `scripts/magazine/build.ts`, `scripts/magazine/parse-directives.ts`, `scripts/magazine/emit.ts`, `scripts/magazine/vite-plugin.ts`; edits `scripts/reader/parse.ts` only for directives; deletes `scripts/reader/layout.ts` column placement at merge | pipeline: svx -> blocks -> planner -> RDR2; `remark-directive` wiring; hidden DOM handlers |
| `fig` | `scripts/magazine/fig/*` (schema, compile, stroke, dagre-layout, lint), `src/lib/magazine/chan.ts`, `src/lib/magazine/figure-cpu.ts`, `tests/fig.test.ts` | figure compiler, channel evaluation, CPU reference raster |
| `shader` | `src/lib/gpu/room/magazine.wgsl.ts` (replaces `reader.wgsl.ts`), `src/lib/gpu/room/magazine.ts` (replaces `reader.ts`) | evaluator for glyph, shape, path, stroke, group, numeral; spread geometry, gutter shadow, bow, turn strips; plane differential; channel uniform |
| `type` | `scripts/magazine/voices.ts`, `scripts/magazine/palette.ts`, edits to `scripts/reader/fonts.ts` (new faces and instances), `docs/upstream/magazine/fonts/**` with SOURCE.md and OFL texts | fonts in `fonts.bin`, OKLCH palette generator with gamut check, 10 voices |
| `preview` | `tools/magazine-preview/**`, `scripts/magazine/watch.ts`, `scripts/magazine/validate.ts`, `scripts/magazine/contact-sheet.ts` | the fast loop, variant grids, A1 validator with controls |
| `input` | `src/lib/magazine/input.ts` (wheel, swipe, keys, flick), `src/lib/magazine/hit.ts`, `src/lib/ecs/magazine.ts`; edits `src/lib/components/World.svelte` | turn and zoom input, overview, link and selection hit-tests, figure focus |
| `content-<slug>` (one lane per article: ifd, hyperion, notes-on-errors, mcp-not-enough, nushell-tui, optimal-parkour) | `src/routes/(site)/thoughts/<slug>/figures.ts`, `spread.json`, directive annotations inside that article's own `+page.svx` | the 6 figures and the per-article declarations; each lane touches only its own folder |

Shared files with a single owner (nobody else edits them): `src/lib/gpu/room/shader.ts` and `room.ts` belong to the ECS lane or the root (the `shader` and `input` lanes request hook lines in writing; the root applies them: a new storage binding, the `rd` uniform fields for spread index, turn progress and channels, `Reading` to `Spread` in `camera()`); `src/lib/ecs/*` and the Rust/wasm module belong to the ECS lane: the `input` lane writes the wrapper `src/lib/ecs/magazine.ts` and a spec of the new components and exports (section 5), the ECS lane implements them. Binding budget: `cs_view` is at the 8-storage-buffer cap (READER.md): the channel table goes into the existing `reader` buffer (written per frame as a subrange) rather than a new binding.

**Wave 2 (root only, one pass):** merge all branches, delete `scripts/reader/layout.ts` column placement and the old sheet-stack paths in `reader.wgsl.ts` / `reader.ts` / `World.svelte`, build once, run A1 to A7 once, render one batch of screenshots (all spreads, light and dark, 6 figures at poster), send failures and images back to the owning lanes. Repeat Wave 2 with only the failing lanes until every acceptance check is green; do not stop at a partial state.

**Wave 3 (polish, same one-pass rule):** foil numerals, in-world find, overview polish, Caveat notes, the three spare figures, `prefers-contrast`.

Dependencies that cannot be parallel: the `contract` lane precedes everything (hours, not days); the `shader` lane needs the ECS lane's shader.ts edit window; the content lanes can write specs against the DSL types immediately and only see pixels at Wave 2.

## 9. Five biggest risks

1. **Shader cost and complexity.** Per-pixel strokes (cubic root solves), Slug fills, 8 turn strips and a gutter term all land in the primary-hit albedo of a tracer already at the 8-storage-buffer cap. Mitigations: cell lists with a hard 24-item cap (build error), bounds-rect early out per figure, LOD tone below 3 px/em, strokes as analytic distance and not curve winding, the READER.md fallback (render visible items into a window texture at screen density, same binary). Measured in A4; if it fails, tune cell size and swept bounds first, not the shader.
2. **Typographic and art quality is not unit-testable.** The planner can produce legal but ugly spreads (rivers in narrow justified columns, odd rhythm). K-P with hyphenation and copyfit gets us a long way, but taste needs review of contact sheets and per-article `plan` overrides. Mitigation: declared layouts always beat the planner, the variant grid exists to compare templates cheaply, and A5 includes a human review gate.
3. **Spread geometry versus devices.** A landscape 1.43 spread suits desktops; phones in portrait get single sheets and need a second set of template variants (double the template work and a second planner pass). Risk: narrow variants look like the old web column. Mitigation: narrow templates are first-class (named `*-n`), included in A5 screenshots at 390x844, and the planner scores them on the same rhythm metric.
4. **Contention on shared files with the ECS rewrite.** `shader.ts`, `room.ts` and the Flecs module are under rewrite by another lane; the format change touches `camera()`, the `rd` uniforms, the binding table and the wasm exports. Mitigation: the single-owner rule in section 8, the contract lane first, hook lines requested in writing and applied by the root in the merge, and the `reader`-buffer-subrange trick to avoid a new binding.
5. **Glyph, font and licence surface growth.** Four new faces and variable instances (Fraunces axes, `smcp`, Big Shoulders digits) grow `fonts.bin` and add build-time failure modes (missing glyphs, features absent in the stored font, a face whose upstream text turns out differently for a specific release). Mitigation: only-used-glyph tables, the 900 KB budget in A7, the OFL texts stored beside each face, a fail-closed missing-glyph rule as today, and a stated rule that any face whose text was not read for the exact release (DM Serif Display, Bricolage as of today) is not used until read. The same applies to `tex-linebreak` (no LICENSE file: not used) and any later library.
