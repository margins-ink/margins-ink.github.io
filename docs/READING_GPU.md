# READING_GPU: the reader is 100% our WebGPU renderer

Decision (Andrew, 2026-10-06): "the book shouldn't be HTML, it should be our own WebGPU rendered thing". This supersedes the
native-scroller / transparent-DOM-text-layer design of `READING.md` sections 4, 8, 9 and the DOM chrome of `READING_CONTRACT.md`.
Everything else in READING.md stays (RDR3 format, build-time Knuth-Plass layout, Flecs ReadingModule, page pass, figures, palette,
fold, 3 width classes, book hand-off, in-world mode). Reader-only and in-world reading share this one implementation.

## What the user sees and touches

One fixed full-viewport `<canvas>` (the page pass). No scrolling DOM, no DOM chrome, no DOM text layer as the interaction layer.
Everything visible is drawn by the GPU: article, scrollbar, top bar, `Aa` control, contents panel, citation popovers, image
lightbox, code copy buttons, figure controls, link hover and focus rings, toasts, selection plates, find bar.

The DOM contains exactly: the head tags and the `<canvas>`. No mirror, no SvelteKit article shell, no text node (the route announcer is removed on mount). Native Cmd+F does not see the page text: accepted, our find bar replaces it. Cost, Andrew's explicit decision (2026-10-06, "remove the HTML version of pages, just have the projection which is WebGPU"): screen readers, search engines indexing body text, Reader Mode and clients without WebGPU get nothing but the head tags and, where WebGPU is missing or fails to start, one line of text. Nothing is added back.

## Modules (every file is new or replaces the named one; all pure TypeScript except where marked)

| Lane | Files | Replaces |
|---|---|---|
| R scroll (Rust + ts) | `world/src/reading.rs` (scroll module inside ReadingModule), `world/src/lib.rs` exports, `src/lib/reading/abi.ts` wrappers, `src/lib/reading/input.ts` (DOM event to wasm forwarding, pure helpers tested) | `scrollstate.ts`, the native `.scroller` |
| U ui (GPU chrome) | `src/lib/reading/ui/{text,layout,widgets,scrollbar,hit}.ts`, page pass extension (`page.ts`, `page.wgsl.ts`, `page-api.ts`: `PageFrame.uiText`) | `components/reader/*.svelte`, chrome CSS |
| S select (engine) | `src/lib/reading/{select,find,hit}.ts` | `textlayer.ts` as interaction layer, DOM selection, native find |
| M mirror (a11y/SEO) | deleted 2026-10-06 (`mirror.ts` removed; `modeltext.ts` reads code text and image alt from the model) | n/a |
| C colour (build) | `src/lib/reading/theme.ts`, `scripts/magazine/palette.ts`, `scripts/reader/parse.ts`, code typesetting in `scripts/magazine/typeset.ts`, tests | scattered palette numbers, github-dark shiki theme |
| root | `Reader.svelte` (thin: canvas, frame loop, wiring), `World.svelte`, layouts, deleting old files, docs, e2e | |

Lanes write code and unit tests and may run `bun test <their own files>` only (no cargo except lane R's `cargo test -p world`, no vite,
no Chrome, no builds). Lanes commit nothing. The root integrates into `Reader.svelte`, builds the wasm once, runs e2e once.

## Scroll (lane R): owned by the engine

State in the ReadingModule (Rust, Flecs singleton `Scroll` + systems), frame-rate independent (all integration in seconds with
exact exponential or spring solutions, never per-frame constants):

* `scrollY` (CSS px), `maxY`, velocity, mode (idle, wheel, drag, fling, animate, rubber).
* Wheel: `deltaMode` 0 px, 1 lines (x 40 px... use 16 px x line height of body), 2 pages (x viewport height); ctrlKey events (pinch) ignored;
  trackpad wheel deltas are already momentum-shaped by macOS: apply directly (no extra smoothing); a discrete mouse wheel (deltaMode 1, or |dy| >= 100 and multiples
  of 100/120) gets a short critically damped glide (about 120 ms) so it does not jump.
* Touch/pointer drag (pointerType touch or pen): 1:1 follow, velocity from the last 100 ms of samples, on release fling with iOS-like
  deceleration (`v(t) = v0 * exp(-t / tau)`, tau chosen so the rate is 0.998 per ms, i.e. UIScrollView normal), stop below 5 px/s.
  Rubber-band beyond [0, maxY]: displacement = `(1 - 1/(x*0.55/d + 1)) * d` (iOS formula, d = viewport height), spring back with critically damped
  spring (about 0.35 s), fling into an edge transfers velocity into the band.
* Keyboard: Space / Shift+Space (viewport minus 40 px, animated), PageDown/PageUp, Home/End, ArrowDown/ArrowUp (60 px, short glide). J/K/E/T keep their meaning.
* Smooth scroll to anchors / section / block (`scrollTo(y, {smooth})`, ease-in-out about 450 ms scaled by distance, clamped 250..700 ms; instant when reduced motion).
* Scroll restore: per-slug `sessionStorage` (`reader:scroll:<slug>`), restored on load, saved throttled and on pagehide. A hidden spacer is NOT used.
* The document height is no longer a DOM spacer. `state[RD.scrollY]` is the single source; the frame loop reads it.
* Exports (abi.ts): `reading_wheel(dx, dy, deltaMode, ctrl)`, `reading_pointer(kind, id, x, y, tMs)` (kind: down, move, up, cancel; type in the id word),
  `reading_key(code, shift)` returning 1 if consumed, `reading_scroll_to(y, smooth)`, existing `reading_set_viewport`, `reading_tick(dtMs)`.
  `scrollbar` thumb drag is a pointer capture owned by lane U, which calls `reading_scroll_to(y, 0)` per move (mode drag-thumb, no fling).

## GPU scrollbar (lane U)

Drawn by the page pass as overlays. Thumb height = `viewH * viewH / docPx` (min 40 px). Track hit area 14 px at the right edge; visible width
6 px, grows to 12 px on hover or drag (spring, 120 ms); fades to 0.0 after 1.2 s idle and back on scroll or hover; thumb in ink at alpha 0.28
(hover 0.5, drag accent); track click scrolls one page toward the click (animated); thumb drag by pointer capture with proportional mapping; keyboard focusable
(no DOM scrollbar role, no mirror). Exactly one scrollbar. Section ticks are optional (small ticks on the track at section starts, visible only while hovered).

## GPU chrome (lane U)

Immediate-mode: `ui/widgets.ts` exports `buildChrome(state, input) -> { overlays, uiText, hits, cursor }` called every frame that is dirty. No retained DOM.

* Text: `ui/text.ts` shapes UI strings at runtime from per-font tables shipped in `fonts.bin` (advance, glyph id by codepoint; kerning pairs optional,
  none is acceptable for UI sizes) into `UiGlyph { x, y, glyphId, font, size, r, g, b, a }`; the page pass draws them in a second instanced draw after overlays
  using the same glyph atlas and MSDF-like coverage as the article text. Strings that are static per article (title, section names, reference titles) may be
  prepared at load; user-typed strings (find query) are shaped per keystroke. Missing glyphs fall back to the glyph table's notdef.
* Widgets: top bar (back/close, article title, current section, reading time, `Aa`, contents button), `Aa` text-size popover (steps), contents panel (wide: sticky left; mid and narrow: slide-over),
  citation popover (title, host, Open link; anchored under the cite), image lightbox (scrim, fit, caption, close, wheel/pinch zoom later), code copy buttons (hover on code block, copy flash), figure controls (play, step, scrub bar),
  link hover underline and focus ring, toasts ("Copied"), find bar (below).
* Hit testing: `ui/hit.ts` hit-tests chrome rects first (topmost first), then the article via `reading/hit.ts` (blocks, links, figures, code, images, cites, text glyphs); cursor style is set on the canvas only (`pointer`, `text`, `grab`, `ew-resize`, `default`).
* Dark only. All colours from `theme.ts` tokens through the RDR palette; no hex literals.

## Selection, links, copy, find (lane S): in-engine

* `hit.ts`: `hitTest(model, doc x/y in em) -> {kind, block, line, glyph, link, fig}`; binary search over blocks (sorted by y0) then lines then glyphs (glyph x, advance).
  Ideas come from the deleted `src/lib/magazine/{hit,select}.ts` (git history: `git show 4f8271c:src/lib/magazine/select.ts`); re-derive, tested.
* `select.ts`: anchor/focus as source-text offsets (`glyph.off` of the RDR glyph records maps back to exact source text); drag selects by glyph, double click word,
  triple click line/paragraph, shift+click extends, Cmd/Ctrl+A all; plates as overlays under the glyphs (selection colour from palette). `copyText(model, sel)` returns the exact article text
  (paragraph breaks, code newlines, list markers as authored). Cmd/Ctrl+C writes through `navigator.clipboard.writeText` (fallback `execCommand('copy')` with a temporary textarea).
  Links: click opens (internal `#ref-*`: scroll and popover; external: `window.open` noopener), keyboard Tab cycles links (drawn focus ring, scrolls into view), Enter activates.
* `find.ts`: Cmd/Ctrl+F opens OUR find bar (query, `n of m`, next Enter, previous Shift+Enter, Esc closes, case-insensitive, diacritics-insensitive) over the full article text including folded blocks;
  a hit in the fold calls `expandFold` first, then scrolls (centered) and draws all hits as accent plates (HDR accent where available), current hit stronger. Incremental per keystroke; pure `findAll(text, query)` returns offset ranges;
  `rangesToRects(model, ranges)` returns doc-space rects per line.

## No mirror (2026-10-06)

The hidden semantic mirror (`mirror.ts`, `#reader-mirror`) and the prerendered article are deleted. Cost, Andrew's explicit decision (2026-10-06, "remove the HTML version of pages, just have the projection which is WebGPU"): screen readers, search engines indexing body text, Reader Mode and clients without WebGPU get nothing but the head tags and, where WebGPU is missing or fails to start, one line of text. Nothing is added back. Tab, Enter and the link focus ring live inside the canvas (reader `onKey`); the e2e check (checks.ts section 4) asserts the body has no text node and no content element, with a planted `<p>` control that must fail it.

## Colour and typography (lane C): independent of the above

OKLCH token table in one place (`src/lib/reading/theme.ts`): ground (deep tinted near-black, not #000), three elevations (code panel, figure card, popover), text ramp (primary about L0.93, secondary, tertiary all >= 4.5:1 on their ground,
large text 3:1), one accent and one ground for every article (no per-article hue or tint), a dark-designed syntax palette (distinct hue families for keyword, function, type, string, number, constant, comment (about 4.5:1), operator, punctuation, attribute/macro, lifetime, property).
A custom Shiki (TextMate grammars, build time) theme generated from the tokens replaces `github-dark`. Contrast test computes every token on its real ground and fails below threshold, with a planted-bug control (old palette). Code blocks: elevated panel, 1px hairline,
rounded corners, language label, copy affordance (drawn by lane U), line height 1.6; ligatures `::` stays two separate colons (splice shaping at `::`), other font ligatures (`->`, `=>`, `!=`, `<=`) as the font draws them.
Headings Inter, tracking 0 to -0.01em, no condensed wdth axis for H2/H3.

## Verification (root)

Screenshots at 1440, 820, 390 dark; scroll feel (wheel trace through Rust equals reference integrator within 1 px; fling distance within 5 percent of the iOS formula; rubber-band bounds); scrollbar drag proportional; selection/copy returns exact text for planted ranges;
hit-test accuracy (clicks at glyph centres hit that glyph, 100 percent over a sampled set; planted off-by-one control fails); find counts equal a naive scan of the model text; no DOM text at all (planted `<p>` control); no `.ln`/`.doc` DOM left; frame time and GPU memory with load reported.
