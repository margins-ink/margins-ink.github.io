# Sources for the IFD post, sections on Buck2 dynamic dependencies and cargo's unit graph

Question answered: what does Buck2's `dynamic_output` defer, what stays static, and how do static (applicative) and dynamic (monadic) dependencies trade off. Used by `src/routes/(site)/thoughts/ifd/+page.svx`.

## build-systems-a-la-carte.pdf (bytes stored)
- URL: https://www.microsoft.com/en-us/research/uploads/prod/2018/03/build-systems.pdf
- sha256: d6c175a48cc908ca3f185e1fb4620e3278c5655218ac687d83dfa7f405624ede; fetched 2026-10-06 UTC (29 pages, ICFP 2018, doi 10.1145/3236774)
- Licence: "licensed under a Creative Commons Attribution 4.0 International License" (read, front matter of the PDF text).
- Read: section 2.2 to 2.5 (Table 1: Make static/minimal; Excel dynamic/restarting/not minimal; Shake dynamic/suspending/minimal, persists previous dependency graph; Bazel dynamic (*) restarting/not minimal, "user-defined build rules cannot have dynamic dependencies"), 3.5 (monadic tasks allow dynamic dependencies), 3.7 (applicative task dependencies can be extracted by running it in `Const [k]`, "no actual computation"; monadic ones "cannot be done statically").

## Buck2: Dynamic Dependencies (facts only, bytes not stored; docs licence not read from text, page footer says copyright Meta)
- URL: https://buck2.build/docs/rule_authors/dynamic_dependencies/ , fetched 2026-10-06 UTC, read from the raw HTML.
- Read: "Dynamic dependencies in Buck2 are implemented using dynamic_output and are restricted in their power compared to fully generic dynamic dependencies." A rule sees attributes and providers (artifact values but not contents) at analysis; with `dynamic_output` it can read artifact contents to produce new artifacts and bind existing artifacts already returned in providers. Signature `ctx.actions.dynamic_output(dynamic, inputs, outputs, lambda ctx: ...)`; `dynamic` artifacts "will be built before the function is run"; `inputs` accepted but ignored; `outputs` are unbound artifacts. Listed uses: Distributed ThinLTO, OCaml (`ocamldeps`), Erlang headers, Erlang BEAM ordering. Haskell and C++ are not listed on this page.

## Cargo: unit-graph (facts only, bytes not stored; licence not read)
- URL: https://doc.rust-lang.org/cargo/reference/unstable.html#unit-graph , fetched 2026-10-06 UTC (via a summarising fetch tool, section quoted back in full; not raw HTML).
- Read: `cargo +nightly build --unit-graph -Z unstable-options`; works on any build command; "Nothing is actually built"; each unit is a compiler execution; JSON has `version`, `units` (with `features`, `mode` including `run-custom-build`, `dependencies` by index, `profile`, `platform`) and `roots`. `cargo metadata` "fundamentally cannot represent" per-dependency-kind features. Tracking issue rust-lang/cargo#8002.

## Cargo: build scripts (facts only; summarising fetch tool)
- URL: https://doc.rust-lang.org/cargo/reference/build-scripts.html , fetched 2026-10-06 UTC.
- Read: script output lines `cargo::rustc-cfg`, `rustc-env`, `rustc-link-lib`, `rustc-link-search`, `rerun-if-changed`; the script runs just before the package is compiled and its outputs are applied to that compile.
