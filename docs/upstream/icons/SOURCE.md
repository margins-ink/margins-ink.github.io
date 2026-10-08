# File-type icons (Material Icon Theme)

- Set: Material Icon Theme by Material Extensions (PKief), https://github.com/material-extensions/vscode-material-icon-theme
- Delivered as: Iconify collection `material-icon-theme` in `@iconify/json` 2.2.473 (`node_modules/@iconify/json/json/material-icon-theme.json`, sha256 044c1ce1cd770187bb61ac35c487170eead42bf6db2763667b62240323e40631), 32x32 viewBox.
- Licence: MIT, Copyright (c) 2025 Material Extensions. Text read in full: `LICENSE-material-icon-theme` (sha256 cdab3014d4f69b49dde2b85e81792208c72de613aa6aed7f7a9b5c6609b89670). Permits use, copy, modify and redistribution with the notice kept. Status: read.
- Fetched 2026-10-07 (UTC).
- Question answered: IntelliJ-style file-type icons for the IFD graph figure (`rust` for .rs, `toml` for .toml sources).
- Extracted: `rust` is one path (#ff7043, holes and arcs), `toml` two paths (#cfd8dc, #ef5350). The set's own colours are kept.
- Pipeline: `bun scripts/icons/build.ts [names...]` flattens the paths, triangulates them with earcut (ISC) and writes `src/lib/reading/icons.gen.ts` (triangles, read by `exhibit.ts`) and `world/src/museum/icons_gen.rs` (name table). Add a name to `ICON_NAMES` or pass names, rerun, rebuild wasm. Lane A's code-block filename header can read `FILE_ICONS` from `icons.gen.ts`.
- Not verified: the set's full per-name list of other file types (only rust and toml were inspected).
