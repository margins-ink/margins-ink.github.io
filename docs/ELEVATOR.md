# Elevator

The camera rides in an old-style cab facing its door. Scroll snaps to floors with a latch; then the scissor gate folds open, then
the sliding doors part and the room is revealed. Leaving reverses it. Written without running anything: nothing here has been
built. First build: read the console for `world.wasm: ... error`, then the checklist at the bottom.

**One look.** The world has one fixed look (the dark night look, CLAUDE.md "The world has one look"). The cab is lit warm by its own
ceiling lamp and the dial and buttons glow (HDR emissive above 1.0 is intended). No light or dark variant exists.

## Files

| File | State |
|---|---|
| `world/scene/11-elevator.flecs` | done: Rig prefabs, hall wall, `Cabin`, `Lift`. Loaded between `prefabs` and `decor` |
| `world/scene/30-rooms.flecs` | `hall : HallWall {}` in `Room`; decor trimmed (below) |
| `world/src/components.rs` | `Glow {r,g,b}`, `Rig {role,a,b,row}` |
| `world/src/export.rs` | `pack_cab`, cab list appended as the last level, `meta.cab` |
| `world/src/elevator.rs` | state machine, exports `elevator_*` |
| `world/src/scene.rs`, `lib.rs` | SCRIPTS entry, spawn/setup, `mod elevator;` |
| `src/lib/gpu/room/elevator.ts` | wrapper (scroll, state, rows, events) |
| `audio/src/lib.rs`, `src/lib/audio/index.ts` | kinds 8 gateRattle, 9 doorSlide, 10 latchClunk |
| `shader.ts`, `room.ts`, `World.svelte` | NOT done, specs S-A to S-D below |

## State machine

Component `Elevator {floor, target, pos, vel}` on the `cab` entity (an instance of prefab `Lift`); `pos` in floors, 0 = top, growing
down. Also `Slide {gate, doors, t}` (progress 0..1), `Latch {off, vel, age}`, `Needle {ang, vel}`, `Lights`, `Glance`, `ScrollIn`, `Hold`.

Exclusive relations on the cab (`add_trait::<Exclusive>`):

- `(Car, Parked | Travelling | Latching)`
- `(Doors, Open | Closed | Opening | Closing)`
- `(Gate, Open | Closed | Opening | Closing)`

```
Parked, doors Open, gate Open
   | target != floor            (Hold absent)
   v
(Doors, Closing) -> (Doors, Closed) -> (Gate, Closing) -> (Gate, Closed)
   | gate and doors closed
   v
(Car, Travelling)  heavy start, v capped, braking curve, creep, rumble + sway
   | |dist| < 0.012 floor
   v
(Car, Latching)    clunk; spring overshoot + brake settle of a few cm
   | settled
   v
(Car, Parked) + (Gate, Opening) -> (Gate, Open) -> (Doors, Opening) -> (Doors, Open)
```

Interrupts: target changes while doors are Closing or Opening: the Sequencer flips the state and keeps progress (no jump). A call
back to the current floor while the gate is Closing reopens it. While Travelling a new target just changes the braking curve.
`Hold` (article being read) pins the cab: the target is ignored.

Detents: `DetentSelect` only changes the target when `|s - target| > 0.5 + 0.12` (s = scroll * (floors-1)), so rest is always on a floor.

Phases (custom, chained by DependsOn from OnUpdate): `LiftInput` (DetentSelect) -> `LiftMove` (CarTravel, CarLatch, Doors/Gate
Opening/Closing, NeedleSpring, DialLights, LiftClock, GlanceTick) -> `LiftSequence` (Sequencer) -> `LiftPack` (PackState, PackCab).
Observers on OnAdd of each pair emit the audio events; the observer on `(Gate, Open)` starts `(Doors, Opening)` on arrival.

Needle: damped spring toward the continuous position (w 8, zeta 0.38) so it lags and overshoots. Dial lamps step with the nearest
floor (incandescent lag, 14 /s). Call buttons stay lit while their floor is the target and the car is away.

## Audio events (`elevator_event_poll`, `kind << 24 | arg`)

1 gate (arg 1 opening) -> `gateRattle`; 2 door (arg 1 opening) -> `doorSlide`; 3 clunk (arg impact 0..255) -> `latchClunk`;
4 ding (arg floor) -> `ding`; 5 step (nearest floor changed) -> `floorPass`; 6 depart (arg 1 down); 7 stop (bit1 gate, bit0 open).
Motor hum stays the existing `setElevator(speed, floor)`, fed from state[2] and state[3]. `elevator_goto(f, 1)` mutes events.

## Relations vocabulary

`Car`, `Doors`, `Gate` (exclusive relations); `Parked Travelling Latching Open Closed Opening Closing` (targets); `Hold` (tag); `Rig`
(role per moving part: 1 gate bar, 2 gate rail/post, 3 hall door leaf, 4 needle, 5 dial lamp, 6 button, 7 fishplate, 8 counterweight,
9 cable, 10 door seam light, 11 ceiling lamp glow); `Glow` (emission rgb, exported in the row's tex).

## Export format

`pack_cab` returns the cab list in cab frame (cab never moves; only dynamic rows change). `pack` appends it to `objs` after the floors
and adds one `lvl` row (index = floor count, `lvl[3] = 1` marks it, lamp from the object with `LampColour`) plus a zero pane row.
`meta.cab = {start, count, level}`. `Glow` goes into the row's tex as `[r,g,b,1]`; tex.w = 1 with a nonzero rgb means emissive.
`Rig.row` is written back so `PackCab` rewrites the row each tick. The cab is excluded from the lightmap bake (nu = 0).

State buffer (`elevator_state_ptr`, 40 f32): 0 car y in metres (negative down, plus rumble), 1 normalised position, 2 speed 0..1,
3 floor, 4 target, 5 gate eased, 6 doors eased, 7 lens blend 0 cab..1 room, 9 needle angle, 10 car (0 parked 1 travel 2 latch),
11 doors code, 12 gate code (0 closed 1 opening 2 open 3 closing), 13 sway, 14 push 0..1, 15 floors, 16 glance yaw, 17 glance pitch,
18 `TH_CAB`, 19 doors fully open, 20..27 dial lamps, 28..35 button lamps, 36 cab start, 37 cab count, 38 eye, 39 push metres.

## Renderer specs (not implemented)

- **S-A shader, cab trace.** Primary rays start in the cab list: trace the list with origin `(o.x, EYE, o.z)` (cab frame), treat the
  hall wall and door leaves as part of the cab list, and fall through to the room list of the current floor where the leaves are open
  (gate bars and the shaft are the only things behind them while travelling). The cab is lit analytically by its lamp row, not the
  lightmap. Kinds stay below 8 for boxes (kinds 8+ are spheres in `intersect`); the cab uses 0, 6, 8.
- **S-B lens.** Camera FOV = lerp(`TH_CAB`, room FOV, state[7]); dolly `state[14] * state[39]` toward the door; yaw/pitch from 16, 17
  (the glance at the control panel when called away). Car y (state[0]) offsets the shaft and floor slabs seen through the gate.
- **S-C room.ts.** Each frame: `elevator.tick(dt)`, `reader.tick(dt)`, `elevator.pump(audio)`, one `writeBuffer` of `elevator.rows()`
  at `cabStart * 112` bytes, state into the uniform. Scroll input calls `elevator.scroll(p)` instead of moving the camera.
- **S-D World.svelte.** Pass `world.exports` to `elevatorApi`; call `hold(true)` when an article opens, `hold(false)` when it closes.
- **S6 speed (recommended)**: per-group AABB culling of the cab list (shaft, gate, panel). The cab list is traced by every primary ray.

## Budget

Cab about 108 objects (walls with wood and brass trim, floor tiles, handrail, lamp, dial with lamps, panel with buttons, gate bars and
rails, door leaves, shaft rails, cables, counterweight). Hall wall +8 per floor (two leaves are moved to the cab list as dynamic rows).
Paid for by trimming decor, 9 to 12 objects per floor: Lobby d_art_a/b/c; Upper d_clock and the shelf cactus; Lower desk d_books and
d_art_a/b; Basement desk d_mug, d_clock and d_art_b. Backup of the old rooms file at `/Volumes/Projects/tmp/30-rooms.bak`.
Measure frame time against the pre-elevator baseline (benchmark rules) before adding more.

## Verification checklist (root, once)

1. Build the world wasm and audio wasm; read the console for flecs script errors (traps: one component per line, `x : P {}` bodies).
2. `lvl` has floors + 1 rows; `meta.cab.count` about 108; every floor still has exactly one kind 9.
3. Cab at rest: gate and doors open, room visible. Scroll: doors close, gate closes, car moves, clunk, gate opens, doors open.
4. Interrupt mid-close and mid-travel; no state where rest is between floors.
5. Needle overshoot and dial lights step; audio events fire once per transition.

## Open risks

Compile risk: flecs_ecs calls (observers with pair `.with`, `try_cloned`, `add_trait`) were inferred from magazine.rs, not built.
The Rig role parameters a, b and prefab names (`CabGateBar`, `CabLeaf`, `CabSeam`, `CabDialLamp`, `CabButton`) must match 11-elevator.flecs.
`elevator_tick` and `world_tick` ordering: Rust systems run in `world_tick`, so call `elevator_tick` first.
