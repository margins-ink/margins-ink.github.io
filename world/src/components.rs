//! Component types. All are reflected (`meta`) so Flecs script can set their members by name.
use flecs_ecs::prelude::*;

macro_rules! vec_component {
    ($name:ident { $($f:ident),* } $default:expr) => {
        #[derive(Component, Clone, Copy, Debug)]
        #[flecs(meta)]
        pub struct $name { $(pub $f: f32),* }
        impl Default for $name {
            fn default() -> Self { let [$($f),*] = $default; Self { $($f),* } }
        }
    };
}

vec_component!(Center { x, y, z } [0.0, 0.0, 0.0]);
vec_component!(Half { x, y, z } [0.0, 0.0, 0.0]);
vec_component!(Albedo { r, g, b } [0.5, 0.5, 0.5]);
vec_component!(Tex { x, y, w, h } [0.0, 0.0, 1.0, 1.0]);
vec_component!(LampColour { r, g, b } [0.0, 0.0, 0.0]);
vec_component!(Plaster { r, g, b } [0.5, 0.5, 0.5]);
vec_component!(Wainscot { r, g, b } [0.2, 0.2, 0.2]);
// Surface response: GGX roughness (0 mirror .. 1 matte) and metalness (0 dielectric, 1 metal). On a room shell the
// roughness is the floor's; walls and ceiling are matte (see docs/LOOK.md).
vec_component!(Material { roughness, metallic } [0.8, 0.0]);
// Tilt about the x axis (radians): the magazines leaning on the shelf.
vec_component!(Lean { angle } [0.0]);
// Free rotation (radians), applied as Ry * Rx * Rz: plant blades and other props.
vec_component!(Euler { x, y, z } [0.0, 0.0, 0.0]);
// Lying flat, turned by `theta + per_floor * floor_index` about the vertical axis.
vec_component!(Flat { theta, per_floor } [0.0, 0.0]);
// HDR emission of a cab object (may exceed 1). Exported into the row's tex.xyz with tex.w = 1 (docs/ELEVATOR.md).
vec_component!(Glow { r, g, b } [0.0, 0.0, 0.0]);

/// A cab part that the elevator systems reposition every tick. `role` selects the rule (docs/ELEVATOR.md), `a` and `b`
/// are its parameters, `row` is the object's row in the cab list (set by the exporter).
#[derive(Component, Clone, Copy, Debug, Default)]
#[flecs(meta)]
pub struct Rig {
    pub role: u32,
    pub a: f32,
    pub b: f32,
    pub row: u32,
}

/// Shader treatment of an object (see docs/WORLD.md).
#[derive(Component, Clone, Copy, Debug, Default)]
#[flecs(meta)]
pub struct Kind {
    pub id: u32,
}

#[derive(Component, Clone, Copy, Debug, Default)]
#[flecs(meta)]
pub struct Dims {
    pub level_h: f32,
    pub room_h: f32,
    pub room_d: f32,
}

/// Floor entity data.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Floor {
    pub index: u32,
    pub basement: bool,
}

/// An article (one Thought). `index` is its position in the list handed to `world_build`.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Article {
    pub index: u32,
}

/// Tag: rests on its parent surface. The exporter sets the height so the object sits on the parent's top face
/// (its own Center.y is ignored; x and z stay local to the parent). Props placed this way cannot sink or float.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Rests;
/// Tag: the Tex of this object is the floor's title sign rect, supplied at build time.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct TexSign;
/// Tag: the Tex of this object is the world-map rect, supplied at build time.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct TexMap;

/// Relation `(Uses, palette)`: which wall palette a floor template paints its shell with.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Uses;
/// Relation `(Displayed, magazine)` on an Article entity: the magazine object that shows it.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Displayed;

pub fn register(world: &World) {
    world.component_named::<Center>("Center");
    world.component_named::<Half>("Half");
    world.component_named::<Albedo>("Albedo");
    world.component_named::<Tex>("Tex");
    world.component_named::<LampColour>("LampColour");
    world.component_named::<Plaster>("Plaster");
    world.component_named::<Wainscot>("Wainscot");
    world.component_named::<Material>("Material");
    world.component_named::<Lean>("Lean");
    world.component_named::<Flat>("Flat");
    world.component_named::<Euler>("Euler");
    world.component_named::<Glow>("Glow");
    world.component_named::<Rig>("Rig");
    world.component_named::<Kind>("Kind");
    world.component_named::<Dims>("Dims");
    world.component_named::<Floor>("Floor");
    world.component_named::<Article>("Article");
    world.component_named::<TexSign>("TexSign");
    world.component_named::<Rests>("Rests");
    world.component_named::<TexMap>("TexMap");
    world.component_named::<Uses>("Uses");
    world.component_named::<Displayed>("Displayed");
}
