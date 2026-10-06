---
name: flecs-scene
description: Editing the Flecs scene (world/scene/*.flecs, world/src/*.rs, world.wasm) of the site's 3D room: placing props, prefabs, relations, Rust components, wasm rebuild.
---

# Flecs scene rules

The room is declared in Flecs script and packed by `world/src/export.rs`; `bun run build:world` rebuilds `src/lib/gpu/room/world.wasm` (commit it).

## Placement (never hard-code a height)
- Props are children of the surface they stand on and carry the `Rests` tag. The exporter sets the height from the parent's top face (`extent_y(parent) + extent_y(child)`, rotation aware), so a prop cannot sink or float. Give only x and z (relative to the parent centre); `Center.y` is ignored on a `Rests` entity.
- Floor surfaces are prefabs (`ShelfSurface`, `DeskSurface` in 30-rooms.flecs); a room type adds the props as children of its own `shelf : ShelfSurface { ... }`. You cannot add children to an inherited prefab child, so define the surface in the room type instead of in `Room`.
- Child `Center` is relative to the parent centre (floor_pos sums ancestors). Compound props (pot + blades) are one prefab whose parts are relative to the pot.
- Rotation components: `Lean` (about x), `Flat` (about vertical, per floor), `Euler {x,y,z}` (Ry*Rx*Rz). Exporter rows are the local axes in world space.

## Script traps
- An empty child instance needs braces: `shelf : ShelfSurface {}` (a bare line fails with "unexpected newline").
- Tags go on their own line inside the braces (`Rests`, `TexSign`).
- New component: add `vec_component!`/struct in components.rs AND `world.component_named::<T>("T")` or the script cannot see it.
- Script errors show in the browser console as `warning: world.wasm: ... error: rooms:`; the room then fails to load (blank canvas).
- Objects are exported sorted by entity id; magazine slots use their own index map, so nesting props does not move magazines.

## Look
- Only boxes and spheres exist (no meshes). Organic props (plant) = many thin tilted boxes with `Euler`; spheres blobbing above a pot looked wrong.

## Flat objects
- `Flat` rotates so local y is horizontal and local z is vertical: a sheet lying on a desk needs `Half: {w, depth, thickness}` (thickness last). Putting the thin half on y made the notes stand upright through the desk.

## Decor prefabs (docs/DECOR.md, scene/12-decor.flecs)
- Load order: `12-decor.flecs` must sit between `prefabs` and `rooms` in `scene.rs` `SCRIPTS`; the rooms script uses its prefabs.
- Build compound props as an IsA tree: base (`Lamp`, `Seat`, `Frame`, `NeonSign`) > variants that restate only what differs (`ArmchairMustard : Seat { Albedo }`, `MugRed : Cup { Albedo }`). Parts are `ChildOf` children with a Center relative to the root.
- The root is the lowest part touching its support; stack the rest with `Rests` (child of child works, y chains). Surfaces and floor props carry their own Center.y in the prefab, and an instance repeats it because `Center: {x, y, z}` replaces the whole component.
- You cannot override a child of a prefab from a variant or add children to an inherited child. Variants recolour via small geometry prefabs (`SeatBack`) re-declared with an `Albedo`; neutral parts are never recoloured. Add per-floor props to an instance's own root (`desk : FurnishedDesk { ... }`), never to an inherited part.
- Rotation does not propagate to children (only the entity's own box rotates): compound props face +z, nothing mounts on side walls.
- Spheres (`Ball`, kind 8) need `Half {r, r, r}` to work with `Rests` (extent_y reads Half.y); the shader uses Half.x as the radius.
- Relations as intent: declare plain entities (`Hangs {}`, `Lights {}`, `Near {}`, `Pairs {}`, `Tint {}`) at the top of the script, then use `(Hangs, BackWall)` on its own line. The exporter ignores them until it reads them; a target must be declared earlier (siblings: `(Pairs, bc_l)`).
- Lighting limits today: one kind 9 (lamp) and one kind 3 (accent) are read per floor (the last by entity id). Extra kind 9 objects move the floor's light: use none. Kind 3 objects all glow with the floor's one accent colour: give every neon bar the same LampColour and keep them axis aligned.
- Cost: `intersect` is linear in objects per level; stay under about 90 decor objects per floor and measure.
- Rust side (world/src/magazine.rs, see docs/MAGAZINE.md 5.1): state lives in singletons (`.term_at(i).set_src(T::id())`), exclusive relations (`add_trait::<flecs::Exclusive>()`) replace index compares, and OnAdd/OnRemove observers on `(Rel, *)` replace event flags. `Id<T>` arrays do not unify across types (use `Entity`), `Query::with` is only on `w.query::<()>()`, and native `cargo check` fails on the vendored C-unwind patch (use the wasm target). Run the idle timer beside momentum, and zero velocity on a clamp.
- Book choreography (docs/BOOK.md, world/src/book.rs): never derive several channels from one spring with smoothsteps (double easing, everything ends together); one spring per channel with its own omega and zeta, and change only targets on a phase change so every interrupt keeps position and velocity. A target aimed slightly past a stop with a clamp gives a finite-time landing and an impact velocity for the sound; threshold the impact (above about 0.25) or a spring resting on its stop emits a sound every frame. Written without a compile: if `book.rs` fails to build, fix pair types first (`Entity` ids, not `Id<T>`).

## Traps (2026-10-06)

- Prefabs created inside `world.import::<Module>()` live in the module scope: root `world.lookup("Name")` panics "Entity not found", and `lookup_recursive` does not search child scopes. Register the id at creation (book.rs `PART_PROTOS` thread_local) and use `entity_from_id`.
- A panic inside `RS.with(|r| r.borrow_mut()...)` leaves the RefCell borrowed; the later "already borrowed (reader.rs)" is a symptom, fix the first panic.
- Rust systems run inside `world_tick` (reader::tick -> progress_time); `elevator_tick` only sets dt, call it before `world_tick`.
- Cab-list hit distances are measured from the eye, room hits from the front plane (offset tp); subtract tp before comparing.
- A WebGPU page that never reaches "room: lightmap texels" with `requestDevice` pending means the browser GPU process is wedged (Dia/Chrome GPU helper at 100%+ CPU for an hour), not a code bug: close leaked localhost tabs, kill the `--type=gpu-process` helper, retry. Screenshot tools must close their tabs.
- Failed pipeline setup returned null silently; room.ts now logs `room: pipeline setup failed`.


## Traps learned (hinged cover, elevator, testing; 2026-10-06)

- A WGSL edit that references an undefined name makes the whole pipeline fail and `/` goes black. Shot-check `/` and `/thoughts/ifd` after every shader edit; init failures now log `console.error` (`room:` / `world:` prefix).
- Page gate is `rd0.x < 0.8995`: the carry caps book t at 0.899, so a gate at 0.899 flashes the full spread at the carry end.
- Reading-pose shading is one deterministic sample with no denoise: any new light term must be noise-free (the cover uses 6 fixed taps).
- Shared `LS` stride: index `lvl[level * LS + 1u]`, never a literal stride.
- Elevator CabSeam (role 10) produced the white vertical line through the door gap; it was deleted. A thin bright slab between doors is the first suspect for such a line.
- Opening a second article while one is open snapped every channel: `openArticle` now closes first and polls `RS.phase === 0` before opening. A click during carry reverses the book (continuous), it does not redirect.
- Edit files with python, not BSD `sed` (this Mac). Open a book in tests by waiting for `a.spot` (created once the lens is above 0.97), with timeouts.
- Detent tests: scroll needs about 500 ms before polling for rest. Latch/detent result 14/14 at random offsets.
- DEV probes in room.ts: `__dbg` (`hinge` override, `timeScale`, `audio` event log), `__rs()`, `__book()`; use timeScale for frame-by-frame strips.
- CDP testing runs in a separate headless Chrome, never Andrew's browser: `chrome --headless=new --remote-debugging-port=9333 --user-data-dir=/Volumes/Projects/tmp/chrome-cdp --enable-unsafe-webgpu --use-angle=metal`; scripts read `CDP_PORT` (default 9333). Kill it when done.

## Page pass (src/lib/reading/page.ts, page.wgsl.ts; 2026-10-06, written without a GPU run, unverified)

- Per-block alpha / dy / dx are done by splitting the text draw into runs with a dynamic-offset uniform slot each (not per-instance tables): a run boundary appears only where a map entry exists or the item ranges are not adjacent, so a normal scroll frame is one text call.
- Never draw the envelope [first item of visFirst, end of last block) when item lists are not contiguous (figure cell lists live in the same items table): use `textRuns`. Text blocks may only list item types glyph / rect / image; shape, path, stroke, numeral words in a block list are dropped by vs_text (they belong in figure cells). Glyphs and rects of text blocks must have group = NONE16 (the quad bounds ignore group transforms).
- Quad bounds come from the glyph directory box (dir words 4..7) times size, plus 1 device px; the fragment recomputes the document point from the pixel centre (pos / pxScale), so coverage uses a constant footprint fw = 1 / (emPx * pxScale) and stays crisp at any DPR.
- 8 bit canvas: the shader gamma-encodes (sRGB OETF) and blends in display space, like CSS text; the palette decode in mg_pal is the exact sRGB EOTF so bytes round-trip. float16 extended canvas (only when matchMedia dynamic-range: high): shader writes linear, overlays may exceed 1.
- foldClipEm applies to every pixel by document y: pass a huge value (1e9) when the article has no fold or the fold is open.
- Resize clears the canvas: the pass forces one redraw on the next draw even if frame.dirty is false.

## Reading module (world/src/reading.rs, 2026-10-06, written without a compile, unverified)

- One `world.progress_time` per frame serves the book and reading systems (`reader::tick`); `reading_tick` in the room must not progress the world a second time when the full world is built (`reader::is_full`).
- Relation adds inside systems are deferred (observers fire at merge): write the cache component (`Doc.reading_block`) directly in the system and let the observer only emit the event. Coalesce a clear followed by a set in the event ring or a hover replace emits duplicates.
- Use the exported prefix-max y1 / suffix-min y0 arrays with binary search for culling, not a per-frame query.
- Rust keyword trap: `gen` is reserved in edition 2024; rename (`epoch`). A closure borrowing `d` while it is mutated needs the value copied out first.
- Reading and book share the old names: delete old `Reading`, `Scroll`, `Page`, `Next`, `Visible` components and the Sheet/Issue prefabs in the same change or `component_named` clashes.
- `loadReadingOnly` uses a dynamic import of world.ts to avoid an import cycle (ecs/reading.ts <-> gpu/room/world.ts).

## GPU-only reader traps (2026-10-06, verified in headless Chrome on :9333)

- The reader is plain TypeScript (`src/lib/reading/reader.ts`, `createReader(el, init)`); `Reader.svelte` only mounts it. Keep logic out of Svelte: Andrew asked "why so much svelte".
- `createPagePass(null, ...)` makes its own canvas with `pointer-events:none`; the reader must set `pointer-events:auto` or every wheel and click lands on the element below (the hidden mirror once ate them). The mirror needs `mirror.css` imported (position fixed, left -10000px, `pointer-events:none`).
- `buildChrome` mutates `state.scrollbar` of the ChromeState you pass: copy it back (`sbState.v = state.scrollbar`) or the scrollbar fade restarts every frame and the reader never goes idle (draws == frames).
- Idle check: after 4 s on an article `counters.draws` must stop growing; if it grows, something (a chrome `animating`, a toast, the dirty bit) is stuck.
- Hit test and selection assume glyph x is monotonic within a line: decorations drawn on a line (the code language label) must stay out of `firstGlyph..glyphCount` (`PG.deco` in typeset.ts, honoured in flow.write). The hit accuracy test on the built bins caught it (`bun test ./src/lib/reading`).
- CDP: `Input.dispatchKeyEvent` `type:'char'` does not reach `keydown` handlers; send `keyDown` with `text`. Cmd is `modifiers:4`. Touch needs `Emulation.setTouchEmulationEnabled` then a page reload. Nushell: wrap shell loops in `bash -c`, a `for` over `"1440 900"` passes one argument.
- A heading block's text range can run on into following content (References); use the first line of the block up to the first newline for contents entries.
- Page-pass lightbox: a second frame uniform buffer and bind group (`g1b`) with `emPx`, origin and scroll chosen so the image's document box maps to the target px rect; the run for the image item sits after the main runs in the same segment buffer.
- Overlay alpha below 1 on the top bar lets article text show through behind the title; the bar is opaque.
- Hands-off rules: lanes commit nothing and run nothing; the root rebuilds wasm (`bun run build:world`) and the magazine (`bun scripts/magazine/build.ts --preview`, deterministic: a second run gives the same hashed file names) once.

## One colour, figure contrast, HDR encode (2026-10-06)

- ONE colour system (theme.ts `THEME`): no per-article hue, tint, glow or gradient; the ground shader reads GROUND_WGSL constants. Never reintroduce `themeFor(h)` or a `hue` uniform.
- The extended float16 canvas (matchMedia dynamic-range: high, Andrew's XDR display) is gamma-encoded extended sRGB: the page shader must apply `pg_srgb_enc` on both canvas kinds. Writing linear there gave a black ground, invisible grey bars and a saturated blue (#5777f7 for accent). Headless repro: `Page.addScriptToEvaluateOnNewDocument` overriding `matchMedia` for `dynamic-range: high` before load (Emulation.setEmulatedMedia does not support it). Always screenshot with and without it after a shader or palette edit.
- Figure colours are palette names only; `fig/contrast.ts` (`figureContrast`) runs in `buildFigures` and in `scripts/magazine/tests/fig.test.ts` over every article's figures.ts (shapes 1.5:1, strokes and text 4.5:1, labels 4.5:1 on their fill) with a planted old-neutral control. Neutrals: L 0.50 / 0.38 / 0.32 (0.15 was the ground itself, invisible).
- Scrub cursor: the OS cursor via data-URI SVG (`scrubCursor` in reader.ts), only for `FigureMode.scrub`; the drag readout is an overlay pill plus UI glyphs. Never a GPU-drawn follower.
- Narrow screens (390 px) shrink a 36 em figure to about 9 px per em: labels read small. A narrow-specific figure layout is the proper fix and is not done.

## No HTML page content (2026-10-06)

- The page is WebGPU only: DOM = head tags + one canvas per mode + (error state only) one `#gpu-error` line from `app.html`. Route `.svx` files are compiled to frontmatter only (`src/lib/frontmatter-preprocess.js`); never render their body, never add a mirror, `inert` article or no-WebGPU article. Shelf books are canvas hit regions (`ws.spots`), so tests click canvas coordinates, not `a.spot` (the shared `/Volumes/Projects/tmp/cdp/lib.ts` `openBook` still looks for `a.spot`: click `ws.spots` centres instead).
- SvelteKit's `#svelte-announcer` writes the page title into the DOM after each navigation; the root layout removes it with a MutationObserver. A stray text node check: `tests/e2e/reading/checks.ts` section 4 (planted `<p>` control).
- Another headless Chrome may already own CDP :9333 (check `ps` for `remote-debugging-port=9333`); use a different port and your own `--user-data-dir`, and kill only yours.

## Hot reload (2026-10-06, verified: scripts/scene-reload.test.ts, scripts/scene-hot-test.ts; docs/WORLD.md "Hot reload")

- Save a `.flecs` file with `bun run dev` open: about 30 ms to pixels, state kept. A bad script leaves the scene intact and shows a toast.
- A script entity must never share a name with a Rust component (`Lights {}` did): the component id moves onto a script-owned entity, and the next `ecs_script_update` deletes it, which silently stops the pipeline (state buffer all zeros after a reload). Check with `bun test scripts/scene-reload.test.ts`.
- `ecs_script_update` is not transactional for evaluation errors (it deletes what the script made): always dry run in a scratch world first (`scene::reload` does).
- `new Uint8Array(memory.buffer, wasmCall(), n)` evaluates `memory.buffer` before the call; if the call grows memory the buffer is detached. Call first, then build the view. Vite swallows a rejected `hot.on` listener promise: catch and log inside it.
- Tests that edit scene files run their own dev server on a copy (`SCENE_DIR`), never the shared tree: a half-written script breaks the home page for everyone.
- The first scroll after load teleports the cab to that floor (`room.setProgress`), later scrolls ride; tests consume the first one.
