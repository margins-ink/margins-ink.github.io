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
