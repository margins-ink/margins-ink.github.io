# Flecs usage audit (2026-10-06)

Snapshot read of world/src/*.rs, world/scene/*.flecs, docs, TS mirrors while other agents edit. Line numbers may drift.
"read" = read in this tree this session. "reported" = from my knowledge of the Flecs manuals (Relationships, Prefabs, Queries, Systems, Observers, flecs_ecs docs); the web pages were NOT fetched, so check each before building on it.

## Verdict

Mixed. The scene is used well (prefabs, IsA, ChildOf, custom relations, script). Everything dynamic is a struct store with logic outside Flecs: systems are `.each` closures over thread_local Cells, there are no observers, no modules, no singletons, no phases, and magazine content lives in TS. Verdict per area:

| Area | Verdict |
|---|---|
| Scene (prefabs, floors) | Good. IsA nesting, ChildOf, `Uses`/`Displayed` pairs, script-declared (read: 10-prefabs.flecs, 30-rooms.flecs). Weak spot: the exporter is a hand-written tree walk. |
| Rooms (placement) | Half-good. `Rests` is a tag but the logic is a recursive Rust function (export.rs:212-225), not a system or cascade query. Floors/magazine layout are Rust loops (scene.rs:64-142). |
| Magazine | Shallow. One entity with 6 components, no relations; figures are a fixed `[Fig;64]` thread_local array plus a `[f32;64]` clock (magazine.rs:79-86, 236-268); all article/template content is TS (scripts/magazine/*, reported from WAVE3.md plan). |
| Reader state | Medium. Article=IsA Issue, Page children with Next/Prev, 4 systems (reader.rs:94-185). But systems communicate through 8 thread_local Cells (reader.rs:39-51), `rs.articles/pages` are Vecs of ids duplicating queries, and open/close/events are imperative glue (reader.rs:226-396). |
| Audio events | Shallow. A hand-rolled u32 `VecDeque` queue, `kind<<24|arg` (reader.rs:29, magazine.rs:82,88-94), polled by TS (world.ts:35-38) and mapped to audio in World.svelte:44-49. Observers/events would replace it. |
| UI | Not in Flecs, correct for Svelte, but `worldState` (world.svelte.ts:4-18: reading, page, pages) is a hand-mirrored copy of Flecs state. |

## Shallow pieces, ranked, with the Flecs feature that replaces each

1. Thread_local Cells as system inputs (reader.rs:43-50, magazine.rs:80-85: DT, ACTIVE, VIEW_H, SCROLL_Y, SHEET_STEP, VIS, POSE, MAGS, WORLD). Replace with singleton components (`world.set(Viewport{..})`, `Pose`, `Active`) read via `.singleton()` / `&Viewport` query terms; dt comes from `it.delta_time()` (reported) instead of DT. This also removes the "never borrow RS in a system" trap (WORLD.md trap 1).
2. `ACTIVE` article + `if ACTIVE == a.index return` filters (reader.rs:121,144). Replace with a tag `Active` (Exclusive relation `(Focus, article)` or just a tag) added on open; systems query `&Reading, &Scroll, Active`. Also gives free "closed articles cost nothing" skipping.
3. Event queues (reader.rs:12-15,296,369,378,385; magazine.rs:20-24,88-94,170,175). Replace with observers on component changes (`.observer::<flecs::OnSet, &Reading>()`, `OnAdd/OnRemove` of `Visible`, `Opened` tag) or `world.event()` custom events; one observer pushes to a single ring buffer for TS. Change detection (observed OnSet / `query.changed`) replaces the `last_page`, `last_scroll`, `opened_sent`, `moving` flags (reader.rs:30-33, 367-386) and `Book.last` (magazine.rs:173-176).
4. `rs.articles: Vec<u64>`, `rs.pages: Vec<u64>` + `despawn_pages` (reader.rs:26-27,212-219,237-256). Replace with `(ChildOf, article)` cascade delete: `article.children(...)`/`delete_with((ChildOf, art))`; look articles up via `Article` component query, not an id Vec. Page chain `Next/Prev` is stored both ways (reader.rs:249-253): declare `Prev` as the inverse by using one `Traversable`/`Symmetric`-free `(Next)` pair and query `(Next, $p)`; or mark `Next` `Exclusive` and drop `Prev`. (reported: Exclusive, Symmetric, Transitive traits.)
5. Hand-rolled tree walk in the exporter (export.rs:181-188 `collect`, 212-225 `floor_pos`, 204-208 `extent_y`, plus `ids.sort_unstable()` at export.rs:246). Replace with a system or `cached query` using `cascade()` traversal (`Parent`-ordered iteration, reported) that computes `WorldPos` once, parents first; `Rests` becomes a system `RestOnParent` in a `PreStore` phase. Also tag each object with `(InFloor, floor)` so collect() is a query with a pair term, not recursion.
6. Magazine figures as arrays (magazine.rs:69-86, 236-268, 450-470). Make each figure an entity: `Figure {t, duration, poster, mode}` child of the Magazine/article; `FigureClock` becomes `.each` over `Figure` with a `Live` tag and `(OnSpread, spread_entity)` pair or a `spread` field. The clock buffer is then an export query, not `CLOCK` array; removes MAX_FIGURES=64.
7. Enums stored as `f32`/`u32` (Spread.layer, Turn.dir/grabbed, Corner.open, Book.closing/reduced all `f32` 0/1 in magazine.rs:26-67; Kind.id u32 0..10 in components.rs). Use Rust `#[derive(Component)] #[repr(C)] enum` reflected as Flecs enum (reported: flecs_ecs `meta` supports enums), bools as tags (`Grabbed`, `Closing`, `ReducedMotion`) so systems select by tag and the script can say `Kind: Glass`. `Kind` ids in scene prefabs (`Kind: {10}`, 40-reader.flecs:3) become names.
8. One monolithic entity "Magazine" with six components and six systems each `.each`ing the same 1 row (magazine.rs:137-295). Systems over one singleton row are fine as singletons, but then say so: `world.set(Spread{..})` singleton components, systems `.singleton()` terms, no `lookup("Magazine")` per call (magazine.rs:113). Better: one `Magazine` per article (prefab `MagazineBook`), so multi-article/resident-article state (WAVE3) is IsA, not global.
9. No pipeline phases / system ordering by name. Order is registration order (WORLD.md Reader section: "declared in this order"). Use `.kind::<flecs::pipeline::OnUpdate>()`, custom phases (`Spring`, `Cull`, `Pack` via `Phase` + `DependsOn`, reported), so PackObjs/PackMag always run after springs, and `Visible` tag runs after ScrollIntegrate. Also SheetCull mutates `VIS` Cell (reader.rs:132-137): replace with a query count (`query.count()` of `Visible`) in PackObjs.
10. No modules. Components registered by hand one-by-one (components.rs:100-124 `component_named`, magazine.rs:125-132) with a repeated "forgot to register" trap (SKILL.md). Use `#[derive(Component)]` + `world.import::<SceneModule>()` implementing `Module` (reported) with components, systems and observers in one module per area (`Scene`, `Reader`, `MagazineBook`); and the `.flecs` scripts can be loaded per module. Also add `(OnDelete, Panic)`/`(OnDeleteTarget, Delete)` traits on `Displayed`, `Uses`, `HasPage` so a dangling magazine/palette is an error not `u32::MAX` (export.rs:315).
11. Packed buffers rebuilt by loops, not queries (export.rs:239-311, reader.rs PackObjs, magazine.rs PackMag). Use `world.query::<(&Kind,&Half,...)>().order_by` / `group_by(floor)` (reported) so floors are query groups and `lvl`/`panes`/`links` come from queries with `Lamp`, `Pane` tags instead of matching on `kind` ints (export.rs:274-287).
12. Floor creation in Rust (scene.rs:64-142): years, specs, Lobby/Upper/Lower choice (scene.rs:110-115), shelf x layout (scene.rs:125-131). Declare variants as prefabs with slots (`SlotOf`, reported) and per-floor `(Archived)` tag; choose prefab by observer or `OnAdd(Floor)`; shelf x layout as a system `ShelfLayout` over `(ChildOf floor), Magazine` with `Slot{index,count}`. Keeps the layout live (re-flow on change), not a one-shot.
13. Reader open/close sequence is imperative (reader.rs:226-297,299-314): replace with a state-machine via Exclusive relation `(ReaderState, Closed|Opening|Open|Closing)`; observers on `OnAdd (ReaderState, Open)` emit Opened, etc. Removes `opened_sent`, `moving`, `finish_close`.
14. Script-declared data is weak outside the scene: Spring omegas (reader.rs:11, magazine.rs:13-18) are Rust consts; put `Spring {omega}` (and `Reading` target defaults) in `.flecs` so tuning is no-rebuild (see Explorer, below). Reading pose (`POSE`, reader.rs:49) and shelf pose could be on a `ReadingRig` prefab.

## TS side (reported/read)

- `src/lib/ecs/magazine.ts` is a typed wrapper + a spec; fine, but the 20 exports are one-per-gesture (lib.rs, reader.rs, magazine.rs 299-485). Replace with 3 generic exports: `set_input(kind, a, b)` that writes an `Input` singleton, `world_tick`, `events_drain(ptr)`. Systems consume `Input`; gestures stop being 20 ABI functions. Cost: moderate, wasm ABI change.
- `worldState` (src/lib/world.svelte.ts:4-18) page/pages/reading mirror Flecs; set from the poll loop (World.svelte:44-49). Acceptable for Svelte, but derive from one packed `UiState` row exported with the state buffer rather than from event payloads.
- scripts/magazine/* (typeset, planner, grid, frames, voices: TS) holds all magazine content and layout. WAVE3.md already plans moving it to Flecs script + Rust; that is the single biggest missing piece (templates as prefabs with SlotOf, articles as IsA instances, figures/tracks as children).

## Features we do not use (reported, verify on the manuals)

Observers; singletons; cascade/up traversal in queries; `(OnDelete, Panic)`, `OnDeleteTarget`; Exclusive/Symmetric/Transitive/Reflexive/Acyclic traits; SlotOf; modules (`import::<M>`); custom pipeline phases + DependsOn; change detection (`query.changed`, `OnSet`, `Modified`); enum components; `Prefab` variants with overrides via `auto_override`; `world.to_json` and Flecs Explorer REST (`FLECS_REST`, `FLECS_STATS`, `FLECS_DOC`) for the fast loop; cached queries by name (`query_named`, can be edited from script); entity names in `.flecs` with `const` and `for` loops (flecs.c keyword table, read in WAVE3.md).

## Ten highest-value changes

| # | Change | Replaces | Cost |
|---|---|---|---|
| 1 | Singletons for DT/Viewport/Pose/Active; delete all thread_local Cells | reader.rs:39-51, magazine.rs:79-86 | S (a day) |
| 2 | Tag `Active` + queries in place of index compare | reader.rs:121,144 | S |
| 3 | Observers + one event ring, change detection | event queues and last_*/opened_sent flags, reader.rs:29-33,367-386, magazine.rs:88-94 | M |
| 4 | Figures as entities with `Figure` component (and `Live` tag) | magazine.rs FIGS/CLOCK arrays, 64 cap | M |
| 5 | Pipeline phases (Input > Spring > Cull > Pack) | registration-order dependence (reader.rs:94-185) | S |
| 6 | Modules (`Scene`, `Reader`, `Book`) | components.rs:100-124 + magazine.rs:125-132 | S-M |
| 7 | Enum/tag state instead of f32 0/1 flags and Kind ints | magazine.rs:26-67, components Kind | M (touches scripts) |
| 8 | Cascade query / `WorldPos` system for placement; `Rests` as a system; `(InFloor, f)` pair | export.rs:181-225 | M |
| 9 | Exclusive `(ReaderState, X)` machine + OnAdd observers; page cleanup by cascade delete; drop `Prev` and the Vecs | reader.rs:212-314 | M |
| 10 | Move magazine content (templates, figures, articles) into `.flecs` prefabs with SlotOf and IsA; delete scripts/magazine TS planner path (WAVE3.md plan) | scripts/magazine/* | L (the main Wave 3 work) |

Not scheduled: Explorer/REST for the fast loop. flecs_ecs 0.2.2 needs `flecs_rest`/`flecs_stats`, and our wasm has no sockets, so run the same world natively (WAVE3 plans a native build/bin) and attach the Explorer there to edit `.flecs` live. Cost S once a native bin exists; worth doing with #10.

## Caveats

- Not verified: that flecs_ecs 0.2.2 exposes each feature named above (observers, `import::<Module>`, enum meta, SlotOf from script). Spike each before committing; 0.2.2 meta did not even compile on wasm without our vendored patch (WORLD.md Toolchain trap 3).
- The 14 pieces overlap with changes 1-10. Other agents are editing world/src and scene files; re-grep before applying.
