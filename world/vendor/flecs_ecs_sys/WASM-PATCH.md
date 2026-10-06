Local patch of flecs_ecs_sys 0.2.1 (crates.io, MIT) for wasm32-wasip1:
- src/bindings.rs: every `extern "C-unwind"` replaced by `extern "C"` (flecs_ecs 0.2.2 expects the "C" ABI on wasm).
- Cargo.toml: bindgen and regex build-dependencies removed (the `regenerate_binding` feature is not usable).
