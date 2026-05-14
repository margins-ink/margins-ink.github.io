# site

Personal site for Andrew Gazelka. SvelteKit + mdsvex, statically rendered via `@sveltejs/adapter-static`.

## Develop

```bash
pnpm install
pnpm dev
```

This project uses **pnpm**. Do not run `npm install`.

## Build

```bash
pnpm build       # output to build/
pnpm preview     # serve the production build locally
pnpm check       # svelte-check
```

## Layout

- `src/routes/(site)/` — main site (home, `/thoughts/*`). The `(site)` route group owns the navbar and shared layout.
- `src/routes/(site)/thoughts/<slug>/+page.svx` — posts authored in mdsvex.
- `src/routes/artifact/{org}/{repo}/{pr}/` — animated PR explainers, isolated from the site layout.
- `src/routes/lmllmtfy/` — standalone tool, its own layout.
- `src/lib/components/visuals/` — per-thought SVG card emblems. Register new ones in `src/lib/components/visuals/index.ts` and `src/lib/thoughts.ts`.
- `src/lib/components/refs/` — numbered references (`useRefs`, `<Cite>`, `<References>`).

## Conventions

See `CLAUDE.md` for the writing style guide, SvelteKit route-group patterns, visual design rules, and PR-artifact structure.
