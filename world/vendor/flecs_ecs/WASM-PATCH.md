Local patch of flecs_ecs 0.2.2 (crates.io, MIT/Apache-2.0): src/addons/meta/meta_fn_types.rs imported
`Entity, WorldRef` only for non-wasm targets but the wasm variant of AssignEntityFnPtr uses them;
the import is now unconditional. Examples, tests, benches and dev-dependencies are removed from the tree.
