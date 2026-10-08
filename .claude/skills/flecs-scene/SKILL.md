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

## Museum build

Traps from the RDR4 / exhibit build side (scripts/magazine/exhibit.ts, docs/MUSEUM.md "Built contract").

- **`exhibit_inspect` is the only source of exhibit metadata.** The build never regexes a `.flecs` for Claim, Extent or controls: it boots the committed `src/lib/gpu/room/world.wasm` under bun (`wasiImports`, as `scripts/scene-reload.test.ts`) and reads JSON (`Inspect` in exhibit.ts). A stale wasm without the export makes the build fail with "rebuild: bun run build:world", and the wasm-dependent tests skip with a console warning; a green run with that warning proves nothing about script exhibits.
- **The lint is a pure function over `Inspect`** (`lintExhibit`): test every rule with a synthetic Inspect fixture that fails exactly one rule plus a clean control, so the rules are covered without the wasm. Only `Random`/`Clock` is also checked on the script text (comments stripped).
- **One id namespace**: `exhibits/<id>.flecs` and `exhibits/art.ts` entries share it; both, unknown, or two `::exhibit` for one id fail the build. `::fig` is gone (unknown directive).
- **Timeline blocks are art + 2.4 em strip** (`TIMELINE_STRIP`): Extent h = art h + 2.4 (static mode: no strip), the cell grid covers the art only, the record's x0..y1 cover the whole block. Script exhibits have no items and an empty grid (`gridCols 0`).
- **inputsHash must include `exhibits/*`**, or an edited `.flecs` is skipped as "up to date".
- **dev HMR**: a `.flecs` edit with an unchanged Extent goes out as `exhibit:reload {slug,id,src}` with no bin rebuild (the bin catches up after 5 s of quiet); an Extent change or the first edit of a session is a full rebuild and `{reload:true}`. The Extent is read by `bun scripts/magazine/exhibit.ts --check <file>`.
- **bun tests that build a temp thoughts dir**: `art.ts` imports `$lib/...`, which only resolves inside the repo; rewrite the import to the absolute `src/lib` path when copying it (see tests/exhibit.test.ts).

## Museum reader (src/lib/reading/exhibit.ts, exhibit-fragment.ts, exhibit-hot.ts; 2026-10-06, written without a browser or wasm run: unverified until e2e section 9 runs)

- **The scroll engine has no drag threshold** (`reading_pointer` moves the page from the first pixel). So a touch or pen press on an exhibit part cannot reach it until the exhibit has decided: `attachScroll(..., { filter })` puts the exhibit router in front of every wheel and pointer event, holds a press on a part, and after 8 px either captures it (mostly horizontal on a capturing part) or sends `leave` and replays the stored down into the engine (`engineDown`). Mouse never drags the page, so a mouse down inside an exhibit is simply swallowed (no selection).
- **Pointer state is pure and tested** (`createRouter`, `routeKey`, `xkeyOf` in exhibit.ts, exhibit-draw.test.ts): reader.ts only wires DOM events. A swallowed event is remembered (`routed`) so the later `onPointerDown/Move/Up` skip selection; a captured pointer keeps routing outside the block until up or cancel (cancel sends `leave`, not `up`).
- **Esc with an exhibit focused only releases the focus** when the exhibit does not consume it; otherwise it would close the article. Tab the exhibit does not consume releases focus and falls through to the link cycle. Cmd/Ctrl combos are never offered.
- **Scissor = the block rect exactly** (`exhibitClip`: rect, then viewport, then the fold clip for blocks with `BlockFlag.folded`; the enter rise `dy` moves rect and clip together). Items outside the frame are still emitted on purpose: the clip is what cuts them, and the e2e ring check proves it. Never widen the clip to the items.
- **One overlay buffer, per-exhibit draws**: chrome overlays are packed first, each exhibit's after them, and exhibits draw earlier through `draw(4, n, 0, firstInstance)` (`instance_index` includes `firstInstance`). `packOverlays/packUiText` take an `at` offset and return the count written. MAX_OVERLAYS 2048, MAX_UI_GLYPHS 8192.
- **Overlay shapes** live in `k.z` (kind: 0 rrect, 1 circle, 2 line, 3 arrow, 4 ring, 6 hatch) and `k.w` (stroke width or hatch pitch, px) of the overlay record; line and arrow carry (x, y) start and (w, h) delta in the box fields and the vertex shader widens their bounds by the stroke. A shape the host does not know draws as an rrect: keep OVL_SHAPE and the shader table in step.
- **page.wgsl.ts and page.ts are generated from the RDR schema**: after Lane B's rename the record is `exhibit` (MH.exhibits, SZ_EXHIBIT, `g('exhibit', ...)`, `b.ex`). Timeline art still draws through the fig pipeline, only for exhibits with `gridCols > 0`, with channels evaluated at `XS.clock` (`evalTimelineChannels`).
- **The URL fragment shares the hash with anchors**: the section spy calls `replaceHash('#id')`, which would wipe `#x:...`; the reader's env wraps it in `keepExhibitFragment`. `goToHash` strips `x:` parts first. Writes are debounced 300 ms on the `exhibitState` event and use `replaceState` only.
- **A width-class change reloads the article** (`openArticle` with a key): snapshot every exhibit by id before `reading.load` and restore after, else the exhibit resets on rotate or resize.
- **Idle**: the reader draws only when `RD.dirty` (bit 5 = an exhibit changed or animates), an enter animation, `needDraw` or chrome says so. Every routed exhibit call sets `needDraw` (one frame). If `counters.draws` keeps growing with nothing running, the engine is leaving dirty bit 5 set.
- **Float32 in tests**: items live in a Float32Array, so `0.05 em * 20` is `1.0000000149`: compare with `toBeCloseTo`.
- **Shell**: this Mac's shell is nu; `sed -i` and unquoted `--include=*.ts` fail. Use python for edits and `rg -g`.

## Hover affordance (world/src/hover.rs, 2026-10-06, verified headless DSF 2)

- Tunables are `HoverTune` on the `Magazine` prefab (10-prefabs.flecs), read every frame: save the file to retune. Never name a system like a Rust component (`HoverTune` system would collide; it is `HoverFrame`).
- Shelf rows are rewritten into the GPU object buffer from `hover_state_ptr` (entries: cover obj, page-block obj, mask, rows); while `busy` the room uses the moving (view) path, because the progressive accumulation would ghost a moving book. The rim is shader-side: kind 2 `alb.w` = amount, `r2.w` = intensity, both 0 on every other card; the same edit is in `cs_view` and `radiance`.
- Another lane's half-edited files can break SSR (`page.wgsl.ts` SCHEMA) on the shared tree. Test from `git worktree add --detach /Volumes/Projects/tmp/<x> HEAD`, copy your files in, symlink `node_modules` and `static/magazine`, and add `server.fs.allow` for the real tree in the worktree's vite.config. `pkill -f` on a port can miss your old server: check `lsof -iTCP:<port>` and kill by PID.
- Hover tilt pivots on the bottom edge (never sinks into the shelf); `book::card_row` includes the hover pose so a click on a hovered book is continuous.

## Museum module (world/src/museum, 2026-10-06, verified by `bun test src/lib/reading/exhibit.test.ts` on the wasm)

- **Script names live in the room's root namespace**: the museum vocabulary (`Left`, `Button`, `Extent`, ...) and the room scripts share it. The component `Frame` collided with the picture-frame prefab `Frame` of 12-decor.flecs (`cannot open scope for 'Frame' (missing reflection data)`), so it is `Extent`. A new museum name needs a boot of the full room (`boot(undefined, true)` in exhibit.test.ts), not only the bare reading world.
- **`each_child` is table order, not declaration order**: `b_reset` (no `LabelAlt`) came before `b_run` (has it). Sort children by `Order`, then by entity id: ids are allocated as the script declares, so the id is the declaration order (`model::children`). Never rely on child order for Tab order, rule priority or presets.
- **Presets are plain entities, not prefabs**: `inc : Preset {...}` next to the exhibit; the runtime reads them as data. `each_child` on a scope may not list prefabs, and nothing instantiates them. Part kinds are found by the direct `IsA` of the part (`e.has((IsA, Button))`), not by tags.
- **A pair, tag or second component on the line of another term fails** (`unexpected '('`): one term per line, every nested entity as a block.
- **Fixed clock**: `Ex::advance` takes whole 1/60 s ticks from an f64 accumulator with 10 microseconds of slack. A frame of `1000/60` ms is 0.016666666 in f32, just under `TICK` (0.016666668): without the slack that frame runs no tick and the first Step seems to do nothing.
- **Wasm memory grows** (an `exhibit_inspect` builds a scratch world): a `Float32Array` view over `memory.buffer` taken before a call is detached after it (`rd[13]` reads NaN). Derive views per read.
- **Release is `panic = "abort"`**: a panic in an exhibit kills the whole world. Use `try_cloned`, `try_lookup`, `.get()` and return `Err(path: reason)`; every error string starts with the entity path or `line:` so the author finds it. A failed load destructs its scope (entity count returns to what it was; the test checks it).
- **Hot reload**: `exhibit_reload` dry-runs the script in a scratch `World` with the vocabulary, then destroys and rebuilds the scope under the same name `ex<N>` and restores the snapshot payload (no hash check, indexes validated). If the rebuild fails it rebuilds the old source. A script entity update is not used: `ScriptEntityView::update` evaluates at the root scope.
- **Golden numbers** (simulated through the wasm): binary increment 1011 + 1 = 1100 and 111 + 1 = 1000, 8 steps each; the 3-state busy beaver (A0 1RB, A1 1RH, B0 0RC, B1 1RB, C0 1LC, C1 1LA) halts after 14 steps with six 1s.
- **Seam traps found when the three museum lanes met (2026-10-06)**: (1) the Rust `inspect` and the TS `Inspect` were written separately and disagreed on every key (`frame` array vs `{w,h}`, no `items/controls/tones/components`); the shape now lives in docs/MUSEUM.md under "Built contract" and the exhibit.test.ts wasm tests are NOT skipped any more (a missing `exhibit_inspect` export fails them). (2) `load_inner` cleared `exs[ex]` without `sync`, so a failed load left `XS.loaded` 1 from the old exhibit: sync after every registry change. (3) pointer kind 3 (leave/cancel) must clear `capture` as well as `pressed`, else a cancelled drag keeps routing; the TS router only sends leave on hover exit when it holds no capture. (4) the lint's Random/Clock text scan must strip string literals (a `Binds: {"Clock.t"}` or a title is not a use). (5) `bun scripts/reading/world-smoke.ts` is the headless ABI check; the engine clamps scroll to the page (collapsed fold max 110 em), so a test scrolling past it must clamp its expectation, and clearing reduced motion does not restart a paused timeline (press play).

## Museum reader look (2026-10-07)

- Layout lives in the build (`scripts/magazine/flow.ts`): hero (kicker, title 5.8em wide, dek, plaque card with rooms list), `ROOM nn / NN` thresholds (hairline + accent rule), a wall-label card under every exhibit (`FIG. n · year · KIND`, title, `Try`/`Look`), a NEXT ROOM footer. Plaque and label blocks carry `BlockFlag.plaque` (bit 128 of the u8 flags; no format bump). The reader gives them a 7px scroll parallax and the enter reveal; reduced motion turns both off.
- Spotlight: `ExhibitDraw.under` overlays are drawn BEFORE page text and timeline art (art is drawn before exhibit overlays, so a backdrop in `overlays` would tint it). Overlay shape 7 is a soft ellipse (`spot`). Wake (`wakeOf` in reader.ts) is stateless and scroll-linked, 1 under reduced motion.
- `RectKind.panel` (8) has an ink hairline, `codeBg` (1) keeps the rule-colour edge. Room rail: `roomRail` in ui/widgets.ts.
- Trap: a new `ExhibitKind`/`FigureMode` use in flow.ts needs the import from format.ts, or the first script exhibit throws ReferenceError at build.
- Trap: placing a `.flecs` exhibit in a post requires scripts/magazine/tests/exhibit.test.ts to copy it into its temp thoughts dir (it only copied art.ts).
- Trap: `cannot set value of 'Timeline': not a component` means world.wasm and the .flecs scripts are out of step (a rebuild in flight); timeline exhibits do not draw until `bun run build:world` is redone by the world lane.
- Measured: reader GPU frame median 0.60 ms (5 runs, Turing exhibit on screen, 1440x900 DSF 2), background GPU 69%, load 11.6.

## Museum stepper families (2026-10-07)

- **Entity ids are not declaration order after a scope is rebuilt** (hot reload, `exhibit_load` of the same index twice): flecs recycles ids LIFO, so the `Order`-then-id sort in `children()` scrambles. Seen as Tab order and node order changing on the second load. Rule: anything order-sensitive is sorted canonically in the reader (parts by layer then y, x, name; graph nodes by y, x, id; Defs resolved by name to a fixpoint) or carries an explicit `Order`. Check: load a script twice in a test and compare snapshots and labels.
- **`{` inside a flecs string starts interpolation**: `Content: {"fn main() { x }"}` fails with "expected '}' at end of interpolated expression". Keep braces out of strings.
- **Forward `(Reads, x)` references do not resolve**: declare the node first, so a cycle cannot even be written; test "a source with inputs" instead.
- **The generated Timeline script must not set a `Timeline` component** (it is a prefab, not a component; the clip lives in `Clip` and defaults to the load record). It is `fig_x : Timeline {}`.
- **`60-museum.flecs` is not in scene.rs SCRIPTS**: `museum::setup` runs it as `museum::prefabs`; the dev page sends it by name, which `scene::override_source` routes to `museum::override_vocabulary` (applies at next page load).
- **Exhibit text needs UI glyphs**: the UI tables only hold fixed ranges plus titles and headings; a character outside them (the lambda) draws the hatch notdef. `build.ts uiTexts` now adds every `exhibits/*.flecs` source.
- A test that regex-matches a preset body must not use `[^}]*` (a `Title: {"..."}` contains `}`).
- Native `cargo check` fails on the vendored flecs (C-unwind); check with the wasm target and the wasi-sdk env of `scripts/build-world.ts`.


## Museum visual pass (2026-10-07, own dev server :5321, headless Chrome DSF 2)

- `/thoughts/ifd` "shows no exhibit": the post has an In brief fold and `graph` sits in the folded body. A fresh load clamps scroll to the collapsed fold (`__reader.state[26]` about 3856 px); run `__reader.act('aa:full')` first. Not a build bug.
- A ring item's aux is the corner radius em; the stroke is `RING_STROKE_EM` (exhibit.ts). Rust once passed `radius.max(stroke)` and the shader drew the box's inscribed circle, so every focus ring and head ring was a fat disc over the button label. Check: click Step, the ring must be a rounded outline.
- A generated Timeline script must carry the block's Extent (`exhibitSource` writes `Extent: {frameW, frameH}`); the prefab's 36 x 14 put the play and scrub strip in the middle of any taller art, and a static figure showed "Animated figure / Press play" because flow.ts compared a string mode with `FigureMode.static` (use `art.strip === 0`).
- Graph node words: settled words (cache hit, rebuilt, edited) sit on the hash row; only a stale prediction shares the name row, else `build-script` and `cache hit` overlap.
- Driver: /Volumes/Projects/tmp/museum/{lib,ex,final,perf}.ts (`__reader.model.exhibits`, `reading.exhibit.pack(ex)` labels give click targets).
- 390 px still shows 36 em exhibits at about 9 px per em (labels about 8 css px): needs a narrow Extent per exhibit, not done.

## Narrated film (2026-10-07; docs/NARRATED.md section 16)

- A template is instantiated as a component: `Demo: {a: "x"}`. Props need defaults (`prop txt = string: ""`) and cannot be called `name`. A template named like a Rust component (`Reveal`) breaks with "number of props does not match members": rename it (`RevealScene`).
- `\{` escapes a brace in script strings. An instance name resolves as a sibling, so a beat may only reference lines declared above it ("unresolved identifier").
- Rust `String` in a component needs a `move` hook: flecs falls back to memcpy and the source is dropped later (double free, garbage text, traps in `film_inspect`). The vendored flecs_ecs sets `move_swap`; the vendored flecs.c zero-initialises template prop storage. Symptom of regression: "Out of bounds memory access" in `reading_init` or random caption text.
- Debug recipe: build with `CARGO_TARGET_DIR=/Volumes/Projects/tmp/film/target-dbg`, run a node harness against the debug wasm for a real trace. Native `cargo test` does not compile; tests run the wasm under `bun test`.
- `film_pack` returns a 64 float meta row and a draw buffer longer than `count`: hash only the live part (`count*8`, `8+8*mounts`), stale tails differ between engines.
- Headless e2e: `play()` on the voice element is refused without a gesture; the film must fall back to the wall clock (`voice.paused`), else the clock sits at the resume position forever.

## IFD graph figure redo (2026-10-07)

- Curves: the host has no bezier shape; `kind_graph.rs` samples a cubic into round-capped `line` items (opaque tones only, translucent segments darken at the joins) and ends with one `arrow`. Long edges run level at the source's y and take one S in the gap before the target, so lay nodes out in layers and keep each long edge's row empty in the columns it crosses.
- New tones (abi.ts `TONE_NAMES`, exhibit.ts `TONES`, Rust draw.rs ids 11..14): `node`, `nodeHi`, `edge` are ink mixed over `surface.card` (`MIX`), `accentInk` is the dark text on amber. Read from THEME at run time; the Rust ids must stay in TONE_NAMES order (test: exhibit-draw.test.ts).
- Animation lives in the Core (`anim(dt)`, `animating()`), is driven by the fixed tick, is never saved or hashed, and must not change which label strings exist: `exhibit-machines.test.ts` compares `labels()` before and after a snapshot restore, so a crossfade that emits a second label (or a faded item skipped at alpha 0) fails it. Per-item alpha is flag bits 16..23 (0 = opaque, minimum 1/255).
- The card draws its own faint border as two rrects (RULE then PANEL inset 0.04 em): a `ring` item has a fixed 0.08 em stroke. The machine family no longer draws the caption inside the card (the reader prints it under the block); the tape family still does.
- HEAD may not build (film WIP `layout` module missing): build the wasm from a `git worktree add --detach` with `world/src/film/{mod,model}.rs` checked out from a good commit, symlink `world/.toolchain` and `node_modules`, copy the world.wasm back. A pure height cap of 22 em applies to exhibit Extents (lint).
