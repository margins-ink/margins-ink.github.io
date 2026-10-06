# The book: taking a thought off the shelf and opening it

Status: implemented in Rust/Flecs and wired in TS, committed but not built or screenshot-verified (the root builds once).
Code: `world/src/book.rs` (the model), `world/src/reader.rs` (glue, scroll), `src/lib/gpu/room/room.ts` (render hand-off), `world.ts` (state slots), `World.svelte` (sounds).

## 1. Why it was janky (read from the old code)

1. One spring for every channel. `ReadingTween` was a single critically damped spring (omega 9) on `Reading.t`, and `PackObjs` derived every channel from that one number with different smoothsteps (`lift = smoothstep(0, .28, t)`, `fly = smootherstep(.12, 1, t)`, `camT = smootherstep(.15, 1, t)`). Easing on top of an eased spring is double easing: the lift finishes in about 115 ms, then the whole fly-in, dolly and dim all end together at about 0.45 s. Nothing is staged, nothing anticipates, nothing settles.
2. A straight lerp from shelf pose to reading pose. No arc, no travel toward the camera, no banking. The "rotate to face the reader" was a 115 ms lean twitch (the lean times `1 - lift`).
3. A hard gate instead of a hinge. The page renderer is switched on by `rd0.x < 0.9` in `page_trace`: at about 0.43 s the whole first spread, the left sheet and the bow appear in one frame. The cover then cross-fades (it dissolves, it does not swing). No thickness, spine or hinge exists to move.
4. Brightness mismatch: the card is dimmed by `exposure * (1 - .45 t)` while the paper is not (about 6x apart, unverified), so the hand-off pops in brightness even when the geometry matches.
5. Interrupts reset motion. `article_open` wrote `Reading { vel: 0 }` (a click during the carry stops dead), opening a second article called `finish_close` (a snap), and `finish_close` snapped everything.
6. Dead time before any motion: `openArticle` awaited `mag.load` and only then called `reader.open`, so the book did nothing for the load time; the render path and resolution switch (`READ_PIX`) happen in the same frame; the first frame after idle used a dt up to 100 ms.
7. Sound at the wrong time: `open`/`close` played on the end events, nothing at the grab.
8. Not a cause: the springs are exact closed forms, so frame rate was fine apart from the dt clamp in 6.

## 2. Design

### Phases (exclusive relation `(BookPhase, X)` on the article entity)

| Phase | Motion | Spring (omega rad/s, zeta) | Leaves when |
|---|---|---|---|
| OnShelf | rest | none | WantOpen added |
| Lifting | anticipation: 90 ms pull back (lift target -0.10), then lift out of the shelf with a 0.10 rad tilt | lift 16, 0.55 (under-damped: a small overshoot reads as weight) | lift > 0.75 and the reading pose is known |
| Carrying | arc toward the camera (bulge 0.10 out, 0.04 up, sine of progress), bank into the turn (roll from carry speed), face the reader (lean unwinds once past 20% of the arc), camera dolly starts at 12% | carry 8.5 critically damped aimed 1.2% past the stop (finite-time soft landing), face 9, 0.8; dolly 4 | carry reached 1 and face settled |
| Opening | the page renderer takes the book (pose identical), the front cover swings on a hinge about the spine, the first spread is revealed under it, the cover trails a curl | hinge 9, aimed 6% past the stop at 1 with restitution 0.15 (lands with a small bounce and an impact velocity); reveal 8 | hinge at 1 and reveal > 0.97 |
| Reading | rest; full-text layers are the magazine lane's | none | WantOpen removed |
| Closing | mirror: cover closes (held open while the full-text layer is up, `close_full` is called first), the card takes the book back at the same pose, returns along the same arc, face unwinds, lift lands on the shelf with a `place` impact | same springs | home on the shelf |

Targets change, positions and velocities never do: every transition keeps the state of every channel, so reversing mid-opening, redirecting during the carry (click again) or opening during the close are continuous. Closing from Carrying runs the carry channel back to 0 from where it is; no phase has an entry snap. Channels are `BookPose {lift, carry, face}`, `Hinge`, `SpreadReveal`, `Backdrop {dim, dolly}`, each a spring with its own omega, zeta and optional stops (`Ch`). `BookRig` (singleton) holds every tuning number.

All time is `it.delta_time()` and every spring is the exact solution for any dt (under-damped and critically damped forms), so the motion is the same at 30 or 144 Hz. The host clamps a frame after an idle gap (more than 250 ms) to one 60 Hz frame.

### Camera, dim, depth
`Backdrop.dolly` (0 shelf camera, 1 reading camera) is a spring that starts during the carry and is exported as `RS.camT` (slot 7), which `room.ts camera()` already mixed. `Backdrop.dim` rises with the phase (0.10 lift, 0.55 carry, 0.90 open, 1 reading) as a spring, so it is a ramp that follows the book, never a switch. `writeScene` exposure uses `RS.dim` instead of the old `t`.

### Shader hand-off
The page shader is the magazine lane's and gates the card on `rd0.x < 0.9`, so the exported `RS.t` keeps that contract: the card travels 0..0.899 while lifting and carrying; at the end of the carry the book enters Opening, `Hinge.pages` becomes 1, `RS.t` becomes `0.9 + 0.1 * hinge`, and the existing cover cross-fade is driven by the hinge spring (physical timing and a landing) instead of the old fly-in. The card is parked by `RS.cardOn` (was `t > 0.995`). The end pose of the card is the old reading pose (centre, half size, no rotation), so geometry matches what shipped.

Known limit (needs the magazine lane, not done here): a true hinged cover with thickness needs `page_trace` to take the hinge angle (`RS.hinge`) and curl (`RS.curl`) and draw the cover board as a turning leaf; the slots are exported (43, 49) and `book.rs` models `Part` prefabs (CoverFront, CoverBack, Spine, PageBlock, FlutterSheet) with follow-springs (`PartAngle`, slots 52..55) ready for it. Until then the opening is the existing cover cross-fade timed by the hinge.

### Flecs model (world/src/book.rs)
- Singletons: `BookRig`, `ReadPose`, `BookEvents`. Tags: `WantOpen` (intent), `BookActive` (the one simulated book; every system filters on it, so shelf books cost nothing).
- Pipeline phases chained with DependsOn after OnUpdate: BookSelect (state machine and targets), BookSpring (integrate, contacts, crossing sounds; `PartFollow`), BookPack (state buffer, `PartPack`).
- Observers on `OnAdd (BookPhase, X)`: `EV_PHASE` for every phase, plus sounds: Lifting `grab`, Carrying `whoosh`, Opening `open`; Reading emits the legacy `opened` event. Impact sounds come from the springs' stops: the hinge landing (`place`, velocity = impact speed), the hinge closing (`close`), the card landing on the shelf (`place`), and a `paperTurn` when the hinge crosses 0.5 (velocity = hinge speed).
- Events: kind 11 `sound` (arg = id << 8 | velocity 0..255; ids grab 0, whoosh 1, paperTurn 2, open 3, close 4, place 5) and kind 12 `phase`. `World.svelte` maps whoosh to the `scroll` audio kind (there is no whoosh kind) and passes velocity.
- Prefabs: `BookPart` with `CoverFront`, `CoverBack`, `Spine`, `PageBlock`, `FlutterSheet`; instances are children of the article (`spawn_parts`, destroyed by `reset`).
- Click starts the lift immediately: `room.ts openArticle` calls `reader.begin(index)` (export `book_begin`) before awaiting `mag.load`; the carry waits for the reading pose (`ReadPose.ready`, set by `set_reading_pose`), so the anticipation and the lift hide the load time.

### State slots (reader_state, now 64 floats)
0 t, 1 want, 2 scroll, 3 scrollMax, 4 article (-1 until the pose is known), 5 magObj, 6 lift, 7 dolly, 8..10 pages, 12..39 card row, then 40 phase, 41 carry, 42 face, 43 hinge, 44 reveal, 45 dim, 46 cardOn, 47 pagesOn, 48 cardLight, 49 curl, 50 bank, 52..55 flutter sheets.

## 3. Root: build and verify (nothing here has been compiled)

1. `bun run build:world` (wasm target only; native cargo check fails on the vendored C-unwind patch). Expect compile fixes in `book.rs`: `Id<T>`/`Entity` pair types, `each_iter` tuple arity with five `&mut`, and the observer pairs. `world/src/lib.rs` carries my `mod book;` and `book_begin` export mixed with the other lanes' edits, so it is uncommitted.
2. Event kinds 11 and 12 must not collide with an elevator kind routed through `event_poll` (the elevator uses its own constants; check `world.ts EVENTS`).
3. Screenshots, dark only: shelf, mid-lift (about 120 ms after click), mid-carry (about 0.4 s), hand-off frame (carry done), mid-hinge, reading, then the same closing. Check: no brightness step at the hand-off, no snap at card-to-page, the cover lands once.
4. Interrupts: click again during the carry (redirects, no stop), close during opening (reverses smoothly), open another article while one is open.
5. Sounds: grab at click, whoosh at the carry, paper at hinge 0.5, place at the landing; none at the old end-of-motion timing.
6. Check the article does not render at the low shelf resolution during the lift (the render path switches to reading at the click; `rdPix` is raised after the load).

## 4. Risks
- The hinge is still the old cross-fade (see "Known limit"): the real hinged cover and first-spread fan need `page_trace` to read `RS.hinge`.
- Exact Flecs API forms were written from the repo's existing patterns without a compile.
- Tuning numbers (`BookRig`) are first guesses; the fast loop is to edit `BookRig::default()`, rebuild the wasm, and look.
