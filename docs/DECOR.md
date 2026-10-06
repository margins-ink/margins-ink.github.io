# Decor: lived-in rooms with neon

Scene: `world/scene/12-decor.flecs` (prefab library) and the per-floor `d_*` sections of `world/scene/30-rooms.flecs`.
The renderer only has boxes and spheres, so every object is a prefab of small boxes/spheres. Nothing here is verified by a
build yet (written without running anything): first build, read the console for `world.wasm: ... error`.

**Required before it loads**: `world/src/scene.rs` `SCRIPTS` needs `("decor", include_str!("../scene/12-decor.flecs"))`
between `prefabs` and `palettes` (30-rooms now uses these prefabs). Without it the rooms script fails and the canvas is blank.

## Per floor

| Floor | Template | Personality | Palette | Neon (accent colour) | Props |
|---|---|---|---|---|---|
| 2026 | Lobby | sunlit living room, plants and a cat | tan plaster, green wainscot; mustard, terracotta, cream | pink "hi!" above the title sign, pink strip under the shelf | mustard armchair, terracotta rug, black cat on it, coffee table (yellow mug, book stack), floor lamp, red pendant, cream curtains + rod, three small posters, desk: record player, teal figurine, cactus, red mug |
| 2024 | Upper | night studio, teal and violet | blue-grey; teal sofa, navy rug, violet curtains, orange beanbag | cyan "up" left of the sign, cyan strip | teal sofa (2 throw pillows, 2 paired back cushions), side table (Near sofa) with table lamp, beanbag on the rug, coffee table (blue mug, books), wall clock, wall shelf (books, figurine, white cactus), black pendant, violet curtains, desk: white record player |
| 2023 | Lower | reading room, brick-red walls | red-brown; forest green, brass, mustard | lime "on" left of the sign, lime strip | low bookcase with two book rows, forest armchair, forest rug with a cat, coffee table (mug, books), amber floor lamp, brass pendant, mustard curtains, two posters, desk: record player, book stack |
| Archive | Basement | dusty listening room, no window | grey; leather, ochre, mint | amber "old" right of the sign, amber strip | bookcase, mint mini fridge, leather armchair, ochre rug with a cat, red pendant next to the old bulb, wall clock, two wide landscape frames, amber floor lamp, desk: record player, radio, mug |

A fourth non-archived year reuses `Lower`.

### Object counts (decor only, added to about 50 existing per floor)

2026: 78, 2024: 80, 2023: 78, Archive: 78. Budget: at most 90 decor objects per floor. Reason: `intersect` in `shader.ts` tests every
object of the level linearly per ray (no BVH), so frame time grows with count; a floor goes from about 50 to about 130 objects, so
expect a measurable path-tracing cost. Measure it (docs benchmark rules) before adding more. Lightmap texels are not the limit (a small box is 24 texels,
`FACE_MIN` 2, texel 0.05 m).

## Inheritance tree

```
Object > Solid
  Fabric  Metal  Gloss  Shade  Wood > Plank
  Ball (Leaf sphere; Half {r,r,r} so Rests works)
  Neon (kind 3) > NeonPink NeonCyan NeonLime NeonAmber          (LampColour per floor)
  NeonSign (Hangs BackWall) > SignHi SignUp SignOn SignOld       (bars are Neon* children)
  Lamp (Lights Interior)
    FloorLamp > FloorLampRose FloorLampAmber      root = shade, pole and base below
    TableLamp                                      root = ceramic base, neck > shade stacked
    Pendant > PendantRed PendantBlack PendantBrass root = shade at y 2.5, cord > canopy up to the ceiling
  Furniture (Fabric)
    Seat > ArmchairMustard ArmchairForest ArmchairLeather   parts: SeatBack SeatArm (recoloured in the variant)
    Sofa > SofaTeal                                         parts: SofaBack SofaArm, Pillow (tp_l tp_r), bc_l (Pairs) bc_r
  Beanbag, DecorRug > RugTerracotta RugNavy RugForest RugOchre
  CoffeeTable (TableLeg x4), SideTable, WallShelf (Hangs BackWall)
  Cup > MugYellow MugRed MugBlue
  BookStack, BookRow, Figurine > FigurineTeal, Cactus > CactusWhite, Cat
  RecordPlayer > RecordPlayerWhite, Radio, Fridge > FridgeMint, Bookcase (Plank, BookRow x2)
  Frame (Hangs BackWall) > FramePortrait, FrameSmall > PosterSun PosterSea PosterRose, FrameWide > WideDusk WideSea
  Clock (Hangs BackWall), CurtainRod, Curtain > CurtainViolet CurtainMustard
```

Variants override only what differs, normally `Albedo` on the root. Parts that must change colour with the root
are small geometry prefabs (`SeatBack`, `SofaArm`) so a variant restates only `Albedo` on them. Flecs script has no
child-override syntax we verified, so a colour variant of a compound prop re-declares its coloured parts (see Armchair*); neutral parts are inherited.

## Relations vocabulary

Declared as plain entities at the top of 12-decor.flecs; the exporter ignores them today.

| Relation | Use | Today | Meaning for later code |
|---|---|---|---|
| `(Hangs, BackWall)` | frames, clock, curtains, rod, wall shelf, neon signs | tag only | wall-mounted piece: Center.z is its half depth, snap to the wall plane at z = 0 |
| `(Lights, Interior)` | every Lamp and every Neon | tag only | emitter that lights the room (spec S1/S2 gather these instead of the "last kind 9") |
| `(Near, d_sofa)` | side table | tag only | placement intent (a layout checker can assert the distance) |
| `(Pairs, x)` | `bc_r` to `bc_l`, `d_curtain_r` to `d_curtain_l` | tag only | matching set: same colour, mirrored placement |
| `(Tint, Upholstery)` / `(Tint, Paint)` | upholstery, rugs, curtains / lamp shades, pendants, fridge, mugs, cactus pot, record player | tag only | spec S4: take Albedo from the floor palette's role colour |
| `Rests` (existing) | everything standing on a surface | works | y from the parent's top face |

Targets of `Pairs` and `Near` are siblings declared earlier in the same prefab body. If the console shows a lookup error for them, delete those
lines (the scene does not depend on them).

## Placement conventions

- Root = the lowest part touching its support. Stacked parts are children with `Rests` (book stack, cushions, record player stack, cactus).
- Heights that are written: floor props (armchair .22, sofa .22, fridge .42, bookcase .55, floor lamp 1.62, pendant 2.5), surfaces (coffee table .4,
  side table .5, wall shelf per instance, rug .02). These are the prefab's own Center.y; an instance repeats it because `Center: {x, y, z}` replaces the whole
  component. Everything standing on a surface or on the rug uses `Rests` and gives only x and z.
- Children of an inherited prefab child cannot be extended, so the desk was moved out of `Furnished` into `FurnishedDesk` and each floor declares
  `desk : FurnishedDesk { props }` (same contents as before).
- Rotation does not propagate to children (only the entity's own box rotates), so every compound prop faces +z and nothing hangs on a side wall.
- Do not use kind 9 in decor. The exporter keeps the last kind 9 as the floor's lamp, so any extra one would move the main light. Lamp shades are bright warm albedo.
- Kind 3 pieces on a floor all glow with the same colour (`emission` reads one accent colour per level). Every bar of a floor's neon uses the same LampColour.
  Keep neon bars axis aligned: the exporter's accent light is an axis-aligned rectangle taken from the last kind 3 object.

## Exporter and shader changes needed (specs, no .rs edited)

- **S0 (required)**: add the decor script to `SCRIPTS` in `scene.rs` as above.
- **S1 neon light, small**: in `export.rs` the `3 =>` arm keeps the last kind 3 object by entity id as the level's NEE rectangle. Keep the one with the largest
  `half.x * half.y` instead, so the light sample comes from a sign bar or the strip, not an arbitrary dot. All kind 3 objects already glow; only their direct-light sampling is single.
- **S1 neon light, full**: up to 4 accent rects per level. `lvl` stride 20 floats becomes 44 (4 + lamp 8 + 4 accents of 8: centre+half width, colour+half height); `lightmap.ts` reads `lvl[l * 20]` (update to the new stride);
  `shader.ts` `LS`, `n_lights`, the accent branch of the light sampler, `light_pdf` (area = 4 hx hy) loop over the list; the exporter collects every kind 3 object
  (rect centre `(c.x, c.y, c.z + half.z)`, half width `half.x`, colour `LampColour`, half height `half.y`), sorted by area, first 4. Different colours per piece then work too
  (`emission(kind 3)` would read the colour from the object, e.g. the object's tex.xyz, instead of the level).
- **S2 lamps**: same for kind 9: collect all kind 9, keep up to 4 as point lights with their own `LampColour`, and use `Lights, Interior`-tagged objects only.
  Then the floor lamp, table lamp and pendant bulbs become real emitters (shade glow, warm pools on the walls). Needs a `Bulb` child per decor lamp: FloorLamp `bulb` under the shade, TableLamp `bulb`, Pendant `bulb` (a small kind 9 sphere).
- **S3 floor rest**: in `floor_pos`, when `e` has `Rests` and its parent is the floor entity (no `Half`), set `y = extent_y(e)`. Then floor props drop their written Center.y and become `Rests`.
- **S4 palette tint**: add components `Upholstery {r,g,b}` and `Paint {r,g,b}` (`vec_component!` plus `component_named`) to the palette entities (`palette0 { Plaster ... Upholstery: {...} }`).
  In `pack`, for any object with the pair `(Tint, Upholstery)` or `(Tint, Paint)` replace its Albedo with the floor's palette colour. Then `ArmchairMustard`, `ArmchairForest`, `ArmchairLeather`, `RugNavy`, `CurtainViolet`, ... collapse to `Seat`, `DecorRug`, `Curtain` (move `back` and `arms` into `Seat`), and one prefab recolours per floor with no copies.
  Register `Tint`, `Upholstery`, `Paint` as `Component` tags if you want them reflected; the script already declares them as entities.
- **S5 group rotation**: propagate a parent's `Euler/Flat` to the children's offsets in `floor_pos`, enabling pieces on side walls and rotated furniture.
- **S6 speed**: if the object count hurts, add a group AABB per decor prop (no `Kind`, only Center and Half) and skip its children in `intersect` when the ray misses it, or build a small per-level BVH.

## Verification checklist (root, once)

1. Load: no `world.wasm: ... error` in the console; floor count and `lvl` lamp present (each floor still has exactly one kind 9: DeskLamp bulb or the Basement bulb).
2. Per floor object count: `lvl[level*20+1]` stays below 50 + 90 + magazines.
3. Look at each floor from the default camera: nothing intersects the desk and shelf, the sofa does not hide the desk, the armchair does not poke through the desk edge,
   curtains clear the shelf plant, neon is not clipped by the ceiling (letters top at y about 2.9).
4. Neon: the wall near each sign is tinted with the floor colour (accent on). If it is black, the accent colour is 0: check that the bars were exported as kind 3 with LampColour.
