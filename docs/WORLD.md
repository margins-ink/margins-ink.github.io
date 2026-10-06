# The room world (Flecs ECS in wasm)

No HTML page content: the home page is the canvas and an empty `#world-spacer` (scroll length of the elevator), the shelf's books are hit regions of the canvas (click, pointer cursor, Tab/arrows/Enter inside the canvas: `World.svelte`), not DOM links; the HTML list of pieces and the hidden accessible copies are deleted. Head tags only. Cost, Andrew's explicit decision (2026-10-06, "remove the HTML version of pages, just have the projection which is WebGPU"): screen readers, search engines indexing body text, Reader Mode and clients without WebGPU get nothing but the head tags and, where WebGPU is missing or fails to start, one line of text. Nothing is added back.

The room's scene (floors, furniture, magazines, window panes, lamps, signs) is declared in a Flecs
world written in Rust (`world/`, crate `flecs_ecs` 0.2.2) and compiled to `src/lib/gpu/room/world.wasm`.
It runs once at startup: `src/lib/gpu/room/world.ts` passes the article list in, gets the packed
buffers back, and `room.ts` uploads them unchanged. There are no per-frame JS<->wasm calls.

```
world/scene/*.flecs     declarative scene (prefabs, palettes, floor templates)   embedded with include_str!
world/src/components.rs reflected component types the scripts set by name
world/src/scene.rs      loads scripts, creates articles, floors, magazines (the count-dependent layout)
world/src/export.rs     flattens the world into the shader's packed buffers
world/src/lib.rs        the wasm exports (world_input / world_build / world_buf / world_buf_len)
src/lib/gpu/room/world.ts   loader: input JSON in, {floors, objs, panes, lvl, links, levelH, roomH, roomD} out
scripts/build-world.ts  `bun run build:world`
```

## Model

Components (all `meta`-reflected, plain names, see `components.rs`):

| Component | Meaning |
|---|---|
| `Kind {id}` | shader treatment: 0 box, 1 glass pane (sky light), 2 textured card (atlas rect in `Tex`), 4 room shell, 6 wood-grain box, 8 sphere, 9 emissive sphere (lamp) |
| `Center {x,y,z}` | position. Local to the nearest ancestor that has a `Center`, else floor space (y up, metres, floor level at y 0) |
| `Half {x,y,z}` | half extents (sphere: radius in `x`) |
| `Albedo {r,g,b}`, `Tex {x,y,w,h}` | colour and atlas rect (default 0,0,1,1) |
| `Lean {angle}` / `Flat {theta, per_floor}` | rotation: tilt about x, or lie flat turned by `theta + per_floor * floorIndex` |
| `LampColour {r,g,b}` | on a `Bulb`: the level's lamp colour. The bulb is the level's lamp (position, radius `Half.x`) |
| `Plaster`, `Wainscot` | wall colours on palette entities |
| `Dims {level_h, room_h, room_d}` | on the `Building` entity; the renderer takes these from the export |
| `Floor {index, basement}` | on each floor entity |
| `Article {index}` | on each Thought entity (`articles::<slug>`), `index` = position in the input list |
| tags `TexSign`, `TexMap` | the object's `Tex` is the floor's title-sign rect or the world-map rect, supplied by TS at build time |

Prefabs (`scene/10-prefabs.flecs`, `30-rooms.flecs`), all with `IsA`:

- Object bases: `Object` (grey, full tex) > `Solid`, `Glass`, `Card`, `Shell`, `Wood`, `Leaf`, `Bulb` (each sets `Kind`).
- Composites with children: `Window` (4 `Glass` panes, children positioned relative to the window), `Plant` (pot + 3 leaves), `DeskLamp` (base + `Bulb`).
- `Magazine : Card` (size, lean). One instance per article is created by `scene.rs`.
- Floor templates: `Room` (shell, shelf, sign, desk, rug) > `Furnished` (window, tray, cup, notes, plant, lamp) > `Lobby` (palette0, map), `Upper` (palette1), `Lower` (palette2); and `Basement : Room` (palette3, crates, hanging bulb).

Relations:

- `ChildOf Floor`: every object of a floor, including instantiated prefab children and magazines, is a child of its floor entity (`floor0`, `floor1`, ...). Floor k is placed at `y - k * level_h` on export.
- `(Uses, palette)`: floor template to wall palette entity (`palette0..3`); the shell takes its colours from it.
- `(Displayed, magazine)` on an `Article`: the magazine object showing that article. The exporter turns it into the `links` table.
- `IsA`: prefab inheritance (values like `Albedo` and `Half` are inherited and overridden per instance).

Floors are derived from the input: one per year of the non-archived articles in first-seen order
(`Lobby`, `Upper`, then `Lower`), then an `Archive` floor (`Basement`) if any article is archived.
Magazine placement along the shelf depends on how many articles a floor has, so it lives in
`scene.rs`, not in script.

## Script format

Flecs script (https://www.flecs.dev/flecs/md_docs_2FlecsScript.html). Rules that bit us:

- One component per line. A comma between components on a line is a parse error (commas only separate members inside `{}`).
- Prefab with children: `prefab Window : Solid { pane_tl : Glass { ... } }`; children of a prefab are copied (as children) into every instance, recursively.
- Instances need a body: `m : Mag {}` works, bare `m : Mag` does not.
- Reflected struct members are set positionally `Half: {0.1, 0.2, 0.3}` or by name `Lean: {angle: 0.14}`.
- Declare an entity with a pair as `(Uses, palette1)` on its own line.
- Order of the packed objects: prefab base children first, derived next, magazines last. The shader does not depend on the order (the multiset of packed objects is identical to the old hand-built list).
- Parse errors print to the browser console as `world.wasm: <script>: <line>: ...` (the `flecs_log` feature is on for this).

To add an object: put a line in the right prefab in `scene/*.flecs`, `bun run build:world`, reload. To add a floor
kind, add a prefab in `30-rooms.flecs` and pick it in `scene.rs`.

## Packed buffers (unchanged from the old `buildLevels` upload)

- `objs`: 28 floats per object: `c.xyz, kind, h.xyz, 0, rot row0 (3+pad), row1, row2, albedo.rgb + (kind 4: levelIndex*2), tex.xyzw` (kind 4: albedo = plaster, tex.xyz = wainscot).
- `panes`: 16 floats per level: up to four pane centres `(x, y, 0, 0)` (z is 0 on purpose: the shader samples the z = 0 plane).
- `lvl`: 12 floats per level: `[start, count, paneCount, 0, lamp.xyz, lampRadius, lampColour.rgb, 0]`.
- `links`: `Int32Array`, for items[i] the object index of its magazine (-1 if none).

## Toolchain (what worked, pinned)

`flecs_ecs` 0.2.2 builds flecs.c with `cc`; `wasm32-unknown-unknown` has no libc headers, so the module targets
**`wasm32-wasip1`** with the **wasi-sdk 34** sysroot (clang + wasi-libc headers, sha256 pinned in `scripts/build-world.ts`,
downloaded to `world/.toolchain/`, gitignored). Rust stable 1.98.1. Only 12 WASI preview1 imports are needed
(clock, random seed, empty environ, stderr, ...), implemented by hand in `world.ts` (no WASI shim dependency).
Optimised with binaryen 132 `wasm-opt -Oz` via `bunx`. Size: ~700 KB (about 258 KB gzip), build of the scene ~5-20 ms at startup.

Traps:

1. `flecs.h` picks Windows `*_s` string functions unless it sees a POSIX target and wants `execinfo.h`. `-D__COSMOCC__` in `CFLAGS_wasm32_wasip1` fixes both (it is a flecs special case that means "POSIX without execinfo").
2. `flecs_ecs` 0.2.2 on wasm expects `extern "C"` bindings, but the shipped `flecs_ecs_sys` bindings are `extern "C-unwind"`; regenerating with bindgen produced an incomplete file. Fix: `world/vendor/flecs_ecs_sys` is a copy with `C-unwind` replaced by `C` in `src/bindings.rs`.
3. `flecs_ecs` `meta` + wasm does not compile (an `Entity, WorldRef` import is cfg'd out for wasm but used there). `world/vendor/flecs_ecs` carries the one-line fix. Both vendored crates are wired in through `[patch.crates-io]`; see their `WASM-PATCH.md`. Worth an upstream PR (Indra-db/Flecs-Rust).
4. The pre-generated bindings reference `ecs_alert_desc_t`, so the `flecs_alerts` feature (which pulls metrics and units) must be on even though nothing uses it.
5. A reflected component used by `IsA` copy/override needs `Clone` + `Default` derived, otherwise a runtime panic ("Clone is not implemented ...") traps the module.
6. `wasm-opt --all-features` emits an import encoding that browsers' and Bun's parsers reject; pass the explicit `--enable-*` list as in the script.
7. Never run cargo with `regenerate_binding`: the sys build script rewrites `src/bindings.rs` inside whatever source dir it was resolved from (it clobbered the shared ~/.cargo registry copy once).
8. Hash maps in std call WASI `random_get`; it must exist in the import object.

Rebuild: `bun run build:world` (writes `src/lib/gpu/room/world.wasm`, which is committed so the dev server works without a Rust toolchain).

## Reader (articles as Flecs entities)

`scene/40-reader.flecs` declares `prefab Sheet : Solid { Kind: {10} ... }` (one page sheet) and `prefab Issue { Reading, Scroll }`.
Every article entity (`articles::<slug>`) is `IsA Issue` and carries `Article`, `Reading {t, vel, target}` (spring state, 0 shelf .. 1 reading)
and `Scroll {y_em, target_em, vel, max_em}`. `article_open` instantiates one `Sheet` per page, `ChildOf` the article,
with `Page {index, y0_em, h_em}`, the relation `(HasPage, page)` on the article and the chain `(Next, page)` / `(Prev, page)`
between pages; the close finishing (or a snap close, or opening another article) despawns them. `world/src/reader.rs` holds the glue and the four systems
(declared in this order, one pipeline pass per `world_tick`): `ReadingTween` (exact critically damped spring, omega 9 rad/s, no overshoot at any dt,
snaps within 1e-3), `ScrollIntegrate` (fling decays 0.95 per 60 Hz frame, clamps to `[0, max_em]`, `y_em` = target), `SheetCull`
(tags `Visible`, counts the first/count of visible sheets, max 3), `PackObjs` (writes the state buffer).

Exports added to `lib.rs` (all `extern "C"`): `world_tick(dt_ms)`, `article_open(index, page_count, sheet_w, sheet_h, gap, snap) -> 0 ok`,
`article_close(snap)`, `scroll_by(dy_em)`, `scroll_to(y_em)`, `scroll_fling(v_em_s)` (extra), `set_viewport(view_h_em)`,
`set_reading_pose(cx, cy, cz, half_w, half_h)`, `event_poll() -> kind<<24 | arg` (1 Opened(article index), 2 Closed, 3 ScrollEnd, 4 PageChanged(page)),
`reader_state_ptr() -> *const f32`, `world_entity_count()`. TS wrapper: `world.reader` (`ReaderApi` in `world.ts`, state indices in `RS`).

State buffer (40 f32): 0 t, 1 target, 2 scroll_em, 3 scroll max, 4 active article (-1 none), 5 active magazine object index (-1), 6 lift = smoothstep(0,0.28,t),
7 camT = smootherstep(0.15,1,t), 8 first visible page, 9 visible count (<=3), 10 page at view centre, 11 page_count (not written yet, JS knows it),
12..40 animated magazine row in the 28-float `objs` format (the `objs` upload keeps the shelf pose). Magazine: position lerps to the reading pose with
`fly = smootherstep(0.12,1,t)` plus a 0.06 m z bump `lift * (1 - fly)`, lean about x goes to 0 over the lift, half extents go to `(half_w, half_h, 0.006)`.

Traps:
1. Systems must not borrow the glue state (`RS`): `world_tick` clones the `World` handle out and calls `progress_time` with no borrow held; systems read `thread_local` `Cell`s (dt, active article, viewport, scroll) instead.
2. Entity count: `world.count(Wildcard)` is stable across open/close only after one warm-up cycle (the first open lazily creates tables); the smoke test takes its baseline after one cycle.
3. Memory growth detaches `Float32Array` views: `world.reader.state()` re-derives the view on every call; do not cache it across a call that can allocate (`open`, `tick`).
4. `scripts/reader-smoke.ts` (bun) is the leak test: 50 open/close/switch cycles, spring overshoot check, event order, scroll clamp.
