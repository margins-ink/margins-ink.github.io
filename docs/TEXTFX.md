# TEXTFX: what only a GPU text renderer can do for this reader

Status: design, 2026-10-06. No code written or run. Builds on `docs/READING.md` (page pass, native scroller, transparent DOM text layer, Flecs `ReadingModule`) and the evaluator in `src/lib/reading/page.wgsl.ts` (Slug coverage, `FrameU`, per-block `SegU`, channel table, overlay pass). Andrew's brief: "ideally do cool things with text (maybe shader, idk) that is going to do cool things we can't do in normal HTML as well". Facts marked "est." are estimates to measure; "reported" means from memory or a secondary source, not read this session.

Two things in the brief differ from the tree. The code face in `docs/READING.md` and `docs/upstream/reader/fonts` is Fira Code, not Berkeley Mono; no Berkeley Mono file or licence text is in the repo (its licence must be read before its outlines are compiled into curve tables: unverified). Every effect below works per glyph cluster, so a ligature is one instance and the face does not matter. Second, glyph outlines today are baked per build-time instance (`glyph.glyphId` indexes one curve table entry), so runtime variable-axis animation is not free: section 2.4 says what it costs.

## 0. Verdict

Eight effects, ranked by value over effort. Top 3 are the first three rows.

| # | Effect | What it is, in one line | Value | Effort (est.) | Tier |
|---|---|---|---|---|---|
| 1 | Reading ruler | the block under the reading line is full ink, neighbours ease down, a thin accent tick marks it | 5 | 1 day | Subtle |
| 2 | Cross-highlight | a term in prose, its code token and its figure element light together | 5 | 3 days | Subtle |
| 3 | Layout morph (FLIP per glyph) | Aa steps, fold expand and width changes slide glyphs to their new places | 4 | 4 days | Subtle |
| 4 | Lit ink UI | selection edge glow, trim-animated link underlines, copy flash | 4 | 3 days | Subtle |
| 5 | Room light on display type | lamps and neon tint headings and rim-light their edges when read in-world | 4 | 2 days | Subtle |
| 6 | Entrance wipe and one-shot glint | h1/h2/pull-quote lines wipe in; an `em` word glints once | 3 | 2 days | Subtle (wipe), Full (glint) |
| 7 | Pointer lens | weight swell and soft glow around the pointer | 3 | 3 days | Full |
| 8 | Depth title | the hero title has a few layers of SDF extrusion with parallax | 2 | 2 days | Full |

My top 3 and why: (1) the ruler solves a real reading problem for almost no cost; (2) cross-highlight is the one effect that carries information a normal page cannot (three representations of one thing, tied together); (3) the morph removes the one jarring moment of this design (relayout pop on Aa, fold and resize). Number 5 is the signature, the one a reader will tell people about, but it only exists in-world.

Honest note: the ruler and a plain underline can be done in CSS. They are in because they are the cheapest way to get value and because they compose with the HDR and room-light passes without a DOM repaint. The GPU-only ones are 2, 3 (per-glyph, no layout thrash), 4, 5, 7, 8.

### 0.1 Evaluated and cut

| Candidate | Decision | Reason |
|---|---|---|
| Scroll-velocity weight or width easing | cut | Every visible glyph needs two coverage evaluations exactly when the GPU is busiest (scrolling); it communicates speed, which the reader already feels; at 20 px a 5% weight change is under the threshold of noticing. The pointer lens (7) is the same mechanism with a bounded glyph count. |
| Per-letter staggered reveal | cut | `READING.md` 2.5: body text never fades, slides or staggers. Only headings and pull quotes wipe, per line. |
| Search hits that glow | cut | The browser gives no event or API for native find matches (only `beforematch`, on `hidden="until-found"` content). We keep native Cmd+F; a custom find bar is already cut. |
| Numerals that tick | already built | The `numeral` item type with a channel is in `format.ts`; it ships with the distilled numerals row. Not ranked. |
| Inline sparklines and glyph-sized figures | v2 | Shader side is the existing shape items; the cost is an inline-box in layout (a reserved width and a baseline). Queue after this wave. |
| Text flowing around figure shapes | cut | A layout feature (CSS `shape-outside` exists), not a GPU strength; `READING.md` 4 removed per-line exclusion intervals on purpose. |
| Optical kerning animation | cut | Moves hit boxes by more than a sub-pixel. |
| Shimmer on emphasis words | folded into 6 | One sweep, once; a loop is noise and fights the 2-effect budget. |
| Drop caps | out | `READING.md` 2.1 dropped them. The depth treatment lives on the hero title instead. |

## 1. Rules that bind every effect

1. **Legibility floor.** No frame of any effect may put body ink below 4.5:1 against `--bg` (build palette script is the authority; est. ink 15:1). Dimming effects keep 7:1 at Subtle (est.), 4.5:1 at Full. Contrast is sampled on every frame of the acceptance sequences, not on the settled frame.
2. **Alignment.** Two classes only.
   - Class A (alpha, colour, mask, additive light): zero geometry change. Ruler, cross-highlight, wipe, glint, lamp tint, selection edge, copy flash.
   - Class B (geometry): bounded to 0.025 em about the glyph's own pen point (0.45 px at 18 px, under the 1.5 px alignment tolerance of READING test 3). Pointer lens only. Depth moves only back layers, never the front face. The one exception is the morph, which is transient, gated (section 2.3), and ends in a state that passes test 3.
3. **Body and code are never "owned".** Body paragraphs and code blocks are drawn by the unchanged core text path. Effects on them are overlays drawn on top (section 3). A bug in an effect cannot make body text disappear.
4. **Budget.** At most 2 noticeable effects at once. Ambient effects (ruler, lamp tint, link underline, selection edge) are not counted. The arbiter in section 4 grants slots by priority; a refused effect either waits up to 600 ms or is skipped and its final state is shown.
5. **No loops.** Nothing repeats except a live figure the reader started. No effect runs while a selection drag is in progress (the lens and the ruler freeze; borrowed from the ix rule in `READING.md` 14, item 5: do not repaint in a way that fights a selection).
6. **Failure-safe.** The native look is always complete without the effect: `::selection` keeps its accent 14% background, underlines have a DOM `text-decoration` fallback, text is ink before any effect touches it. If the fx pass fails to compile or the governor turns it off, nothing is missing.
7. **One setting, one switch.** Off, Subtle (default), Full. `prefers-reduced-motion: reduce` caps it (section 5). The setting lives in the `Aa` popover, persisted next to `scale`.

## 2. The effects

### 2.1 Reading ruler (rank 1)

Looks: a ruler sits at 38% of the viewport height. The block under it (a paragraph, list, heading) is full ink. Other text blocks ease to alpha 0.78 (Subtle) or 0.58 (Full), by distance in blocks (neighbours first, then a floor). A 2 px accent tick, the height of the focused block, sits in the left margin; its head is HDR 1.3 on an extended canvas. Code blocks, figures and the hero are exempt and never dim.

Communicates: where you are. After a glance away, the eye returns to the one bright block. It also quietly says which block the sticky bar and `J`/`K` will treat as current.

Technique: no shader work. `SegU.alpha` is already a per-block opacity in the page pass; a Flecs spring per block writes it. The tick is one overlay-pass rounded rect. The ruler is paragraph-granular on purpose: per-line falloff inside a paragraph looks like a flashlight and tires the eye.

Cost: about 0 (an existing uniform, 2 to 4 blocks changing per frame, all others `Settled`). Overlay: 1 instance.

Drive: `Effects.level`, exclusive relation `(ReadingBlock, block)` set by the existing `ReadingSpy` system (extended from heading to block, hysteresis of 0.6 line so it does not flicker at a boundary), `Dim {a, target}` on blocks, spring omega 12, zeta 1.

Degrade: reduced motion uses a 160 ms linear crossfade, no spring, no tick pulse. `prefers-contrast: more`: ruler off (all full). Low power: unchanged (free). No HDR: the tick is plain accent. Frozen while a selection exists or the pointer is down, and off while find has just scrolled (a `beforematch` event suspends it for 2 s).

Alignment and readability: no geometry. The floor in rule 1 is the whole risk; the contrast sampler covers it.

### 2.2 Cross-highlight (rank 2)

Looks: hover or focus a code token, a defined term or a figure label, and every occurrence of the same thing lifts together: prose words, the code token, the figure element. They go to `--accent` with a soft under-glow (HDR 1.3 on the glow only), over 220 ms; nothing else dims. Driven the other way too: when a figure's playhead reaches a beat ("stops", "waits", "resumes" in Fig. 1), the matching prose or caption words pulse once. In the ifd post this ties `stops/resumes` in Fig. 1, `thunk` in Fig. 2 and the `nix` code block to the sentences that name them.

Communicates: the relationship between three representations of one object, which a page of plain HTML cannot show without three separate scripts. It is the "figure and prose are one thing" promise of `MAGAZINE.md` made visible.

Technique:
- Build time: authors mark references in the post (`content` lane: a small annotation in the figure spec and in the `.svx` code fence or prose, resolved to `xid` 1..63). The layout emits an `Xref` table in the blob: `{xid, kind (prose|code|figure), firstItem, itemCount}`.
- Glyph record: `glyph.flags` bit 1 = xref candidate, `glyph.pad` (u16, unused today) = `xid`. Shapes in figures carry the `xid` in `shape.pad`.
- Runtime: the fx overlay draw (section 3) re-draws only glyphs whose `xid` has intensity above zero (a CPU-built instance list, tens of items). Fragment: `cov` from the same `slug_cov`, colour `mix(base, accent, k)`, plus a halo from a second `slug_cov` call with size scaled 1.12 about the glyph centre, weighted `0.35 * k`, HDR only on the halo. Figure shapes use the same intensity through their existing channel (`mg_cv`).
- Intensities live in the channel table: reserve channels 192..255 (`CHAN_FLOATS` is 256; the `contract` lane confirms no figure uses them or raises the constant).

Cost: a flagged glyph is 2 coverage evaluations, over at most 60 glyphs on screen (est.): under 0.05 ms desktop, under 0.2 ms phone (est.). Zero when no xref is active (no draw issued).

Drive: `XrefGroup {id, intensity, target}` entities (tens per article), relations `(Refers, group)` from `Token` entities (`{firstItem, count}`) and from figure beat entities; observer on `Hover`/`Focus` sets `target`; `FigureAdvance` sets it at beats; spring omega 16.

Degrade: reduced motion shows a static tint (no pulse, no glow animation, instant on/off, still accent). Low power: unchanged. No HDR: the halo clamps to 1.0 and gains chroma instead. Off: nothing.

Alignment: class A. Highlight is drawn at the same glyph rect; the halo is an overlay, never moves a box.

Readability: the highlighted word is accent on bg (at least 4.5:1 by the palette script); the halo is below 35% so it cannot wash neighbouring letters (checked by the contrast sampler on neighbours of a lit glyph).

### 2.3 Layout morph, FLIP per glyph (rank 3)

Looks: tap `Aa`, expand the fold, or cross a width class, and glyphs slide and scale from their old positions to the new layout in 280 ms (spring, omega 14, zeta 1) instead of popping. Lines that keep their words move as a unit; a word that re-wraps travels a short arc to its new line; new words (the folded text) fade in 120 ms; the block under the reading line is pinned (scroll anchoring keeps it still). A live window drag does not morph (it relays instantly) and morphs once at the end of the drag.

Communicates: continuity and cause. The reader never loses their place when text size changes, and sees the fold open rather than a jump.

Technique:
- `page.ts` keeps the previous layout's `(x, y, size)` per item in a side storage buffer `prev: array<vec4f>` indexed by item. Matching is by `(block anchorId, charOffset)` which `glyph.charOffset` already holds; unmatched items get `prev.w = 0` (fade in). The matching is a CPU merge over two sorted lists at relayout time (est. under 1 ms for 10,000 glyphs).
- The morph reads from the same text pass: `vs_text` replaces `gx, gy, size` by `mix(prev, cur, ease(t))`. `slug_cov` already takes the glyph's own size and origin, so interpolated size needs no new fragment code. A new uniform `morph.t` (frame uniform v6.z) selects the path; at `t = 1` the shader branch is not taken. The quad is the interpolated glyph rect.
- Morph is a mode of the core pass (a flat uniform branch in the vertex shader, one extra 16-byte fetch per vertex), not an overlay, because every glyph on screen moves.
- DOM sync: the text layer relayouts to the final geometry at once, because selection and find must be correct the moment layout changes. During the 280 ms, line `<span>`s get a WAAPI `transform` animation with an easing generated from the same spring (`linear()` easing list), so line-level motion matches the GPU within a frame. Re-wrapped words are GPU-only, so `pointer-events: none` is set on the text layer for the duration and cleared on `EV_MORPH_SETTLED`. Selection in progress is never interrupted (it is native on the DOM); only new pointer starts are gated for under 300 ms.

Cost: the pass cost is unchanged (vertex fetch only), for 280 ms. Layout and matching are paid once per change (est. under 2 ms).

Drive: singleton `Morph {t, vel, active}`; `Typography`, `Fold.target` and `Viewport.class` observers arm it and snapshot the previous layout; `MorphSpring` (Spring phase); `Effects` priority 0 (it owns the screen, so nothing else noticeable starts while it runs).

Degrade: reduced motion, Off and low power: instant (`t = 1` at once, no side buffer written). Large articles (over 15,000 glyphs): morph only the visible range plus one screen.

Alignment: transient, gated, and ends exactly on the layout. Test 3 of `READING.md` section 10 is re-run at `EV_MORPH_SETTLED` and at a mid-morph frame where every glyph must lie on the segment between its old and new positions.

### 2.4 Lit ink UI: selection edge, link underline, copy flash (rank 4)

Looks:
- Selection: the native accent 14% background stays. The GPU adds one continuous rounded outline (1.5 px, accent, HDR 1.4 on an extended canvas) and a soft inner glow around the merged `Range` rectangles, so a selection reads as a lit highlighter, not a flat box.
- Link underline: a 1 px accent stroke at the underline position. On hover it draws left to right with a trim channel over 160 ms, with a small settling wave (amplitude 0.06 em, damping to flat in 300 ms), then thickens to 2 px. Focus keeps the ring of `READING.md` 2.4.
- Copy flash: as `READING.md` 5 (pulse 300 ms, hold 700 ms, fade 400 ms), now in the same HDR pass.

Communicates: link affordance and extent, selection extent and "copied" acknowledgment. The wave on hover is the only decorative part; it exists to show the link's exact span.

Technique: all three are overlay pass instances (`vs_ovl` rounded rects) and existing stroke items (`stroke.trimT1Chan`, `widthChan`, `phaseChan`). Selection rectangles come from `getClientRects` on `selectionchange`, merged gap-free (the ix copy-flash idea, `READING.md` 14); the old `SEL_BASE` table in `magazine.wgsl.ts` is the precedent. CSS `text-decoration-skip-ink` already handles descenders in the DOM fallback; the GPU underline breaks its stroke at descender spans computed at build time from glyph bounds.

Cost: at most a few dozen overlay instances; under 0.05 ms (est.).

Drive: `Hover`/`Focus` relations (existing), `Selection` handled in the `dom` lane, `Events` for copy; channels per underline.

Degrade: reduced motion: no wave, underline appears instantly, selection edge static, copy flash hold and fade only. No HDR: edge plain accent. Off: DOM look only.

Alignment: overlays only; the `<a>` and the selection are native DOM boxes.

### 2.5 Room light on display type (rank 5)

Looks: only in the world. The room's lamps and neon throw coloured light across the title, h2s and pull quotes: a soft gradient of the lamp colour over the ink, and a rim highlight along the lamp-facing edge of large letters, up to HDR 1.5. Walking the camera (or the lamp flicker, frozen while reading per `READING.md` 8) changes nothing in layout; a lamp turned on beside the book visibly tints the heading. Body ink gets no tint.

Communicates: the page is an object in the room, not a UI sticker over it. That is the main reason to read the same article in-world.

Technique: display blocks (title, h2, pull quote, section numerals) are **fx-owned** (section 3): drawn by the fx pass, not the core pass. Fragment: `cov` from `slug_cov`; coverage gradient `g = vec2(dpdx(cov), dpdy(cov))` is a free pseudo-normal of the letter edge (large type has many pixels of edge); `rim = saturate(dot(normalize(g), toLamp)) * edge(cov)`; tint `= lampColour * intensity * falloff(distance, em)`; result `ink + tint * 0.12 + rim * lampColour * 0.5`, with the final luminance clamped so `ink` contrast stays at least 7:1 (the tint is added to a colour that has more than 2x contrast margin on display sizes). At most 2 lamps (nearest by Flecs query), as page-space positions.
- Reader-only mode has no lamps: the ground's ambient accent radial (existing, `fs_ground`) acts as the single light.

Cost: about 60 glyphs on screen, about 30 extra ALU each: negligible (est. under 0.05 ms).

Drive: `FxLight` singleton (two lamp positions projected to page em, colour times intensity), refreshed by `PackPage` from the world's `Lamp` entities when the reading pose is orthographic (the pose is screen aligned, so the projection is a 2D transform). Components: `LampLit {gain}` tag on display blocks.

Degrade: reduced motion: no change (the light is static while reading). Low power: tint only, no rim. No HDR: rim clamps at 1.0 with a chroma boost. Off: none.

Alignment: class A.

### 2.6 Entrance wipe and one-shot glint (rank 6)

Looks: when an h2 or pull quote first enters view (once per visit, not on scroll restore, not when the scroll speed is above 1.5 viewports per second), its lines are revealed by a left-to-right mask, 420 ms, with a feathered edge (1.5 em) whose leading edge runs hot (accent, HDR 1.4); the 2.4 em accent rule of the section entry grows with it. The hero title does the same on cold load (the 480 ms hero entrance of `READING.md` 2.5). Body text never wipes. Glint (Full only): an `em` or strong word the author marked sweeps one diagonal accent band, 500 ms, once, when it enters the reading band and no other noticeable effect runs.

Communicates: arrival at a section boundary (it pairs with the section entry of `READING.md` 3.1) and, for the glint, the one word the author wants noticed.

Technique: display blocks are fx-owned, so a per-block `reveal` value (SegU.pad1) feeds a mask `smoothstep(x - feather, x, reveal * lineWidth)` in the fx fragment. Glint words are overlay instances (like cross-highlight) with a sweep coordinate `s = dot(p, dir) - t * speed`.

Cost: a few dozen glyphs, under 0.03 ms (est.).

Drive: `Reveal {t, done}` on fx-owned blocks; observer `OnAdd Visible` arms it unless `Scroll.vel` is high or the scroll was restored; `Glint {t}` on marked words, armed by the arbiter.

Degrade: reduced motion: no wipe, no glint (text is simply there). Low power: unchanged. No HDR: edge clamps to 1.0. Off: none.

Alignment: a mask, no geometry. The DOM text is present and selectable the whole time (a wiped-out line is still there for find and copy; the mask is visual only).

### 2.7 Pointer lens (rank 7, Full only)

Looks: within about 5 em of the pointer, letters swell very slightly in weight (stem growth up to 0.025 em) and a soft warm glow (HDR 1.15) sits behind the text under the pointer. Text under a link brightens more. It is the "lens" feeling: the page notices you.

Communicates: little beyond delight and a weak "this is interactive" cue for links. That is why it is Full only and ranked 7.

Technique: build time compiles a second instance of the body face with the same topology at `wght + 60` (Inter's wght axis; `fontTools.varLib.instancer`, reported, https://fonttools.readthedocs.io/en/latest/varLib/instancer.html) and stores it as a second glyph table, built only when `Effects.level == Full` is first reached (lazy load, est. +150 KB brotli for 1,400 words). The overlay draw re-draws only glyphs within the radius (a per-line binary search on the `Block.lines` table, at most about 80 glyphs, flagged `fx_lens`): coverage is `mix(slug_cov(base), slug_cov(bold), k)`, where `k` falls off with distance. Cross-fading two coverages of outlines that differ by under 0.03 em is visually the same as interpolating control points, and it avoids rebuilding the Slug band data (which are not valid for interpolated curves; the sorted-by-max-x early-out would break). To verify: a side-by-side of cross-fade against true interpolation at 18 px and 36 px. The proper design if the cross-fade shows a visible difference is a build-time interpolatable master pair with a union band table and the early-out disabled for flagged glyphs; cost 2 curve fetches per curve, about 1.5x on flagged glyphs only. The glow is one overlay instance in the ground pass.

Cost: at most 80 glyphs times 2 coverage evaluations, under 0.1 ms desktop, 0.3 ms phone (est.). Pointer devices only (no touch).

Drive: `Pointer {x, y, active}` singleton, `Lens {radius, amount}`; frozen while a pointer button is down (selection) and over code.

Degrade: reduced motion: off. Low power and Subtle and Off: off. No HDR: glow at 1.0.

Alignment: class B, bounded to 0.025 em about each glyph's pen point, no advance change, so hit boxes are exact.

### 2.8 Depth title (rank 8, Full only)

Looks: the hero title (only) has 4 layers of soft extrusion behind the face, darker steps of the ground colour, drifting with the pointer (desktop) and with scroll (0.04 em per viewport) so the title sits slightly off the page. Device tilt is not used (iOS needs a permission prompt for orientation, reported).

Communicates: the title is the one loud thing (`READING.md` 2.1). Nothing else.

Technique: the title block is fx-owned. The fx fragment evaluates `slug_cov` at 4 offsets along the parallax vector, composites back to front, then draws the face at its true position on top. About 30 glyphs.

Cost: 5 coverage evaluations over about 30 glyphs: under 0.05 ms (est.).

Drive: `Depth {px, py}` from `Pointer` and `Scroll.y`; `LampLit` direction can aim the extrusion shading when in-world.

Degrade: reduced motion: static extrusion at zero offset, or off (I pick off: a static 3D title is decoration). Low power, Subtle, Off: off. Alignment: the front face never moves; back layers extend at most 0.08 em.

## 3. Rendering structure (keeps core text fast)

The core text path (`vs_text` and `fs_text`, per-block runs with `SegU`) is not branched for effects, except the morph's single flat uniform branch in the vertex shader. Everything else lives in a separate include and a separate draw.

```
src/lib/reading/page.wgsl.ts        core, unchanged (PAGE_EVAL_WGSL)
src/lib/reading/page.fx.wgsl.ts     PAGE_FX_WGSL, appended after PAGE_EVAL_WGSL, imports its helpers
src/lib/reading/fx/*.ts             CPU: arbiter, instance-list builder, selection rects, lens binning, spring easing
```

Two kinds of fx draw, both after the core text and before the overlay pass, both instanced from a storage list `fx_inst: array<vec4u>` (item index, effect mask, param, block):

- **fx-owned blocks**: title, h2, section numerals and pull quotes. The core pass does not issue their runs (the CPU skips the run, they are separate blocks with their own `SegU`). `vs_fx`/`fs_fx` draw them with wipe, lamp tint and rim, depth layers. Flag: next free `Block.flags` bit, `fxOwned`. A few dozen glyphs.
- **overlay draws on core text**: cross-highlight, glint, lens. The core pass draws the glyph as plain ink; the fx draw re-draws only the active glyphs (tens to about 80) with the effect on top. Edge fringe: premultiplied over of the same coverage leaves a faint base-colour bleed at glyph edges (about `a * (1 - a)` of base); with accent over ink this is imperceptible, and the screenshot lane checks it.

Per-glyph attributes (all exist as spare fields in the glyph record, so `RDR3` grows by nothing):

| Field | Use |
|---|---|
| `glyph.flags` u8 | bit 0 lens-eligible (body face), bit 1 xref candidate, bit 2 glint word, bit 3 depth |
| `glyph.pad` u16 | `xid` (0 none, 1..63) |
| `glyph.charOffset` u32 | morph matching key with the block anchor; link to DOM text offsets |
| `glyph.colour` u8 | palette index; the fx pass mixes toward accent through the palette, never a literal |

Per-block (`SegU` pads, no growth of the 32 bytes): `pad0` = block fx flags (`fxOwned`, `noDim`), `pad1` = reveal `t`. `alpha` stays the ruler's dim.

Frame uniform grows from 6 to 12 vec4f: `v6` = (effective level 0..2, HDR gain, time seconds, morph.t), `v7` = (pointer css x, y, lens radius px, lens amount), `v8..v9` lamp 0 (page em position and height; colour times intensity), `v10..v11` lamp 1. `packFrame` in `page.ts` writes them; the root applies the hook edits to `page.ts` and `room.ts` (shared files, `READING.md` risk 5).

HDR rule: only accent-derived values exceed 1.0, capped at `min(headroom, 1.6)` as `READING.md` 2.4 says; body ink stays 1.0 at most. The `fx_hdr(c)` helper clamps to 1.0 and moves the excess into chroma when `v6.y == 1.0` (no headroom).

## 4. Flecs model

Module `FxModule`, inside `ReadingModule`.

Singletons:
- `Effects {level: u8 (setting 0 Off, 1 Subtle, 2 Full), eff: u8 (after reduced-motion cap and governor), hdr: f32 (headroom), noticeable: u8, budget_ms: f32, gpu_ms_p95: f32}`
- `Pointer {x, y, active, down}`, `Morph {t, vel, active}`, `FxLight {l0, c0, l1, c1}`

Per entity:
- Blocks: `Dim {a, target}` (ruler), `FxOwned` tag, `Reveal {t, done}`, `LampLit {gain}`
- Xref: `XrefGroup {id, intensity, target}`; `Token {firstItem, count}` entities with `(Refers, group)`; figure beat entities with `(Refers, group)`
- `Glint {t}` on marked words

Relations: exclusive `(ReadingBlock, block)`; `(Refers, group)`; tag `Deferred` on an effect that the arbiter refused.

Systems (phases of `READING.md` 6): `EffectsGovernor` (Input), `ReadingSpy` extended to blocks and `RulerFocus` (Cull), `XrefSpring`, `MorphSpring`, `RevealTrigger` (Cull, on `Visible`), `LensBin`, `FxPack` (Pack: builds the fx instance list, writes the uniforms, writes xref channels, runs the arbiter).

**Arbiter** (inside `FxPack`): effect requests carry a priority: morph 0, cross-highlight 1, copy flash 2, wipe 3, lens 4, glint 5, depth 6. Grant the first two noticeable requests in priority order; a granted morph blocks every other noticeable one for its duration. Refused: wipe waits up to 600 ms (it then shows its final state); glint and depth skip; lens drops and returns when a slot frees. Ambient effects are not arbitrated.

**Governor**: measures GPU time with timestamp queries when the device has them (else frame interval p95). If p95 of the fx share exceeds budget for 2 s, `Effects.eff` drops one level (Full to Subtle to Off) and does not rise again in the session; it logs the reason. This also covers low-power devices: iOS low-power mode is not detectable from the page (unverified), so the governor is the mechanism, not a power API.

## 5. Settings and degradation

| Setting | Effects on |
|---|---|
| Off | none (not even the ruler); native selection and underline only |
| Subtle (default) | ruler (0.78), cross-highlight, morph, lit ink UI, room light, wipe on h1, h2 and pull quotes |
| Full | Subtle plus ruler 0.58, lens, glint, depth title, stronger HDR peaks (up to 1.6) |

| Condition | Result |
|---|---|
| `prefers-reduced-motion: reduce` | level capped at Subtle; ruler crossfades 160 ms, xref is a static tint, morph instant, wipe off, lens, glint, depth off, room light static |
| `prefers-contrast: more` | ruler off, glow and halos off, underlines solid, edges only |
| Governor drop or `Save-Data` | one level lower for the session |
| No HDR headroom | all peaks clamp to 1.0; accent gains chroma instead |
| Touch device | no lens; hover-driven xref becomes tap or focus driven |
| fx pass fails to compile | fx disabled, `Effects.eff = 0`, native look is complete (rule 6) |

## 6. Cost summary (est., to measure)

| Effect | GPU per frame, desktop | GPU per frame, phone (390 x 844, DPR 3) |
|---|---|---|
| Ruler | about 0 | about 0 |
| Cross-highlight | under 0.05 ms | under 0.2 ms |
| Morph | pass unchanged, +16 B per vertex fetch for 280 ms | same |
| Lit ink UI | under 0.05 ms | under 0.1 ms |
| Room light | under 0.05 ms | under 0.1 ms |
| Wipe and glint | under 0.03 ms | under 0.1 ms |
| Lens | under 0.1 ms | off (touch) |
| Depth | under 0.05 ms | off |
| Total with 2 noticeable plus ambient | under 0.3 ms | under 0.7 ms |

Budget: all effects together at most +10% of the page pass, which is under 0.3 ms of the 3 ms desktop pass and under 0.8 ms of the 8 ms phone pass (`READING.md` 8). Larger and the governor drops a level.

## 7. Acceptance plan

Extends `READING.md` section 10; each check has a planted-bug control that must fail it. Lane `tests` owns `tests/e2e/reading/fx/**`. A deterministic time uniform (`fx.time` set by the harness, not the clock) makes every frame reproducible.

1. **Screenshot sequences** (dark only, per the single look): for each effect, frames at fixed times (morph at t = 0, 0.25, 0.5, 0.75, 1; wipe every 60 ms; xref pulse in and out; glint; lens at three pointer positions), at 1440 x 900 and 390 x 844, in-world and reader-only, level Subtle and Full, and Off as the baseline. Contact sheets go to Andrew. Control: fx on a body paragraph with an alpha bug, sheet shows it.
2. **Contrast on every frame**: sample the ink and background luminance of each frame of every sequence over body text, headings and the neighbours of lit glyphs. Floors: 7:1 Subtle, 4.5:1 Full, ever. Control: set the ruler floor to 0.4; fails.
3. **Alignment with effects on**: READING test 3 (30 sampled lines, DOM span rect within 1.5 px of the GPU line) runs at every settled frame with each effect at peak (lens at maximum, ruler on, xref on, wipe settled). Mid-morph: every glyph lies on the segment between its old and new positions; at `EV_MORPH_SETTLED` test 3 passes. Control: lens delta 0.1 em; the sub-pixel bound fails. Control: do not gate pointer events in the morph; the interaction check fails.
4. **Readability A/B, objective**: render the same 20 paragraphs at peak effect state (lens, ruler floor, halo, glint at maximum) and with effects Off, run OCR on the frames, and require the word error rate to be within +0.5 percentage points of Off (est. threshold; tesseract or a comparable engine, pinned). Human check: a side-by-side contact sheet Off vs Subtle mid-scroll for Andrew to pick. Control: halo at 100% weight; the OCR gap exceeds the threshold.
5. **Noticeable-effect budget**: a scripted session triggers morph, a figure beat, a copy, a wipe and the lens at once; assert the arbiter never shows more than 2 and that morph blocks the others. Control: raise the cap to 3; fails.
6. **Native behaviour intact**: select-all and copy equal the post text, find still matches, links hit-test, with each effect at peak (READING tests 4, 5 and 7 re-run in Subtle and Full). The ruler freezes during a selection drag. Control: let the ruler run during a drag; the selection check fails.
7. **Frame time**: 600-frame scroll and 600-frame effect-dense stretch at both sizes, GPU timestamp queries with fx Off vs Subtle vs Full, at least 5 runs, median and spread, background GPU utilisation and `uptime` load beside each number, runs with more than 10 points of background movement discarded, results as a ratio to the Off baseline and as absolute ms. Budgets of section 6. Control: build the lens without the radius bound (all glyphs); the budget fails.
8. **Degradation matrix**: each row of the section 5 table with `emulateMedia` and a forced no-HDR canvas; reduced motion shows no motion frames (diff between consecutive frames is zero outside scroll).

Fast loop (build first): a flat preview page `tools/fx-lab` that loads the ifd blob, takes `fx.time`, level and per-effect amount from the query string and sliders (no rebuild, uniforms only), renders variant grids (N settings per sheet), and prints contrast and alignment next to each tile. Target: slider to picture under 2 s. Fidelity ladder: CPU sketch of the ruler and xref states in the layout export (no GPU), then the lab at low res, then the full page pass, then the in-world frame.

## 8. Staged plan and lanes

One pass per the house rule: all lanes fan out in one wave on disjoint files, the old path is not kept, the root merges, builds once, runs the acceptance once, sends failures back. Another wave (WAVE3 port, `READING.md` 10) may be moving files: paths map to the same-named crates when it lands; hooks into shared files (`page.ts`, `room.ts`, `World.svelte`, wasm exports) go through the root.

| Lane | Owns | Delivers |
|---|---|---|
| `fx` (new) | `src/lib/reading/page.fx.wgsl.ts`, `src/lib/reading/fx/**`, `tools/fx-lab/**` | WGSL include, fx instance list, arbiter, governor, spring easing, lab page |
| `contract` | `src/lib/magazine/format.ts` (glyph flags and `xid`, `Xref` table, block `fxOwned` bit, channel reserve 192..255) | blob and schema, sample buffer |
| `page` | `src/lib/reading/page.ts`, `page.wgsl.ts` (hooks only: draw order, `SegU` pads, frame uniform to 12 vec4, morph vertex branch, prev buffer) | applied by the root from the `fx` lane's patch |
| `world` | `world/src/reading.rs` (`FxModule`, singletons, systems, relations of section 4), `src/lib/ecs` bindings | Flecs model, `set_pointer`, `set_effects` exports |
| `dom` | `Reader.svelte`, `TextLayer.svelte`, `Aa` popover, `src/lib/reading.css` | setting control, selection rect export, WAAPI line FLIP, pointer gating, `::selection` and underline fallbacks |
| `content` | `thoughts/ifd/+page.svx`, `figures.ts`, build annotation pass | `xid` marks for the ifd post (Fig. 1 beats, thunk, the nix block), `em` glint marks |
| `type` | `scripts/reader/fonts.ts`, build palette script | bold-delta instance (Full), contrast floors for dim levels as palette checks |
| `tests` | `tests/e2e/reading/fx/**` | section 7 checks with controls |

Same-wave dependencies the root watches: `contract` before `fx` and `world` compile; `content` needs the `Xref` table shape.

**What to cut first, in order, if the budget or schedule fails:** 8 depth title, 7 lens (and the bold instance), glint (keep the wipe), 6 wipe, 5 room light (loses the signature, so only after the others), 4 selection glow (keep the underline and copy flash), 3 morph (fall back to instant relayout, which is today's behaviour), 2 cross-highlight, 1 ruler last. The Off setting and the governor ship regardless.

Learned-into-skills: when a lane finds a trap (a coverage fringe, a bad master pair, a mis-matched morph key), it writes it into the project skill for the reader in the same turn (rule from the global `CLAUDE.md`); the root checks it when the lane reports.

## 9. Prior art (links: read = opened this session, reported = from memory or a secondary source, not fetched)

- Slug, Eric Lengyel: analytic quadratic-curve coverage per fragment; reference shaders in `docs/upstream/reader/slug/` and https://github.com/EricLengyel/Slug, licence MIT or Apache-2.0 (read, `docs/upstream/reader/slug/SOURCE.md`). Paper, JCGT 2017: https://jcgt.org/published/0006/02/02/ (reported).
- Pathfinder, GPU vector and font rasteriser (Rust): https://github.com/servo/pathfinder (reported; archived, relevant for tile-based alternatives, not used here).
- troika-three-text, SDF text for Three.js with outline, glow-like fill and curve options and a material hook for custom shaders: https://github.com/protectwise/troika/tree/main/packages/troika-three-text (reported). It is SDF-atlas based, so its effects soften at large sizes; our analytic coverage keeps edges exact, which is why the rim in 2.5 works on display type.
- Valve, "Improved Alpha-Tested Magnification for Vector Textures and Special Effects", SIGGRAPH 2007: SDF text with outlines, glows and drop shadows from distance: https://steamcdn-a.akamaihd.net/apps/valve/2007/SIGGRAPH2007_AlphaTestedMagnification.pdf (reported).
- msdfgen and msdf-atlas-gen in `docs/upstream/reader/` (stored; not the glyph path here, relevant if a fallback atlas is ever needed).
- Apple, "Meet Liquid Glass", WWDC25: https://developer.apple.com/videos/play/wwdc2025/219/ (reported). Relevant idea: type and controls respond to light and to what is behind them; our lamp tint and rim (2.5) are the reading-page version, restrained to display type.
- FLIP technique, Paul Lewis: https://aerotwist.com/blog/flip-your-animations/ (reported). Our morph is FLIP per glyph, with the previous layout stored instead of measured from the DOM.
- fontTools `varLib.instancer` for same-topology instances: https://fonttools.readthedocs.io/en/latest/varLib/instancer.html (reported).
- Kinetic typography research: Lee, Forlizzi and Hudson, "The Kinetic Typography Engine: An Extensible System for Animating Expressive Text", UIST 2002 (reported; exact URL not verified, search the ACM Digital Library by title). The relevant finding for us, as I remember it and unverified: motion carries emotion but costs reading speed, which is why every effect here is gated, short and off the body.
- iA Writer Focus Mode (https://ia.net/writer, reported): the ruler's precedent (dim all but the current sentence or paragraph).
- Distill.pub reactive articles (https://distill.pub, reported): the precedent for prose and figure referring to each other.
- In-tree: `docs/READING.md` (2.4 HDR rule, 2.5 motion rules, 7 text layer, 10 acceptance, 14 ix prior art), `docs/READER.md`, `docs/MAGAZINE.md`, `src/lib/reading/page.wgsl.ts`, `src/lib/magazine/format.ts` (glyph record), `src/lib/gpu/room/magazine.wgsl.ts` (the old per-pixel evaluator, superseded for the page).

## 10. Open items for Andrew

- Default tier: I picked Subtle, which includes the ruler dimming neighbours to 0.78. If that reads as too active on first use, the one-line change is the Subtle ruler floor in the setting table.
- Berkeley Mono: confirm it is the intended code face (the docs say Fira Code) and that its licence allows compiling outlines into the shipped curve tables; I did not find the file in the repo.
