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
// Lying flat, turned by `theta + per_floor * floor_index` about the vertical axis.
vec_component!(Flat { theta, per_floor } [0.0, 0.0]);

// Reading state of an article: t is the spring state (0 on the shelf .. 1 reading pose), vel its velocity.
vec_component!(Reading { t, vel, target } [0.0, 0.0, 0.0]);
// Scroll state of the sheet stack in em: y follows target, vel is the fling speed (em/s).
vec_component!(Scroll { y_em, target_em, vel, max_em } [0.0, 0.0, 0.0, 0.0]);
vec_component!(Page { index, y0_em, h_em } [0.0, 0.0, 0.0]);

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

/// Relation `(HasPage, page)` on an Article: its sheets.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct HasPage;
/// Relations `(Next, page)` / `(Prev, page)` on a Page: the ordered chain.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Next;
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Prev;
/// Tag set by SheetCull on sheets that intersect the view.
#[derive(Component, Clone, Copy, Debug, Default)]
pub struct Visible;

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
    world.component_named::<Kind>("Kind");
    world.component_named::<Dims>("Dims");
    world.component_named::<Floor>("Floor");
    world.component_named::<Article>("Article");
    world.component_named::<TexSign>("TexSign");
    world.component_named::<TexMap>("TexMap");
    world.component_named::<Uses>("Uses");
    world.component_named::<Displayed>("Displayed");
    world.component_named::<Reading>("Reading");
    world.component_named::<Scroll>("Scroll");
    world.component_named::<Page>("Page");
    world.component_named::<HasPage>("HasPage");
    world.component_named::<Next>("Next");
    world.component_named::<Prev>("Prev");
    world.component_named::<Visible>("Visible");
}
