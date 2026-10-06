# Sources for "When you pay for computation"

Used by `src/routes/(site)/thoughts/models/+page.svx`. All fetched 2026-10-06 UTC. "Read" means the text was read (raw PDF text, or a page read through a summarising fetch tool that quoted it back); "reported" means only a secondary description was seen. Bytes are stored only where the licence allows redistribution.

## accattoli-dallago-lmcs-2016.pdf (bytes stored)
- URL: https://lmcs.episciences.org/1627/pdf (landing page https://lmcs.episciences.org/1627), DOI 10.2168/LMCS-12(1:4)2016, 46 pages.
- sha256: 6d9d0c5ce28decc81ae205256eeb5b39ad2758d0b5929ffab76ccf3da1e5be0d
- Licence: "This work is licensed under the Creative Commons Attribution-NoDerivs License ... http://creativecommons.org/licenses/by-nd/2.0/" (read, last page of the PDF). Verbatim redistribution with attribution is allowed.
- Question: is the number of beta steps a fair time cost model? Read (abstract): leftmost-outermost derivation length to normal form is an invariant (reasonable) cost model in the Slot and van Emde Boas sense; cannot be shown directly because of size explosion ("terms that in a linear number of steps produce an exponentially large output"); solved with the linear substitution calculus and "useful" shared reduction.

## Stanford Encyclopedia of Philosophy: The Church-Turing Thesis (facts only)
- URL: https://plato.stanford.edu/entries/church-turing/ ; B. Jack Copeland; first published 1997-01-08, substantive revision 2023-12-18. "Copyright (c) 2023 by B. Jack Copeland": no redistribution licence, bytes not stored.
- Read: the thesis cannot be proved because "effective calculability" is an informal notion; Turing (1936) proved lambda-definable = Turing-computable; Church and Kleene (1936) proved lambda-definable = recursive; efficiency is the separate Extended Church-Turing thesis (Yao's polynomial formulation).

## Lean Language Reference: Functors, Monads and do-Notation, Syntax (facts only; licence not read)
- URL: https://lean-lang.org/doc/reference/latest/Functors___-Monads-and--do--Notation/Syntax/
- Read: `do e1; es` => `e1 >>= fun () => do es`; `do let x ← e1; es` => `e1 >>= fun x => do es`; `let x := e` stays a `let`; `let mut` is elaborated "similarly to the way that StateT would".
- Behaviour claims in the post (inferred `IO Unit`, `rfl` equalities, `Tuple`/`mkTuple` output, the error without the signature, `countdown` accepted) were run locally with Lean 4.30.0 (nixpkgs `lean4-4.30.0`), not taken from docs.

## Haskell 2010 Language Report, section 3.14 (facts only)
- URL: https://www.haskell.org/onlinereport/haskell2010/haskellch3.html
- Licence (read, report index): copying allowed "provided that it is reproduced in its entirety, including this Notice"; a single chapter is not stored.
- Read: `do {e} = e`; `do {e;stmts} = e >> do {stmts}`; `do {p <- e; stmts} = let ok p = do {stmts}; ok _ = fail "..." in e >>= ok`; `do {let decls; stmts} = let decls in do {stmts}`.

## Moggi, Notions of computation and monads (facts only)
- URL read: https://person.dibris.unige.it/moggi-eugenio/ftp/ic91.pdf (author's copy; server has an incomplete TLS chain, fetched with verification off for reading only), sha256 45bbf268f3a8e7b24702cf75a1941fd0fcaf96c3d642125478418e1d4a041e03. Published Information and Computation 93(1):55-92, July 1991 (Crossref metadata for DOI 10.1016/0890-5401(91)90052-4). Elsevier copyright: bytes not stored.
- Read (abstract and intro): beta-eta conversion identifies programs with total functions, which "wipes out completely behaviours like non-termination, non-determinism or side-effects"; a categorical semantics of computations based on monads.

## Wadler, Monads for functional programming (reported via the author's index page)
- URL: https://homepages.inf.ed.ac.uk/wadler/topics/monads.html ; Marktoberdorf Summer School 1992.
- Read (abstract on the index page): "Monads provide a convenient framework for simulating effects found in other languages, such as global state, exception handling, output, or non-determinism." Paper body not read.

## Peyton Jones, the Spineless Tagless G-machine (facts only)
- URL: https://www.microsoft.com/en-us/research/wp-content/uploads/1992/04/spineless-tagless-gmachine.pdf (version 2.5, 1992-07-09), sha256 52ffdd9c584f2cbec57489eb42effeeb923f54106b1caa21814c2016578edf30. No licence in the text: bytes not stored. JFP 2(2):127-202.
- Read: the heap holds head normal forms and unevaluated suspensions (closures); forcing a closure "pushes a continuation on the stack and enters the closure"; target is C; appendix has implementation notes for the Glasgow Haskell compiler.

## Rust: recursion_limit and E0275 (facts only; licence not read)
- https://doc.rust-lang.org/reference/attributes/limits.html : recursion_limit sets "the maximum depth for potentially infinitely-recursive compile-time operations like macro expansion or auto-dereference"; "The default in rustc is 128." (read)
- https://doc.rust-lang.org/error_codes/E0275.html : "An evaluation of a trait requirement overflowed." (read)
- Run locally with rustc 1.98.1: an unbounded trait requirement fails with E0275 and "help: consider increasing the recursion limit by adding a `#![recursion_limit = "256"]` attribute"; the type-level `Add` example in the post prints 5.

## Turing completeness of type systems (facts only)
- Shea Leffler, "Rust's Type System is Turing-Complete" (2017-03-07), https://sdleffler.github.io/RustTypeSystemTuringComplete/ , code https://github.com/sdleffler/tarpit-rs : a Smallfuck interpreter in Rust traits; notes rustc's recursion limit. Read through a summarising fetch.
- Todd L. Veldhuizen, "C++ Templates are Turing Complete" (Indiana University, 2003). Abstract read from a third-party PDF mirror (https://rtraba.files.wordpress.com/2015/05/cppturing.pdf, sha256 e6be7a19afc38e8f062f80d2937674a939109f05b374d6c393a9fc8a0de1d25a): "We sketch a proof of a well-known folk theorem that C++ templates are Turing complete." Cited via Semantic Scholar (page returned 403 to the fetch tool; URL from search results).
- TypeScript issue #14833, "TypeScripts Type System is Turing Complete", Henning Dieterichs, opened 2017-03-24, https://github.com/microsoft/TypeScript/issues/14833 (read through a summarising fetch).

## Dowek, The Undecidability of Typability in the Lambda-Pi-Calculus (facts only)
- URL: https://arxiv.org/abs/2306.07599 (arXiv 2023 posting of the TLCA 1993 paper, LNCS 664 pp. 139-145 per Springer and ACM listings). arXiv non-exclusive distribution licence: bytes not stored.
- Read (abstract): "The set of pure terms which are typable in the λΠ-calculus in a given context is not recursive. So there is no general type inference algorithm for the programming language Elf and, in some cases, some type information has to be mentioned by the programmer."

## Unison documentation (facts only; "(c) 2026 Unison Computing, a public benefit corp and contributors", no licence read)
- https://www.unison-lang.org/docs/the-big-idea/ (read): "Each Unison definition is identified by a hash of its syntax tree"; names "are just separately stored metadata that don't affect the function's hash"; "Once anyone has parsed and typechecked a definition and added it to the codebase, no one has to do that ever again."; "Dependency conflicts and the diamond dependency problem are just not a thing."; "There's no need to rerun a deterministic test if none of its dependencies have changed!"; "the sender ships the bytecode tree to the recipient, who inspects the bytecode for any hashes it's missing. If it already has all the hashes, it can run the computation; otherwise, it requests the ones it's missing and the sender syncs them on the fly."; "The Unison codebase is a proper database".
- https://www.unison-lang.org/docs/usage-topics/workflow-how-tos/update-code/ (read): `update` applies dependents that typecheck and opens the rest in the editor on a temporary branch.
- https://www.unison-lang.org/docs/fundamentals/abilities/for-monadically-inclined/ (read): example `safeDiv1 : Nat -> Nat ->{Exception} Nat`; "Direct-style algebraic effects (delimited continuations) and monads have the same expressive power".
- SQLite storage: `parser-typechecker/src/Unison/Codebase/SqliteCodebase/Paths.hs` at unisonweb/unison a1652e3ada28924cb9e75ff1d62408ee8df6b78f: `codebasePath = ".unison" </> "v2" </> "unison.sqlite3"` (read via the GitHub API).
