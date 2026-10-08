# READING: one scrolling page, drawn by the GPU

> **No HTML page content (2026-10-06).** Every mention below of a DOM text layer, prerendered article, accessible copy, native Cmd+F, Reader Mode, print or no-JS text is historical and deleted. The DOM holds head tags and one canvas per mode; the article exists only as the RDR3 data drawn by WebGPU. Cost, Andrew's explicit decision (2026-10-06, "remove the HTML version of pages, just have the projection which is WebGPU"): screen readers, search engines indexing body text, Reader Mode and clients without WebGPU get nothing but the head tags and, where WebGPU is missing or fails to start, one line of text. Nothing is added back.

Status: implemented 2026-10-06 as the GPU-only reader (see `docs/READING_GPU.md`, which supersedes sections 4, 8 and 9, and the Deviations in `docs/READING_CONTRACT.md`). Written as design before any code ran; the numbers and claims below were not all re-measured. Supersedes the paged-book reading of `docs/MAGAZINE.md` (sections 1.2 to 1.5, 4.1, 4.5, 4.4 and the spread parts of 5 and 8). Keeps `docs/READER.md` text rendering (Slug-style analytic glyphs), `docs/BOOK.md` (the shelf-to-book animation) and the Flecs conventions of `docs/FLECS_AUDIT.md`. Links in section 12 were written from memory, not fetched this session. Facts marked "est." are estimates to measure; "unverified" is a claim about a browser or library I did not test.

Andrew's brief: he does not like the paged format; he wants a proper page to scroll, click through and interact with, still GPU-drawn, and gave creative freedom: beauty and readability first. My pick, stated once: **native scrolling owns the physics, the GPU draws the page, and a transparent real-DOM text layer sits exactly over the glyphs.** Everything below follows from that.

## 1. Decisions (all of them, no menu)

| Question | Decision | Why |
|---|---|---|
| Scroll physics | The browser's own scroller. A tall `<div class="scroller" tabindex="0">` holds the DOM text layer; the canvas is `position: fixed` behind it and draws the window at `scrollTop`. We never reimplement momentum, rubber-band, Space/PageDown/Home/End, touch fling, scroll restoration or `scrollIntoView`. | Native feel on every OS is a solved problem we cannot beat. Custom physics is the main reason GPU-text readers feel wrong. Costs one frame of latency (canvas follows `scrollTop` read at the top of each rAF), invisible because all visible ink is the canvas. |
| Find-in-page | **Native Cmd+F**, no custom bar. | The text layer is real text at the true document position inside a real scroller, so the browser finds, highlights, scrolls to matches, Cmd+G and the match count all work. A custom bar means reimplementing matching, highlight, navigation and muscle memory, worse. Collapsed text uses `hidden="until-found"` (Chromium reveals and fires `beforematch`, we expand in place). Safari and Firefox do not reveal collapsed text (unverified for current Safari): mitigation is a persisted "Always show full text" toggle and the fold's word count. |
| Selection, copy, links, Tab order, focus | Native, on the text layer (`color: transparent` spans, `::selection` painted accent at 30%). Links are real `<a>`; cursor, hover, click, middle-click, context menu, Tab order are the browser's. The GPU only draws the look (hover underline, focus ring from the focused element's rect). | Mirrors the accessible DOM by construction: there is one DOM, not a hidden copy plus a mapping. This is the pdf.js text-layer technique. |
| Accessible copy | The text layer **is** the accessible DOM (real `h1..h6`, `p`, `figure`, `pre`, `nav`, `aside`, `button`). Canvas is `aria-hidden`. The old `.sr-only` duplicate is deleted. | One source, no drift, SEO unchanged (it is still prerendered by mdsvex). |
| Distilled vs full | One flow: hero, then "In brief" (the distilled content, always open), then a **fold** control, then the full text. The fold is collapsed by default with a faded 5-line peek; click, Enter, `E`, a `#heading` deep link, or a find match expands it in place (height spring, no layer swap). Choice persisted per slug. | "One click or scroll away" is satisfied twice: the peek invites scrolling into it, one click opens it. The distilled text stays in the flow above, so it is never hidden by opening the rest. |
| Layout | One long vertical flow, one column, ragged-right Knuth-Plass, sidenotes in the margin at width. No spreads, no sheets, no baseline pairing across sheets. | See section 3. |
| Rendering | Screen-space instanced pass over the world frame (or over a static ground in reader-only mode), not per-pixel evaluation in the tracer albedo. | Far cheaper, which is what makes 60 fps on a phone credible (section 8). |
| Light mode | None. One dark look (CLAUDE.md "The world has one look"). Print is the only light rendering (section 11). | Andrew's standing direction. |
| Primary mode | **Reader-only**: a cold load of `/thoughts/<slug>` starts no tracer and no scene, only the page pass. The in-world reading is the same page over the dimmed scene. | Phones and shared links land here; the tracer is the expensive part. |

## 2. Visual spec

### 2.1 Type

Faces unchanged (Inter body and UI, Instrument Sans display, Fira Code). Build-time instances: Inter at opsz 14 (body 400, label 500), opsz 20 (h3), Instrument Sans `wdth 80 wght 600` per article voice.

`--em` is the body size: `clamp(17px, 15.6px + 0.36vw, 21px) * --scale` where `--scale` is the user's text-size step (0.9, 1, 1.1, 1.25, 1.4; control "Aa" in the top bar, persisted; browser zoom also works because layout is in CSS px and relays out on resize). 17 px at 390 wide, 18.2 at 1000, 20.1 at 1440 (calculation, not measured). Scale ratio 1.25 (major third) below the display size.

| Role | Face | Size (em) | Line | Tracking | Notes |
|---|---|---|---|---|---|
| Title (h1) | Instrument Sans wdth 80 wght 600 | clamp(2.7, 1.4 + 5.2vw, 5.4) | 0.98 | -0.025em | the one loud thing; up to 3 lines |
| Dek | Inter 400 | 1.375 | 1.4 | -0.005em | ink-2 |
| Lead paragraph (first paragraph of "In brief" and of the full text) | Inter 400 | 1.2 | 1.55 | 0 | replaces drop caps (dropped: a one-sans page does not earn them) |
| Body | Inter 400, opsz 14 | 1 | 1.62 | 0 | ragged right, no hyphenation except phone |
| h2 | Instrument Sans wdth 85 wght 600 | 2.0 | 1.1 | -0.015em | label above: `02 / 06` in Fira Code 0.72em ink-3 |
| h3 | Inter 600, opsz 20 | 1.25 | 1.3 | -0.005em | |
| Pull quote | Instrument Sans wdth 80 wght 500 | 1.75 (2.4 on wide) | 1.2 | -0.01em | 3 px accent rule on the left |
| Caption, meta, labels | Inter 500 | 0.8 | 1.45 | +0.02em (caps +0.06em) | ink-2 |
| Code | Fira Code 400 | 0.875 | 1.6 | 0 | `calt` on |
| Numeral (distilled) | Instrument Sans wdth 75 wght 700 | 4 to 7 | 0.9 | -0.03em | `tnum` where the file has it (unverified) |

Why these numbers: Butterick recommends 45 to 90 characters per line and line spacing of 120 to 145% of the point size for print; Inter's tall x-height wants the generous end on screen, so 1.62 for body and tighter leading only as sizes grow. Headings snap their line boxes to half body lines so the vertical rhythm survives.

### 2.2 Measure and columns

- Reading column: `34em` (about 66 Inter characters at the mean 0.52 em advance; to check in the preview). Clamp: never narrower than the viewport minus 2 x 20 px, so a 390 px phone gets about 40 characters per line, below the 45 floor on purpose (hyphenation on, ragged right, 17 px).
- Wide (>= 1180 px): grid `[toc 13em] [column 34em] [margin 17em]` centered, gaps 3em. TOC left (sticky), sidenotes and wide-figure overflow in the right margin. Wide figures may span column plus margin (up to 52em) and bleed 3em to the left.
- Medium (720 to 1179 px): column 34em centered (or `100% - 2 x 32px` if smaller); TOC collapses into the top bar and a slide-over; sidenotes become inline notes.
- Phone (< 720 px): column = viewport minus 40 px; figures full column width; sidenotes tap-to-expand inline; TOC in the top bar sheet.
- Figure classes: `column` (34em), `wide` (52em, only >= 1180, else column), `full` (viewport width, for the hero or one signature figure per post).

### 2.3 Spacing system

All vertical space is a multiple of half a body line (`u = 0.81em`). Tokens in em: `s1 0.4, s2 0.81, s3 1.215, s4 1.62, s5 2.43, s6 3.24, s7 4.86, s8 6.48`.

- Paragraph gap `s2` (no indent). List item gap `s1`. h3 above `s5`, below `s2`. h2 above `s7`, below `s3`. Figure above and below `s5`. Code block above and below `s4`. Pull quote above and below `s6`. Hero top `s8` (min 14svh), hero bottom `s7`. Fold control row `s6` above and below.
- Heights of figures, images and code blocks round up to a multiple of `u` (so the rhythm never drifts after a figure).
- Horizontal: gutters 20 px phone, 32 px medium, auto on wide.

### 2.4 Colour tokens (ONE colour system: one dark look, one ground, one accent, for every article; the numbers live in `src/lib/reading/theme.ts`, the table below is the shape, not the authority)

Andrew, 2026-10-06: "we want one color for everything, not multiple color guidelines". No per-article hue, tint or glow; nothing changes colour between pages or scroll positions. Tint hue 265 (deep blue-grey ground and text), accent amber (OKLCH h 68, the hue of the room's lamps, LampColour {4, 2.4, 1.1}), one fixed secondary teal (h 205) for a second data series.

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.165 0.012 h)` | page ground (a static gradient texture in reader-only mode, the dimmed scene around the column in the world) |
| `--surface` | `oklch(0.205 0.012 h)` | code panel, popovers, fold, tinted field |
| `--surface-2` | `oklch(0.245 0.014 h)` | hover, lightbox scrim over 60% |
| `--ink` | `oklch(0.93 0.008 h)` | body text, capped at 1.0 even on HDR (white glare is the enemy of long reading) |
| `--ink-2` | `oklch(0.76 0.01 h)` | dek, captions, meta |
| `--ink-3` | `oklch(0.64 0.012 h)` | numbers, tick labels, comments in code; never used for text a reader must read |
| `--hair` | `oklch(1 0 0 / 0.08)` | rules, panel borders |
| `--accent` | `oklch(0.78 0.14 h)` | link underline, rule, active TOC, rail head, focus ring |
| `--accent-2` | `oklch(0.74 0.11 h+40)` | second series in figures, strings in code |
| `--accent-wash` | accent at 14% over bg | heading deep-link highlight, pull quote field, selection at 30% |

Build step (existing palette script) fails the build under 4.5:1 for text and 3:1 for graphics against `--bg` and `--surface`, and on sRGB gamut clipping. Estimated ratios: ink about 15:1, ink-2 about 9:1, ink-3 about 5.3:1 (est., script is the authority).

No ambient glow, no gradient: the ground is flat. Nothing is decorative.

Figures draw only palette names (ink, muted, accent, accent2, neutral1..3, paper); `scripts/magazine/fig/contrast.ts` fails the build when a shape is under 1.5:1 against the ground, a stroke or text under 4.5:1, or a label under 4.5:1 on its fill.

HDR-aware: on an `extended` canvas (WAVE3 5.1) the accent only may exceed 1.0, up to `min(headroom, 1.6)`: the focus ring, the link underline on hover, the progress-rail head, the figure's key mark at its poster beat, the copied check. Ink stays SDR. Off under `prefers-contrast: more` and when headroom is 1. Reduced motion does not remove it (it is not motion).

Links: ink-coloured text, 1 px accent underline (offset 0.18em, thickness from the font), hover thickens to 2 px over 120 ms and the text takes `--accent`; focus draws a 2 px accent ring, offset 3 px, radius 4 px, and keeps an invisible DOM outline for forced-colors. External links append a 0.7em north-east arrow. No visited colour.

Code: panel `--surface`, 1 px `--hair`, radius 0.6em, padding 1em 1.2em, language label top-left (caption style, ink-3). There is no copy button (Andrew, 2026-10-07): copying is Cmd/Ctrl+C on a selection, acknowledged by the copy flash (pass 6). Syntax tones derive from the hue: keywords `--accent`, strings `--accent-2`, numbers ink, comments `--ink-3`, punctuation ink-2 (tokens come from the existing Shiki pass at build). Long lines scroll horizontally inside the block (section 7).

### 2.5 Motion (all timings are CSS-ms equivalents driven by Flecs springs or `delta_time`)

| Motion | Timing | Rule |
|---|---|---|
| Body text | none | never fades, slides or staggers: reading starts at paint |
| Figure, pull quote, image enter | 480 ms, `cubic-bezier(.2,.7,.2,1)`, 12 px rise + opacity, when 15% in view, once | stagger 40 ms, at most 3 |
| Figure autoplay | starts when more than 60% visible and the page is idle 200 ms; pauses off screen | loop and once modes as in MAGAZINE.md 2.3 |
| Link underline | 120 ms | |
| Heading `#` affordance | fades in 120 ms on heading hover or focus | |
| Fold expand | height spring omega 14, zeta 1 (about 350 ms), content opacity 200 ms delayed 80 ms | collapse is the same spring reversed; scroll anchoring keeps the heading under the pointer still |
| Sticky bar title change | 160 ms crossfade, 6 px slide | |
| Anchor jump | native smooth scroll, about 450 ms; target heading gets `--accent-wash` for 1.2 s | instant under reduced motion |
| Popover (cite, link card) | open 140 ms, close 90 ms; 120 ms hover intent delay | |
| Lightbox | FLIP from the image rect to fit, 320 ms same curve | |
| Toast ("Link copied") | 1.6 s, aria-live polite | |
| Ambient glow and any looping figure | follow `prefers-reduced-motion`: figures show `poster`, no rises, no springs (instant) | |

### 2.6 Mockups

Wide (1440 x 900, dark). `T` is the sticky top bar (40 px: article title left, current section centre, `Aa`, progress time right). Rail is a 2 px line at the right edge.

```
+--------------------------------------------------------------------------------------------+
| T  IFD is fine                       The frame is the evaluator          Aa   4 min left   |
+--------------------------------------------------------------------------------------------+
|                                                                                       |    |
|  CONTENTS            02 / 06                                                          |    |
|  01 What blocking     The frame is                                                    |    |
|  02 Cost of doing..   the evaluator                         +--------------------+    |    |
|  03 Snix moves ...    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~    | Jade, 2025          |    | #  |
|  04 Edge cases        body at 34em, ragged right, 66 cpl    | Stopping evaluation |    | #  |
|  05 The frame  *      ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~    | from blocking [3]   |    | *  |
|  06 Refs              ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~    +--------------------+    |    |
|                       +------------- wide figure, 52em, bleeds into margin ----------+   |    |
|                       |   eval-timeline (hover scrub, click to step, <- -> keys)     |   |    |
|                       +----------------------------------------------------------+   |    |
|                       | caption                                                       |    |
+--------------------------------------------------------------------------------------------+
```

Medium (820 x 1180):

```
+------------------------------------------+
| T IFD is fine        02 The frame...  Aa |
+------------------------------------------+
|        02 / 06                           |
|        The frame is the evaluator        |
|                                          |
|        body, 34em centered, 66 cpl,      |
|        ragged right ....................  |
|        .................................  |
|        | note [3] inline, indented,      |
|        | accent rule, tap to close       |
|        +----- figure at column width ---+ |
|        |  (tap = focus mode)            | |
|        +--------------------------------+ |
+------------------------------------------+
```

Phone (390 x 844): top bar 44 px with a 2 px progress line along its bottom edge; title of the section in the bar; contents open as a bottom sheet.

```
+----------------------+
| IFD is fine  3 Snix >| = bar, progress line below
|======----------------|
|                      |
|  03 / 06             |
|  Snix moves          |
|  the wall            |
|                      |
|  body 17 px, 40 cpl  |
|  hyphenated, 20 px   |
|  gutters, 1.62 lead  |
|                      |
|  +----------------+  |
|  | figure, full   |  |
|  | column; tap to |  |
|  | open focus view|  |
|  +----------------+  |
|  [ Read the full text|
|    7 min, 1,380 w ]  |
+----------------------+
```

### 2.7 What is wrong with the current IFD spread, and the structural fix for each

Read from `/Volumes/Projects/tmp/cdp/d0.png` (1440 x 900) and `/Volumes/Projects/tmp/h-sheet.png`. Numbers are measured off those screenshots by eye (about, in screen px at 1440 wide).

| # | What is bad (specific) | Cause in the spread design | Fix by design in the flow |
|---|---|---|---|
| 1 | **Figures are tiny.** The timeline occupies about 190 x 150 px of a 600 px half-sheet (a third of the width); the graph about 240 x 160. Both were authored at 36 x 20 em but drawn at about 12 em wide because the slot is a 6-column area and the figure scales to fit its slot. | A figure is a decoration that fits a grid area. | A figure is the **hero of its section**: `wide` class, 52em (about 940 px at 18 px body, 1.5x the text column), minimum height 24em, authored at that size. The text column adapts to the figure, never the reverse. Figure labels are authored at body size (1em, minimum 0.9em), so they are readable without zoom. |
| 2 | **Labels are illegible.** `stops`, `resumes`, `waits`, `eval`, `build`, `thunk` render at about 7 to 8 px (0.55em); two `build` labels float far from their bars. | Labels use the 0.78 em caption style then the figure is scaled down by about 3x. | Labels are authored in body em units and never scaled below 0.9em (the `fig` lane's label lint fails the build otherwise); a label is attached to its shape by construction (child of the node), so it cannot float. |
| 3 | **Dead space.** The bottom-left quarter of the left sheet (about 600 x 330 px) is empty, a band of about 170 px sits between captions and quote, and a margin of 70 px sits left of both figures. | Fixed templates place content into areas and leave the rest blank; the right sheet and left sheet are paired. | There is no second sheet to balance. Vertical rhythm is continuous (`s5` and `s7` gaps); every gap is one of the spacing tokens, and a gap larger than `s8` fails a layout lint. Whitespace is set by the system, not left over. |
| 4 | **Flat hierarchy.** Deck (22 px), definition (15 px), captions (13 px) and the quote (about 26 px) sit within a factor of two of each other; the 100 px title is the only large element and it floats alone; the quote is strong but buried in a corner. | Template slots each get a size, but nothing ranks them. | Five ranks only, each at least 1.25x the next: title 5.4em, section heading 2.0em, lead 1.2em, body 1.0em, caption 0.8em; the pull quote is rank 2 (1.75 to 2.4em) and is placed between sections, never in a corner. Size, weight and ink colour are used together (ink, ink-2, ink-3) so reading order is visible from across the room. |
| 5 | **Weak rhythm.** Content is spread over a 1240 x 860 px sheet at about 134 words, so everything is far from everything else; the captions have a 25 px line for 13 px text (leading about 1.9) so they read as detached, and the title block, figures and quote do not share a baseline. | Frames place content independently; the baseline grid exists per frame, not across the page. | One column, one baseline unit `u`, headings and figures snapped to half-lines. Captions use leading 1.45 and sit `s1` under their figure, aligned to the text column's left edge. Density is steady: about 60 to 75 words per screen of reading, one figure or quote per screen at most. |
| 6 | **Misalignment.** Title left edge at about 170 px, figure inset to about 237 px, deck and quote at 773 px; no shared edges. | Three different slot origins. | Exactly three vertical edges on wide: the column's left edge (title, deck, body, captions, quote rule, code), the figure's left edge (the wide figure bleeds left by 3em from the column, on its own grid line), the margin notes' left edge. Every element sits on one of them. |
| 7 | **No entry points.** Every section, in the full text, would be a bare heading in a column. | No notion of a section opening. | Each section opens with a **strong entry** (section 3.1): number label, a 2.4em x 3 px accent rule, a 2em display heading, and a lead sentence in the lead style. |

Verification of the fixes is a test, not an impression: the 1440 screenshot of the ifd page must show, measured from the DOM text layer and the layout export, figure width >= 1.4 x column width, smallest label >= 0.9em, no vertical gap larger than `s8`, and exactly the three left edges above (check 10 in section 10).

## 3. Page structure (what the reader sees, top to bottom)

1. **Hero**: title, dek, meta row (date, author, "In brief 1 min, full 8 min" computed at build), ambient glow. At scroll 0 this is exactly what the opened book's page shows (section 9).
2. **In brief** (the distilled layer, section 1.7 of MAGAZINE.md, same `distill` block, same lint and `review.post_sha` gate, `template` field deleted): lead = definition and deck, then 1 to 2 figures (wide class, stacked), each with its caption, the pull quote on an `--accent-wash` field, optional numerals row. 100 to 250 words, still verbatim from the post.
3. **Fold**: full-width control row: "Read the full text, 7 min" with a chevron, over a 5-line faded peek of the first full paragraph. `aria-expanded`, `aria-controls`. Expanded state persists per slug. The "Always show full text" setting lives in the `Aa` popover.
4. **Full text**: the post in order; h2 sections numbered `01 / N`; figures, code, images, pull quotes, sidenotes inline as authored; ends with references (the `Cite` list) and a "next thought" card (the neighbouring posts).
5. **Footer**: previous and next post, back to shelf.

Posts without a `distill` block skip 2 and 3 and open straight into the full text.

### 3.1 The section entry (every h2) and figures as heroes

**Section entry**, top to bottom, all on the column's left edge, `s7` of space above:
1. Accent rule: 2.4em wide, 3 px, `--accent` (HDR peak on enter, then settles).
2. Label `03 / 06` (Fira Code 0.72em, `--ink-3`), `s1` below the rule.
3. Heading (h2, 2em Instrument Sans). The step-style titles the post already uses stay as written (CLAUDE.md voice rules).
4. **Lead**: the section's first sentence, set in the lead style (1.2em, `--ink`, leading 1.55) and then the paragraph continues in body size. This is a style change on a run of the same text, not new copy: the DOM text is identical to the post, so the text-equality check and the verbatim rule hold. A section whose first block is code or a list takes no lead.
5. `s3` below, then the body.

**Hero figure rules**: a figure is `wide` (52em) by default; one per post may be `full` (viewport width) as the signature. Minimum rendered height 24em (the figure's declared aspect decides, so authors write 52 x 24 to 52 x 30). Labels at body size. Its caption sits `s1` below, left-aligned to the column edge, 0.9em `--ink-2`, with a figure number in Fira Code ("Fig. 1") and a one-line takeaway first. A figure always has room to breathe: `s5` above and below, never beside text on wide (side-by-side layouts go to the margin only for sidenotes). Two figures are never adjacent without at least one paragraph or a quote between them. On phones the figure is full column width and tapping opens focus mode, where labels get a second chance at body size.

### 3.2 Worked example: IFD is fine, top to bottom at 1440 wide

Source: `thoughts/ifd/+page.svx` (about 1,530 words, six h2 sections, two figures in `figures.ts`, one code block, one `Cite` list). All copy below is the post's own text; sizes are at 18 px body.

| # | Block | Composition |
|---|---|---|
| 0 | **Hero** | `s8` above (about 14svh). Title "IFD is fine" at 5.4em (about 97 px) Instrument Sans wdth 80, tight, left on the column edge, 1 line. Dek (the `dek` frontmatter) at 1.375em `--ink-2`, 2 lines max at 34em. Meta row: `2026-05-13  ·  Andrew Gazelka  ·  In brief 1 min  ·  Full 8 min` (caption style). Ambient accent glow (hue 265) behind the title. About 480 px tall, first screen is only this plus the first line of In brief, so the first impression is calm and typographic. |
| 1 | **In brief: lead** | Section label "In brief" (rule + caption label), then the definition sentence as a lead paragraph (1.2em, 3 lines at 34em): "Import From Derivation: during evaluation, the Nix language asks for a path whose bytes depend on a derivation's output." |
| 2 | **Fig. 1: eval-timeline** (hero) | `wide` 52em x 26em (about 940 x 470 px), bleeding 3em left. Two lanes at 3em row height, labels (`CppNix`, `Snix`, `eval`, `build`, `stops`, `waits`, `resumes`) at 1em. The playhead and hatch animation as designed. Hover scrubs, click on `stops`/`waits`/`resumes` beats steps, Left/Right 0.25 s. Caption: "Fig. 1  When a thunk demands the contents of `${drv}/foo`, the evaluator stops, calls out to the daemon, waits for the build, resumes." Replaces the 190 px figure. |
| 3 | **Fig. 2: eval-graph** (hero) | `wide` 52em x 28em, after `s6` of space (the Fig. 1 caption ends the first figure; two figures never touch). Circles and squares at 1.2em, labels at 1em. Caption: "Fig. 2  Eval and build are nodes in one graph. The graph grows as eval discovers more of it. A thunk that needs a build emits a request and yields." A takeaway line under it at lead size: "A thunk nobody forces is a derivation nobody builds." |
| 4 | **Pull quote** | Between In brief and the fold, `s6` above and below: "The IFD ban was a polite way to say "the reference evaluator cannot handle this yet." The phrasing outlived the constraint." at 2.4em on wide (margin-breaking: set across column plus margin, 3 px accent rule on the left, `--accent-wash` field), attribution "The frame is the evaluator" as a link to that section. |
| 5 | **Fold** | Full column width, 5-line peek of "The community calls this an anti-pattern..." faded to `--bg`, row: "Read the full text  ·  7 min  ·  1,380 words" with chevron. Everything below it is the post. |
| 6 | **Full text: opening** | Not a section; text starts directly after the fold: the thesis paragraph and the `nix` code block (panel, language label, 34em wide, 11 lines, no horizontal scroll needed), followed by the two paragraphs on the community and the reference manual (one sidenote at wide: Cite 1 "Import From Derivation, Nix Reference Manual" in the margin beside the first mention, with host `nix.dev`; Cite 2 beside the `flake check` sentence). |
| 7 | **01 / 05 What "blocking" actually means in CppNix** | Entry per 3.1. Lead: "The manual is precise: "the Nix language evaluator is sequential, it only finds store paths to read from one at a time"." Three paragraphs; sidenote for the jade.fyi link (Cite 3 in the margin). Consider Fig. 1 repeated as a small `column` figure only if the author asks: no, the hero is in In brief and is not repeated. |
| 8 | **02 / 05 The cost of doing without it** | Lead: "Cut IFD from your flake and every input shape has to be expressible in pure Nix." The three "Take Rust / git / code generation" paragraphs get a hanging 3 px accent tick at the left and a bold lead-in as authored (no new copy). Margin sidenote for `crane` (link card). |
| 9 | **03 / 05 Snix moves the wall** | The point where the figures pay off. Lead names Snix (Cite 4); Fig. 2 is **referenced here** with a small "see Fig. 2" link that scrolls up and shows a back chip (it is not duplicated). Paragraph on a hundred derivations; Tvix roadmap quote. |
| 10 | **04 / 05 Edge cases** | The six edge cases become six `h3`-style run-in blocks (the bold lead-ins already in the post: "Eval triggers builds.", "Determinism.", ...) each with a small accent label, spaced `s4`, so a reader can skim the worries as a list; the answer text is body. A thin `--hair` rule above each. This is the section where scanning is most likely, so entries are the most visually separated. |
| 11 | **05 / 05 The frame is the evaluator** | Strongest claim last (voice rule): lead paragraph, then the closing pull quote is **not repeated** (it already appears in In brief); the last sentence of the section is set at lead size so the post ends on a quotable line. |
| 12 | **References** | `Cite` list as a numbered `column` list (caption style, host in `--ink-3`), each entry a link with a back arrow to the citing paragraph, then the footer: previous and next post cards. |

Reading flow in numbers (est., 1440 x 900, 18 px): the hero is the first screen; In brief takes about 3 screens (lead, Fig. 1, Fig. 2 and quote); the fold appears at about screen 4; the full text is about 14 screens. At 390 x 844 the same blocks stack in the same order with figures at 350 px wide (focus mode for detail).

## 4. Flow layout engine (Rust/Flecs layout, reused and replaced)

Input: post blocks (existing parse), viewport width and DPR, `em_px` (from `--scale`), voice. Output (binary `RDR3`, delta from `RDR2`): `Blocks[]` {kind, x, y, w, h in CSS px, firstLine, lineCount, firstItem, itemCount, level, anchorId, fold flag}, `Lines[]` {block, y, x, w, textRange}, items as before (glyph, rect, image, shape, path, stroke, group, numeral) but clipped per block, `Anchors[]`, `Notes[]` {anchor block, line, margin y, text}, `Links[]` {line rect, target}, figures as before. Removed from the binary: `Spreads[]`, `layer`, spread grid cells. Per-block item lists replace the 6 x 1.6 em cell grid, since the renderer instances glyph quads (section 8) and needs no per-pixel cell lookup.

Algorithm, per layout request (resize, text-size change, fold toggle, relayout of a block):
1. **Measures** from width class (2.2). A pure function `Measure(width, em_px) -> {col_x, col_w, margin_x, margin_w, toc, class}`.
2. **Flow**: blocks stack in Y. A block's width class selects its x and w. Paragraphs run the existing Knuth-Plass (boxes from harfbuzz words, ragged finishing glue, hyphenation only when `cpl < 48`), one constant line width, no per-line exclusion intervals (drop caps and wrapped quotes are gone, which also kills the old `lineIndex -> [x0,x1]` frame function).
3. **Rhythm**: every block's height rounds up to a multiple of `u` (0.81 em); figures keep their declared aspect at their class width.
4. **Sidenotes** (>= 1180 only): each `Cite` and `:::aside` gets a note placed in the margin at its anchor line's y; a one-pass relaxation pushes overlapping notes downward (about 40 lines, kept from MAGAZINE.md 1.4.6, now actually used); notes past the end of their section clamp to the section end. Below 1180 the same notes become inline blocks after their paragraph.
5. **Fold**: blocks after the fold control carry `Folded`; a collapsed fold lays out only the peek (5 lines) and gives the rest `h = 0` but keeps their `Lines[]` for the text layer (`hidden="until-found"` content), so find and anchors know where they would be.
6. Whole-article layout is synchronous in wasm. Est. under 30 ms for a 1,500-word post (K-P is milliseconds per 300 lines per MAGAZINE.md), under 120 ms for 10,000 words, no height estimation and so no layout shift, which keeps scroll positions deterministic. If a post exceeds 16 ms on a phone, layout moves to a worker; the contract does not change.
7. Caching: per block by `(hash(block), width, em_px, class)`; resize relays only changed blocks' widths (all, but cached shaping), so a drag-resize is shaping-free.

Survives from the magazine design: Inter + Instrument Sans + Fira Code; per-article `wdth`/`wght` voice (colour is one system) (dark column only); the Slug glyph evaluator and curve data; shaping, Knuth-Plass, hyphenation, microtype (hanging punctuation); the figure engine (`figures.ts`, channels, strokes, scrub, `poster`, `describe`/`alt` lints) and the figure Flecs systems; pull quotes (restyled); the distilled block and its lint, controls and review gate; hairlines, folio-as-top-bar, numerals as an inline block; the half-baseline rhythm (as `u`); drop caps stay out.

Deleted: spread templates (`duo`, `solo`, `compare`, `numerals`, `text`, `text-code`) and their `-n` variants, `grid.ts` track solver, `planner.ts` and copyfit, `frames.ts` (spread frames), the two-sheet geometry (bow, gutter shadow, spine safe zone), page turning (`Turn`, `Corner` peel, `LeafCull`, `spread_goto/nav/by/grab/release`), the Full-text-tab peel and the layer swap, `Overview` contact sheet (replaced by the contents list), `Bounce`, A1 spread invariants and A2 planner checks (replaced in section 10), the `reader.wgsl`-style per-pixel cell evaluator for the page, the `template:` field in `distill`, `spread.json` template keys (voice stays).

## 5. Interaction spec

- **Anchors and deep links**: every heading has an id (`slugify`, same as `rehype-pages.js`). Hover or focus shows `#` in the left margin (hanging outside the column); click copies `…/thoughts/<slug>#id` and shows the toast, and sets the hash with `pushState`. Scroll-spy updates the hash with `replaceState` (debounced 250 ms, no history spam). Load with a hash: scroll to it (expanding the fold if inside), wash highlight 1.2 s. `scroll-margin-top` equals bar height plus one line. `#full` expands the fold.
- **Internal links** (`#id`): native jump, then the wash. A footnote jump shows a "back to text" chip in the margin at the anchor, closing on use or on scroll away. **Other thoughts** (`/thoughts/x`): navigate (flies to the next book in the world, plain route change in reader-only mode); hover or focus shows a link card (title, date) after 120 ms. **External links**: open in a new tab with `noopener`, hover shows the host in the bottom-left corner like a browser status bar.
- **Sticky headings**: a 40 px bar (44 on phones). It always shows the article title; once the first h2 has passed it shows `NN title` of the current section (exclusive relation `Reading`), crossfading. The bar background is `--bg` at 80% over a 12 px blur of the page. Clicking the section name opens the contents (a sheet on phone, scroll-to-TOC on wide).
- **Contents and progress**: wide shows a sticky TOC at left with the current section in accent and a 2 px rail on the right edge with section ticks (hover shows the name, click or drag scrubs by setting `scrollTop`). Medium and phone show the section in the bar and a 2 px progress line; "N min left" on wide and medium. All drawn by the GPU pass, with a real `<nav>` of links in the DOM (Tab order, screen readers).
- **Images**: click, Enter or Space on a focused image opens a lightbox (GPU overlay, `--bg` at 88% scrim): FLIP to fit, wheel or pinch zoom to 4x with the detail texture tier, drag to pan, double-click toggles fit and 100%, Esc or click outside closes. DOM: the image is a `<button>` with alt text; focus returns to it on close.
- **Cite and footnote popovers**: `[N]` is a real `<a>` to the reference. Hover (120 ms intent), focus or tap draws a popover card (reference title, host, "open") above it, clamped to the viewport, Esc closes; wide screens show it as the sidenote permanently instead. Click or Enter follows the in-page anchor with the back chip.
- **Interactive figures** (the existing figure engine): a figure is a focusable `role="group"` with `aria-roledescription="interactive figure"` and its `describe` as the label. Pointer hover over a scrubbable figure previews that time; drag scrubs with momentum (existing `MOMENTUM_K`); click or tap on a beat marker steps to it; Left and Right step 0.25 s, Space plays or pauses, Home returns to `poster`, `F` or double-click opens focus mode (the figure fills the viewport as in the lightbox, with the scrub strip; the phone's answer to small labels). Autoplay and pause per 2.5. Vertical scroll gestures starting on a figure always scroll the page (the figure only takes horizontal drags, locked by the first 8 px).
- **Code**: a block is a native horizontal scroller (`overflow-x: auto`, hidden scrollbar, a 1 px fade at the clipped edge); the GPU draws the code at the DOM `scrollLeft`, the same trick as the page. There is no copy button; selected code copies its exact source on Cmd/Ctrl+C. Touch: native pan with axis lock, no page scroll while panning a long line horizontally. Keyboard: the block is focusable (`tabindex=0`, `role="region"`, named by language), arrows scroll it.
- **Keyboard**: native Space, Shift+Space, PageUp/Down, Home, End, arrows act on the scroller (it holds focus by default, no custom code). Added: `J` / `K` next and previous section, `E` toggle the fold, `T` open contents, `?` a one-screen shortcut list (v2), `Esc` per section 9. `Cmd/Ctrl +/-` scales the browser zoom natively; the `Aa` control is the finer step.
- **Scroll restore**: `history.scrollRestoration = 'manual'`. Save every 250 ms idle `{ blockId, offsetInBlock, fold, scale }` in `history.state`; restore by block anchor, not pixels, so a different width, text size or font load still lands on the same sentence. A restored page does not play the hero entrance.
- **Reduced motion**: section 2.5; no momentum anywhere is ours to disable (it is the browser's setting). **Contrast**: `prefers-contrast: more` makes ink pure white at 1.0, accents ink with underlines, hairlines at 30%.
- **Selection and copy**: native drag, double and triple click, Shift+arrows, Cmd+A (the article only), all on the text layer. Copy yields real text with the soft line breaks of a paragraph joined; selection inside code copies the exact source. Selection colour is the accent at 30% (`::selection`). Copy acknowledgment: after `copy` (and after the code Copy button) a continuous rounded selection shape covers the copied rows, pulses 2.5% over 300 ms, holds 700 ms and fades 400 ms, drawn by the GPU pass from the rows of the DOM `Range` (`getClientRects`, merged into a gap-free column); reduced motion shows the hold and fade only. Clipboard writes use `navigator.clipboard.writeText` with a hidden-textarea fallback that restores the reader's selection. Details and the prior art this was re-derived from are in section 14.

## 6. Flecs model

Module `ReadingModule` (replaces the spread parts of `MagazineModule`; Figure, scrub, clock systems and the exclusive-relation observers pattern stay). The page is declared by build-time pack from `ArticleIR` (WAVE3 decision) into entities; runtime state is Flecs, strings and GPU resources stay in JS.

**Prefabs** (all `IsA` from `Block`): `Block {x, y, w, h}` (CSS px, document coordinates), with `Heading {level, number}`, `Paragraph {firstLine, lines}`, `Figure` (existing component plus `Block`), `CodeBlock {scroll_x, scroll_max}`, `PullQuote`, `ImageBlock {tier, ready}`, `ListBlock`, `Rule`, `Numerals`, `FoldBlock {peek_lines}`, `Hero`, `Refs`. Notes are `Note {y}` entities. Each carries `Rect` only where it differs from the block.

**Hierarchy and order**: `article` entity (`Article {slug}`, `Voice {wdth, wght}`); blocks are `(ChildOf, article)` created in reading order with `OrderBy` on creation index, plus an exclusive `(Next, block)` chain for neighbour traversal (J/K, next-heading, sticky bar). `Prev` is not stored (query `(Next, $this)`). Sections are `(InSection, heading)` pairs on blocks (a cascade query computes them at pack time, so "what is current" is a relation lookup, not a scan).

**Relations**: `Anchor` is a component `{id}` on headings and figures, and `(Targets, anchor)` is the relation on a `Link` entity for internal links (so `LinksTo` jumps and the back chip are one lookup); `(Cites, ref)` from a `Link` to a `RefEntry`; `(NoteOf, block)` from a note to its anchor paragraph; `(InFold, fold)` on every block after the fold. Exclusive relations (existing pattern, observer turns each change into a JS event): `Reading` (current heading), `Hover`, `Focus` (focused link, figure, code block), `Scrubbing`, `Open` (popover or lightbox target). Tags: `Visible`, `Folded`, `Expanded`, `Settled`, `Reduced`.

**Singletons**: `Scroll {y, vel, max}` (written from the DOM `scrollTop` by `set_scroll(y)` each frame; `vel` is derived for the figure autoplay gate, never integrated), `Viewport {w, h, dpr, class}`, `Typography {scale, em_px}`, `Fold {t, target, vel}` (the expand spring; one per article if more than one is ever resident), `Rail {t}`, `Events`, `Export` (the clock block and the packed per-frame state).

**Systems** (custom phases with `depends_on`: Input, Layout, Spring, Cull, Pack):
- `RelayoutOnChange` (Layout): runs when `Viewport`, `Typography` or `Fold.target` changed (change detection, not flags), calls the layout, rewrites `Block` rects, re-derives `Scroll.max`, and applies the scroll anchor (keeps the block at the viewport top still).
- `FoldSpring` (Spring): critically damped height; emits `EV_FOLD_SETTLED`.
- `Cull` (Cull): finds the visible range (`Rect.y` ordered; binary search over the exported y array, then a short linear walk, not a per-frame query over all blocks) and adds or removes `Visible` with a 1.5 viewport lookahead for figures and images (data fetch) and a 0.25 viewport lookahead for text.
- `ReadingSpy` (Cull): sets `(Reading, h)` to the last heading with `y <= scroll + bar + 1 line`.
- `FigureClock`, `FigureAdvance` (existing): only for `Visible` figures with `Settled` and the idle gate.
- `PopoverPlace`, `NotePlace` (Layout): sidenote relaxation lives in layout, popover clamping in Pack.
- `PackPage` (Pack): packs the instance ranges (first and last visible block), UI overlay state (rail, bar, popover, ring, lightbox), channel table; one export, one pointer, no per-gesture ABI (the FLECS_AUDIT change: `set_input(kind, a, b)`).

**Observers**: `OnAdd (Reading, *)` emits the section event (bar crossfade, hash `replaceState`, rail); `OnAdd/OnRemove Visible` on figures requests data and starts the clock; `OnAdd Expanded` on the fold starts the spring and relayout; `OnAdd (Open, *)` raises the popover or lightbox event; `OnAdd (Focus, *)` positions the ring.

**Deleted components and systems**: `Spread`, `Turn`, `Corner`, `Overview`, `Bounce`, `Leaf`, `Book.n`, the `Peeled` and `OverviewOn` tags, `SpreadSpring`, `CornerSpring`, `OverviewSpring`, `BounceDecay`, `TurnProgress`, `LayerLand`, `LeafCull`, `BookCursor`, and the `spread_*`, `corner_*`, `overview_set`, `bounce`, `pulse_tab` exports. Kept: `Figure`, `FigureTime`, `Scrubbing`, `Hover`, `Focus`, `Events`, `Export`, `Reduced`, `Settled`, `BookRig` and the book phases of `docs/BOOK.md`.

## 7. Rendering and the text layer

- **Pass**: one render pass over the frame (world, or the static ground in reader-only mode). Per visible block, instanced quads: glyphs (Slug curve + band evaluation per fragment, quads sized to the glyph box plus 1 px), rects, images (texture array as READER.md 3.5), shapes, strokes, figures (the existing figure evaluator inside the figure's bounds rect). Text coverage uses the plane differential `pxWidth` as before, so it stays crisp at any DPR and browser zoom. The UI (bar, rail, popovers, focus ring, lightbox, toast) is the same pass with its own small instance list.
- **Text layer** (DOM): for each block the real element (`<p>`, `<h2>`, `<pre>`, `<figure>`) is absolutely positioned at its `Block` rect, with one `<span>` per layout line (`white-space: pre`, `color: transparent`, font set to the same Inter at `em_px`). A one-time calibration after layout reads the span's width and applies `transform: scaleX(layoutWidth / measuredWidth)` (cap 0.5%) for lines entering the viewport plus two screens; spans farther away stay uncalibrated (find still matches; selection geometry only matters where the user can see). Reading order equals DOM order equals Tab order. Collapsed text sits inside `hidden="until-found"`. A `beforematch` handler expands the fold and relayouts synchronously before the browser scrolls to the match.
- **Scroller height** is `Scroll.max + viewport h`, set whenever layout changes. Overscroll bounce is native and not mirrored (the fixed canvas stays still, acceptable).
- **Cold start budget** (est., to measure): HTML + text layer paint first (the prerendered DOM is already readable text, styled to look like the page: system fallback until fonts load, so the first paint is real content, not a poster); the GPU pass takes over and the DOM spans go transparent in one frame once the first `Visible` range has drawn (no flash, no double ink).

## 8. Performance

- Culling is by block band as in section 6; glyph instances for visible blocks only (about 600 on a phone viewport, up to 3,000 on a 4K desktop viewport, est.).
- Curve data: the whole article's glyph tables upload once (est. 150 KB brotli for 1,400 words, about 1 MB for 10,000, from MAGAZINE.md 1.6; small, so "streamed by block" is not worth its complexity for text). **Streamed by proximity**: figures (compiled tables 10 to 40 KB each) and images (tiered textures) load within 1.5 viewports of the screen and evict beyond 3.
- Idle frames cost zero: the pass redraws only when scroll, hover, an animation, a spring or a live figure is active (a `dirty` flag from the Flecs `Export`). When reading in the world, the tracer renders the scene behind the scrim at half resolution and 15 Hz at most with a frozen lamp flicker (blur radius 24 px, dim 0.9 from BOOK.md), because nobody reads the room; in reader-only mode there is no tracer.
- Budgets (est., set as acceptance in section 10): reader pass at most 3 ms GPU on a desktop integrated GPU, at most 8 ms on a mid phone (a 2022 Android or an iPhone 12) at 390 x 844 and DPR 3; Flecs tick at most 0.3 ms; no frame above 16.7 ms across a 600-frame programmatic scroll; relayout on resize at most 16 ms for the largest post.
- Phones: DPR 3 means 3.0 MP of fragments for the full-screen pass, but fragments are only evaluated inside glyph and figure quads (text covers about 12% of the screen), so cost scales with ink, not pixels.

## 9. Integration with the book and routing

- **URL**: `/thoughts/<slug>` and `/thoughts/<slug>#heading`. Prerendered by SvelteKit (`adapter-static`) as today; the mdsvex article is the text layer's content.
- **Handoff from the opened book**: BOOK.md phases Lifting, Carrying, Opening stay. At the end of Opening the camera is in the reading pose: orthographic and screen-aligned, the book's open spread centred. The page pass is enabled at the start of Opening (as the old reader pass was) and draws the hero block at scroll 0 **on the book's right sheet** in screen space with the same pixel transform as the sheet (the sheet rect is exported by `book.rs` as `ReadPose`), so the title lands where it will live. Then Reading begins and, over 420 ms (one spring, omega 10, zeta 1): the sheet geometry fades out (dim to 1), the page's dark ground and its measure expand from the sheet rect to the viewport layout, and the hero translates to its column position. Scroll is locked (`overflow: hidden` on the scroller) until this settles, then native scroll is released. Reversal is the same spring backwards (Closing). Everything is a continuous channel, no state snap, per BOOK.md.
- **Cold load** (reader-only): no book, no tracer; the page fades in with the hero entrance (480 ms).
- **Back and Escape**: `Esc` order: lightbox, popover, figure focus mode, contents sheet, then close the article: if `history.state.fromWorld` is set, `history.back()` (Back and Esc are identical: the book returns to the shelf with its mirror animation); otherwise `goto('/')`, which boots the world. Explicit anchor clicks push history entries, so Back first undoes the jump (native expectation); scroll-spy hash updates replace. The browser Back at the first entry leaves the article the same way.
- Opening another post from a link card in the world flies to that book (`goto`, reuse of the shelf pose); in reader-only mode it is a plain route change with a 160 ms crossfade.

## 10. Staged migration and acceptance

House rules (CLAUDE.md): one pass, old path deleted in the same change, lanes write and commit in their own worktree and run nothing, the root merges, builds once and runs the checks once. Another wave (the WAVE3 Rust port) may be flipping `scripts/magazine` into `crates/mag-*` at the same time: paths below are given for the current tree, and each lane maps to the same-named crate once WAVE3 lands (flow to `mag-layout`, page to `mag-gpu`, dom to the shim and Svelte, world to `mag-world`). Do not edit files owned by an active lane without asking the root.

| Lane | Owns | Delivers |
|---|---|---|
| `contract` | `src/lib/magazine/{format,types}.ts`, `format.test.ts` (or `mag-format`) | `RDR3` (blocks, lines, anchors, notes, links, per-block items; spreads and `layer` removed), `Distill` without `template`, a sample buffer |
| `flow` | new `scripts/magazine/flow.ts`, `measure.ts`, `sidenotes.ts`; edits `emit.ts`, `build.ts`, `kp.ts` (per-line constant width only); deletes `grid.ts`, `planner.ts`, `frames.ts`, `templates/**` | flow layout, measures, rhythm, fold, sidenotes, `RDR3` emit, byte-deterministic output |
| `page` | `src/lib/gpu/room/magazine.ts`, `magazine.wgsl.ts` (new page pass; deletes the sheet and turn paths), `src/lib/magazine/chan.ts` kept | instanced glyph and item pass, culling by block range, UI instances (bar, rail, ring, popover, lightbox, toast), HDR accent, dirty-flag redraw, reduced-rate scene behind |
| `dom` | `src/lib/components/Reader.svelte` (new), `TextLayer.svelte`, `Toc.svelte`, `src/lib/magazine/{input,hit,select}.ts` rewritten to DOM events, print CSS, `src/routes/(site)/thoughts/+layout.svelte` edits | scroller, text layer and calibration, native find with `beforematch`, scroll restore, deep links, copy-link, keyboard, `Aa` control, link cards, a11y semantics, print |
| `world` | `world/src/magazine.rs` (becomes `reading.rs`), `reader.rs`, `book.rs` edits for `ReadPose` and handoff, `src/lib/ecs/magazine.ts` | `ReadingModule` of section 6, deletions listed there, `set_input` export |
| `fig` | `scripts/magazine/fig/**`, `figure-cpu.ts`, `src/routes/(site)/thoughts/ifd/figures.ts` | responsive figure sizes (class width), phone focus mode data, label lint at 350 px (min 11 px effective, else the figure must declare a `narrow` size), keyboard step markers |
| `type` | `scripts/magazine/voices.ts`, `palette.ts`, new `src/lib/reading.css` tokens, `scripts/reader/fonts.ts` (add opsz 20 instance) | tokens of 2.4 as CSS variables and as the shader palette from one source, contrast and gamut checks, light palette deleted |
| `content` | `thoughts/ifd/+page.svx` frontmatter (`distill` loses `template`), the `Cite` to note mapping in `$lib/components/refs` | the ifd page end to end; other posts keep their text, gain a note mapping only |
| `tests` | `tests/e2e/reading/**`, `scripts/magazine/validate.ts` (replaces A1 and A2) | the checks below with their controls |

Wave 1: all lanes in parallel, disjoint files. Wave 2 (root only): merge, delete the old paths, build once, run the checks once, render the batch, send failures back to the owning lanes, repeat only with failing lanes. Order inside the merge: contract, type, flow, world, page, dom, fig, content, tests. Wave 3: the other ten posts (notes mapping, any figure), `?` shortcut sheet, internal link cards, TOC drag.

**Acceptance** (each check names a planted-bug control that must fail it):

1. **Screenshots in dark** at 1440 x 900, 820 x 1180 and 390 x 844 for ifd: top, mid-page with a sticky section title, fold collapsed, fold expanded, code block scrolled right, figure at poster, lightbox, cite popover (wide: sidenote), focus ring on a link. Contrast computed on the screenshots (ink 12:1 floor measured against ground). A contact sheet goes to human review (layout quality is not a unit test). Control: set `--ink` to `--ink-3` in a build; the contrast check fails.
2. **Scroll determinism**: `scrollTo(anchor)` for every heading at each width: the heading's rect top equals the `scroll-margin-top` within 1 px; save and reload restores `{blockId, offset}` within 1 px at the same width and within one line at another width and at another text size; two layout runs produce byte-identical `RDR3`. Control: make restore use raw pixels; the changed-width case fails.
3. **Text layer alignment**: for 30 sampled lines per width, the DOM span rect equals the GPU line rect within 1.5 px (the layout export is the oracle). Control: shift the layer 3 px; fails.
4. **A11y tree** (CDP `Accessibility.getFullAXTree`): the heading sequence, link count and names, landmarks (`nav`, `main`), the fold button with `aria-expanded`, figure groups with their `describe`, code regions, equal an expected outline derived from the post source; no text appears twice (canvas hidden). Tab order equals document order of links and buttons; focusing a link in the collapsed region expands the fold and scrolls it into view. axe: zero serious violations. Control: swap two heading elements in the DOM; outline and Tab order checks fail.
5. **Find and selection**: `window.find` for a string in the collapsed full text fires `beforematch`, expands the fold, and the selection rect overlaps the matching GPU line; select-all then copy yields the post text modulo whitespace; copy inside code yields the exact source. Control: remove `hidden="until-found"`; the expand check fails.
6. **Culling correctness**: scroll by 7 px steps over the whole post; the pixels of the culled render equal a reference render with every block drawn (difference under 0.5% luminance, no region over 25%); the set of drawn blocks always contains every block intersecting the viewport. Control: cull one pixel early; fails.
7. **Interaction suite** (CDP): anchor copy writes the correct URL, hash replace and push behaviour, Esc ordering, Back from an anchor jump then Back to the shelf, J/K, link hit-test for every link on the page (hover cursor, click target), figure keyboard steps and drag-scrub reach the expected `t`, code horizontal scroll moves the GPU draw. Control: break the Esc order (close article before lightbox); fails.
8. **Performance**: 600 frames of programmatic scroll plus a 600-frame figure-dense stretch, at 1440 x 900 and at 390 x 844 DPR 3 with CPU 4x throttle in CDP and on a real phone if one is reachable; at least 5 runs, median and spread, each number printed with background GPU utilisation and `uptime` load, runs discarded when background moved more than 10 points; budgets of section 8; the idle page measures zero GPU frames over 5 s. Control: disable the dirty flag; the idle check fails.
9. **Print and reduced motion**: print preview PDF is the light article text (section 11) with 100% of the text; `emulateMedia({ reducedMotion: 'reduce' })` shows poster frames, no rises, instant anchor scroll. Control: a stylesheet that hides the DOM in print; the text-completeness check fails.

10. **Layout critique fixes** (from the layout export and the DOM text layer at 1440 x 900, ifd): hero figure width at least 1.4 x column width; smallest figure label at least 0.9em; no vertical gap between consecutive blocks above `s8`; every block's left edge is one of the three declared edges; every h2 has rule, label, heading and lead; five type ranks each at least 1.25x apart. Control: render Fig. 1 at the old 12em width; the width and label checks fail.

## 11. Print and no-JS

`@media print`: canvas and bar hidden, the text layer becomes normal flow text (transparent colour replaced by `#000`, positioning and spans reset to static, hyphenated), `background: #fff`, fold expanded, `<details>` and `hidden` content shown, body 11 pt at 1.5, references printed in full, external links print their URL after the text. Print is paper, so it is the one light rendering, and it comes free because the text layer is the real article. No JS: the prerendered DOM is the whole article in the same stylesheet's dark colours as plain styled HTML (not a poster, not blank).

## 12. Risks and what to cut

Risks:
1. **Text layer drift**: browser text layout differs from ours by sub-pixel amounts; mitigated by per-line `scaleX` calibration, but tested only with Inter; a font-load race could misalign selection until calibration. Test 3 guards it; selection only matters on visible lines.
2. **One frame of scroll latency** between the compositor-scrolled DOM and the canvas read in rAF (and iOS scroll events during momentum are per frame, unverified for current iOS). The fixed canvas cannot show a jump relative to the DOM because the DOM is invisible; the only effect is about 16 ms of input latency. Accepted; measure in test 8.
3. **`hidden="until-found"` support**: Chromium yes; Safari and Firefox unverified or no. The persisted "Always show full text" setting and the visible word count are the mitigation; if Andrew prefers the full text open by default, flip the default and keep the fold as "collapse".
4. **Relayout correctness** on resize and fold toggles with scroll anchoring; the block-anchor restore and test 2 cover it.
5. **Shared files**: `shader.ts`, `room.ts`, `World.svelte` and the wasm exports are shared with the running WAVE3 and ECS lanes; hook edits are requested in writing and applied by the root.
6. **Phone legibility of figures** authored at 36 x 20 em; mitigation is the lint, `narrow` sizes and focus mode, not shrinking labels.

Cut (not in v1): a custom find bar; sidenote placement beyond the one-pass push-down; per-article HDR palettes beyond the accent; inline-link hover cards for external sites; pinch zoom of the whole page (browser zoom does it); the `Aa` font-family choices (only size); TOC drag-scrub; share cards; reading-time personalisation; narrow figure variants beyond the lint; the `?` shortcut sheet (Wave 3); light mode (deleted).

## 13. Sources (written from memory, not fetched this session)

- Matthew Butterick, Practical Typography: https://practicaltypography.com/ (line length https://practicaltypography.com/line-length.html, line spacing https://practicaltypography.com/line-spacing.html, justified text https://practicaltypography.com/justified-text.html)
- Robert Bringhurst, The Elements of Typographic Style (measure of 45 to 75 characters; book, not a link)
- Tufte CSS (sidenotes and margin notes): https://edwardtufte.github.io/tufte-css/
- Stripe documentation, a reference for restrained long-form technical reading with a margin: https://docs.stripe.com/
- Medium's typographic scale and measure as a reference for narrow single-column reading: https://medium.com/
- Utopia fluid type scales: https://utopia.fyi/
- Inter (variable, `opsz`): https://rsms.me/inter/
- `hidden="until-found"` and `beforematch`: https://developer.chrome.com/docs/css-ui/hidden-until-found
- pdf.js text layer (transparent DOM text over a drawn page): https://github.com/mozilla/pdf.js
- WCAG 2.2 contrast minimum: https://www.w3.org/TR/WCAG22/#contrast-minimum
- In-tree: `docs/MAGAZINE.md`, `docs/READER.md`, `docs/BOOK.md`, `docs/WAVE3.md`, `docs/FLECS_AUDIT.md`, `CLAUDE.md` ("The world has one look" and the post voice rules).

## 14. Prior art (ix/packages/web)

Confidentiality: `/Volumes/Projects/indexable-inc/ix` is team-private and this repo may be public. I read the files below, cite paths and line numbers only, and re-derived every idea in my own words; no code or text was copied. Do not paste ix source here. Paths are relative to `/Volumes/Projects/indexable-inc/ix/packages/web/`.

**What it does (read this session):**
- A terminal page whose text is drawn on a canvas (ghostty-web) and is not DOM text. Selection is the canvas widget's own: its drag select is extended with double click (word) and triple click (line) in `src/lib/site/terminal-select.ts:1-5` and `:46-74`. A word is a run of characters matching a fixed class (`:9`), found by walking left and right from the clicked cell (`:63-65`). The pointer position is mapped to a cell by dividing by the canvas box (`:53-57`).
- The selection's rectangles per row are derived in cell units and trimmed of trailing blanks (`terminal-select.ts:9-24`, `:27-44`), because a drag selects whole cells to the right edge and the blank padding copied as text.
- A copy acknowledgment (`src/lib/site/copy-flash.ts:1-7`): one continuous rounded selection shape over the copied text that pulses, holds and fades (timings at `:19-26`: 300 ms pulse, 700 ms hold, 400 ms fade, 40 ms row stagger), drawn on a canvas laid over the page so it works for DOM text, a textarea and the terminal alike. Rectangles for DOM text come from `Range.getClientRects` merged into a gap-free column (`:29-35`, merge at `:60-`); for a textarea from a hidden mirror element copying the textarea's font and wrapping (`:38-59`). One selection colour is shared by drag-select, the terminal and the flash (`:16-17`).
- The clipboard write (`src/lib/site/copy.svelte.ts:35-55`): async `navigator.clipboard.writeText`, falling back to a hidden off-screen textarea and `execCommand('copy')` that saves and restores the user's selection (`:19-33`), and a "Copied" state for 1.5 s (`:7`, `:51-53`). `src/lib/components/ui/CopyButton.svelte` is the control built on it.
- Guards against the renderer fighting the selection: the crab animation holds while a selection exists or the pointer is held (`src/lib/site/TerminalView.svelte:426-440`), because a full re-render drops or flips the highlight; some rows are declared unselectable (`:234-235`); Safari's contenteditable caret bar is hidden (`:561`).
- An HDR element on a WebGPU extended-range canvas the size of one box, with a breathing luminance up to 3.0 and a fallback to a plain CSS element on any failure (`src/lib/site/hdr-caret.ts:1-14`), page root limited to standard dynamic range.

**What we reuse as an idea (re-derived, not copied):**
1. One selection colour everywhere, and a **copy acknowledgment shape** drawn over the copied rows (section 5). Our rows come from the DOM text layer's `Range`, so the same `getClientRects` merge applies.
2. **Clipboard write with a fallback that preserves the reader's selection** for Cmd/Ctrl+C and the heading copy-link.
3. **Trim trailing blanks from a selection**: our analogue is that a selection ending at a line end must not copy the layout's soft line breaks as newlines, and a code selection must not copy gutter or panel padding.
4. **Word and line semantics defined explicitly** where the platform does not give them (canvas); for us the browser gives them on the text layer, so we do not implement them, except inside figures (below).
5. **Hold animations while a selection or pointer drag is active**: our dirty-flag redraw and figure autoplay must not repaint in a way that drops the highlight; since the highlight is native DOM, the check is that no GPU pass change moves a glyph during a drag (e.g. relayout is deferred while `pointerdown` or a selection exists).
6. **HDR as one small canvas box with a fallback**, and `dynamic-range-limit` standard on the root, matching our rule that only accents may exceed 1.0 (section 2.4); on failure fall back to SDR accent.

**What differs for a GPU-drawn page (and why we do more with the DOM):**
- ix has no DOM text to select, so it implements hit-testing, word and line selection and highlights itself (`terminal-select.ts:46-74`). We put a transparent real DOM text layer over the glyphs (section 7), so hit-testing, selection, caret-free drag, word and triple click, Shift+arrows, find, copy and the context menu are native. We never convert a pointer to a glyph cell.
- ix selects in a monospace cell grid (`cols`, `rows`), where a position is an integer pair. Our text is proportional, ragged and reflowing; positions are DOM ranges, and the highlight is the browser's `::selection` over transparent text, not GPU rectangles. Only the **copy flash** is GPU-drawn, from `Range` rectangles.
- ix's copy source is the terminal buffer's `translateToString`. Ours is the DOM selection's text, post-processed for paragraph joining and code exactness (section 5); no layout glyph table is consulted at copy time.
- ix draws its flash on a separate overlay canvas for all kinds of text; ours is one pass of the page's own GPU renderer (same device, same HDR transfer), with no second canvas.
- Find: ix has no find story for the canvas. Ours is native Cmd+F over the text layer, which is why the text layer must sit at true document positions (section 7).
- Selection inside **figures** is the one place we may need custom hit-testing (figure labels are canvas ink): labels are exposed as real `<text>`-like spans in the figure's DOM (`describe` and per-label spans, transparent), so labels are selectable and copyable without custom selection; word and line rules for them use the browser.
- ix's unselectable rows (`TerminalView.svelte:234-235`) map to our `user-select: none` on UI chrome (bar, rail, toast), set in the DOM, not in the renderer.

## 2026-10-07 style redo (Andrew: "completely redo the style ... clean, modern, like Apple or Brilliant")

Supersedes the visual parts of sections 2.1 to 3.2 above (the hero plaque, ROOM labels, contents column, FIG cards are deleted).
- Hero: date (secondary), title in Inter 700 opsz 32 (`F.title`, wide 2.8em = 56px), dek regular secondary, "N min read". No plaque, no room list, no kicker rule.
- No table of contents: sticky column, bar button, slide-over, `t` key, `toc:*` hits, `tocOpen` and the bar section label are gone. The bar is close, title, Aa; the rail is one plain accent progress line.
- h2 is plain Inter 600 opsz 28 at 1.9em with 6U above; no hairline, rule, label or lead-sentence split. Figure caption is one quiet 0.85em secondary line under the figure (a11y strings unchanged). Pull quote and takeaway are plain Inter 600, no bar. Footer says Next / Previous.
- Code panel: radius 1.0em, no language label (`label = ''` in typeset.ts layoutCode), faint hairline (alpha 0.03). Inline code is a pill (radius 0.28em).
- Body em: clamp(17.5, 14.5 + 0.004 vw, 20) so 20px at 1440, column 34em = 680px.
- Palette: code L 0.188, card 0.212, popover 0.235 (was 0.2/0.23/0.26); thresholds untouched; theme.test hairline floor 1.3 is what limits how faint hairlines go.
- Traps: `static/magazine` must be rebuilt (`bun scripts/magazine/build.ts --preview`) or the old plaque keeps showing; shelf.test stamp fails until then. Adding a font instance means appending to FONT_SPECS (indices are baked). Title tracking is not supported by the typesetter (opsz 32 carries tight spacing itself).

### 2026-10-07 pass 2 (reference: the ix docs "Machines" page)
- Neutral ground (L 0.16, C 0.003), cards 0.195/0.222/0.25, hairline alpha 0.06; text primary 0.97 (headings, links), body secondary 0.785 (the 9:1 body floor on the code panel is what stops it going darker), tertiary 0.66 (meta, captions). Figure neutrals darkened to [0.39, 0.355, 0.32] because body ink (now grey) must still reach 4.5:1 on neutral1 and neutral3 must stay 1.5:1 off the ground.
- Wide column is centred (docX0 -9, docX1 43; figures 52em break out on both sides); margin notes deleted, citations are inline note blocks at every width.
- Links white with a thin ink3 underline, inline code coral (the `property` syntax slot) on a faint pill, code panel radius 0.6em with a header row (language label, hairline). LINE_H is 1.7 (UNIT 0.85). Title is Inter 650 opsz 32.
- Ragged-right: the K-P breaker minimises global slack, so a 90% line followed by a longer one is its optimum; changing raggedStretch (0.5, 3, 12) did not change breaks, left at the default.

## 2026-10-07 pass 3: type scale-down

em = 16 to 17px (metrics.ts clamp), gutters 24px, narrow margin 48px, colW 38em (about 646px wide). Title 3.0/2.6/2.3em, h2 1.6/1.6/1.5em, dek and lead 1.12em, caption 0.8em, code 0.8em, inline code 0.9em. Shots: /Volumes/Projects/tmp/redesign/a/r5*.

## 2026-10-07 pass 4: one link underline, link preview card

The link record bottom edge is the baked underline bottom (typeset.ts UL_Y/UL_H); hover draws the same line at full ink, 1.5px (widgets.ts). Link card: ui/layout.ts layoutLinkTip, widgets.ts, reader.ts setTip (150 ms delay, mouse and keyboard focus), linktip.ts content; metadata from scripts/magazine/linkmeta.ts (build time, cache docs/upstream/linkmeta.json, baked into index.json articles[].links). UI font has one sans weight (500): the title is that weight, not 600.

## 2026-10-07 pass 5: code hover tips and one motion system

Code hover is ix's syntax tip (packages/web/src/lib/syntax-tips.ts, styles/base.css .syntax-tip), not a copy button (Andrew: "there should be no copy button, it's like a highlight thing where the text pops out"). `codetip.ts` finds the token under the pointer (run of one palette slot and one character class), the wash follows at once (ink 10%, 3px radius, 110 ms), the tip appears after 250 ms (once one is out, hops retarget at once), mono 12.5px, max 46ch, flips below, clamps 8px. Inline code spans get the wash only. Roles come from the glyph's palette slot, and the build maps each Shiki hex to the first slot with that hex (ix reuses six colours across twelve slots), so a slot names a colour family; `roleOf` splits blue / orange / code-ink by the token text. Exact words: `WORDS` (ix shell words, nix words).

Motion (ui/motion.ts, from ix site.css `--ease: cubic-bezier(0.2, 0.7, 0.2, 1)`, `--dur-fast: 150ms`, SearchPalette `pop` 0.2s): every chrome animation is a time-based tween with that ease.

| thing | in | out |
| --- | --- | --- |
| hover tint (buttons, hits), link underline, code buttons | 150 | 150 |
| Aa popover, citation popover, lightbox, find bar | 200 | 150 |
| link card (springs 0.96 to 1) | 200 | 150 |
| code token wash | 110 | 110 |
| code tip (0.98 to 1) | 90 | 90 |
| hover intent before showing | link 150, code 250 | |

## 2026-10-07 pass 6: copy acknowledgment and the code tip as ix's tooltip

Copy: Cmd/Ctrl+C on a selection plays ix's copy flash (packages/web/src/lib/site/copy-flash.ts), ported in `selshape.ts` (pure: `joinRows`, `rowRadii`, `pulse`, `shapeRows`; tests in `selshape.test.ts`). The resting drag selection and the flash are one shape: rows joined gap-free (a paragraph break stays a separate shape), corners facing a neighbouring row square, radius 4, colour rgb(10 132 255 / 0.30) (the OS selection blue, the one exception to the monochrome palette). On copy the shape and the copied glyphs grow 2.5% about the selection centre on the ix pulse curve over 300 ms and a white light sweeps left to right (opacity sin(pi * phase) * 0.12, rows entering 40 ms apart over 110 ms), then the resting shape remains (`keep`). ix's `keep` mode skips the row stagger of the shape itself (the selection is already on screen), so only the light is staggered. Reduced motion: no flash. The overlay shapes 9 (row with per-corner square mask) and 10 (its light) are in `page.wgsl.ts`; glyph items [v4.z, v4.w) scale about (v5.xy) by v5.z in `vs_text`/`fs_text` (`PageFrame.flash`), so the glyphs are scaled by the page pass itself, not redrawn. Known edge: a horizontally scrolled code block scales about the unscrolled centre (off by the scroll, at most 2.5% of it).

Tip: the code token tip is HoverWord's surface: ground 82% over white, 12 px radius, 1 px white hairline at 12%, 0 12 32 shadow, sans 14 / 1.4, padding 10 14, max 280, opacity and a 4 px slide over 150 ms. Header row: icon chip (token's own syntax colour at 22%, vector icon per kind from `ui/kindicon.ts`), the token in a mono chip, the kind label; body in sans. The link card uses the same surface (`raised`).
