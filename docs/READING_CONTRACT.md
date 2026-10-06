# READING contract: lanes, files, frame protocol

Companion of `docs/READING.md` (design) for the implementation. The code is the contract: `src/lib/magazine/format.ts` (RDR3 bytes),
`src/lib/reading/abi.ts` (wasm load buffer, state indices, events, inputs, exports), `src/lib/reading/page-api.ts` (page pass).
Where this implementation differs from READING.md, section "Deviations" below says so.

## Architecture in one paragraph

The build (`scripts/magazine/flow.ts`) lays each article out once per width class (wide >= 1180 px, mid 720..1179, narrow < 720) in
em units into one RDR3 file per class. At runtime nothing is laid out: a resize switches class and scales. The reader (`Reader.svelte`)
owns a native scroller whose children are a transparent DOM text layer generated from the RDR3 lines, links and text; a `position: fixed`
canvas behind it is drawn by the page pass at the scroller's `scrollTop`. The Flecs `ReadingModule` (wasm) owns reading state:
blocks, scroll, viewport, typography, the fold spring, culling, the current section, figure clocks and the exclusive relations.
JS owns DOM, GPU resources and strings.

## Frame protocol (Reader.svelte, one rAF)

1. `y = scroller.scrollTop`; `wasm.reading_set_scroll(y)`; viewport or typography changes call `reading_set_viewport` first.
2. `wasm.reading_tick(dtMs)`; read `state = new Float32Array(memory.buffer, reading_state_ptr(), 64)` (RD indices in abi.ts); drain events.
3. For each live figure (RD.figBase + 2i visible), evaluate its channels at its clock into the 256 float table (`src/lib/magazine/chan.ts`).
4. If `state[RD.dirty] != 0` or an overlay animates: build a `PageFrame`, `page.draw(frame)`, `reading_ack_dirty()`. Otherwise do not draw (idle = zero GPU frames).
5. Scroller content height = `state[RD.docHeightEm] * emPx` (+ viewport slack set by the reader). The fold changes it through the spring.

Document px mapping: `px_x = originX + x * emPx`, `px_y = originY + y * emPx - scrollPx`, `originX = (viewW - (docX1 - docX0) * emPx) / 2 - docX0 * emPx`.
`emPx`: wide and mid `clamp(17, 15.6 + 0.0036 * viewW, 21) * scale`, then at most `(viewW - 2 * gutter) / (docX1 - docX0)`; narrow `(viewW - 40) / colW`, scale capped at 1.

## DOM text layer (the accessible DOM; the canvas is aria-hidden)

```
div.reader[data-class][data-mode=only|world]  style: --em (px)
  canvas.page (aria-hidden)               position fixed, inset 0, z-index 0   (created by the page pass)
  header.bar / nav.toc / ...              chrome (Reader chrome lane), z-index 3
  div.scroller[tabindex=0]                position fixed, inset 0, overflow-y auto, z-index 2, overscroll-behavior contain
    div.doc                               position relative; left = originX + docX0 * em; width = (docX1 - docX0) * em; height = docHeight
      <h1|h2|h3|p|pre|figure|ul|blockquote|aside|nav ...>.b[data-block=i][data-kind]   absolutely positioned at the block box
        span.ln[data-line=i]              one per RDR3 line, absolutely positioned at (x0, yTop) of the line, white-space: pre,
                                          color: transparent, font-size = line.size * em, line-height = (yBot - yTop) em;
                                          links are <a href> wrapping the text range [t0, t1) inside the span
      div.fold-region[hidden=until-found]  holds every block with BlockFlag.folded while the fold is collapsed
```
Block element by kind: hero h1 (+ dek p), heading `h<level>` (level from the record, h2 default), para `p`, code `pre` (role region, tabindex 0, aria-label "<lang> code",
a copy `button`), quote `blockquote`, list `ul`/`ol` of `li` (one li per first line marker; the build writes the marker as text), figure `figure[role=group][tabindex=0]
[aria-roledescription=interactive figure]` with `aria-label = describe` and a `figcaption` from the caption block, image `figure` with a `button` (alt), rule `hr`,
fold `button[aria-expanded][aria-controls]`, refs `ol` of `li`, notes `aside`. `::selection` is the accent at 30%. Hidden prerendered fallback article: see deviations.

## Files and owners

| Lane | Files |
|---|---|
| flow (root) | `scripts/magazine/{flow,measure,sidenotes,emit,build,...}.ts`, `src/lib/magazine/format.ts`, `static/magazine/**` |
| world (Rust) | `world/src/{reading,reader,book,lib,components,magazine(deleted)}.rs`, `src/lib/ecs/reading.ts` (replaces `ecs/magazine.ts`), `src/lib/gpu/room/world.ts` types |
| page (GPU) | `src/lib/reading/{page.ts,page.wgsl.ts}` (new files only; the old `magazine.*` files are trimmed by the root) |
| reader (DOM core) | `src/lib/reading/{load.ts,metrics.ts,textlayer.ts,scrollstate.ts}`, `src/lib/components/Reader.svelte` |
| chrome (DOM) | `src/lib/components/reader/{Bar,Toc,AaMenu,Toast,Popover,Lightbox,CopyButton,FigureControls}.svelte`, `src/lib/reading.css` |
| root | `World.svelte`, `(site)/+layout.svelte`, `thoughts/+layout.svelte`, `room.ts`, `shader.ts`, book handoff, tests, docs |

Lanes write code and commit nothing, run nothing (no builds, no dev server, no Chrome). The root builds and verifies.

## Deviations from docs/READING.md (kept current by the root)

1. Layout is precomputed at build time in three width classes instead of a runtime wasm relayout (em-relative layout makes resize a scale).
2. The page pass runs on its own canvas and device above the world canvas, so `room.ts` render loop is untouched.
3. Text-bearing UI chrome (bar, section name, `Aa`, TOC, popovers, toast, captions in lightbox) is DOM; only rails, rings, flashes are GPU overlays.
4. The prerendered mdsvex article stays in the HTML for no-JS and SEO as a hidden `display: none` fallback once JS runs; it is not exposed to assistive tech (no duplicate).
