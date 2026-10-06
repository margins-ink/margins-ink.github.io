# The room world (Flecs ECS in wasm)

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
