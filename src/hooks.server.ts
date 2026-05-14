// number-flow's lite bundle assumes a browser because wrangler/esbuild applies
// the `browser` package condition on workerd, so esm-env's BROWSER is true. The
// module then references HTMLElement at top level and calls customElements at
// module load via `define()`. Shim both before any route chunk loads.
const g = globalThis as { HTMLElement?: unknown; customElements?: unknown };
if (typeof g.HTMLElement === 'undefined') {
	g.HTMLElement = class {};
}
if (typeof g.customElements === 'undefined') {
	g.customElements = {
		get: () => undefined,
		define: () => {},
		whenDefined: () => Promise.resolve(),
		upgrade: () => {}
	};
}
