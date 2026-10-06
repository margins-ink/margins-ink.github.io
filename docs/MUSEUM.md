# MUSEUM: articles as a live museum (exhibits declared in Flecs script)

Status: design, 2026-10-06. Nothing here is built, run or verified in the tree; no code was changed. Facts are marked **read** (from this tree or a primary page this session), **reported** (from memory of the Flecs manuals) or **unverified** (a spike in stage S0 settles it). Builds on `docs/READING_GPU.md` (the reader is our WebGPU renderer), `docs/READING_CONTRACT.md` (frame protocol), `docs/WAVE3.md` (Flecs-declared magazine), `docs/FLECS_AUDIT.md`, `docs/TEXTFX.md` (cross-highlight), `docs/MAGAZINE.md` (figures) and `.claude/skills/flecs-scene/SKILL.md`.

Paths in the request that do not exist in this tree, so the doc uses the real ones: `world/src/magazine.rs` is gone (its state moved into `world/src/reading.rs` and `world/src/book.rs`); `scripts/magazine/figures.ts` is `src/routes/(site)/thoughts/<slug>/figures.ts` (today `ifd` and `models`) compiled by `scripts/magazine/fig/*`; the reader is `src/lib/reading/reader.ts` (read: 1283 lines, `figure` handling at lines 400-440, 576-620, 659-732).

## 0. The model in two sentences

An exhibit is a Flecs entity tree (parts, controls, state, rules) declared in a `.flecs` file next to its article, loaded as a child scope of the open article in the one shared world, and driven by a small closed set of generic Rust observers and systems that read the script's relations; the reader forwards pointer and key events in, and reads back one flat draw list that the page pass draws inside the exhibit's block rectangle. A figure is the degenerate exhibit (a clock and a scrub control over compiled art), so `FigureTime` and the figure ABI are deleted and replaced by the exhibit ABI in the same change.

## 1. The museum idea and what counts as an exhibit

A thought is an argument; today its figures illustrate it and the reader can only scrub them. In a museum the reader tests the argument with their hands: the Turing post lets you write a rule and watch the machine halt or loop, the IFD post lets you edit a source file and watch which actions rebuild. The article stays the author's prose (`+page.svx`); an exhibit is a block in it, like a figure, that you can play with. The room's Archive floor (`Basement`, `docs/DECOR.md`) shelves the historical artifacts (Jacquard cards, a Babbage column, an Enigma rotor) as props that open the same exhibits (section 6).

An exhibit is an exhibit only if all of these hold; the build lint (`scripts/magazine/exhibit.ts`, section 7) fails the article otherwise.

| # | Rule | Lint check |
|---|---|---|
| 1 | Interactive: at least one `Control` or `Hit` part changes persisted state. Autoplay alone is a figure (class Timeline) | count of parts with `Does` or `Draggable` >= 1, or a `Timeline` |
| 2 | Small: one frame, at most 36 x 22 em (`Frame`), at most 400 draw items at any step, script at most 250 lines, pack under 0.5 ms | items counted by packing every preset at step 0 and after 200 steps |
| 3 | One idea: `Claim` is one sentence of the post, shown as the caption; the exhibit draws nothing the claim does not need | `Claim` must occur verbatim in the `.svx` (same fail-closed rule as `distill` copy) |
| 4 | Legible: every fixed label is a word of the post (the figure rule of `ifd/figures.ts`), text at least 0.85 em, contrast through the existing `scripts/magazine/fig/contrast.ts`, ONE accent (amber, `THEME.accent`) marking only "what happens next" or "what is active" | colour fields are `Tone` names, never RGB (a literal fails) |
| 5 | Reset: a `Reset` control and the key `r` return to the first preset exactly | a `Does: {Reset}` part exists; test restores the snapshot hash |
| 6 | Shareable state: everything the user changed is in `Persist` state and encodes to at most 2 KB into the URL fragment (section 2.6) | round-trip test |
| 7 | Deterministic: no wall clock, no random, no hash-map iteration order in state. Time enters only as the fixed `Tick` | grep for `Random` and `Clock` components in the script; golden step tests |
| 8 | Fails closed: an unknown component, relation, verb or tone is a build error with the entity path (`exh.models.turing.r_scan_0: unknown Moves target "Rihgt"`), never a silent default | validated in a scratch world |
| 9 | Has a poster: a static frame (the first preset at step 0) compiled at build time, used on the spread, on the shelf card and before the exhibit scrolls near | poster items non-empty |

Hard non-goals: no free text entry in v1 (no IME or caret on a canvas; term editing is by palette buttons), no network, no sound, no per-exhibit shader. An exhibit that wants any of these is a different project.

## 2. The Flecs model

### 2.1 Where things live

```
world/scene/60-museum.flecs                       the prefab family below (scene script "museum", embedded; hot reload as today)
world/src/museum/{mod,model,input,draw,snapshot}.rs    ExhibitModule: components, generic observers, phases, packing
world/src/museum/kind_{timeline,tape,rewrite,graph,grid,wheel}.rs   one interpreter per exhibit family (section 2.5)
src/routes/(site)/thoughts/<slug>/exhibits/<name>.flecs   one file per exhibit, authored next to the article
```

The `.svx` references an exhibit by file name with a leaf directive, the same grammar as `::fig` (`scripts/magazine/parse-directives.ts`, read: LEAF regex, fail closed on unknown names):

```
::exhibit{id="turing" place="wide"}
```

`id` is the file stem (`models/exhibits/turing.flecs`), `place` is `inline | wide | column | bleed` as for figures. An unknown id, a file with no `::exhibit`, or two directives for one id fail the build. `distill.figures` ids share one namespace with exhibit ids: naming an exhibit there puts its poster on the spread.

### 2.2 One world, a `museum` scope (decision)

Pick: the same Flecs world as the room and the ReadingModule, with all museum components, prefabs and systems inside the scope `museum` (module `ExhibitModule`, imported next to `ReadingModule` in `reading::setup`; read: `world.import::<ReadingModule>()` at reading.rs:955). Each open article's exhibits are loaded with the article entity as the scope parent, so the article's cascade delete (read: pages already die with their article, reading.rs header) removes them.

Why not a per-reader world: (1) one hot-reload path, `update_script` into the live world, which already exists and dry-runs in a scratch world first (read: `scene::reload`, scene.rs:260-290); (2) the room's Archive props can hold `(Opens, exhibit)` relations to the same entities, no cross-world ids; (3) one ABI, one state buffer, one tick (`reader::tick` calls `progress_time` once, read: reader.rs); (4) observers and the existing exclusive relations `Hover`, `Focus`, `Open` (read: reading.rs header) are shared, so Tab order and TEXTFX cross-highlight (`Refers`) work without a bridge. Cost: a bug in exhibit code can corrupt the room world. Mitigations: the module imports into a bare `World::new()` too (tests and the build lint run exhibits with no room, as `reading_init` does today), exhibit systems only touch entities under `museum` queries, and the hot reload dry-run runs in a scratch world.

### 2.3 What Flecs script can and cannot declare (read: https://www.flecs.dev/flecs/FlecsScript.html, fetched 2026-10-06)

Supported and used below: `module`, `using`, `prefab`, `template` with `prop`, `const`, `enum`, `for i in a..b` with `"name_$i"` interpolation, `if`/`else`, pair assignment `(Rel, Tgt)` and `(Rel, Tgt): {value}`, `Component: {fields}` initialisers, nested children, `IsA` through `: Base`. The page documents no syntax for declaring systems, observers or queries in script, so treat them as not available. Consequence, and the first decision for Andrew: the script declares everything that is data (parts, geometry, state, rules as entities with relations, presets, controls and which exhibit they drive, tones); behaviour is a small closed set of Rust observers and systems that read that data (section 2.5). A new exhibit of an existing family is script only; a new family is one Rust file. This is the honest maximum, and it is still far past today, where figure content is TypeScript and interaction is 20 ABI functions.

### 2.4 Components, tags and relations (the vocabulary)

Components are reflected Rust structs (`#[derive(Component)]`, `Clone + Default`, registered through the module, which removes the "forgot `component_named`" trap of the flecs-scene skill). Enums are reflected Rust enums so scripts say `Moves: Right` style names (reported: flecs_ecs meta enums; S0.1). Coordinates are exhibit-local em, origin top-left of the `Frame`.

| Kind | Name | Fields or meaning |
|---|---|---|
| Component | `Frame` | `{w, h}` em; fixes the block height (the build lays the block out from it) |
| Component | `Title`, `Claim`, `Describe`, `Alt`, `Caption` | strings; `Describe` at least 40 chars and `Alt` required as for figures; `Claim` is the one sentence |
| Component | `Rect` | `{x, y, w, h}` of a part; `Hit` parts are tested in descending `Layer` |
| Component | `Layer` | `u8` z and hit order |
| Component | `Draw` | `{shape: Shape, tone: Tone}`; `Shape` = Rect, Round, Circle, Line, Arrow, Ring, Dot (the existing `ShapeKind` of format.ts:67) |
| Component | `Label` | `{text, size, align}`; text drawn by the UI glyph path (section 3) |
| Component | `Glyph` | `{text}` one symbol drawn centred in the part's rect |
| Component | `Does` | `{verb: Verb}` with `Verb` = Step, Run, Pause, Reset, Load, Cycle, Toggle, Scrub, Copy |
| Component | `Key` | one character that fires the part when the exhibit has focus |
| Component | `Range`, `Binds` | slider: `{min, max}` and a reflection path like `"Rate.hz"` it writes |
| Component | `Rate` | `{hz}` steps per second while `Running` |
| Component | `Budget`, `Steps`, `Fuel` | steps still owed, steps taken, steps left before a forced `Halted` |
| Component | `Tape` | `{cells}` authoring string; an observer materialises `Cell` entities (tape family) |
| Component | `Cell` | `{index}` |
| Component | `Timeline` | `{duration, mode, poster}` (the old `FigureTime`: loop, once, scrub, static) and `Clock {t, v}` |
| Component | `Order` | declaration order for rule rows and `Cycle` targets |
| Tag | `Exhibit`, `Part`, `Control`, `Button`, `Slider`, `Hit`, `Draggable` | what a thing is; `Control` parts join the Tab order |
| Tag | `Running`, `Halted`, `Pressed`, `Pending`, `Conflict`, `Dirty`, `Persist`, `Blank`, `Halting` | state flags; systems select by tag, never by a 0/1 float (FLECS_AUDIT item 7) |
| Prefab | `Exhibit`, `TapeMachine : Exhibit`, `Timeline : Exhibit`, `Button`, `Slider`, `Symbol`, `State`, `Rule`, `Preset` | the family (2.7) |
| Relation | `ChildOf` | a `Part` is a child of its exhibit; geometry is relative to the exhibit `Frame` |
| Relation | `IsA` | exhibit kind, presets as prefabs, controls from `Button` |
| Relation | `Drives` | `(Drives, exhibit_or_part)`: a control acts on this target |
| Relation | `Reads` | rule `(Reads, symbol)` the symbol the rule matches; in the graph family `(Reads, node)` is an input edge |
| Relation | `Writes`, `Moves`, `From`, `To` | rule: symbol written, direction (`Left`, `Right`, `Stay`), source and target state |
| Relation | `On`, `InState`, `Holds` | exclusive: head on a cell, head in a state, cell holds a symbol (a step is three relation rewrites) |
| Relation | `Alphabet` | machine to its symbols; `Cycle` walks it in `Order` |
| Relation | `Runs` | exclusive, exhibit to the current `Preset`; changing it is the `Load` verb |
| Relation | `Selected` | exclusive per exhibit: the part the keyboard acts on |
| Relation | `Hovering`, `Dragging` | exclusive on the world: the part under the pointer, the part holding pointer capture |
| Relation | `Refers` | to a TEXTFX `XrefGroup`: hovering the word `carry` in the prose lights the state in the exhibit |
| Relation | `Opens` | on a room prop (section 6): `(Opens, "models/turing")` as a string component `Opens {id}` since the exhibit may not be loaded |
| Singleton | `Pointer {x, y, down, id, mods}`, `Keys {code, mods}`, `Tick {n, dt}` | written by the ABI, read by systems (FLECS_AUDIT item 1: no `thread_local` inputs) |

Traits to set in the module: `Exclusive` on `On`, `InState`, `Holds`, `Runs`, `Selected`, `Hovering`, `Dragging`; `(OnDeleteTarget, Delete)` on `Drives` and `Alphabet`; `Acyclic` on `ChildOf` (default) (reported; each is a spike line in S0.1).

### 2.5 Observers, systems and phases

The reading world already has custom phases chained by `DependsOn` after `OnUpdate`: `Input -> Spring -> Layout -> Cull -> Pack` (read: reading.rs header). The museum adds one phase and puts the rest into existing ones, so it follows the same frame protocol:

| Phase | System or observer | Does |
|---|---|---|
| (event) | observer `Activate` on custom event, term `Does` | dispatch the verb on the `(Drives)` target: Step adds `Budget +1`; Run toggles `Running`; Reset reloads the current preset; Load sets `(Runs, preset)`; Cycle advances a relation target through `Alphabet` or the `To` states in `Order`; Scrub writes `Clock.t`; Copy emits the share event |
| (event) | observer `OnAdd Pressed` | emits `Activate` at the part (so pointer, key and test input share one path) |
| (event) | observer `OnAdd Tape` / `(Runs, *)` set | materialise cells; load a preset (clone the preset's children under the exhibit, remapping sibling references; S0.3 settles whether `IsA` re-instantiates on an existing entity, otherwise a 40 line copy function) |
| (event) | observer `OnSet Persist` and relation changes on persisted entities | add `Dirty`; push event `exhibitState` into the existing ring (TS debounces the URL write) |
| Input | `ExhibitPointer` | hit-test `Hit` parts of the exhibit the reader says is under the pointer; maintains `(Hovering)`, `(Dragging)`, adds `Pressed` on pointer up inside the pressed part |
| Input | `ExhibitKeys` | with `Focus` on an exhibit: `Key` parts, arrows move `Selected`, Enter and Space press it, `r` resets, Esc releases focus; returns consumed |
| Input | `ExhibitClock` | fixed timestep: `acc += dt`, whole ticks of `1/60 s` become `Tick`; for `Running` exhibits `Budget += Rate.hz * tick`; the sequence of states depends on step count only, never on frame time |
| Sim (new, `DependsOn(Input)`, before `Spring`) | `TapeStep`, `RewriteStep`, `GraphStep`, `GridStep`, `WheelStep`, `TimelineAdvance` | one system per family; each loops `while Budget > 0 && !Halted && Fuel > 0`, at most 64 per frame, consuming `Budget` and bumping `Steps` |
| Sim | `TapeMatch` (after `TapeStep`) | tags the one rule that will fire next `Pending`, and every extra rule with the same (From, Reads) `Conflict` |
| Layout | `ExhibitLayout` | derives `Rect` for derived parts (tape window follows the head with a critically damped spring, rule rows in `Order`, graph node positions from a layered pass) |
| Pack | `ExhibitPack` | for exhibits with `Visible` (existing tag, reading.rs): walk parts in `Layer` order and append `DrawItem`s to the draw list (section 3) |
| Pack | `PackState` (existing) | adds the new dirty bit and the exhibit slots to the `RD` buffer |

Per family the rule semantics are Rust, the data is script. The tape family's step is a pure query over relations, written out in 4.4. Families, and which exhibits use them: Timeline (all current figures), Tape (Turing machine, Jacquard loom, Enigma stepping), Rewrite (lambda calculus, mkTuple, unification), Graph (action graph, Merkle DAG, archetype tables), Grid (path planning), Wheel (Babbage engine, slide rule if ever). Six Rust files of 150 to 400 lines is the whole behavioural budget of the museum.

### 2.6 Input, snapshot and the URL fragment

Input enters through two ABI calls and nothing else (section 3.3): the reader hit-tests blocks in TypeScript (`reading/hit.ts`, read) and, when the pointer is over an exhibit block, converts to exhibit-local em and calls `exhibit_pointer`. The Rust side owns everything inside the frame, so exhibits never see page coordinates.

State is shareable through the fragment `#x:<id>=<blob>` (several exhibits join with `&`; the `x:` prefix cannot collide with `#ref-*` anchors, read: `scrollstate.ts` keeps its block anchor in `history.state`, not the fragment). `<blob>` is `base64url(version(4 bytes: first 4 bytes of sha256 of the exhibit script) + kind payload)`. Each family implements `encode(exhibit) -> bytes` and `decode(exhibit, bytes) -> Result`: the tape family writes text, for example `inc|1011|0|8|` plus rule edits as `r3=1Sd` (writes `1`, moves `S`, to `done`), so a link is readable in a bug report. A stale version hash falls back to the first preset and shows a toast (the existing toast widget). `history.replaceState` runs at most once per 300 ms after an `exhibitState` event, never `pushState` (no back-button spam). The same encoder is the hot-reload state keeper (2.8) and the planted-bug test fixture.

### 2.7 The prefab family (script, `world/scene/60-museum.flecs`)

```flecs
// Scene script "museum". Components are registered by ExhibitModule; this file only declares shapes of data.
module museum
using museum.Dir

prefab Part   { Layer: {1} }
prefab Button : Part { Control  Hit  Layer: {2}
  Draw: {Round, Panel}  Rect: {0, 0, 4, 1.8} }
prefab Slider : Part { Control  Hit  Draggable  Layer: {2}
  Draw: {Round, Panel}  Rect: {0, 0, 6, 1.8} }

prefab Exhibit { Exhibit  Frame: {36, 14} }
prefab TapeMachine : Exhibit {
  Frame: {36, 21}
  Rate: {4}  Fuel: {5000}  Steps: {0}
}
prefab Timeline : Exhibit {
  Timeline: {duration: 10, mode: loop, poster: 0}
  scrub : Slider { Rect: {2, -1.6, 32, 1.2}  Does: {Scrub} (Drives, $parent) }
  play  : Button { Rect: {0, -1.6, 1.4, 1.2}  Does: {Run}   (Drives, $parent) Key: {" "} }
}

// Tape-family parts, instantiated by a Preset (see 4.2)
prefab Symbol { Glyph: {"?"} }
prefab State  {}
prefab Rule   { Order: {0} }
prefab Preset {}
```

`$parent` as a pair target is a placeholder for "the instance's parent"; Flecs script has no such token (unverified, S0.2). The fallback is that the Rust loader resolves `Drives` with no target to the exhibit root (a `Control` with no `Drives` drives its nearest `Exhibit` ancestor). The doc below uses the fallback form (no target) so the scripts survive S0.2 either way.

### 2.8 Authoring and hot reload

- Dev: `scripts/magazine/vite-plugin.ts` already rebuilds on any thoughts `+page.svx`, `figures.ts` or `spread.json` change (read, CLAUDE.md "Magazine trap"). Add `exhibits/*.flecs` to the watch set and push `exhibit:reload {slug, name, src}` over the HMR socket, the same wire as `scene:reload` (read: WORLD.md "Hot reload").
- Reader dev hook (`src/lib/reading/exhibit-hot.ts`, only under `import.meta.env.DEV`) snapshots every open exhibit (`exhibit_snapshot`), calls `exhibit_reload`, then restores. `exhibit_reload` is `scene::reload`'s method: dry run in a scratch world with only `ExhibitModule`, then `ecs_script_update` on the named script `exh::<slug>::<name>`, which deletes what the script created and re-runs it (read: the comment above `update_script`, scene.rs:127; it is not transactional, hence the dry run). A script error shows the Flecs `file: line: msg` in the dev overlay and keeps the old exhibit. Target latency like the scene: about 30 ms save to frame (measure).
- Production: scripts are concatenated per article into `static/magazine/<slug>.exhibits.<hash>.flecs` next to the `.bin` blobs, fetched with the article, and run by `exhibit_load` with the article entity as scope. A script is data in a hashed file, so no wasm rebuild per exhibit (the dev server needs no Rust toolchain, as for `world.wasm`).

## 3. Rendering

### 3.1 Static art, dynamic art, one draw list

Two layers, one scissor rectangle:

1. Static art (frame card, titles, fixed labels, a Timeline's compiled figure items) is compiled at build time into the RDR blob exactly as a figure's items and channels are today (`scripts/magazine/fig/*`, `src/lib/magazine/chan.ts`), under the block's item range. Unchanged pipeline, zero per-frame work.
2. Dynamic art (tape cells, head, rule rows, graph nodes, hover plates) is the exhibit draw list: `ExhibitPack` fills a flat buffer each dirty frame, `exhibit_draw_ptr()/exhibit_draw_len()` expose it like the existing `RD` state buffer (a `Float32Array` view on wasm memory).

`DrawItem`, 8 words (32 B), `XD` constants in `abi.ts`:

| Word | Content |
|---|---|
| 0..3 | `x, y, w, h` in exhibit-local em (for `Line` and `Arrow`: start and delta) |
| 4 | `shape u8 | tone u8 | aux u16` (aux is a string index for `Label`/`Glyph`, radius f16 for shapes) |
| 5 | `alpha f16 | glow f16` (glow above 0 uses HDR on the extended canvas, as TEXTFX) |
| 6 | exhibit index (for the scissor) and `flags` (hover, pressed, selected) |
| 7 | shape parameter (ring width, dash, arrowhead) |

400 items is 12.8 KB per frame at most, one `writeBuffer`. Idle exhibits cost nothing: the existing `RD.dirty` gets bit 5 ("an exhibit changed or animates"), and no bit means no frame, as today (read: frame protocol step 4).

### 3.2 Pipelines, clip, colour

- Shapes reuse the page pass shape pipeline: `ShapeKind` rrect, circle, line, arrowHead, hatch, dot, ring already exist (read: format.ts:67). The draw list becomes one more instanced draw in `page.ts` after the article items and before the UI overlays (so the top bar, scrollbar and toasts stay above). Text reuses the second instanced draw of UI glyphs (`PageFrame.uiText`, `ui/text.ts`, read: READING_GPU.md "GPU chrome"): Rust emits string indices, TypeScript shapes each distinct string once (cache key: string, font, size) and emits `UiGlyph`s from the exhibit item position. Strings are interned in Rust per exhibit and read with `exhibit_str(i)`; JS owns strings, as today (reading.rs header).
- Scissor: one `setScissorRect` per visible exhibit, the block's rectangle in page pixels (document em to px by the frame protocol formula in READING_CONTRACT.md, then intersected with the viewport and the fold clip `RD.foldClipEm`). At most two exhibits are on screen in practice; a third is skipped until it scrolls in (`Visible`). Nothing an exhibit draws can leave its frame; the e2e test checks a pixel row outside the rect.
- Colour: tones are slot names resolved to `THEME` (`src/lib/reading/theme.ts`, the single source: Ground, Panel (elevation 2), Ink, Ink2, Ink3, Accent, Accent2, Rule). There is no per-exhibit hue and no light variant (CLAUDE.md "One colour, one accent", "The world has one look"). Amber marks exactly two things: what will happen on the next step (the `Pending` rule, the cell under the head) and what is running. HDR: the glow channel may take the accent to 1.3 on the extended canvas only; the 8 bit canvas clamps (same rule as TEXTFX).
- Motion: spring omegas (tape window follow, hover plate) live in script as a `Spring {omega}` component (FLECS_AUDIT item 14), under reduced motion they are instant (`Reduced` singleton tag, read).

### 3.3 The ABI (replaces the figure ABI)

Deleted in the same change: `INPUT.scrubBegin/scrubTo/scrubEnd/figureStep/figurePlay/figureHome`, `RD.scrubFig`, `RD.figBase` (16 figure clocks), `MAX_FIG_STATE`, the `FigureClock`/`FigureAdvance` systems and the `Figure`/`FigureTime` components in reading.rs (read: abi.ts:74-113, reader.ts:141-142, 576-620). Added in `src/lib/reading/abi.ts`:

```ts
exhibit_load(ptr, len, blockIndex, scriptHash) -> u32       // run a script as a child scope of the article; 0 ok, else error text in the error buffer
exhibit_pointer(ex, kind, xEm, yEm, buttons, mods) -> u32  // bit 0 consumed, bit 1 wants capture, bits 2..5 cursor id
exhibit_key(code, mods) -> u32                              // 1 if consumed
exhibit_snapshot(ex) -> ptr/len   exhibit_restore(ex, ptr, len) -> u32
exhibit_draw_ptr() / exhibit_draw_len()   exhibit_str(i) -> ptr/len
exhibit_reload(slug, name)                                  // dev only
```
`reading_tick` runs the exhibit systems (one pipeline, one tick). The event ring gains `exhibitState`, `exhibitHalted`. `RD` gains `RD.exhibitDirty` inside `dirty` bit 5 and `RD.exFocus` (the exhibit holding keyboard focus, -1 none).

### 3.4 Input routing

| Input | Rule |
|---|---|
| Wheel | Always scrolls the page, except while an exhibit part is `Dragging`, and `ctrl`/pinch wheel over an exhibit with a `Wheel` part (grid zoom). The scroll engine already ignores ctrl wheel (read: READING_GPU.md "Wheel"), so exhibits take it for free |
| Mouse | `pointermove` over an exhibit block calls `exhibit_pointer(hover)`; the return value sets the canvas cursor (`pointer`, `grab`, `ew-resize`, default). `pointerdown` on a `Hit` part: the reader calls `canvas.setPointerCapture` (as for the scrollbar thumb) and the page drag is not started. `pointerdown` elsewhere in the frame does nothing (no text selection starts inside an exhibit) |
| Touch and pen | `pointerdown` on a `Hit` part waits for the engine's existing drag threshold: movement mostly along a `Draggable` part's axis captures it, anything else becomes page scroll (fling and rubber band untouched). Every `Hit` part has at least a 44 CSS px target (`Hit` rect inflated at test time, the lint warns when a part is smaller than 1.6 em) |
| Keyboard | Tab visits `Control` parts after links in reading order (the engine owns Tab, READING_GPU.md "Selection, links"); `exhibit_key` is called only while an exhibit has `Focus`: Enter or Space presses the `Selected` control, arrows move `Selected`, `Key` parts fire on their letter, `r` resets, Esc releases focus. While focused, Space is consumed by the exhibit; PageDown, Home and End still scroll. The J/K/E/T chrome keys are unaffected because an exhibit binds only the letters it declares in `Key` (lint: no clash with J K E T F `/`) |
| Focus ring | drawn by the exhibit pack as a `Ring` item around the `Selected` part, in accent |

Accessibility cost, accepted under Andrew's standing decision (2026-10-06, no mirror): an exhibit is operable by keyboard but is invisible to screen readers, Reader Mode and search engines. Nothing is added back; `Describe` and `Alt` are build-time lint and the find bar (`find.ts`) may search `Title`, `Claim` and `Caption`, nothing more. The e2e check that fails on any DOM text node stays and covers exhibits.

## 4. Worked exhibit: the Turing machine

File: `src/routes/(site)/thoughts/models/exhibits/turing.flecs`, placed in the post "When you pay for computation" (`models`, which already has the `two-machines` figure and argues Turing machine versus lambda calculus). The tape is shown as cells; the machine is three relations: head `(On, cell)`, head `(InState, state)`, cell `(Holds, symbol)`.

### 4.1 Component and relation table for this exhibit

| Entity | Kind | Components and relations |
|---|---|---|
| `turing` | `TapeMachine` | `Title`, `Claim`, `Describe`, `Alt`, `Caption`, `Frame {36, 21}`, `Rate {hz}`, `Fuel`, `Steps`, `(Runs, <preset>)` exclusive, tags `Running`, `Halted` |
| `inc`, `bb3` | prefab `Preset` | `Title`, `Tape {cells}`, `HeadAt {index}`, children: symbols, states, rules |
| symbol (`zero`, `one`) | `Symbol` | `Glyph {text}`, tag `Blank` on the blank one; `(Alphabet, symbol)` on the machine, order by `Order` |
| state (`scan`, `carry`, `done`) | `State` | tag `Halting` on halting states; `(InState)` targets |
| rule `r_*` | `Rule` | `Order`, `(From, state)`, `(Reads, symbol)`, `(Writes, symbol)`, `(Moves, Dir)`, `(To, state)`; tags `Pending` (fires next), `Conflict` (another rule has the same From and Reads) |
| cell | `Cell` (materialised) | `Cell {index}`, `(Holds, symbol)` exclusive, `(Right, cell)` and `(Left, cell)` links, grown on demand to both sides |
| `head` | `Head` (materialised) | `(On, cell)` exclusive, `(InState, state)` exclusive; persisted |
| controls | `Button`, `Slider` | `Rect`, `Does`, `Key`, `Label`, `Drives` (defaults to the exhibit), `Layer 2` |

### 4.2 The script

```flecs
// models/exhibits/turing.flecs  (Flecs script; grammar: module/using/prefab/pairs/const/for as read on the Flecs script page)
using museum
using museum.Dir

// ---- preset 1: binary increment. Head starts on the leftmost digit; 1011 + 1 = 1100 in 8 steps, 111 + 1 = 1000 in 8.
prefab inc : Preset {
  Title: {"binary increment"}
  Tape: {"1011"}  HeadAt: {0}

  blank : Symbol { Glyph: {"·"}  Blank  Order: {0} }
  zero  : Symbol { Glyph: {"0"}  Order: {1} }
  one   : Symbol { Glyph: {"1"}  Order: {2} }
  scan  : State  { Order: {0} }
  carry : State  { Order: {1} }
  done  : State  { Order: {2}  Halting }

  r_scan_0  : Rule { Order: {0}  (From, scan)  (Reads, zero)  (Writes, zero)  (Moves, Right) (To, scan) }
  r_scan_1  : Rule { Order: {1}  (From, scan)  (Reads, one)   (Writes, one)   (Moves, Right) (To, scan) }
  r_scan_b  : Rule { Order: {2}  (From, scan)  (Reads, blank) (Writes, blank) (Moves, Left)  (To, carry) }
  r_carry_1 : Rule { Order: {3}  (From, carry) (Reads, one)   (Writes, zero)  (Moves, Left)  (To, carry) }
  r_carry_0 : Rule { Order: {4}  (From, carry) (Reads, zero)  (Writes, one)   (Moves, Stay)  (To, done)  }
  r_carry_b : Rule { Order: {5}  (From, carry) (Reads, blank) (Writes, one)   (Moves, Stay)  (To, done)  }
}

// ---- preset 2: 3-state busy beaver (Rado's sigma champion): writes six 1s and halts after exactly 14 steps on a blank tape.
// Table checked by hand simulation 2026-10-06: A0 1RB, A1 1RH, B0 0RC, B1 1RB, C0 1LC, C1 1LA.
prefab bb3 : Preset {
  Title: {"3-state busy beaver"}
  Tape: {""}  HeadAt: {0}

  zero : Symbol { Glyph: {"0"}  Blank  Order: {0} }
  one  : Symbol { Glyph: {"1"}  Order: {1} }
  a    : State  { Order: {0} }
  b    : State  { Order: {1} }
  c    : State  { Order: {2} }
  halt : State  { Order: {3}  Halting }

  r_a0 : Rule { Order: {0} (From, a) (Reads, zero) (Writes, one)  (Moves, Right) (To, b) }
  r_a1 : Rule { Order: {1} (From, a) (Reads, one)  (Writes, one)  (Moves, Right) (To, halt) }
  r_b0 : Rule { Order: {2} (From, b) (Reads, zero) (Writes, zero) (Moves, Right) (To, c) }
  r_b1 : Rule { Order: {3} (From, b) (Reads, one)  (Writes, one)  (Moves, Right) (To, b) }
  r_c0 : Rule { Order: {4} (From, c) (Reads, zero) (Writes, one)  (Moves, Left)  (To, c) }
  r_c1 : Rule { Order: {5} (From, c) (Reads, one)  (Writes, one)  (Moves, Left)  (To, a) }
}

// ---- the exhibit
turing : TapeMachine {
  Title:    {"A Turing machine"}
  Claim:    {"A table of rules, a tape and a head compute."}   // replaced by a sentence of the post; lint: must occur verbatim in +page.svx
  Describe: {"A tape of cells, a head on one cell in one state, and a rule table. Each step finds the rule for the state and the symbol under the head, writes, moves and changes state."}
  Alt:      {"A row of tape cells with a head marker below one of them, a button row above and a table of rules below with the next rule highlighted."}
  Caption:  {"Click a cell or a rule field to edit it. Step runs one rule."}
  (Runs, inc)

  // controls (row y = 1.2)
  b_step  : Button { Rect: {1,    1.2, 4,   1.8}  Label: {"Step"}   Does: {Step}  Key: {"s"} }
  b_run   : Button { Rect: {5.4,  1.2, 4,   1.8}  Label: {"Run"}    Does: {Run}   Key: {" "}  LabelAlt: {"Pause"} AltIf: {Running} }
  b_reset : Button { Rect: {9.8,  1.2, 4,   1.8}  Label: {"Reset"}  Does: {Reset} Key: {"r"} }
  b_inc   : Button { Rect: {15,   1.2, 6.4, 1.8}  Label: {"increment"} Does: {Load} Loads: {"inc"} }
  b_bb3   : Button { Rect: {21.8, 1.2, 6.4, 1.8}  Label: {"busy beaver"} Does: {Load} Loads: {"bb3"} }
  speed   : Slider { Rect: {29,   1.2, 6,   1.8}  Label: {"speed"} Does: {Scrub} Binds: {"Rate.hz"} Range: {1, 30} }

  // derived parts (positions come from ExhibitLayout; only the style is declared here)
  tape  : TapeView  { Rect: {1, 4.0, 34, 2.4}  Cell: {2.0, 0.2}  Window: {15} }   // 15 visible cells, 2.0 wide, 0.2 gap; follows the head
  head  : HeadMark  { Rect: {0, 6.6, 2.0, 1.2}  Draggable  Hit  Draw: {Arrow, Accent} }
  stat  : StatusLine { Rect: {1, 8.0, 34, 1.2} }                                    // "step 8   state carry   halted: accept"
  table : RuleTable { Rect: {1, 10.0, 34, 10.2}  Row: {1.1}  Cols: {5.0, 3.5, 3.5, 4.0, 5.0}  Max: {8} }
}
```

Notes on the script: names with digits and `$i` interpolation are not needed (cells are materialised from `Tape {cells}` by an observer, so the `for i in 0..N` form is unused; if S0.2 shows it works, authors may use it for fixed-size grids in other exhibits). `Loads {id}` names a preset entity by string so the button does not need a pair to a prefab sibling. `TapeView`, `HeadMark`, `StatusLine`, `RuleTable` are prefabs of the tape family in `60-museum.flecs` that carry the layout components the family's `ExhibitLayout` reads. `Dir` constants (`Left`, `Right`, `Stay`) resolve through `using museum.Dir`.

### 4.3 Hit regions (exhibit-local em; frame 36 x 21)

| Id | Rect `x y w h` | Verb and effect | Cursor |
|---|---|---|---|
| `b_step` | 1, 1.2, 4, 1.8 | `Step`: `Budget += 1` | pointer |
| `b_run` | 5.4, 1.2, 4, 1.8 | `Run`: toggle `Running`; label swaps to Pause | pointer |
| `b_reset` | 9.8, 1.2, 4, 1.8 | `Reset`: reload `(Runs)` preset, clear `Halted`, `Steps` | pointer |
| `b_inc`, `b_bb3` | 15, 1.2, 6.4, 1.8 / 21.8, 1.2, 6.4, 1.8 | `Load`: set `(Runs, preset)` | pointer |
| `speed` | 29, 1.2, 6, 1.8 | `Scrub`: capture, write `Rate.hz` from pointer x | ew-resize |
| cell k (k = 0..14) | 1 + 2.2k, 4.0, 2.0, 2.4 | `Cycle`: advance the cell's `Holds` through `Alphabet` | pointer |
| `head` | head cell x, 6.6, 2.0, 1.2 | drag: capture, snap `(On)` to the cell under the pointer | grab, grabbing |
| rule row r, field f (r = 0..7) | col_x[f], 11.3 + 1.1r, col_w[f] - 0.2, 1.0 | `Cycle` that rule's relation: f=0 From, 1 Reads, 2 Writes, 3 Moves, 4 To; a Moves cycle is Left, Right, Stay | pointer |
| rule delete r | 33.2, 11.3 + 1.1r, 1.8, 1.0 | delete the rule entity | pointer |
| rule add | 1, 11.3 + 1.1 * rows, 5, 1.0 | add a blank rule child (ignored until From and Reads are set) | pointer |

Column x origin for the table: From 1.0, Reads 6.0, Writes 9.5, Moves 13.0, To 17.0 (widths 5.0, 3.5, 3.5, 4.0, 5.0; the remaining width to 34 holds the status text). Tests compute these rects by asking `exhibit_pointer` which part is hit across a sampled grid, not from this table, and compare to the table only in the lint (so the table cannot silently drift).

### 4.4 The Step system (Rust, generic over any `TapeMachine`)

Pseudocode in Flecs query terms; this is the whole semantics of the tape family:

```
// system TapeStep, phase Sim, query: TapeMachine exhibit with Budget > 0, not Halted
head_q  = Head, (InState, $s), (On, $c)                       // per exhibit, vars $s $c
rule_q  = Rule, (From, $s), (Reads, $sym)                     // cached query, vars set per match; $sym = (Holds($c))
loop while budget > 0 and fuel > 0:
    sym  = target of (Holds, *) on $c
    rule = rule_q(s, sym) ordered by Order, first match      // second match = Conflict, first still wins
    if none:  add Halted, (Why, NoRule); break
    set (Holds, rule.Writes) on $c
    $c' = match rule.Moves: Left => (Left,$c) | Right => (Right,$c) | Stay => $c   // grow the tape when the link is missing
    set (On, $c') and (InState, rule.To) on head
    steps += 1; fuel -= 1; budget -= 1
    if state(rule.To) has Halting: add Halted, (Why, Accept); break
```
`TapeMatch` then tags the next rule `Pending` (or none) so the table shows what Step will do before it is pressed.

### 4.5 Snapshot payload (tape family)

`preset-id | tape text | head offset | steps | halted | rule edits`, for example `inc|1011|3|5|0|r3=0Rc`. Decode builds the preset first, then applies the diff, then sets `Steps`, so a link made before a preset is edited in the script falls back through the version hash (2.6).

## 5. Catalogue: ten more exhibits, ranked

Value 1 to 5 is how much of a post's argument the exhibit carries; cost is lane-days of one Sonnet lane after the framework exists (estimates, not measured). Posts named from the tree (read: `thoughts/`: commit, gpt4-hals-and-rest-libs, hyperion, ifd, initial-thought, mcp-not-enough, models, notes-on-errors, nushell-tui, optimal-parkour, rust-named-parameters, snuon); content of `hyperion`, `optimal-parkour` and `commit` is not re-read here, so those ties are marked (verify).

| # | Exhibit | Family | Post and artifact | Value | Cost | What you do and what it shows |
|---|---|---|---|---|---|---|
| 1 | Action graph with cache hits (Buck2 style) | Graph | `ifd`; Buck2 dynamic deps | 5 | 3 d | Edit a source node: inputs hash, changed hashes propagate, unchanged actions show an accent cache-hit ring, rebuilt ones hatch. A "dynamic dependency" toggle makes eval discover an edge mid-run, the post's Fig. 2 claim (graph grows as eval discovers) made hands-on |
| 2 | Lambda reducer with Church numerals | Rewrite | `models`; Church 1936 | 5 | 4 d | Terms are entity trees (`App`, `Lam`, `Var` with `(Binds, lam)`). Click a redex to reduce it; toggle normal versus applicative order; presets `succ 2`, `add 2 3`, and omega (never halts, `Fuel` stops it). Pairs with exhibit 3 |
| 3 | Content-addressed Merkle DAG: a rename is free | Graph | `ifd`, nix content addressing (the `nix-cycles` post cited in CLAUDE.md is not in the tree: verify before linking) | 5 | 2 d | Tree of blobs and trees with 4 hex digit hashes. Rename a file: only the parent tree hash changes, the blob keeps its hash (the "free" part, drawn as the unchanged ring); edit content: hashes change up to the root; duplicate files share one node. Reuses exhibit 1's node and hash code |
| 4 | Path planning grid | Grid | `optimal-parkour` (verify) | 5 | 3 d | Paint walls and a goal; step BFS versus A* frontier; move set as `(Moves, offset)` relations (walk, jump of 1 gap, sprint jump) so the post's jump constraints are editable data; show expanded count beside path length |
| 5 | Type that computes: `mkTuple` | Rewrite | `models`; Lean `Tuple n alpha` | 4 | 4 d | Slide `n`: the type `Tuple n Nat` unfolds one step per click to `Nat x ... x Unit`, the value `mkTuple 3 0` reduces beside it. Shows a type is a computation. Same interpreter as 2 with a `Nat` recursor and a typed display |
| 6 | Unification and inference stepper | Rewrite | `models` ("inferred or written") | 4 | 5 d | Hindley-Milner on a 4 line term: constraint list as entities, `(Unifies, tvar)` relations, step one constraint, union-find merges drawn as nodes merging. Highest risk of illegibility; ship after 1 to 5 |
| 7 | Jacquard loom | Tape | `models`; Jacquard 1804, punched cards that Lovelace's 1843 Note G compares to Babbage's engine | 4 | 2 d | The card deck is the tape, the hook row the head: click holes, step one card, the thread pattern grows. Reuses the tape interpreter with a 2-D read (columns of `Hole` cells per card); the cleanest historical artifact for "a program is data" |
| 8 | Babbage difference engine | Wheel | `models` or a future history post; Difference Engine No. 2 | 4 | 4 d | Three columns of digit wheels, crank = Step, carries ripple one wheel per phase (drawn, not instant); `n^2 + n + 41` by finite differences. Wheel family: `Wheel {digit}`, `(Adds, column)`, carry as a `Pending` tag cascade |
| 9 | Archetype table | Graph | `hyperion` (verify) and the Flecs argument of CLAUDE.md "Writing" | 4 | 3 d | Entities as rows, components as columns, add or remove a component and the row jumps to the table with that component set; query terms light matching tables. The site's own engine as an exhibit |
| 10 | Enigma | Tape | no post yet | 3 | 4 d | Three rotors, plugboard pairs, the double-step anomaly shown by stepping letters. Build only with a post; as a tape-family exhibit it shares 90 percent of 7 |

Cut: the slide rule. It is a single `Slider` over a log scale, a cute demo of the `Slider` part, but no post argues from logarithms and it teaches nothing the Babbage wheels do not teach better. Reconsider if a floating point post exists.

Ordering by value over cost: 3, 1, 4, 7, 9, 2, 5, 8, 6, 10. The Turing machine (section 4) is exhibit 0: it forces the framework, and every later one is script plus at most one interpreter.

## 6. The museum in the 3D world

Yes, narrowly: as props that open an exhibit, not as objects you play with in 3D.

- The Archive floor (`Basement`, `docs/DECOR.md`: dusty listening room, amber neon "old") already exists and is the right home for historical artifacts. Add prefabs in `world/scene/12-decor.flecs` style: `JacquardCards` (a box stack of punched card textures), `BabbageColumn` (brass cylinders as boxes and spheres, within the 90 object decor budget), `EnigmaBox`. Each carries `Artifact` and `Opens {"models/jacquard"}`. A prop is a `Card`/`Solid` assembly like `Plant` (read: 10-prefabs.flecs), placed with `Rests` on the Archive shelf.
- Clicking a prop is the same gesture as clicking a book: the room already has click hit regions for floors and books (read: ELEVATOR.md "Clicking a floor", WORLD.md book hit regions). A click on an `Artifact` calls `article_open(index, snap=false)` then deep-links `#x:<id>`; the reader in-world mode (`data-mode=world`) shows the page scrolled to the exhibit. The exhibit plays in the reader pane, in one implementation.
- Why not play in 3D: the room is path-traced boxes and spheres (read: DECOR.md "intersect tests every object linearly"), with no text pipeline, no UI pass and a scroll-driven elevator camera (no free walking, so "walk up to" is not a verb in this world). Rendering a tape machine there duplicates the draw path, loses scissor-based legibility, and costs per-object ray time. The poster (the build-time static frame, rule 9) can be a `Card` texture on the Archive wall, drawn as a gallery label, for zero runtime cost.
- Which exhibits get props: only the ones that are physical artifacts (Jacquard, Babbage, Enigma). Software exhibits (lambda, Merkle, grid) have no object, and a fake plinth for them is decoration. Rooms stay keyed by year; the Archive is the one thematic floor.
- A museum index, `static/magazine/museum.json` (slug, exhibit id, title, claim, poster rect), is built with the shelf (read: `shelfProblems()` and `shelf.test.ts` already guard the shelf index). It feeds the props' `Opens` check (a prop pointing at a missing exhibit fails the build) and a future "museum" listing. No article-less exhibits: every exhibit is authored beside the article that argues from it, so there is no new route type.

## 7. Test strategy

Principle (house rule): a few strong integration tests, then one level down only where a bug is likely. Everything is deterministic because exhibit state depends on step count only (2.5 `ExhibitClock`).

1. Golden machines, native: `world/tests/exhibits.rs`. A bare `World::new()` with only `ExhibitModule`, loads `models/exhibits/turing.flecs` from disk (the production file, not a copy), and drives it through the same `exhibit_pointer` and `exhibit_key` the browser calls (it finds `b_step` by hit-testing a grid, not by coordinates). Asserts: increment on `1011` halts after exactly 8 steps with tape `1100`; on `111` after 8 steps with tape `1000` (checks growth to the left); busy beaver halts after exactly 14 steps with six `1`s and state `halt`; `Steps`, `Halted` and `Why` are right; hash of all `Persist` state is identical when the same run is driven as 1 frame of 8 ticks, 8 frames of 1 tick, and with `dt` 1/60 versus 1/144 (the step sequence must not depend on frame time).
2. Snapshot and URL: `encode -> decode -> encode` is the identity for the three presets and for 200 generated edit sequences (hegel property test: random cell cycles, rule cycles, head drags, steps), blob at most 2 KB, a stale version hash falls back to the first preset.
3. Whole ABI through wasm: `src/lib/reading/exhibit.test.ts` (bun test) loads the committed `world.wasm`, runs `exhibit_load`, a click script (Load bb3, Step x14), reads the draw list: item count at most 400, every item inside `Frame`, the `Pending` rule row carries the accent tone before the halting step and none after, every `Hit` rect lies inside the frame and no two equal-layer hit rects overlap.
4. Build lint: `scripts/magazine/tests/exhibit.test.ts` runs `scripts/magazine/exhibit.ts` over every `exhibits/*.flecs` in the tree (the rules of section 1), including fixtures that must fail one rule each (missing `Describe`, `Claim` not in the post, an RGB literal, `Random`, a missing Reset, a typo in `Moves`).
5. e2e: a new section in `tests/e2e/reading/checks.ts`: open `models`, scroll to the exhibit, click Step three times, assert the canvas pixels change inside the block rect and are byte-identical in a one pixel border outside it (scissor leak control), the URL fragment holds `#x:turing=`, a reload with that fragment restores the same head position, wheel over the exhibit still scrolls the page, and the existing "no DOM text node" check still passes with a planted `<p>` control.
6. Hot reload: save the script with a changed rule mid-run; the exhibit keeps its tape and steps (through snapshot) and a script with an error keeps the old exhibit and reports the Flecs `file: line`.

Planted-bug controls (a test that cannot fail proves nothing):
- Mutate the `bb3` table in memory (`r_c1`: `Moves Left` to `Right`) and run test 1 against the mutated script: the suite must fail on the 14-step assertion. The harness asserts this failure itself (`expect(() => goldenSuite(mutated)).toThrow()`), so a passing control means the suite is real.
- Plant an off-by-one in a hit rect (shift one rule field by 1.1 em) in a fixture script: test 3 must fail on the pending-row or hit-overlap check.
- Remove the scissor in a debug build flag: the e2e border check must fail.
- Plant a frame-time dependence (use `dt` instead of the fixed `Tick`) in a local build: the dt 1/60 versus 1/144 hash test must fail.

## 8. Staging and lanes

### 8.1 End state (what "done" means)

One wave delivers the whole model; content lanes follow in a second wave. After wave 1: the museum scope and `ExhibitModule` exist; `::exhibit` is a directive and `BlockKind.exhibit` (21) and the exhibit table are in the format (RDR4: the `fig` field of the block record is renamed `ex`, figures become exhibits of the Timeline family and the old figure ABI, `FigureClock`, `FigureAdvance`, `FigureTime` and `Figure` are deleted in the same change); the page pass draws the exhibit draw list in a scissored pass; the reader routes pointer, wheel, touch and keys; the fragment state round-trips; hot reload works; the Turing machine ships in `models`; `ifd` and `models` figures run as Timeline exhibits with generic Scrub and Play controls; the tests of section 7 exist and the planted controls fail as planned. After wave 2: the ten exhibits of section 5 (one lane each, plus one Rust interpreter lane per new family). There is no staged flip, no switch between old and new figure paths and no per-lane gating: the old figure path is deleted in the commit that adds the new one.

### 8.2 Wave 0: spikes (half a day, one lane, no tree changes beyond a scratch dir)

S0.1 flecs_ecs 0.2.2 (read: FLECS_AUDIT.md caveat, "not verified that 0.2.2 exposes each feature"): custom-event observers, reflected enums, `Exclusive` and `OnDeleteTarget` traits, singletons through `.singleton()`, on the vendored wasm build. S0.2 script grammar: `$i` arithmetic in names and pair targets, a `$parent` token, string components with `\u` escapes, string field `Loads: {"inc"}` on a custom component. S0.3 does adding `IsA` to an existing entity instantiate prefab children, and do sibling references remap (decides clone-by-IsA versus the 40 line copy function). S0.4 `ecs_script_update` on a script that declares children of a runtime parent scope. Output: a pass or fail per line appended to this doc under "Spike results"; a failure changes only the fallback named at its use, not the design.

### 8.3 Wave 1: lanes (all in parallel in one wave; lanes write and commit code and run nothing; root merges, builds once, runs the suite once, per the rounds rule)

| Lane | Files | Cost (days) |
|---|---|---|
| A museum core (Rust) | `world/src/museum/{mod,model,input,draw,snapshot}.rs`, `world/src/lib.rs` exports, `world/src/reader.rs` (tick and setup), `world/tests/exhibits.rs` (core and snapshot tests) | 4 |
| B tape family and script | `world/src/museum/kind_tape.rs`, `world/scene/60-museum.flecs`, `thoughts/models/exhibits/turing.flecs`, golden tests and the planted `bb3` control | 3 |
| C timeline family and figure deletion | `world/src/museum/kind_timeline.rs`, delete figure systems and components in `world/src/reading.rs`, `src/lib/reading/abi.ts` (remove figure inputs and `RD.figBase`), port `reader.ts` figure clock reads | 3 |
| D format and build | `src/lib/magazine/format.ts` (RDR4: `BlockKind.exhibit`, exhibit table, `ex` field), `scripts/magazine/parse-directives.ts` (`::exhibit`), `scripts/magazine/exhibit.ts` (new: validate, lint, poster via `world.wasm`), `scripts/magazine/{build,emit,flow,vite-plugin}.ts`, `src/lib/reading/load.ts`, `static/magazine/**` regenerated, `shelf.test.ts` extended, `scripts/magazine/tests/exhibit.test.ts` | 4 |
| E render | `src/lib/reading/{page.ts,page.wgsl.ts,page-api.ts}` (`PageFrame.exhibits`, scissored instanced draw, string-to-glyph cache), `src/lib/reading/ui/{text.ts,widgets.ts}` (focus ring, toast text), `src/lib/reading/page.test.ts` | 3 |
| F reader and input | `src/lib/reading/{reader.ts,input.ts,hit.ts,scrollstate.ts}` (route pointer, key, capture, cursor, fragment write and read), `src/lib/reading/ui/hit.ts`, `src/lib/reading/exhibit.test.ts`, dev `exhibit-hot.ts` | 3 |
| root | merge, `bun run build:world` once, `bun scripts/magazine/build.ts`, `bun test`, e2e once, docs: `docs/READING_GPU.md` and `docs/READING_CONTRACT.md` deviations (the figure ABI is gone), `CLAUDE.md` "Exhibits" paragraph, `.claude/skills/flecs-scene/SKILL.md` museum traps, `docs/FLECS_AUDIT.md` (mark items 1, 3, 5, 6, 9, 10, 14 done where the museum module does them) | 2 |

Critical path is A then B (the family needs the core's trait); both are written in parallel against the contract in 2.4 and 3.3 (which is this doc), and the root fixes the seam at merge. Total about 22 lane-days of parallel work, 4 to 5 calendar days of wall time. Files that other agents currently edit and that lanes E and D touch: `src/lib/reading/page.wgsl.ts` and `thoughts/ifd/+page.svx` carry uncommitted changes in the working tree at the time of writing (read: `git status`); the lane brief says to merge on top of them, not to reset.

### 8.4 Wave 2: content lanes (parallel, each independent after wave 1)

One lane per exhibit of section 5 touching only its own `exhibits/<name>.flecs`, its directive line in the `.svx`, its golden test and, for a new family, its `kind_*.rs`: rewrite (2, 5, 6) shares one lane for the interpreter then three script lanes; graph (1, 3, 9) one interpreter lane then three; grid (4) one lane with its interpreter; tape reuse (7, 10) script only; wheel (8) one lane with its interpreter. Archive props (6) are a separate lane in `world/scene/12-decor.flecs` and `30-rooms.flecs` plus the `Opens` check in the shelf test.

Each lane's brief carries the house rule on learning: anything the lane finds that others will hit (a Flecs script trap, a flecs_ecs gap) goes into `.claude/skills/flecs-scene/SKILL.md` or this doc the same turn; the root checks it when the lane reports.

## 9. Risks that change a decision

- Systems and observers are not scriptable (2.3). If Andrew wants "systems in Flecs script" literally, the only route is to contribute script support upstream; that is a large separate project and not recommended. The design keeps behaviour in six small Rust interpreters and moves everything else to script.
- flecs_ecs 0.2.2 gaps (spike S0.1). The design uses nothing exotic; a missing reflected enum falls back to `u8` constants with named lookup, a missing custom-event observer falls back to a system over `Pressed`. Neither changes the script surface.
- WAVE3 plans to replace the TypeScript page pass with a Rust `wgpu` renderer. The exhibit draw list is a flat renderer-neutral buffer, so lane E is the only code that moves; do not delay the museum for WAVE3.
- Poster generation runs `world.wasm` at build time under bun. If that proves slow or flaky, posters can be produced by the e2e screenshot path instead, at the cost of a browser in the build; decide at wave 1 merge from the measured build time.

## Decisions for Andrew to confirm

1. Behaviour stays in Rust, data in script: exhibits are declared in Flecs script but each family needs a small Rust interpreter, because Flecs script cannot declare systems or observers.
2. One shared world (a `museum` scope), and the figure block is replaced by the exhibit block in one wave (RDR4, old figure ABI deleted, figures become Timeline exhibits).
3. In the 3D world only physical artifacts become props on the Archive floor that open an exhibit in the reader; exhibits never run in 3D, and every exhibit is authored beside an article (no article-less exhibits).
