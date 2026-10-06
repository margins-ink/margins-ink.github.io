# WAVE 3: Flecs-declared magazine, Rust renderer and layout, real WGSL files

Status: plan, 2026-10-06. No code written or run for this document (another agent is editing the tree). Facts are marked **read** (from a primary text this session), **reported** (from a secondary description or crates.io metadata) or **unverified** (to be settled by a spike in step 0). Builds on `docs/MAGAZINE.md`, `docs/WORLD.md`, `docs/READER.md`, `.claude/skills/flecs-scene/SKILL.md`.

Andrew's decisions (all five, binary size no concern, Rust wherever there is no DOM):

| | Decision |
|---|---|
| A | The magazine system is declared in Flecs script (`*.flecs`): spread templates, figures, articles. Packed by the Rust world. TS templates, figure DSL, `spread.json`, and `distill:` frontmatter are deleted. The `.svx` stays the author's text. |
| B | All WGSL leaves TS template strings: real `.wgsl` files, validated at build time by naga (pinned), shipped via `include_str!` (Rust) or `?raw` (the transitional TS). |
| C | The whole renderer (pipelines, buffers, bake, frame loop, view/still, present, UI pass) is a Rust crate on `wgpu`, `wasm32-unknown-unknown`, browser WebGPU backend. A thin JS shim stays. |
| D | Shaping, Knuth-Plass, grid solver, planner are one Rust crate used by the build binary and, in the browser, for live relayout. |
| E | `scripts/magazine/*` becomes a Rust binary (`magazine`) plus a ~60 line JS orchestrator (vite plugin). |

## 0. The shape of the answer

```
 build time (native)                                 browser
 ------------------                                  -------
 article.flecs + templates.flecs ─┐                  world.wasm  (wasip1, C Flecs)   runtime state: Spread, Figure clocks,
 post +page.svx ──────────────────┤                              Reading, Scroll, scene objs; unchanged contract
 fonts, images ───────────────────┘                  mag.wasm    (unknown-unknown, wgpu, wasm-bindgen)
        │                                                          mag-gpu renderer + mag-layout/mag-text relayout + input/hit
   `magazine build`  (mag-build: links mag-world native,           │
   mag-layout, mag-text)                                    shim.ts (~150 lines): canvas, DPR, resize, rAF,
        │                                                           pointer/wheel/key forwarding, fetch, createImageBitmap
   static/magazine/<slug>.ir.bin  (ArticleIR: post blocks, templates, compiled figures)
   static/magazine/<slug>.<class>.bin (RDR2, same bytes mag-layout makes live)
   static/magazine/fonts.bin + subset fonts
```

Two decisions that shape everything else:

1. **Two wasm modules, not one.** Flecs is C (flecs.c). It builds today only for `wasm32-wasip1` with the wasi-sdk sysroot and hand-written WASI imports (`docs/WORLD.md` Toolchain). `wgpu` for the browser needs `wasm32-unknown-unknown` + `wasm-bindgen` + `web-sys`. A single module would need flecs.c compiled for unknown-unknown with a libc shim and WASI imports inside a wasm-bindgen module: possible, fragile, and it buys nothing, because the boundary is tiny (one copy of the packed `objs/panes/lvl` at startup, ~200 B of state per frame, event polls). Natively (build binary, all tests) both are linked into one process, so the bridge never appears in tests. Revisit only if spike S4 shows the bridge or the second instantiate costs more than 5 ms of startup.
2. **The browser relayouts from `ArticleIR`, not from `.flecs`.** The Flecs script is parsed once, at build, by the native world. The build emits a compact serde-encoded `ArticleIR` (post blocks with runs, the solved template set, compiled figures, palette, voice). `mag-layout::layout(ir, class, viewport) -> RDR2 bytes` is the same function on native and wasm. The browser world keeps only runtime state; it never parses magazine script (saves wasm startup and keeps the script format free to change).

## 1. Research (2026-10-06)

| Item | Finding | Status |
|---|---|---|
| `wgpu` | 30.0.1 (2026-08-22), MSRV 1.87, `MIT OR Apache-2.0` (crates.io API) | reported |
| browser backend | README: "When running in a web browser ... without the `"webgl"` feature enabled, `wgpu` relies on the browser's own WebGPU implementation. WGSL shaders are simply passed through to the browser" (https://github.com/gfx-rs/wgpu/blob/trunk/README.md). Cargo.toml: feature `webgpu` = `web`, `naga?/wgsl-out`, `wasm-bindgen-futures`, web-sys (Document, Navigator, Window, WorkerGlobalScope...) (https://github.com/gfx-rs/wgpu/blob/trunk/wgpu/Cargo.toml) | read |
| features we use | `default-features = false, features = ["webgpu"]` for mag.wasm; `["wgsl", "metal"]`-style native for tests. Whether `wgsl` is required to call `create_shader_module(Wgsl)` on the web backend, and whether it drags naga into the wasm: **unverified**, spike S1 measures both. Never enable `webgl` (house rule: WebGPU only). | unverified |
| `naga` | 30.0.1 `MIT OR Apache-2.0`; pin `=30.0.1` equal to the wgpu pin so the validator and the native test backend are one version. `naga_oil` rejected (version lag behind naga, a second dependency for 30 lines of include handling). | reported |
| shaping | `harfrust` 0.14.0 (2026-10-04), MIT, MSRV 1.85, features `std`, `libm`. LICENSE head read: "MIT ... Copyright (c) HarfBuzz developers, Copyright (c) 2020 Yevhenii Reizner". Successor of `rustybuzz` 0.20.1 (MIT, last release 2024-11-12, stale) and lives in the HarfBuzz org. **Choose harfrust.** Lane must read the full LICENSE of the 0.14.0 tarball (and `read-fonts`, `skrifa`) and store it under `docs/upstream/wave3/` with `SOURCE.md` before the first line of code. | head read, rest reported |
| outlines and variable fonts | `skrifa` 0.48.0 (fontations), `MIT OR Apache-2.0` (crates.io). Draws outlines at a variation location, so the build needs no static instancing (replaces opentype.js and the fonttools instancer step). harfrust shapes a variable font at a location too. | reported |
| font subsetting | `klippa` (fontations subsetter) for the browser subset fonts. Maturity **unverified**: spike S3 compares its output to `hb-subset`; fallback is shipping the full variable fonts (Inter ~800 KB, size is no concern). | unverified |
| Markdown | `markdown` (markdown-rs, MIT, mdast output like remark, frontmatter, GFM, math) plus an own pre-pass for `::fig{}` and `:::code-wide` directives (markdown-rs has no directive syntax) and for the 3 Svelte tags `Cite`, `References`, `StickyNote`. Pin and read licence at lane start. | reported |
| Code highlight | `syntect` (MIT, `fancy-regex` pure Rust) with the two shiki themes converted to `.tmTheme`; palette quantisation unchanged. Parity with shiki token colours is a gate (T5). | reported, parity unverified |
| Math | **stays JS**: MathJax 4 (no maintained Rust equivalent produces glyph paths). One 40 line node sidecar `tools/mathjax.mjs` run by the orchestrator, output cached by `sha256(tex)` in `static/magazine/math.cache.json` (committed, 6 equations in the corpus). The only TS/JS in the pipeline besides the vite plugin. | decision |
| Images | `webp` (libwebp, BSD-3) and `image` natively in `mag-build`; `sharp` removed from the magazine path. Fallback if lossy parity is bad: keep `sharp` in the same sidecar as MathJax. | reported |
| Hyphenation | Port `scripts/magazine/hyph.ts` 1:1 (Liang; the Kuiken notice stays in `docs/upstream/magazine/hyph/`), not a crate: exact parity with the oracle, no new licence surface. KP port 1:1 from `kp.ts` for the same reason. | decision |
| Flecs script surface | Flecs 4.1 (`FLECS_VERSION_MAJOR 4, MINOR 1`, read in `world/vendor/flecs_ecs_sys/src/flecs.h`); flecs.c contains the `template`, `prop`, `const`, `for`, `using`, `module` keywords (read, `flecs.c` keyword table). String members, enum-by-name, `for` ranges, string interpolation, multi-line strings: **unverified**, spike S2 parses the worked example in section 3 as written. | partly read |

## 2. Crate layout

One cargo workspace at the repo root (`Cargo.toml`, `crates/*`). `world/` moves to `crates/mag-world` with its `vendor/` and `[patch.crates-io]` (the move is the root's job, in a window when the ECS lane is idle; see risk 4). Per-package profiles: `mag-world` keeps `opt-level = "z"`; `mag-web` `opt-level = 3` plus `wasm-opt -O3` (CPU work in the browser is layout and the frame loop; size is no concern). No sccache. Nightly allowed and pinned if a spike shows it pays (build-std for smaller panic/fmt), else stable 1.98.1.

| Crate | Kind | Contents | Depends on | Targets |
|---|---|---|---|---|
| `mag-format` | rlib | RDR2 types, `pack`/`parse`, `bytemuck` Pod records, schema table; `build.rs` writes `format.gen.wgsl` (header consts, record sizes, field offsets) so the Rust schema is the single source of the WGSL constants | `bytemuck` | native, wasm |
| `mag-text` | rlib | shaping (harfrust), outlines (skrifa), Slug band builder, quad conversion, KP, hyphenation, microtype, text measure, glyph table builder, font set loader | harfrust, skrifa, `libm` | native, wasm |
| `mag-layout` | rlib | track/grid solver, frames, planner + copyfit, template solve, figure compiler (nodes + tracks to items, channels), `Edge` router, palette (OKLCH, gamut check), `ArticleIR` (serde, `postcard`), emit to RDR2 | mag-format, mag-text, serde, postcard | native, wasm |
| `mag-world` | rlib + cdylib | existing scene/reader systems, plus `mag.rs`: reflected magazine components, `lift_article(world, slug) -> ArticleIR` with fail-closed validation, runtime Spread/Figure systems | flecs_ecs (vendored), mag-layout (types only) | native (build/tests), wasip1 (browser) |
| `mag-gpu` | rlib | wgpu renderer (section 5), `shaders/*.wgsl`, `build.rs` (include expansion + naga validation) | wgpu, naga, mag-format, bytemuck | native (golden tests, `magazine shot`), wasm |
| `mag-web` | cdylib | wasm-bindgen entry: async init, frame loop, input state machine and hit-testing (ports of `src/lib/magazine/input.ts`, `hit.ts`), live relayout glue, ImageBitmap uploads, event queue to JS | mag-gpu, mag-layout, wasm-bindgen, web-sys, js-sys | wasm32-unknown-unknown |
| `mag-build` | bin `magazine` | `build`, `watch`, `lint`, `validate`, `shot`, `dump`, `bless`, `distill`; svx parse, syntect, images, math cache, fonts.bin, bin emit, ws push to preview | all above, markdown, syntect, webp, notify, tungstenite | native |

Build commands (all cargo, `bun` only drives the vite plugin and `wasm-bindgen`):
`cargo build -p mag-world --target wasm32-wasip1 --release` (existing recipe, wasi-sdk 34, `-D__COSMOCC__`), `cargo build -p mag-web --target wasm32-unknown-unknown --release` then `wasm-bindgen --target web` then `wasm-opt`. Both outputs are committed under `src/lib/gpu/` as `world.wasm` and `mag_bg.wasm` (the dev server must run without a Rust toolchain, same rule as `world.wasm` today). Builds run on a dev-compute host; the Mac only edits and runs GPU goldens.

### 2.1 What stays TypeScript

Only what touches the DOM or is a bridge: `shim.ts`, `atlas.ts` and `emblems.ts` (Canvas2D covers and signs, they hand an `ImageBitmap` to mag-web), the vite plugin, Svelte components (`World.svelte`, routing, hidden `.sr-only` article DOM, aria-live), `tools/mathjax.mjs`. Everything else listed in section 9 is deleted.

### 2.2 JS shim (the whole contract)

```ts
// src/lib/gpu/shim.ts  (target ~150 lines)
const mag = await import('./mag.js'); await mag.default(wasmUrl);          // wasm-bindgen init
const world = await loadWorld(items);                                     // existing world.ts (wasip1), unchanged API
const app = await mag.App.create(canvas, worldBuffers, opts);             // async: requestAdapter/requestDevice live in Rust
ro = new ResizeObserver(([e]) => app.resize(e.devicePixelContentBoxSize?.[0] ?? cssToDevice(e)));
canvas.onpointer*/onwheel/onkeydown -> app.pointer(kind, x, y, buttons, mods) / app.wheel(dx, dy, mods) / app.key(code, mods)
matchMedia('(prefers-color-scheme: dark)').onchange -> app.set_dark(bool)
function frame(t) { world.tick(dt); app.frame(t, world.readerState() /* Float32Array view, 40 floats */); poll events; raf = requestAnimationFrame(frame); }
app.on_device_lost(() => showPoster());                                   // WebGPU only: the prerendered poster is the only non-GPU state
```
Images: the shim `fetch`es and `createImageBitmap(..., {premultiplyAlpha:'none'})`, then hands the bitmap to `app.upload_image(id, bitmap)`, which calls `queue.copy_external_image_to_texture` through wgpu (no image decoder in wasm). rAF is JS because only JS can schedule it; everything the frame does is one call.

## 3. Flecs script schema (A)

### 3.1 Where the files live

```
world/scene/                          (crates/mag-world/scene/ after the move; shared, embedded with include_str!)
  50-mag-schema.flecs                 prefabs for slots, nodes, tracks, copy; enums via `using`
  51-mag-templates.flecs              duo, solo, compare, numerals, text, text-code (+ narrow variants)
  52-mag-palette.flecs                the 8 reserved palette entries and the diagram neutrals
src/routes/(site)/thoughts/<slug>/
  +page.svx                           the author's text; frontmatter keeps title, dek, date, username only
  article.flecs                       voice, distilled spread (copy, quote, captions), figures, review
```
`distill:` frontmatter and `spread.json` are deleted when `article.flecs` lands for ifd. Posts without `article.flecs` open on the full text layer, as today.

### 3.2 Model (names are the Rust component names, all reflected, all `Clone + Default`)

| Concept | Script form | Meaning |
|---|---|---|
| spread template | `prefab duo : SpreadTemplate`, components `Grid {cols, spine}`, `Rows {"3b 7b fr ..."}`, `Fit {...}`, `Budget {words_min, words_max}`; children `row0..rowN : AreaRow {"ASCII line"}`, `slot_H : Slot {...}`; narrow variant is a child prefab `narrow : Variant` with its own Grid/Rows/AreaRows/Slots | the ASCII-art areas stay (a human sees the page); the track solver reads them |
| slot | `Slot {id: "H", type: head, font: display, size: 7.5, bleed: {l, r, t, b}}` | `type` in head, deck, body, figure, pullquote, numeral, caption, code, folio, rule, field |
| article | `magazine.<slug> : Magazine`, `Voice {hue, wdth, wght}`, `Review {by, at, post_sha}` (optional until Andrew signs), `(Of, articles.<slug>)` (relation to the existing Thought entity) | name of the entity is the slug |
| spread | child `distilled : Spread {layer: 0}` with `(Uses, duo)`; children are named after the template slot ids (`H`, `D`, `a`, `b`, `Q`) | content is matched to slots by name; an unknown or missing name is a pack error |
| copy | `Copy {"verbatim string"}` plus either nothing (must occur in the post, checked) or the tag `Synth` (exempt, reviewed); `Quote {from: "section heading"}` | replaces `distill.synth` |
| figure | child `eval_timeline : Figure {w, h, mode, duration, poster}`, `Describe {"..."}`, `Alt {"..."}`; `(Fills, A)` on the figure instance says which slot of which spread places it | `describe` of at least 40 chars and `alt` are required or the pack fails |
| figure nodes | prefab instances `Rect`, `Circle`, `Label`, `Edge`, `Dots`, `Numeral`, `Pathline`, `Group`; components `At {x, y}`, `Size {w, h}`, `Radius`, `Fill {ink}`, `Stroke {w, color, dash_on, dash_off}`, `Hatch`, `Text {"..."}`, `Font`, `Align`, `Along`; the entity name is the id | tracks target `<name>.<prop>` |
| animation | `Track {target: "c0.size.x", ease: linear}` with `Keys {"0:0 3.6:10.4"}` (t:value pairs), plus sugar that compiles to tracks: `Reveal {from_s, to_s}`, `Appear {at_s}`, `Draw {at_s}` (trim t1), `Crawl {rate}` (hatch phase), `Travel {from_s, to_s}` (dots u) | sugar exists so a figure is not 60 `Track` lines; the packer expands it |
| channels | not authored: the figure compiler allocates them from tracks, exactly as `fig/compile.ts` does today | |
| generators | `Edge {from: e0, to: e1}` is routed in Rust (the quadratic `edgePath` of `ifd/figures.ts` moves into `mag-layout::route`), `Dots {scatter: {seed: 7, ...}}` uses a seeded Rust RNG; `dagre` is dropped (the ifd graph is hand placed) | arithmetic and loops that lived in TS figure modules are either Flecs `const`/`for` or a named Rust generator, never general code in the script |

Errors name the entity path (`magazine.ifd.eval_timeline.c3: unknown Stroke.cap "sqaure"`), not a line (Flecs does not keep source lines on entities); script syntax errors keep Flecs' `file: line: msg` and are checked by a planted-error test (T6).

### 3.3 Worked example: the IFD spread

```flecs
// src/routes/(site)/thoughts/ifd/article.flecs        (syntax fixed by spike S2; the schema is the decision)
using flecs.meta
using mag

magazine.ifd : Magazine {
  Voice: {hue: 265, wdth: 80, wght: 600}
  (Of, articles.ifd)
  // Review: {by: "andrewgazelka", at: "2026-10-07", post_sha: "<magazine sha ifd>"}   written by Andrew at review

  distilled : Spread {
    (Uses, duo)
    Layer: {0}
    H : Headline  { Copy: {"IFD is fine"} }
    D : Deck      { Copy: {"The case against import-from-derivation is a case against CppNix's evaluator, not against the idea."} }
    def : Definition { Copy: {"Import From Derivation: during evaluation, the Nix language asks for a path whose bytes depend on a derivation's output."} }
    a : Caption   { Copy: {"When a thunk demands the contents of ${drv}/foo, the evaluator stops, calls out to the daemon, waits for the build, resumes."}
                    (For, eval_timeline) }
    b : Caption   { Copy: {"Eval and build are nodes in one graph. The graph grows as eval discovers more of it. A thunk that needs a build emits a request and yields."}
                    (For, eval_graph) }
    b2 : Caption  { Copy: {"A thunk nobody forces is a derivation nobody builds."}
                    (For, eval_graph) }
    Q : PullQuote { Copy: {"The IFD ban was a polite way to say \"the reference evaluator cannot handle this yet.\" The phrasing outlived the constraint."}
                    Quote: {from: "The frame is the evaluator"} }
  }

  // ---- figure A: the evaluator waits (36 x 20 em, loop 12 s, poster 9 s) ---------------------------------
  eval_timeline : Figure {
    Frame: {w: 36, h: 20}
    Time: {mode: loop, duration: 12, poster: 9}
    Describe: {"When a thunk demands the contents of a derivation, the CppNix evaluator stops, waits for the build, resumes. Snix keeps eval going while the builds run."}
    Alt: {"Two lanes, CppNix and Snix: eval blocks on CppNix are separated by hatched build blocks where it waits; Snix eval blocks run back to back and end first."}
    (Fills, distilled.A)

    const U = 2.9          // em per timeline unit; x(u) = 6 + U*u ; 1 unit = 0.9 s
    const S = 0.9
    const LANE_H = 3

    // CppNix lane (y = 4): eval, then the evaluator sits behind each hatched build
    c0 : Rect { At: {6 + U*0,   4}  Size: {U*1.5 - 0.05, LANE_H}  Fill: {muted}    Text: {"eval"}   Reveal: {S*0,   S*1.5} }
    c1 : Rect { At: {6 + U*1.5, 4}  Size: {U*1.5 - 0.05, LANE_H}  Fill: {neutral2} Text: {"build"}  Reveal: {S*1.5, S*3}   Hatch  Crawl: {0.58} Stroke: {0.1, muted, 0.4, 0.3} }
    c2 : Rect { At: {6 + U*3,   4}  Size: {U*1.0 - 0.05, LANE_H}  Fill: {muted}    Text: {"eval"}   Reveal: {S*3,   S*4} }
    c3 : Rect { At: {6 + U*4,   4}  Size: {U*2.0 - 0.05, LANE_H}  Fill: {neutral2} Text: {"build"}  Reveal: {S*4,   S*6}   Hatch  Crawl: {0.58} Stroke: {0.1, muted, 0.4, 0.3} }
    c4 : Rect { At: {6 + U*6,   4}  Size: {U*1.0 - 0.05, LANE_H}  Fill: {muted}    Text: {"eval"}   Reveal: {S*6,   S*7} }
    c5 : Rect { At: {6 + U*7,   4}  Size: {U*1.5 - 0.05, LANE_H}  Fill: {neutral2} Text: {"build"}  Reveal: {S*7,   S*8.5} Hatch  Crawl: {0.58} Stroke: {0.1, muted, 0.4, 0.3} }
    c6 : Rect { At: {6 + U*8.5, 4}  Size: {U*1.5 - 0.05, LANE_H}  Fill: {muted}    Text: {"eval"}   Reveal: {S*8.5, S*10} }

    // Snix lane (y = 10): eval never stops, so it ends first
    for i in 0..6 {
      s$i : Rect { At: {6 + U*($i == 0 ? 0 : 0.5 + $i), 10}  Size: {U*($i == 0 ? 1.5 : 1.0) - 0.05, LANE_H}
                   Fill: {accent}  Text: {"eval"}  Reveal: {S*($i == 0 ? 0 : 0.5 + $i), S*($i + 1.5)} }
    }

    // builds Snix asked for run concurrently on the strip below, each tied by an arrow to the eval block that asked
    sb0 : Rect { At: {6 + U*1.5, 17.7}  Size: {U*1.5 - 0.05, 0.8}  Radius: {0.2}  Fill: {neutral2}  Reveal: {S*1.5, S*3} }
    sb1 : Rect { At: {6 + U*2.5, 16.6}  Size: {U*2.0 - 0.05, 0.8}  Radius: {0.2}  Fill: {neutral2}  Reveal: {S*2.5, S*4.5} }
    sb2 : Rect { At: {6 + U*3.5, 15.5}  Size: {U*1.5 - 0.05, 0.8}  Radius: {0.2}  Fill: {neutral2}  Reveal: {S*3.5, S*5} }
    sa0 : Pathline { D: {"M 10.35 13 L 10.35 17.7"} Stroke: {0.12, accent}  Arrow  Draw: {S*1.5, 0.4} }
    sa1 : Pathline { D: {"M 13.25 13 L 13.25 16.6"} Stroke: {0.12, accent}  Arrow  Draw: {S*2.5, 0.4} }
    sa2 : Pathline { D: {"M 16.15 13 L 16.15 15.5"} Stroke: {0.12, accent}  Arrow  Draw: {S*3.5, 0.4} }

    // lane names and the three words of the first hatched block
    lane_cpp  : Label { At: {0, 5.9}  Text: {"CppNix"}  Font: {label} }
    lane_snix : Label { At: {0, 11.9} Text: {"Snix"}    Font: {label}  Fill: {accent} }
    w_stops   : Label { At: {10.15, 3.3}  Text: {"stops"}   Align: {right}  Appear: {S*1.5} }
    w_waits   : Label { At: {12.9, 8.2}   Text: {"waits"}   Align: {center} Appear: {S*2.25} }
    w_resumes : Label { At: {14.9, 3.3}   Text: {"resumes"} Align: {left}   Appear: {S*3} }

    playhead : Pathline { D: {"M 6 2.4 L 6 14"} Stroke: {0.12, ink} }
    t_play : Track { Target: {"playhead.x"} Ease: {linear} Keys: {"0:0 9:29"} }
  }

  // ---- figure B: one graph that grows (36 x 20 em, loop 14 s, poster 11 s) -------------------------------
  eval_graph : Figure {
    Frame: {w: 36, h: 20}
    Time: {mode: loop, duration: 14, poster: 11}
    Describe: {"Eval and build are nodes in one graph. The graph grows as eval discovers more of it. A thunk that needs a build emits a request and yields; other thunks keep running, and every build runs at once."}
    Alt: {"A graph of eval circles and build squares that grows over time: a thunk yields while its build runs, then resumes; the remaining builds run in parallel."}
    (Fills, distilled.B)

    // eval nodes: Circle {At, R}, Mix animates muted -> accent at `lit`; Appear = discovery time in seconds
    e0 : Circle { At: {3,    10}   R: {1.15}  Mix: {muted, accent, 10.4} }
    e1 : Circle { At: {8.5,  5.5}  R: {1.15}  Mix: {muted, accent, 10.4}  Appear: {0.8} }
    e2 : Circle { At: {8.5,  14.5} R: {1.15}  Mix: {muted, accent, 8.0}   Dim: {1.2, 3.0, 8.0, 8.6} }   // the thunk: dims while its build runs
    e3 : Circle { At: {14,   3}    R: {1.15}  Mix: {muted, accent, 10.8}  Appear: {1.6} }
    e4 : Circle { At: {14,   8}    R: {1.15}  Mix: {muted, accent, 10.8}  Appear: {1.6} }
    e5 : Circle { At: {14,   12.5} R: {1.15}  Mix: {muted, accent, 10.8}  Appear: {1.6} }
    e6 : Circle { At: {19.5, 12.5} R: {1.15}  Mix: {muted, accent, 10.8}  Appear: {2.2} }
    e7 : Circle { At: {25,   10}   R: {1.15}  Mix: {muted, accent, 10.8}  Appear: {3.4} }
    e8 : Circle { At: {25,   14.5} R: {1.15}  Mix: {muted, accent, 10.8}  Appear: {4.0} }
    // build nodes: outline square plus an inner square that scales in (b0 alone from 4.2 s, the rest at once from 9 s)
    b0 : Build { At: {14,   17.5}  Appear: {2.6}  Fill: {4.2, 8.0} }
    b1 : Build { At: {19.5, 3}     Appear: {2.4}  Fill: {9.0, 10.6} }
    b2 : Build { At: {19.5, 8}     Appear: {2.6}  Fill: {9.1, 10.7} }
    b3 : Build { At: {19.5, 16.5}  Appear: {3.0}  Fill: {9.2, 10.8} }
    b4 : Build { At: {25,   4.5}   Appear: {4.4}  Fill: {9.3, 10.9} }
    b5 : Build { At: {30.5, 10}    Appear: {5.0}  Fill: {9.4, 11.0} }
    // edges draw on once their target is discovered (route and trim computed by mag-layout::route)
    Edge: e0 -> e1  Edge: e0 -> e2  Edge: e1 -> e3  Edge: e1 -> e4  Edge: e2 -> e5  Edge: e2 -> b0  Edge: e3 -> b1
    Edge: e4 -> b2  Edge: e4 -> b4  Edge: e5 -> e6  Edge: e5 -> b3  Edge: e6 -> e7  Edge: e6 -> e8  Edge: e7 -> b5
    // request out, result back, along the e2 -> b0 edge
    req : Dots { Along: {e2_b0}  Count: {1}  R: {0.24}  Fill: {accent}  Travel: {3.2, 4.2}  Show: {3.15, 4.3} }
    ret : Dots { Along: {e2_b0}  Count: {1}  R: {0.24}  Fill: {accent}  Travel: {8.6, 8.0}  Show: {7.95, 8.7} }
    w_thunk   : Label { At: {8.5, 12.5}  Text: {"thunk"}   Align: {center}  Appear: {1.2} }
    w_request : Label { At: {11.8, 15.4} Text: {"request"} Align: {center}  Window: {3.1, 4.4} }
    w_yields  : Label { At: {8.5, 17.4}  Text: {"yields"}  Align: {center}  Window: {3.3, 8.0} }
    w_resumes : Label { At: {8.5, 17.4}  Text: {"resumes"} Align: {center}  Appear: {8.2} }
    lg_eval  : Circle { At: {1.3, 18.7} R: {0.5} Fill: {accent} }   lg_eval_t  : Label { At: {2.3, 19} Text: {"eval"}  Font: {label} }
    lg_build : Rect   { At: {6, 18.2} Size: {1, 1} Radius: {0.15} Fill: {neutral2} }   lg_build_t : Label { At: {7.3, 19} Text: {"build"} }
  }
}
```
`Build`, `Edge`, `Dots`, `Show`, `Window`, `Dim`, `Mix` are further prefabs/sugar in `50-mag-schema.flecs`, each defined as "compiles to N tracks" in `mag-layout::figure` (listed there with the exact track recipe, so the compiled output is bit-for-bit what `scripts/magazine/fig/compile.ts` produces today; that equality is the T6 gate). The `Edge: a -> b` shorthand above is shown for readability: if S2 shows script cannot express it, it becomes `e0_e1 : Edge {From: {e0} To: {e1}}`, one line per edge.

### 3.4 Packing

`mag-world::lift_article(world, "ifd") -> Result<ArticleIR, Vec<PackError>>` walks the entity tree with Flecs queries (children of `magazine.<slug>`, `(Uses, template)`, `(Fills, slot)`, `(For, figure)`), expands sugar, resolves track targets by entity name inside the figure scope, and returns plain Rust data (serde). It fails closed: unknown slot, slot without content, figure not placed, duplicate track target, palette name not in the 32-entry table, `describe` under 40 characters, words outside 100..250 (error) or under 150 (warning). `mag-build lint` adds the verbatim check (every `Copy` without `Synth` is a substring of the post after Markdown stripping and whitespace normalisation) and the review gate (`post_sha`), ported 1:1 from `scripts/magazine/distill.ts`. `distill <slug>` (agent call) prints a diff of a generated `article.flecs` and never writes `Review`.

The runtime world (browser, `world.wasm`) gains only: `Spread {f, target, vel, layer}`, `Corner {drag, open}`, `Turn {progress, dir, grabbed}`, `Figure {id, t, rate, mode, focus}` (per `docs/MAGAZINE.md` section 5), created from the RDR2 header at `article_open`, not from magazine script.

## 4. WGSL out of TS (B), validated by naga

Today: `shader.ts` (1217 lines, entry points `cs`, `atrous`, `cs_view`, `bake_lightmap`, `denoise_lightmap`, `bake_probe`, `probe_mip`, `bake_sun`, `vs`, `fs`), `magazine.wgsl.ts` (909, built by interpolating the schema from `format.ts` into the shader: `headerConsts`, `sizeConsts`, `fieldOffset` accessors), `reader.wgsl.ts` (277, deleted with the old reader). Interpolation is the real obstacle: the offsets must come from one schema.

Plan:
1. `crates/mag-gpu/shaders/`: `trace.wgsl` (tracer: sampling, bsdf, bake, denoise, present entry points), `magazine_eval.wgsl` (self-contained evaluator, as the preview page already needs), `magazine_trace.wgsl` (page_trace/page_shade/page_light), `common.wgsl`, `flat.wgsl` (preview page). No `${}` anywhere.
2. Constants come from `format.gen.wgsl`, written by `mag-format/build.rs` from the Rust schema and included by a one-line directive `//!include "format.gen.wgsl"`. Include expansion is ~30 lines in `mag-gpu/build.rs` (line-mapped so an error cites the original file and line). Transitional TS side (until step C flips): `scripts/gen-wgsl-consts.ts` writes the same file from `format.ts`, committed, with a test that regenerates and diffs, deleted at the flip.
3. `build.rs` parses each composed module with `naga` (`wgsl-in`), validates with `naga::valid::Validator` (capabilities = what the target adapters give: no `f16`/subgroups unless a `requires` line says so), and fails the build with file:line. It also reflects the module: entry point list, bind group layout, storage-buffer count per entry point, and writes `shaders.manifest.json`.
4. Delivery: Rust `include_str!(concat!(env!("OUT_DIR"), "/trace.wgsl"))` (expanded text, one WGSL string per module); the transitional TS imports `?raw` of the same expanded output committed at `src/lib/gpu/room/wgsl/*.wgsl` (generated; the TS path disappears at the flip).
5. Gates that fail the build: (a) naga validation; (b) storage buffers per shader stage at most 8 (the `maxStorageBuffersPerShaderStage` default; today's bindings go to 18 across entry points per `docs/READER.md`, so `trace.wgsl` is split per entry point by this check, not by hand); (c) Rust Pod uniform structs (`Sc`, `Rd`) equal the naga-reflected struct layout (size and offsets).
6. naga licence: `MIT OR Apache-2.0` (reported); read the LICENSE files of 30.0.1 into `docs/upstream/wave3/naga/` first. Pin `=30.0.1`.
Caveat: naga validates against the WGSL naga implements, not against Chrome's Tint; a shader naga accepts can still be rejected by the browser, and the reverse. T1 therefore also runs the shaders through the real browser (CDP `createShaderModule` + `getCompilationInfo`) in the e2e batch.

## 5. Renderer in Rust (C): `mag-gpu` module split

Ports `room.ts` (940 lines), `magazine.ts` (463), `reader.ts` (295, deleted), `world.ts` glue, `lightmap.ts`. Pipelines use `layout: None` (auto) first, exactly as the TS does (`layout: 'auto'`), so the port is 1:1; explicit layouts later only if a profile shows a reason.

| Module | Owns (from today) |
|---|---|
| `device.rs` | `Instance` (`Backends::BROWSER_WEBGPU` on wasm, `PRIMARY` native), async `request_adapter` / `request_device` (limits copied from the adapter: `maxStorageBufferBindingSize`, `maxBufferSize`, as `createRoom` does), surface config, `uncaptured_error` and device-lost callbacks, timestamp-query feature when present |
| `shaders.rs`, `pipelines.rs` | the include_str modules, pipeline creation (`cs`, `atrous`, `cs_view`, bake pipelines, present render pipeline, flat preview pipeline), error scope around creation (`pushErrorScope('validation')` equivalent) |
| `buffers.rs` | storage buffers (`objs`, `panes`, `lvl`, reader/magazine buffer, channel uniform array), uniform Pod structs (`Sc`, `Rd`, step buffers), `write_buffer` helpers |
| `bake.rs` | `bake_sun`, lightmap bake and denoise (`lightmap.ts`), probe bake and mip chain, LM_SPP accounting |
| `trace.rs` | `cs` compute, a-trous denoise ladder, `cs_view` (scroll/zoom pass), accumulation buffers and resize |
| `view.rs` | zoom window (`sc.view`, centre and half-size, min 1/6), still pass, camera/hero pose (`camera()`, `focusObj`), reading-pose blend |
| `magazine.rs` | `assemble()` of RDR2 + fonts container into GPU buffers, image texture array (`reader_img`), figure channel evaluation per frame (port of `chan.ts`), spread uniforms (`writeRd`), turn strips and peel (`leafAngle`) |
| `present.rs` | present render pass, exposure/dark uniform |
| `ui.rs` | the UI pass: hover, focus ring and selection rects, zoom chip, as drawn today (the lane reads the exact draw list from `room.ts` first and lists it in the module doc) |
| `frame.rs` | the frame graph and idle logic of `tick()` (rdIdle, lmN, when to stop requesting frames), driven by `App::frame(t, state)`; wall-clock based, not frame count |

`mag-web` (separate crate) holds what is not GPU: `App` (wasm-bindgen), `input.rs` (wheel, swipe, keys, flick rule, magnet, corner peel, 4.5 gestures; ports of `input.ts`/`hit.ts` with their tests), `relayout.rs` (calls `mag-layout::layout` on class change, text scale, viewport aspect with hysteresis, then `magazine.rs::upload`), `events.rs` (queue the shim drains: opened, closed, link, page changed).

Async init: `App::create` is `async` through `wasm-bindgen-futures`; the shim awaits it. Sequence: instantiate world.wasm and mag.wasm in parallel (`Promise.all` on the two streaming compiles), `world.build(items)`, `App::create(canvas, buffers)`, first `frame`. Device-lost returns to the prerendered poster (kept, per house rule); no fallback path exists.

The tracer is stochastic. Seeded RNG is a uniform (frame counter), so a fixed (seed, spp) is reproducible on one machine. Cross-implementation comparisons (browser TS vs Rust native vs Rust wasm) use tolerance metrics, never bit equality (see T8).

## 5.1 HDR end to end (day-one step of the renderer port)

Andrew's direction: the whole pipeline is HDR. It is not a later add-on: the first commit of `device.rs`, `present.rs` and `frame.rs` configures the HDR canvas and carries the headroom uniform, and every golden is taken through it. There is one render path (no SDR arm kept beside an HDR arm): SDR is the same path with headroom H = 1.

**1. Canvas.** Chrome WebGPU (HDR canvas shipped in Chrome 129 to 131 era; Chrome blog "What's New in WebGPU (Chrome 129)" and the explainer https://github.com/ccameron-chromium/webgpu-hdr/blob/main/EXPLAINER.md, both from a search result, not yet opened in full, so **reported**):
```js
context.configure({ device, format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT /* | COPY_SRC in test builds */,
                    alphaMode: 'opaque', colorSpace: 'display-p3', toneMapping: { mode: 'extended' } });   // 'standard' clamps to [0,1]
```
Rust/wgpu 30: `SurfaceConfiguration { format: Rgba16Float, color_space: SurfaceColorSpace::ExtendedDisplayP3, .. }`. wgpu 30.0.0 changelog (read, https://github.com/gfx-rs/wgpu/blob/trunk/CHANGELOG.md, "Surface color space selection (HDR output)"): `SurfaceConfiguration` gained `color_space`; the default `Auto` is "never a wide-gamut or HDR color space", so we must ask explicitly; the support table lists `ExtendedDisplayP3` as supported on Metal and WebGPU, `ExtendedSrgbLinear` and PQ/HLG as not on WebGPU; `SurfaceCapabilities.format_capabilities` reports what the surface offers; `Surface::display_hdr_info` is "populated on ... Metal on macOS, and the web" and `DisplayHdrInfo::tone_map_headroom()` folds nits/EDR headroom into one multiplier. Whether wgpu's web backend maps `ExtendedDisplayP3` to `colorSpace: 'display-p3'` plus `toneMapping: {mode: 'extended'}` exactly: **unverified**, spike S5. Fallback if not: `mag-web` calls `GpuCanvasContext::configure` through `web-sys`/`js-sys` itself with the dictionary above and gives wgpu the already-configured texture path is NOT possible (wgpu owns the context), so the fallback is a thin `wasm-bindgen` call that reconfigures the same `HTMLCanvasElement` context after wgpu's configure; S5 decides. Always `rgba16float`: no `bgra8unorm` branch. When the display or window is SDR, the same format is configured with `toneMapping: {mode: 'standard'}` (reconfigure on change; cheap).

**2. Detection.** `matchMedia('(dynamic-range: high)')` and `matchMedia('(color-gamut: p3)')` (media query change events re-evaluate on display or window moves). The numeric headroom comes from wgpu `display_hdr_info().tone_map_headroom()` on the web and Metal backends (reported by the changelog above); a browser-side number (`screen.highDynamicRangeHeadroom` or similar) is **unverified**, S5 lists what Chrome stable exposes. EDR headroom on macOS changes with brightness, ambient light and load: re-read on media change, `visibilitychange`, `resize`, and every 500 ms while visible; the shim passes `app.set_headroom(h)` and Rust eases toward it over 200 ms (no pop when the user dims the display). Clamp `H` to `[1, 8]` and report the value in the debug HUD. CSS `dynamic-range-limit` on the canvas element is an optional user-facing cap (**unverified**). Forced override for tests: `?hdr=<H>` and `App::set_headroom`, because headless Chrome reports `dynamic-range: standard`.

**3. Present pass.** Input: the scene-linear f16 accumulation target (never an 8-bit or clamped intermediate anywhere in the chain: bake, lightmap texels, probe, accumulation, denoise ping-pong are already f16/f32 and stay so). Output: the `rgba16float` canvas texture. No `clamp(.., 0, 1)` anywhere after shading. One curve with a headroom parameter: `out = tm(x * E, H)` where `tm` is identity-like through the diffuse range (knee about 0.75 of reference white so paper, ink and walls look as in SDR), then a smooth shoulder that approaches H asymptotically; `H = 1` must reproduce today's operator exactly (the lane extracts the present operator from `fs`, shader.ts:1198, and generalises it; T8 compares the `H = 1` output to the oracle at the existing tolerance, so SDR parity is proved, and the HDR branch is the same function with a bigger asymptote). HDR energy is allowed only where the scene earns it: lamps, bulbs (kind 9), the sun through the window panes, neon/emissive signs, specular lobes of coated figure pages, and bloom; diffuse surfaces never exceed their albedo times light, so they stay at or below reference white. If bloom exists or is added it runs pre-tonemap in scene-linear with the threshold at 1.0 after exposure, so only super-white energy blooms. Colour: the renderer works in linear sRGB primaries; the present pass converts to Display P3 primaries (3x3 matrix) and applies the transfer function the canvas expects. Which transfer Chrome expects for `rgba16float` + `display-p3` + `extended` (sRGB-curve extended symmetric versus linear extended) and whether it matches wgpu-native Metal (`ExtendedDisplayP3`) is **unverified**; S5 renders a luminance ramp, reads it back and writes the answer into a per-backend `OUT_TRANSFER` override constant in the shader.

**4. Pre-exposure.** f16 tops out at 65504 and has 10 mantissa bits (house precision rule: f16 for colour, pre-expose HDR before it goes in). Radiance is stored as `L * E` with a scalar `E` (uniform, chosen once per scene from the lamp radiance so the brightest emitter lands near 64 to 256 and mid-grey near 0.18 to 0.5, eased not stepped, never changed during accumulation without resetting the accumulation weight); the present pass divides it out through `tm`. The accumulation readback test asserts no inf/NaN and the 99.99th percentile below 16384 (a factor of 4 below overflow). Denoiser variance and a-trous weights operate in `E`-scaled space so their thresholds do not change with `E`. Lightmap and probe textures keep `rgba16float`; if any is currently `rgba8` or clamps, that is a bug to fix in the port, listed by the `gpu` lane in its module docs.

**5. UI and page text stay at reference white.** The paper, ink, figure fills and all UI (zoom chip, focus ring, selection tint, hover underline, corner peel tab) are shaded in the tracer's primary-hit albedo or drawn by `ui.rs` after tonemapping, in display space with values capped at 1.0 (reference white = SDR white, which the OS ties to the user's UI brightness). Rules: paper luminance stays 0.78 to 0.88 and ink 0.04 to 0.06 as in READER.md (contrast floors 12:1 light, 9:1 dark unchanged and computed at reference white); `ui.rs` composites in a pass after `present.rs` onto the same canvas texture and its shader has an explicit `min(color, 1.0)`; the highlight lobe on `coated` figure pages may exceed 1.0 (a lamp sheen) but never the text or figure fill. A page lit by a lamp that is itself at 100x white must not make the text brighter than UI white: the page's reading light is the analytic term of READER.md 3.1 (bounded), and only its specular term can pass 1.0.

**6. Light and dark themes.** `prefers-color-scheme` already flips the palette uniform. HDR adds one more theme-dependent value, the highlight cap: `H_eff = min(H, Hcap_theme)` with `Hcap_light = 2.0` (a bright page around a white UI makes 4x highlights glare) and `Hcap_dark = H` (dark rooms and dark paper leave perceptual room for lamps; dark paper at 0.07 to 0.12 display-linear stays far from the cap). Initial values are guesses; they are tuned in the fast loop with the real display and recorded. Dark mode lowers the lamp to 0.6 (MAGAZINE.md 4.4) before `E` is chosen, so `E` is recomputed on theme change with the usual accumulation reset. `prefers-contrast: more` sets `H_eff = 1` (no glare), as does `prefers-reduced-motion` for exposure easing (instant). Transitions between themes ease `H_eff` and the palette together over the same 200 ms.

**7. Verification (a screenshot cannot show HDR; assert numbers).** `Page.captureScreenshot` and `magazine shot` PNGs are 8-bit sRGB and clamp. So:
- Present pass renders into the canvas texture; test builds configure the canvas with `COPY_SRC` (or render through an intermediate `rgba16float` texture that is then blitted) and `copy_texture_to_buffer` reads back f16, decoded on the CPU. Native headless (`magazine shot --hdr H --readback out.f16`) uses the same `present.rs` against an offscreen `rgba16float` texture: sub-second, no browser.
- Browser e2e (CDP, headless): load with `?hdr=2.5`, call `app.read_pixel(x, y)` (debug export, test builds) and assert: lamp-core pixels have max channel greater than 1.0 and at most H; paper and ink pixels at most 1.0 + 1/1024; UI pixels at most 1.0; with `?hdr=1` every pixel at most 1.0 + 1/1024 and the output equals the SDR oracle at T8 tolerance.
- Curve unit test (pure Rust, no GPU): `tm(x, H)` is monotonic, `tm(x,1) == oracle operator`, `tm(x,H) <= H`, continuous in H, identity-like below the knee.
- Display: a one-time manual look on this Mac's XDR display at high and low brightness, recorded as notes (a photo of the screen, not a screenshot); CDP `Emulation.setEmulatedMedia` cannot be relied on for `dynamic-range` (**unverified**, S5 tries it), the forced `?hdr=` override is the contract.
- Planted-bug controls (T13): insert `clamp(.., 0.0, 1.0)` in the present shader (the lamp max must drop to 1.0 and the assertion fail); make `tm` ignore `H` (the `?hdr=1` case must exceed 1.0 and fail); composite `ui.rs` before tonemap (UI pixels exceed 1.0 and fail); halve the pre-exposure divisor (accumulation overflow detector must fire); swap the P3 matrix for identity (a saturated-red patch must read back at the sRGB value and fail the gamut assertion).

## 6. Text shaping and layout (D)

`mag-text` + `mag-layout` replace `typeset.ts`, `kp.ts`, `hyph.ts`, `microtype.ts`, `grid.ts`, `frames.ts`, `planner.ts`, `emit.ts`, `palette.ts`, `voices.ts`, `fig/*`, `src/lib/magazine/{chan,format,types,dsl}.ts`, `src/lib/reader/*`. Rules for the port:
- 1:1 algorithm ports first (KP, hyphenation, grid, planner), differential-tested against frozen oracle output, then improvement. Float discipline: layout in `f32` em with `libm` for transcendental functions (no platform `sin`), no fast-math (Rust has none), so native and wasm agree bit for bit; the test runs the wasm build under `wasmtime` and compares RDR2 bytes to native (T4).
- Shaping: harfrust at a variation location for Inter and Instrument Sans, features `kern`, `liga`, `calt` (Fira Code), `tnum`; glyph advances in font units, converted with one rounding rule shared by build and browser.
- Live relayout: inputs are `ArticleIR` + `Class {wide, narrow}` + `emScale`. Triggers: class change (aspect crosses 0.9 with 10% hysteresis), text-scale change, a hard `#s3` jump. Pure resize inside a class only refits the camera (as READER.md 2.1). Budget: one spread under 150 ms warm, whole-article plan under 30 ms (both from MAGAZINE.md, to be measured in wasm); if the plan exceeds 16 ms on the main thread, `mag-web` is instantiated a second time in a Worker for layout only (same wasm bytes, no threads) and posts the RDR2 buffer back. This is a staged option, not v1.
- Fonts in the browser: shaping needs the font bytes, not the glyph table. Ship `fonts.<hash>.bin` (bands, curves, as today) plus subset TTFs for shaping, loaded lazily on first relayout request, not at first paint (first paint uses the build-time `.bin`).

## 7. Build pipeline (E)

`magazine` binary (clap), replaces `scripts/magazine/{build,vite-plugin,watch,distill,parse-directives}.ts` and `scripts/reader/{build,parse,fonts,images,math,geom,layout,validate,dump,vite-plugin}.ts`:

| Command | Does |
|---|---|
| `magazine build [--only slug] [--preview]` | native world loads shared scripts + every `article.flecs`, `lift_article`, parse svx, shape, plan, emit `<slug>.ir.bin`, `<slug>.<wide\|narrow>.<hash>.bin`, `fonts.<hash>.bin`, `index.json`; hash-keyed cache so a warm build touches only changed posts |
| `magazine watch` | resident: fonts, shapers, syntect, world loaded; notify on `*.svx`, `article.flecs`, `*.flecs`, `*.wgsl`; re-lays-out the affected article, validates a changed shader with naga, pushes over a WebSocket |
| `magazine lint` | schema pack errors, verbatim check, word counts, figure-poster-readable check, review gate, palette gamut |
| `magazine validate` | A1 invariants (baseline grid, glyph boxes in frames, text-equality of the full layer) |
| `magazine shot <slug> --spread N [--t 3.0] [--dark] --out x.png` | headless native wgpu (Metal) render of one flat spread: the sub-second picture loop |
| `magazine dump`, `bless` | JSON dumps for diffing; regenerate goldens from the current binary (only after a reviewed diff) |

JS orchestrator: `scripts/vite-magazine.ts` (about 60 lines): in `vite dev` spawn `magazine watch` and forward its WebSocket events as `server.ws.send` HMR; in `vite build` run `magazine build --release` and fail on non-zero; run `tools/mathjax.mjs` only when a TeX string misses `math.cache.json`. `bun run build:world` becomes `bun run build:wasm` (both modules).

## 8. Order of work and lanes

House rules apply: lanes write and commit in their own worktree and run nothing; the root merges, builds once on a dev-compute host, runs tests once, runs the GPU goldens once on this Mac. One pass, dependency-ordered: waves are not gates, every lane launches as soon as its inputs exist. The old path is deleted in the same merge that flips to the new one (no switch, no old arm).

**Wave A (root, short; tree stays green because everything is additive):**
1. A0 oracle freeze (lane `oracle`): tag the current tree `wave3-oracle`; with the existing TS pipeline write `tests/oracle/**`: per-post per-class RDR2 bins and sha1s, JSON dumps of shaped runs (glyph ids, advances), KP line breaks, planned spreads, `CompiledFigure` JSON for the 2 ifd figures, solved template rectangles for the 6 templates, the distill lint outputs including its 3 planted controls, the mdast JSON of each post, and PNGs from the existing preview page and the room (fixed seed, fixed spp, light and dark, 1440x900 and 390x844) with background load recorded beside each. Also record the baseline numbers of section 11. This is the only part that runs code in Wave A, run once by the root.
2. A1 research bytes (lane `research`): licences and SOURCE.md under `docs/upstream/wave3/{wgpu,naga,harfrust,skrifa,read-fonts,klippa,markdown-rs,syntect,flecs}/` (full text of each exact release); S1..S4 spikes below. Nothing is built into the tree.
3. A2 skeleton (lane `skeleton`, root merges when the ECS lane is idle): root `Cargo.toml`, `crates/*` with public API stubs (`todo!()` bodies) fixing the contracts: `ArticleIR`, `layout()`, `RDR2` pack/parse, `App` and shim signatures, `lift_article`; `git mv world crates/mag-world` plus updating `scripts/build-world.ts`. `bun run build:world` and the site still work unchanged.

Spikes (step 0, all measured, results written into the sections they decide):
- **S1 wgpu on web**: hello compute plus render with `webgpu` only, with and without `wgsl`; opt-level s vs 3, fat LTO, wasm-opt; size raw and brotli; confirm naga is not linked; confirm `copy_external_image_to_texture`, storage-buffer limits and `uncaptured_error` work; one 8-storage-buffer compute pass in Chrome stable.
- **S2 Flecs script**: parse section 3.3 as written in the vendored flecs on native and wasip1; record which constructs fail (enum by name, `for`, `$i` interpolation, `const` expressions, multi-line strings, `Edge: a -> b`) and fix the surface syntax, not the schema.
- **S3 fonts**: harfrust vs harfbuzzjs glyph ids and advances for every string in the 11 posts (Inter variable at opsz 14 wght 400/500, Instrument Sans, Fira Code with `calt`); skrifa outline vs opentype.js path (curve error under 1/4096 em); klippa subset vs `hb-subset`.
- **S5 HDR canvas**: in Chrome stable (this Mac, XDR) and native Metal: configure `rgba16float` + `display-p3` + `extended` through wgpu `SurfaceColorSpace::ExtendedDisplayP3` and, if that fails, through `web-sys`; render a luminance ramp and a P3-red patch, read back f16, decide the transfer function (`OUT_TRANSFER`), the sRGB-to-P3 matrix placement, what headroom number Chrome and wgpu `display_hdr_info` give (and how it moves with display brightness), whether `COPY_SRC` on the canvas texture works, and whether CDP can emulate `dynamic-range`.
- **S4 two modules**: instantiate world.wasm and a stub wgpu module, measure the added startup, the per-frame bridge cost (40 floats), and whether a single module is worth reopening (threshold: more than 5 ms startup or 0.2 ms per frame).

**Wave B (all lanes parallel after Wave A, disjoint ownership, code only; the `gpu` lane's first files are `device.rs` (HDR configure), `present.rs` (`tm(x,H)`) and the headroom uniform, so HDR exists before any other pass is ported):**

| Lane | Owns (create or edit only these) | Delivers |
|---|---|---|
| `format` | `crates/mag-format/**` | RDR2 pack/parse, generated WGSL constants, format round-trip tests, fuzz target |
| `shaders` | `crates/mag-gpu/shaders/**`, `crates/mag-gpu/build.rs`, `crates/mag-gpu/tests/shaders.rs`, `scripts/gen-wgsl-consts.ts`, `src/lib/gpu/room/wgsl/**` (generated) | WGSL extracted from `shader.ts`/`magazine.wgsl.ts`, include expansion, naga gates (a)(b)(c), transitional `?raw` loaders. Edits `shader.ts`/`magazine.wgsl.ts` only inside a root-granted window after the ECS lane merges (shared file) |
| `text` | `crates/mag-text/**` | shaping, outlines, bands, KP, hyphenation, microtype, glyph table, oracle diff tests |
| `layout` | `crates/mag-layout/**` | grid, frames, planner, copyfit, figure compiler, route, palette, emit, `ArticleIR`, oracle diff tests |
| `world` | `crates/mag-world/**` (after the move), `crates/mag-world/scene/5*.flecs` | `mag.rs` components, `lift_article`, runtime Spread/Figure systems, pack errors, native tests, wasip1 build still green |
| `content` | `src/routes/(site)/thoughts/ifd/article.flecs`, `.../51-mag-templates.flecs` (owned by `world`, content lane writes the template text), converter `crates/mag-build/src/convert.rs` | one-shot `magazine convert-ts` (reads the TS figures/templates/frontmatter via the oracle JSON) producing the `.flecs` files; the T6 round trip |
| `gpu` | `crates/mag-gpu/src/**` | renderer modules of section 5, native `shot` harness, golden tests |
| `web` | `crates/mag-web/**` | `App`, input/hit ports with tests, relayout glue, events |
| `build` | `crates/mag-build/**` (except `convert.rs`), `scripts/vite-magazine.ts`, `tools/mathjax.mjs` | the `magazine` binary, svx parse and directive pre-pass, syntect palette, images, math cache, watch/shot/lint/validate, vite plugin |
| `shim` | `src/lib/gpu/shim.ts`, `src/lib/components/World.svelte` (wiring only), `tools/magazine-preview/**`, `tests/e2e/**` | JS shim, preview page on mag-web, CDP e2e scripts |

Shared files with a single owner (root): `Cargo.toml`, `src/lib/gpu/room/{room,shader,world}.ts` while they exist, `package.json`, `.gitignore`. Lanes request edits in writing; the root applies them.

**Wave C (root only, one pass):** merge in dependency order (`format`, `text`, `shaders`, `world`, `layout`, `content`, `build`, `gpu`, `web`, `shim`); build both wasm modules and the native binary once; run T1..T12 once; flip in the same commit: vite plugin calls `magazine`, Svelte loads `shim.ts`; delete every file in section 9; re-`bless` goldens from the Rust path after a reviewed diff; take the section 11 measurements; commit the wasm artifacts.

**Wave D (polish, same one-pass rule):** relayout worker if the 16 ms rule is hit, other articles get `article.flecs` (one each), explicit bind group layouts if profiling says so, upstream the `flecs_ecs` wasm patch (`docs/WORLD.md` trap 3, pre-authorised PR), update skills (`flecs-scene`, new `magazine-rs`), record learnings.

## 9. What is deleted at the flip (same commit)

`scripts/magazine/**` (all .ts, templates/, fig/, tests/), `scripts/reader/**` (what is not already deleted), `scripts/build-world.ts` (replaced by `build:wasm`), `src/lib/magazine/{format,types,dsl,chan,hit,input}.ts` and their tests, `src/lib/reader/**`, `src/lib/gpu/room/{room,shader,magazine,magazine.wgsl,reader,reader.wgsl,world,lightmap}.ts` (`magazine.test.ts` ported to Rust), `thoughts/ifd/{figures.ts,spread.json}`, the `distill:` block in `thoughts/ifd/+page.svx`, `harfbuzzjs`, `opentype.js`, `sharp` (unless the image fallback is taken), `unified`/`remark-*` used by the magazine path from `package.json`. The svelte `mdsvex` path for the hidden DOM stays.

## 10. Tests and acceptance (every check names its control)

Verification law: a check without a failing control proves nothing. Each control below is a planted bug run once to show the check goes red, then removed; the run output is kept in `tests/controls.log`.

| # | Check | Pass rule | Planted-bug control |
|---|---|---|---|
| T1 | naga validation of every composed WGSL, plus the same modules compiled by the browser (CDP `getCompilationInfo`) | zero errors, zero warnings; storage buffers per entry point at most 8 | undefined identifier in a fixture shader must fail with file:line; add a 9th storage binding must fail gate (b) |
| T2 | uniform layout: Rust `Sc`, `Rd` Pod structs vs naga-reflected layout | size and every offset equal | swap two fields in the Rust struct |
| T3 | RDR2 round trip: oracle bins parse in Rust and re-emit byte-identical; structured fuzz (`cargo-fuzz` or `proptest`) never panics and parse(emit(x)) == x | byte equal | flip one byte of a table count: parse must return an error, never a panic |
| T4 | text oracle: for the 11 posts, both classes: shaped glyph ids exact, advances within 1/4096 em, KP breakpoints exact, planned spreads and RDR2 items equal within 1e-4 em; native vs wasm (wasmtime) RDR2 bytes identical | all equal; documented exceptions list may exist only with a reason per entry | change one hyphenation penalty, one `looseness`, and a template column count: each must produce a non-empty diff |
| T5 | markdown and highlight parity: mdast JSON of each post equals oracle (after normalising position fields); syntect palette indices equal shiki's on every code token of the corpus (or the exact differing tokens listed and signed off) | equal | change a language grammar alias; strike a tag from the component registry (unknown component must fail with file) |
| T6 | Flecs round trip: `lift_article(ifd)` equals the oracle `CompiledFigure` JSON for both figures and the solved template rects; script syntax error reports `file: line` | equal | edit one key value in `article.flecs`; plant `Cap: sqaure`; plant a missing `describe` |
| T7 | distill lint (ported): verbatim, word count 100..250, at most 3 captions and 2 figures, review `post_sha` | the three oracle controls reproduce | the three planted controls of MAGAZINE.md 1.7 (a caption not in the post, a wrong `post_sha`, a 4th caption) must all fail |
| T8 | golden images (native wgpu on this Mac, Metal): (a) flat spread of ifd, light and dark, 1440x900 and 390x844; (b) both figures at t = 0, mid, poster; (c) the room tracer at fixed seed and spp. (a)(b): per-channel diff at most 3/255 on at least 99.9% of pixels and mean abs error under 0.2/255 (stroke AA edges allowed to differ, listed). (c): after a gaussian blur (sigma 4 px), mean abs error under 2/255 and SSIM at least 0.98 against the browser-TS oracle; load recorded beside each | pass | scale one stroke width by 1.1, swap a palette index, tilt the light by 5 degrees: each must fail; a re-run of the oracle against itself must pass at tolerance 0 (noise floor shown) |
| T9 | frame-loop logic: recorded call traces of `tick()` (rdIdle, lmN, rAF requests) from the oracle replayed against `frame.rs` | same sequence | change `LM_SPP` by one |
| T10 | world: the 50-cycle open/close/switch smoke test of `scripts/reader-smoke.ts` ported to a native Rust test (entity count stable after warm-up, spring no overshoot, event order, scroll clamp); wasip1 build still imports only the 12 hand-implemented WASI functions | pass | leak one entity per open |
| T11 | browser e2e (CDP, Chrome with `emulateMedia` for scheme and reduced motion): cold load `/thoughts/ifd` boots in reading pose; resize 1440x900 to 390x844 relayouts to the narrow class and matches the narrow golden; wheel settles on integer `f`; `#s3` deep link; device-lost shows the poster; hidden DOM holds all text and every figure `alt`/`describe` | pass | break the relayout hook; drop `aria` text |
| T13 | HDR: curve unit tests, readback assertions of section 5.1 (lamp over 1.0 and at most H, text/paper/UI at most 1.0, `H = 1` equals SDR oracle, no inf/NaN, p99.99 under 16384) | pass | the five planted bugs of 5.1 item 7 |
| T12 | size and speed gates (section 11) | within budget lines | inflate with a 5 MB static |

## 11. Fast edit-to-picture loop

Define "right" per rung, then iterate; record latency before and after (before: `bun scripts/magazine/watch.ts` is estimated about 1 s save-to-spread per MAGAZINE.md section 7, not measured; the oracle lane measures it).
1. **Copy and template edit** (`article.flecs`, `51-mag-templates.flecs`, `*.svx`): `magazine watch` re-lays-out the one article (fonts, shapers, world resident) and pushes RDR2 over WebSocket to the preview page, which only re-uploads buffers. Target under 300 ms save-to-pixels (to measure).
2. **Shader edit** (`*.wgsl`): watch process naga-validates in milliseconds, pushes the expanded source, the page recreates pipelines with no wasm rebuild. Target under 400 ms.
3. **Headless picture** (`magazine shot ifd --spread 0 --out /Volumes/Projects/tmp/x.png`, native wgpu, no browser, no GPU lease beyond one tiny dispatch): the rung for agents; PNG ready in under 1 s warm.
4. **Rust renderer or layout edit**: `cargo build -p mag-web --target wasm32-unknown-unknown` incremental dev profile (opt-level 1) plus `wasm-bindgen`; target under 10 s (to measure; this is the slowest rung and the one to watch).
5. Variant grids as in MAGAZINE.md: `?variants=duo,solo,compare`, `?fig=eval-timeline&sheet=0,3,6,9,12`, contact sheet of all spreads; the fidelity ladder uses the same RDR2 and the same WGSL at every rung (native shot, preview page, room reading pose, full world).

## 12. Size and speed measurements (take once in Wave A for the baseline, once in Wave C for the result; background load reported beside each)

| Measure | How |
|---|---|
| world.wasm (today: about 700 KB, 258 KB gzip, `docs/WORLD.md`) | raw, gzip, brotli before and after |
| JS today for room, magazine, reader, shaders, preview | `vite build` stats, raw/gzip/brotli per chunk; shader template strings alone |
| mag.wasm stages | S1 hello (webgpu only, with/without `wgsl`), + mag-format, + mag-text (harfrust, skrifa), + mag-layout, + mag-gpu full, + mag-web; each: raw, `wasm-opt -O3`, `-Oz`, brotli; `twiggy top` and `cargo bloat` for the top 20 symbols; wasm-bindgen JS glue bytes |
| startup | fetch to first frame, split into: compile world.wasm, compile mag.wasm, device init, pipeline creation, first bake, first present (Performance marks); compare with the TS path at the same scene |
| per-frame CPU | JS-visible frame function time (median, p95 of 5 runs of 600 frames) TS vs Rust; GPU time with timestamp queries; bridge cost |
| memory | peak JS heap + wasm memory (`performance.measureUserAgentSpecificMemory` or CDP heap) |
| relayout | wasm time for whole-article layout, one spread, class switch; main-thread long-task count |
| HDR | headroom reported by Chrome and by `display_hdr_info` at three brightness levels; present-pass GPU time `H=1` vs `H=4`; f16 accumulation headroom (p99.99 of `L*E`) per scene |
| data | `ArticleIR` and RDR2 bytes per post and class (raw, brotli), fonts bin, subset fonts |
Budgets are tripwires, not caps (binary size is no concern): fail the gate when mag.wasm exceeds 2x the S1-derived estimate, first frame is more than 150 ms slower than the TS path at the same load, or per-frame CPU is above the TS baseline (the target is lower: no GC, no JS marshalling). Report each number as "X at background GPU B% and CPU load L", median and spread over at least 5 runs, and as a ratio to the quiet baseline.

## 13. Five biggest risks

1. **Flecs script as the authoring medium for figures.** Animations with dozens of keys, loops and computed coordinates are awkward in a declarative script; unverified features (enums by name, `for`, string interpolation, multi-line strings) may be missing in Flecs 4.1, and errors carry entity paths not lines. Mitigation: S2 before any lane starts, sugar components (`Reveal`, `Appear`, `Draw`, `Travel`) and named Rust generators (`Edge`, scatter) keep scripts short; if S2 kills the loops the ifd file simply gets longer (it is data); the T6 round trip against the frozen compiled figures proves nothing was lost. If the surface is truly unusable the schema stays and the syntax moves to one entity line per node.
2. **GPU port parity and wgpu-on-web limits.** A stochastic path tracer ported to a different host language, wgpu validation and bind-group model, 18 storage bindings (cap 8 per stage), and `copy_external_image_to_texture`/limit behaviour can all differ from raw WebGPU; goldens cannot be bit equal. Mitigation: pipelines stay `layout: None` as today, naga gate (b), tolerance metrics with a noise-floor control (oracle against itself), S1 first, and the deterministic passes (flat spread, figures) get tight tolerances while the tracer gets blurred ones.
3. **Typographic parity (harfrust vs harfbuzzjs, KP, syntect vs shiki, markdown-rs vs remark).** Four independent ports can each shift one glyph or token and silently change every spread. Mitigation: exact-match oracle fixtures for each stage (T4, T5) with documented exceptions only, 1:1 algorithm ports before any improvement, native-vs-wasm byte equality to catch float divergence; if shiki parity fails the code highlight alone moves into the Node sidecar next to MathJax.
4. **Contention and tree stability.** `room.ts`, `shader.ts` and `world/` are under edit by another agent; the `world/` move, the WGSL extraction and the flip all touch them. Mitigation: root owns those files, the move and the extraction run in granted windows after the ECS lane merges, everything else is additive until Wave C, the oracle tag lets TS be deleted without losing a reference, and no lane builds in a worktree.
5. **Two-module startup and wasm cost, and HDR plumbing.** HDR adds one more unverified seam (wgpu web `color_space` mapping, the transfer function, the headroom number); S5 settles it before the `gpu` lane starts, and the `H = 1` parity test keeps the SDR look pinned to the oracle.
   Original risk: Two instantiates, a wasm-bindgen glue, async device init and pipeline creation could make first paint slower and the poster-to-world handoff visible; relayout in wasm could hit long tasks. Mitigation: parallel streaming compile, S4 threshold (5 ms startup, 0.2 ms per frame) for reopening the single-module option, section 12 measurements with a 150 ms first-frame tripwire, relayout worker staged in Wave D.

## 14. Learn-into-skills (owed at the end of Wave C)

Update `.claude/skills/flecs-scene/SKILL.md` with the magazine schema traps found by S2, add `.claude/skills/magazine-rs/SKILL.md` (workspace commands, the fast loop, how to bless goldens, the oracle tag), and record in `/Volumes/Projects/omni/journal/Learned/` every finding that differed from the beliefs above (wgpu `wgsl` feature and naga linkage, harfrust parity exceptions, Flecs script construct support). Lanes get the same instruction in their briefs.
