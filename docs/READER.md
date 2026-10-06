# READER: articles read inside the world

Status: design, 2026-10-06. No app code changed. Research bytes and licence texts are in `docs/upstream/reader/*/` (each with `SOURCE.md`).
Constraint set (Andrew): clicking a magazine opens the article INSIDE the ray-traced WebGPU world; the article is drawn by WebGPU as part of the scene; no HTML popup, no separate page, no no-WebGPU fallback (the prerendered static poster is the only non-GPU state). Articles are Flecs entities. A visually hidden DOM copy exists for a11y/SEO only.

## 0. What the code already gives us (read before deciding)

- `src/lib/gpu/room/shader.ts` is a compute path tracer. Albedo is demodulated: `cs_view` and `cs` write `gbuf[idx*2+1] = vec4f(alb,0)` and `shade_at` returns `final_ro * gbuf_albedo` (shader.ts:573-581). The denoiser filters illumination only. So whatever `albedo_of(...)` returns for the primary hit reaches the screen at full resolution, unfiltered. This is the property that makes analytic vector text on a surface crisp at any zoom.
- Zoom is a real re-trace, not a crop: `sc.view` (centre, half-size `s`, min 1/6) re-aims primary rays (shader.ts:415-425, room.ts:761-767). Text drawn in `albedo_of` therefore gets 6x more pixels per page unit at 6x zoom for free; a texture-based approach would have to track that.
- `cs_view` is the scroll/zoom pass: primary ray plus irradiance fetched from a per-floor cache projected through the floor's rest camera (shader.ts:480-503). A page that moves in front of the shelf is not in that cache's view, so cache fetch misses and falls to the noisy `indirect_e` fallback. Decision 3 handles this.
- Magazines are `kind: 2` boxes with `tex` rect into a 2048 canvas atlas (`atlas.ts`) and a `link` slug; `camera()` already has a `focusObj` hero pose (room.ts:366-378). Landing page scroll drives the elevator (`Room.svelte` `onscroll`), pinch/pan/dblclick are on the canvas.
- Article source is mdsvex: frontmatter, `---page---` markers (`rehype-pages.js`), shiki highlighted code (github-light/github-dark dual theme), inline code `{:lang}` marker, KaTeX in 2 posts (hyperion, optimal-parkour: inline `$...$`), 7 large PNGs in `static/posts` (up to 4112x4112, 11 MB), svelte components used inside posts today: `<Cite>`, `<References>`, `<StickyNote>`, plus `<script>` imports. No tables or footnotes today but both must be supported. Fonts: Inter, Newsreader, Fira Code (all from Google Fonts, SIL OFL).

## 1. Text rendering: decision = Slug-style analytic curve coverage, evaluated in the tracer's primary-hit albedo

Candidates (licences read from the stored text):

| Option | Licence (read) | Crispness at 1-6x | Scroll cost | Verdict |
|---|---|---|---|---|
| MSDF atlas (msdfgen v1.13, msdf-atlas-gen v1.4) | MIT, MIT | Resolution-bound per glyph: a 48 px/em atlas is 1x sharp but at 6x (body 16 px -> ~100 px/em) corners round off and thin serifs of Newsreader at small sizes alias; needs a median-of-3 + screen-px-range AA path and per-glyph atlas tuning; code block and math need separate atlases | 1 texture sample x3 per pixel, cheap | Fallback only. Native C++ build in our toolchain. |
| Canvas2D page textures, re-rasterised per zoom bucket | n/a | Best small-size hinting, but every zoom change needs a re-raster on the main thread (~10-40 ms per 2k page); pinch passes through blurry upsampled buckets; scroll strips need overdraw; no 120 Hz guarantee | Cheap sampling, expensive updates | Rejected: fails the pinch requirement. |
| Slug (Lengyel 2017, reference shaders MIT or Apache-2.0, patent dedicated to the public domain 2026-03-17) | MIT/Apache dual, credit required (README) | Exact analytic coverage from quadratic Beziers: resolution independent, no atlas, no zoom buckets | One banded-curve walk per text pixel; bounded by band size, designed for per-fragment use | **Chosen.** |

Why Slug fits this renderer specifically (not just in general):
1. The page is evaluated per primary-hit pixel inside `albedo_of`, so there is no render-target, no resampling, no mip chain, no zoom bucket: crispness is a property of the evaluation, valid at 1x to 6x and on any camera tilt during the fly-in.
2. Slug needs `emsPerPixel` (the reference uses `fwidth(renderCoord)`, SlugPixelShader.hlsl:146). In a compute shader we get it analytically: for a planar page, intersect the neighbouring pixel's ray (`d + dRgt*dx`, `d + dUp*dy`) with the plane, or use the closed form `dp/dpx = (|d_x - (d_x . n) d / (d . n)|)` from the camera basis. One extra plane-intersect, no neighbour reads, works under the existing `sc.view` zoom (the ndc step is `2*view.z/res`).
3. Math (MathJax SVG paths), code (Fira Code with ligatures), headings (Newsreader italics) and rules/boxes are all "shapes made of quadratic Beziers" so one evaluator draws everything; only photos use a texture.
4. The patent blocker is gone and MIT WGSL ports exist as starting points: `diffusionstudio/slug-webgpu` (MIT, WGSL + TS band builder, rev 12d8bdf) and `rubick24/tsl-slug` (MIT). We port the evaluator into `shader.ts` (WGSL) and run the band builder at build time in node. We keep the reference credit line in the site's colophon (required by the README).

Known Slug limits and how we meet them: no hinting. Mitigation from the README: choose the page em size so cap height lands on integer pixels at the reading pose (the reading camera distance is a free parameter, so snap it). Tiny text (the shelf distance, a page seen at 0.2x) is not meant to be read; there the evaluator is skipped (below 3 px/em it returns a flat ink-tinted tone = page "text mass" colour computed at build time per page, LOD with zero cost). Variable fonts: instantiate static instances at build time (`hb-subset --instance`/fonttools instancer): Newsreader 400/400i/600, Inter 500, Fira Code 400/500. Ink bleed: Slug dilation keeps stems at 1 px minimum at small sizes.

Cost control: shader work happens only on pixels of the primary hit that land on a page quad and only in the albedo write (once per pixel per frame in `cs_view`; in `cs` write it only where the first sample writes `gbuf`, never inside the 160-spp bounce loop, which uses the page's average paper albedo `ob.alb`). Implementer must confirm in `cs` that the primary albedo does not also multiply path throughput; if it does, switch that multiply to `ob.alb` for kind 10 (illumination stays demodulated either way).

## 2. Layout: build-time layout to a compact binary, no runtime reflow

### 2.1 Key simplification
A page is a physical sheet with fixed world size. Layout is therefore done in em units against a fixed measure and never reflows on resize; resize only refits the camera. Two width classes are built (wide: 40 em sheet, 30 em measure; narrow, aspect below ~0.9: 28 em sheet, 21 em measure) because a phone-width sheet at the wide measure sets 11 px text. The runtime picks a class once per open from canvas aspect and swaps on rotation (re-uploads, ~1 MB).

### 2.2 Pipeline (new Vite plugin `readerPlugin`, runs in node via pnpm at build and dev)
Input: each `src/routes/(site)/thoughts/*/+page.svx` source text (not the compiled svelte output).
1. Parse with `unified`: `remark-parse`, `remark-frontmatter`, `remark-gfm` (tables, footnotes, strikethrough), `remark-math` (all MIT; `unified`/`remark` family are maintained). `---page---` becomes a `pageBreak` node (kept: hard sheet break, same semantics as today's `?p=`).
2. Component registry, fail closed: `Cite` becomes a superscript numeric ref linked to the References entity; `References` becomes a numbered list section; `StickyNote` becomes a tinted inset box; `<script>` blocks are dropped (their imports only feed icons/components). Any other component tag throws at build with the file and line. This keeps hidden surprises out.
3. Inline code `{:lang}` (see `remark-inline-shiki.js`) and fenced code: run shiki `codeToTokens` with both themes (same two themes as `svelte.config.js`), quantise token colours to a 24-entry palette per theme (one table, light and dark columns). Glyph colour in the layout is a palette index, so the theme flips with a uniform, no relayout. Palette entries 0-7 are reserved for prose ink, link, muted, heading, rule, selection, code-bg, quote-bar.
4. Shape text: `harfbuzzjs` (MIT, v1.6.2) per run (script/direction/features: `liga`, `calt` for Fira Code as the site CSS enables them; kerning for Newsreader). Output: glyph id, x advance, offsets. Glyph outlines come from the same font bytes (`opentype.js` or `fontkit`, both MIT, read cmap-free by glyph id); curves are converted to quadratics (cubic split to error < 1/4096 em), bands built by the algorithm in the Slug README and the `slug-webgpu` builder. Only glyph ids actually used across all posts are emitted (a union glyph table, ~1-2k glyphs, estimated under 1 MB before brotli); a character with no glyph fails the build.
5. Equations: MathJax 4 (Apache-2.0, 4.1.3) `tex2svg` in node, SVG `<path>`/`<use>`/`<rect>` flattened to the same quadratic form and appended to the article's own "extra glyph" table (equation = one glyph-like object with its own bands, inline baseline aligned or display centred). `$..$` becomes an inline object, `$$..$$` a display block. The 6 occurrences in the corpus are inline, so v1 supports inline plus display, no `\begin{align}` multi-column beyond what MathJax emits as a single SVG (it all emits as one SVG, so no extra work).
6. Line breaking and pagination: greedy with look-ahead (minimum raggedness over the next 3 lines, ragged right, no hyphenation in v1; code blocks never wrap but scroll as a clipped fixed-width block at 6x zoom through pan, with a visible fade and the full line preserved for copy). Rules: widow/orphan 2, headings keep-with-next 2 lines, images and display equations atomic (move to next sheet if they do not fit; a sheet never ends on a heading), code blocks may split between lines, blockquote bar and code background repeat per sheet.
7. Images: `sharp` (already allowed in `package.json`) writes per image a tier set `w512, w1024, w2048, orig-capped-4096` as lossless-quality WebP (lossy q90 for photos, lossless for screenshots/diagrams chosen by alpha/palette heuristic), content-hashed under `static/reader/img/`. Layout stores intrinsic size so the reserved box is exact before bytes arrive.
8. Emit per article and width class: `reader/<slug>.<class>.<hash>.bin` (brotli at the host) plus one `reader/index.json` (slug, title, dek, date, pageCount, byte sizes, hash, accent). The existing `thoughts.ts` registry stays the source for metadata.

### 2.3 Binary layout (little-endian, u32-aligned so it uploads as one storage buffer)
```
Header      magic 'RDR1', version, widthClass, emPx0 (reference), pageCount, counts for each table, plainTextBytes
Pages[]     {y0_em (f32), h_em (f32), firstLine, lineCount, firstItem, itemCount, toneRGB565 (LOD colour), pageNo}
GridDims    cellW_em=6, cellH_em=1.6 (one body line), gridCols, gridRows per page
GridCells[] {itemStart:u32, itemCount:u16, pad}   // per page, row-major
Items[]     u32 each: [type:3 glyph|rect|image|eqn ][ index:29 ]  // cell lists, dilated by one glyph
Glyphs[]    {x:f32, y:f32 (baseline), glyphId:u32 (union table or extra table), size_em:f16, colour:u8, flags:u8, charOffset:u32}  // order = reading order
Rects[]     {x0,y0,x1,y1 f32, colour u8, kind u8 (rule, code-bg, quote bar, table line, note box)}
Images[]    {x0,y0,x1,y1 f32, imageId u16, radius u8, altOffset u32}
Lines[]     {y_top, y_bot, x0, x1, firstGlyph, glyphCount, charOffset}   // hit-test and selection
Links[]     {x0,y0,x1,y1, targetKind (url|anchor|ref|article), targetOffset}   // CPU only
Anchors[]   {id string offset, page, y}                                         // TOC and #hash
UnionGlyphs {curveTexels f16x4 (shared across all articles, loaded once as fonts.bin), bandHeader u16x2 ...}
Text        UTF-8 plain text with glyph->char offsets (copy, find, screen-reader sync)
```
Estimated size: 3000-word post ~ 20k glyph instances x 24 B = 480 KB raw, ~120 KB brotli; grid and items add ~25%. Fonts file `reader/fonts.<hash>.bin` is loaded once and kept resident across articles.

Runtime cost is only upload: `device.queue.writeBuffer` of the article buffer plus bind-group rebuild, ~1 ms.

## 3. Scene geometry, shading, camera, scroll, navigation

### 3.1 Geometry and shading
- Article sheets are thin boxes with a new surface kind `10` ("page"), one per Flecs Page entity (sheet 40x56 em, em = 0.0155 m so a sheet is 0.62 x 0.87 m, slightly larger than a shelf magazine at 0.42 x 0.58). Sheets stack vertically with a 0.6 em gap and travel together; the reading camera is fixed, `scroll` translates the stack (`Transform.y`) so only sheets intersecting the frustum are traced (broadphase: 3 boxes max).
- `albedo_of` gets a `kind == 10.0` branch with a `primary` argument: primary -> paper texture (vnoise grain already in the shader) composited with the Slug-evaluated ink, rect fills, images and selection tint; non-primary (bounces, shadow rays) -> `ob.alb` paper average. No texture binding for text; one new read-only storage buffer `reader` plus one `texture_2d_array<f32>` for images (see 3.5). Check that adding `reader` stays within `maxStorageBuffersPerShaderStage` on the target adapters before coding (Apple and Chrome defaults are 8-10; the existing bindings go to 18 across entry points); if over budget, pack `panes`/`lvl` or request the adapter limit.
- Lighting decision: **lit by an analytic reading light, not by the path tracer's cache.** In reading pose `e_page = ambientTint * 0.35 + readLight(p)`, where `ambientTint` is the converged floor cache irradiance sampled once at the shelf (a uniform), and `readLight` is the existing lamp as a soft area term with a falloff gradient over the sheet (1 - 0.15 * normalised distance from lamp) plus a vignette. Paper stays between 0.78 and 0.88 display-linear luminance, ink 0.04-0.06, contrast ratio at least 12:1 in light and 9:1 in dark (checked in acceptance, 6). A pure emissive overlay would look pasted on and ignore `prefers-color-scheme`; the cache path is unusable because the stack leaves the rest-camera view. The sheet still casts a soft shadow and blocks light in the full `cs` pass so the room behind dims and reads as depth. Blend `k = readingBlend` (0 at the shelf, 1 in reading pose) between the normal cache fetch and this analytic term, so the magazine-to-sheet transition has no pop.
- Light and dark: paper/ink/code-bg/quote/link/selection colours are two uniform palettes keyed by the existing `prefers-color-scheme` handling (`mq` in room.ts); dark paper is a warm dark grey with light ink, not inverted photos (images get a 0.9 multiply in dark).
- Backdrop: outside the sheets the existing room renders unchanged, with exposure x0.55 and a mild screen-space darkening ramp driven by `readingBlend`.

### 3.2 Camera choreography (shelf to reading pose)
Timeline 700 ms, Flecs-driven (`Reading` state on the Article entity; the Room's `camera()` reads it):
- 0-200 ms: magazine entity lifts off the shelf (z +0.06, rotation from `lean(8deg)` to 0), `Transform` tween, cover alpha stays.
- 120-700 ms: camera critically damped spring (omega 9 rad/s, no overshoot) to the reading pose: frontal, centred on sheet 1 top, distance `D = 1.06 * max(H/(2 tan th), W/(2 tan th * aspect))` where `th = tan(17deg)` as today (room.ts:366-378); then snap `D` so cap height is an integer pixel count at the canvas's device resolution.
- 120-700 ms in parallel: magazine quad scale animates to the sheet size, cover pixels crossfade into sheet 1 (page 1 opens with the same masthead/accent as the cover from `atlas.ts`, so the crossfade reads as the cover unfolding).
- Elevator progress freezes at the current floor; exit restores it. Floor camera y stays as is.
- Back/close reverses the same curve. `prefers-reduced-motion`: 150 ms crossfade, no flight.
Elapsed time is wall clock (not frame count), so 60 and 120 Hz play the same.

### 3.3 Scrolling inside the article
- Wheel without ctrl on the canvas while `Reading`: `preventDefault`, `scrollTarget += deltaY * pxToEm`, no extra smoothing (macOS already sends inertial wheel events; apply them directly, one `touch()` per event, coalesced per rAF). Keys: space/shift-space, PgUp/PgDn, arrows, Home/End, `/` (find, v2). Touch: one finger drag scrolls with our own fling (velocity from the last 80 ms, exponential decay 0.95/frame normalised to dt). Pinch zoom unchanged (`zoomAt`), and while zoom > 1 two-finger pan moves the view window as today; scroll then moves the page under the zoomed view.
- Body scroll is locked in reading mode (`overscroll-behavior: contain` + the world host `overflow: hidden`); the elevator's scroll mapping is unbound until close. Page `Next/Prev` (Flecs relation) become a visible turn affordance at the end of the last sheet.
- Scroll offset is clamped to `[0, totalHeight - viewportHeight]` and stored in URL hash-less state (`history.replaceState` every 500 ms idle, key `reader`) so reload and back restore position.

### 3.4 Navigation, URL, prerender
- Decision: hoist the world into the `(site)` layout as one persistent fixed canvas for every route. Routes become data only: `/` = browsing state, `/thoughts/<slug>` = reading state for that slug. Opening a magazine calls `goto('/thoughts/<slug>', { noScroll: true, keepFocus: true })`; the browser URL, back/forward, share links and SvelteKit prerender (`+page.svx` still emits real HTML per route, `adapter-static`, `strict: true`) all work natively. Do not use shallow routing: a second state machine diverging from the URL is the bug source. The back button pops the navigation and the world flies back; a cold load of `/thoughts/<slug>` boots the world already in reading pose (snap, no flight; flight on first user close).
- `Room.svelte`'s per-component `createRoom` and `ArticleHero`'s second room instance go away: one `World` component in `(site)/+layout.svelte`; the landing scroll spacer (`.world` height `floors*90svh`) is rendered by the layout only for `/`.
- Share/anchor: `#heading-id` scrolls to the Anchor entry (the same ids `rehype-pages.js` makes with `slugify`). `?p=N` maps to sheet N for old links (hard `---page---` breaks keep their meaning).
- Link click in the world: external URL -> `window.open(url, '_blank', 'noopener')`; same-site `/thoughts/*` -> `goto` and fly to the next article (the world reuses the shelf pose); `#anchor` -> scroll; footnote/ref -> scroll with a back-chip ("back to text") drawn in the sheet margin as a Rect item.

### 3.5 Images
- `texture_2d_array<f32>` `reader_img` (rgba8unorm, layer 2048x2048, 8 layers, mips generated once per upload with the standard render blit chain) plus one 4096x4096 "detail" layer used for the image nearest the view centre when zoom > 2.5. Images are letterboxed into a layer at the best tier for current on-screen size (`px/em * placed_em` -> pick `w512/1024/2048`), loaded by `fetch` + `createImageBitmap(..., {premultiplyAlpha:'none'})` + `copyExternalImageToTexture`, eviction when a sheet is more than 1 sheet from the view. Memory budget 8 x 2048^2 x 4 B x 1.33 = 180 MB worst case; reduce to 6 layers or `w1024` tiers on adapters under a measured budget (target < 128 MB on phones; read it from `adapter.limits`/trial, record the number).
- Sampling: `textureSampleGrad(reader_img, s, uv, layer, ddx, ddy)` with gradients from the same plane-differential used for Slug (trilinear + `maxAnisotropy 16`), so minified screenshots stay sharp and magnified ones fall back to the detail layer. Placeholders (blur-hash grey from the layout tone) draw until bytes land, no layout shift.
- Honest limit: 6x zoom of a 4000 px source on a 1000 px sheet is native-resolution only up to ~4x; beyond that the original is upsampled (physical limit of the asset, noted not hidden).

### 3.6 Hit-testing, links, selection
All CPU, from the layout binary (no GPU readback):
1. Pointer to ray: reuse the Room camera basis incl. `sc.view` zoom window (expose `room.rayAt(nx, ny)`; the ECS lane owns room.ts, so this is a requested export, listed in 6).
2. Ray vs the sheet planes (3 boxes) gives `(page, x_em, y_em)`; `Lines[]` binary search by y, then glyph by x; `Links[]` rect test (up to ~30 per page).
3. Hover: cursor `pointer`, uniform `hoverRect` tints/underlines glyphs whose box is inside the rect in the shader (link colour palette 1, 2 px underline in em units).
4. Selection: left-drag on text selects (anchor/focus glyph index in reading order; instances are in reading order so highlight test is `idx in [a,b)` in the shader, plus up to 3 rects for the line backgrounds passed as uniforms: first partial line, full middle block, last partial line). Camera pan with the mouse requires `space`+drag or middle button in reading mode (the current mouse drag-pan when zoomed conflicts; resolve in favour of selection). Touch: long press to start selection with two handles; one-finger drag still scrolls. Copy: `copy` event (no DOM selection needed): `Text` slice via glyph char offsets, as plain text plus a markdown flavour if the selection starts inside a code block. `Cmd/Ctrl+A` selects the article. In-world find (`/`, `Cmd+F` is browser-owned and would search the hidden DOM; see 4) is v2.
5. Keyboard focus: see section 4.

## 4. Accessibility and SEO

Decision: keep the real article in the DOM, visually hidden, as the single accessible and indexable representation; the canvas is `aria-hidden`.
- The route renders its mdsvex output unchanged inside `.sr-only` (`position:absolute; clip-path:inset(50%); width:1px; height:1px; overflow:hidden`; never `display:none`, which removes it from the accessibility tree). Heading structure, links, `Cite`, images with alt text, MathJax MathML for equations come from the existing prerender; Open Graph tags, `<title>`, canonical and JSON-LD `Article` are emitted from `+layout.svelte` as today. This is already what crawlers get on prerendered routes.
- Hover/click on the canvas sheet and Tab in the DOM are kept in sync: focusing a DOM link/heading (`focusin`) scrolls the sheet so the matching `Links[]`/`Anchors[]` rect is in view and draws a 2 px focus ring in the sheet (uniform `focusRect`); Enter activates; Escape closes the article (`aria-live="polite"` region announces "Opened: <title>" and "Closed").
- Browser-native text selection and Cmd-F operate on the hidden DOM and are invisible to sighted users. We say so: sighted selection is the custom one (3.6), and find is the v2 in-world find bar; this limitation is accepted.
- `prefers-reduced-motion`, `prefers-contrast: more` (ink to pure black/white, bar-less links underlined), and a text-scale control (`Cmd +/-` while reading changes `emPx0` via the zoom window, no relayout) are required in acceptance.
- No-WebGPU: shows the prerendered poster plus title/dek text and "this site needs WebGPU"; the article is not drawn (per Andrew). Note the consequence: users without WebGPU see only the hidden DOM via assistive tech or "reader mode", which the `.sr-only` markup survives. Flagged as a product decision, not engineering.

## 5. Flecs model and wasm interface

(The ECS lane owns the module; this is the contract the reader needs. Flecs v4.1.6 is MIT, `flecs_ecs` 0.2.2 MIT, both read.)

Components (plain, `#[repr(C)]`, f32/u32):
```
Transform { pos: [f32;3], rot_y: f32, scale: f32 }   // reused by magazines and sheets
Surface   { kind: u32, albedo: [f32;3], tex: [f32;4] }  // existing room surface description
Article   { slug: u32, no: u32, date: u32, accent: u32, widthClass: u8, layout_hash: u64 }  // strings live in JS
Reading   { t: f32, target: f32 }          // 0 shelf .. 1 reading; tween target set by Open/Close
Scroll    { y_em: f32, target_em: f32, vel: f32, max_em: f32 }
Page      { index: u16, y0_em: f32, h_em: f32, item_start: u32, item_count: u32 }
Selection { a: u32, b: u32 }  Hover { rect: [f32;4] }  Focus { rect: [f32;4] }   // singletons on the world
Resident  { }  tag: layout buffer and images loaded
```
Prefabs and relations:
- `prefab Magazine { Transform, Surface(kind 2), Article }` instanced once per post on its shelf; `prefab Sheet { Transform, Surface(kind 10), Page }`.
- `HasPage(Article, Page)` (one-to-many, Page entities created on open from `Pages[]`, deleted on close); `Next(Page, Page)` and `Prev(Page, Page)` (ordered chain, also across articles: `Next(Article, Article)` mirrors `thoughts.ts` issue order: older/newer links); `Cites(Article, Article)` from `Cite` refs whose target is another post (graph for the "More pieces" row and for in-world link flights).
- `ChildOf(Sheet, Article)` so scroll `Transform` is inherited from the article's `Scroll`; systems: `ReadingTween` (spring on `Reading`), `ScrollIntegrate` (fling, clamp, 120 Hz safe), `SheetCull` (marks sheets intersecting the camera window; only those enter the object buffer), `PackObjs` (writes the `objs` storage buffer rows incl. kind-10 sheets, `Float32Array` view into wasm memory, no copies).

Wasm exports (C ABI, minimal; strings stay on the JS side keyed by integer ids):
```
world_init(), world_tick(dt_ms: f32)
article_open(slug_id: u32), article_close()
scroll_by(dy_em: f32), scroll_to(y_em: f32)
selection_set(a: u32, b: u32), hover_set(x0,y0,x1,y1), focus_set(x0,y0,x1,y1)
objs_ptr() -> *const f32, objs_len() -> u32         // packed rows consumed by writeBuffer
reader_state_ptr() -> *const f32                    // reading blend, scroll_em, selection, hover, focus, camera pose for shader uniforms
event_poll() -> u32                                 // Opened(slug), Closed, ScrollEnd, PageChanged(n)
```
JS side loads layouts and calls `article_open`; wasm never touches fetch, textures or the DOM. All time is wall-clock `dt`.

## 6. Staged plan (tree stays green at every step; one stage = one commit; build and tests run once on the main tree after merge, per house rules)

Stage 0 (docs only, this change): `docs/READER.md`, `docs/upstream/reader/**` (done).

Stage 1: font and Slug data, no runtime use. Add `scripts/reader/fonts.ts` (instancing, subsetting by union glyph set, quadratic conversion, band build), `src/lib/reader/format.ts` (binary read/write, shared by build and runtime), `static/reader/fonts.<hash>.bin` (generated, gitignored if derived, commit the generator not the output), `src/lib/reader/bands.test.ts` (round-trip and winding-number parity against opentype.js path fill on 200 random points per glyph). Acceptance: bands test passes; `fonts.bin` brotli under 600 KB for the current corpus.

Stage 2: layout build. Add `scripts/reader/parse.ts` (remark pipeline + component registry), `scripts/reader/shape.ts` (harfbuzzjs), `scripts/reader/layout.ts` (line breaking, pagination, grid), `scripts/reader/math.ts` (MathJax -> curves), `scripts/reader/images.ts` (sharp tiers), `scripts/reader/vite-plugin.ts` registered in `vite.config.ts` (emits `reader/<slug>.<class>.<hash>.bin` + `index.json`). Acceptance: all 11 posts build for both width classes with zero unknown components; a debug dump (`pnpm exec tsx scripts/reader/dump.ts <slug>`) writes an SVG of each sheet; reviewed against the live HTML article for the 3 stress posts (`hyperion` images+math, `notes-on-errors` code+headings, `mcp-not-enough` StickyNote). Build time added under 20 s warm.

Stage 3: shader and world, behind no flag (kind 10 simply never appears until stage 5). Add `src/lib/gpu/room/reader.wgsl.ts` (Slug evaluator, plane differentials, rect/image/selection compositing, reading light), a `reader` storage binding and image array binding into `shader.ts` (coordinate with the ECS lane, who currently edits room.ts/shader.ts: this stage starts only after their branch lands), `src/lib/gpu/room/reader.ts` (buffer upload, image residency, LOD), and the camera `reading` pose path in `room.ts`. A dev route `src/routes/reader-lab/+page.svelte` renders one article sheet at configurable zoom for the checks below (removed or hidden at stage 6).

Stage 4: Flecs module wiring (after the ECS lane delivers). Add `src/lib/ecs/reader.ts` (typed wrapper over the exports in 5), `crates/.../reader` components/systems (Rust source, path set by the ECS lane), and replace `focusObj` in `camera()` by the `Reading` component. Acceptance: opening/closing 50 times leaks no entities (`world_entity_count` returns to baseline) and no GPU buffers (`device` object count stable).

Stage 5: product wiring. Edit `src/routes/(site)/+layout.svelte` (hoist `World`), add `src/lib/components/World.svelte` (merge of `Room.svelte` input handling plus reader input: wheel, keys, touch, selection, hit-testing in `src/lib/reader/hit.ts`), change `src/routes/(site)/thoughts/+layout.svelte` to render only the `.sr-only` article, prev/next real links, and `state` for the world; delete `ArticleHero.svelte`, the visible folio/TOC/EraRail chrome, `Room.svelte` (same commit that adds `World.svelte`). `goto`/back-button wiring, `?p=` mapping, `#anchor`, scroll restoration. Acceptance: `pnpm build` emits every `/thoughts/<slug>/index.html` containing the article text and OG tags (grep the build); cold deep link boots in reading pose; back button returns to the shelf pose.

Stage 6: polish and removal of the lab route. In-world find bar (v2 backlog item), `prefers-contrast`, text-scale control.

### Acceptance checks (measurable)

1. Screenshots, light and dark, per posts `notes-on-errors` (code), `hyperion` (image+math), `mcp-not-enough` (notes), at pose reading 1x, with `chrome --headless` over CDP using `emulateMedia prefers-color-scheme`; stored in `docs/upstream/reader/shots/` with the commit sha; checks: contrast ratio paper/ink computed from the screenshot pixels >= 12:1 light, >= 9:1 dark; no text clipped at sheet edge; both width classes at 1440x900 and 390x844.
2. Zoom crispness: render the same line at zoom 1, 2, 4, 6 (programmatic `room.zoomAt`), DPR 1 and 2. Metrics on a vertical stem of `l` in body and an `H` in the heading: 10-90% edge transition width <= 1.5 device px at every zoom (MSDF and bucketed textures fail this at 6x by construction, so this is a real control); mean absolute luminance difference against a CPU reference (opentype.js path, 8x8 supersample, box downsample) <= 2% over the region. Control: the same check run on a deliberately bilinear-upscaled texture of the 1x render must fail (planted-bug control for the metric).
3. 120 Hz scroll: timestamp-query on the `cs_view` pass plus rAF deltas, 600 frames of constant-velocity wheel scroll through a 10-sheet article at the Room's current internal resolution on a 120 Hz display; report median, p95, p99 GPU ms and rAF dt, with background GPU utilisation and CPU load beside every number (`ioreg -r -d 1 -w0 -c IOAccelerator | rg -o '"Device Utilization %"=[0-9]+'`, `uptime`), >= 5 runs, discard runs where background GPU moved > 10 points. Target: p95 frame <= 8.3 ms and zero frames > 16.7 ms. Baseline for the ratio: the same pose with text and images disabled (page = paper only); text must cost <= 1.25x that baseline. If the ratio fails, first tune the grid cell size and band count in `layout.ts`, not the shader.
4. Navigation: Playwright/CDP script: click each magazine -> URL equals `/thoughts/<slug>`, `history.length` +1, Back -> shelf pose and URL `/`, Forward -> reading pose; deep load of each slug boots into reading pose within 1.5 s of `load` on the dev machine; `goto` from one article's link to another keeps the one WebGPU device (`GPUDevice` identity unchanged).
5. Hit tests: for every link in the 11 posts, a synthetic pointer at the link rect centre resolves to that link target (table-driven from `Links[]`); selecting a code line and copying yields the exact source string (byte-compare with the post's fenced block).
6. A11y/SEO: Lighthouse (or axe) on each prerendered route, 0 serious violations; the hidden DOM's text equals the layout's `Text` section modulo whitespace (diff test in `scripts/reader`), so the two copies cannot drift.
7. Resources: article open allocates at most the stated image budget; `device.destroy()` on page unload leaves no `uncapturederror`.

## 7. Risks and the proper-design note

- Biggest dependency: shader.ts/room.ts are under rewrite by the ECS lane; stage 3 and 4 wait for it. Stages 1-2 are independent and can start now.
- Storage-buffer limit (3.1) is the one external constraint; everything else is ours to change.
- The cheaper alternative (MSDF or Canvas2D page textures into the existing atlas path) is a smaller version of the same ceiling: both are bounded by a texel resolution that the 6x zoom exceeds, so they need zoom-bucket re-rasterisation, which is what the analytic approach removes. Cost of the proper design: a Slug band builder in the build step (ported from the MIT `slug-webgpu` builder, about 400 lines) and a WGSL evaluator (about 200 lines); both are one-time. Fallback if Slug per-pixel cost misses acceptance check 3: same bands, but render only visible glyph quads into a page-window texture at screen density, resampled 1:1 (no change to the layout format, no change to the build).

## Stage 1-2 notes

Implemented: stage 1 (glyph curve data, Slug bands) and stage 2 (build-time layout, one binary per article and width class). Nothing from stage 3 on.

Commands (pnpm repo, bun runs the scripts):
- `bun scripts/reader/build.ts [--force] [--only slug] [--md file.md]` writes `static/reader/` (gitignored, generated): `fonts.<hash>.bin`, `<slug>.<wide|narrow>.<hash>.bin`, `index.json`, `img/*.webp`. Skips itself when the input stamp matches. `scripts/reader/vite-plugin.ts` runs it at dev/build start.
- `bun scripts/reader/validate.ts [slug...]`: 13 checks per article and class (glyph ids resolve, glyphs inside page bounds, line ranges tile glyphs, reading order, links/anchors resolve, h/v band walks agree, text length within 5% of an independent source-derived count). Green on all 11 posts, including ifd, hyperion, optimal-parkour.
- `bun test src/lib/reader/bands.test.ts`: band winding vs harfbuzz outline (88k points) and vs opentype.js (35k points), 0 mismatches; planted-corruption control is caught; container round trip.
- `bun scripts/reader/dump.ts <slug> [--class wide|narrow] [--png] [--dark]`: rasterises sheets from the binary into `$TMPDIR/reader-dump` for eyeballing.

Layout: `src/lib/reader/format.ts` (container, records, f16), `slug-cpu.ts` (CPU band walk, shared with the future shader), `scripts/reader/{fonts,geom,parse,math,images,layout,build,validate,dump}.ts`. Fonts and licences (all OFL) in `docs/upstream/reader/fonts/` with SOURCE.md.

What worked:
- harfbuzzjs does shaping, variable instancing (`new hb.Variation(tag, v)`) and outlines; cubics split to quads at 1/4096 em.
- MathJax 4 SVG (fontCache none) flattened to quads; each distinct path becomes a glyph in a per-article extra table (glyphId bit 31). Needs `@mathjax/mathjax-newcm-font` listed explicitly under pnpm.
- Min-raggedness DP line breaking, widow/orphan 2, keep-with-next headings; build takes about 4.5 s cold.

Traps:
- harfbuzzjs `setVariations` rejects plain objects.
- Missing glyphs (U+2208, U+2124, emoji) fall back to Fira Code then Noto Emoji; anything still missing fails the build.
- Do not add `x += adv` twice when building segments (shows as letter-spaced text); the dump catches it.
- Round-trip tests must compare f32-rounded values (`Math.fround`).
- macOS sed: no `/d;` forms; use `-i ''`.

Deviations from the spec:
- Newsreader opsz is 18 (the axis default), not 16.
- Pages record carries an extra f32 `coverage`; links carry a `page` field; `ItemType.eqn` is unused.
- Line breaking is a DP per paragraph segment, not 3-line look-ahead.
- Code glyphs beyond the measure are in Glyphs/Lines but not in grid cells (clipped block); the validator allows it.
- Hidden posts are built and flagged `hidden` in index.json.

Unsupported: no post failed the build. The only component tags in the corpus are Cite, References, StickyNote (plus inline code/em/strong/a/span/kbd/br); any other tag or script content throws with file:line. Tables, footnotes and blockquotes are implemented but no real post exercises them.
