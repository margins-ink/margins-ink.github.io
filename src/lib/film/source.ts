// Where a film's script comes from: `src/routes/(site)/thoughts/<slug>/film.flecs`, bundled lazily (one chunk per film) with a glob.
// A post has a film exactly when that file exists; the reader opens the film for such a post and the article one key away.
const files = import.meta.glob('/src/routes/\\(site\\)/thoughts/*/film.flecs', { query: '?raw', import: 'default' }) as Record<string, () => Promise<string>>;

const pathOf = (slug: string) => `/src/routes/(site)/thoughts/${slug}/film.flecs`;

export const hasFilm = (slug: string): boolean => pathOf(slug) in files;

export async function filmSource(slug: string): Promise<string | null> {
	const f = files[pathOf(slug)];
	return f ? await f() : null;
}

export interface FilmReloadEvent { slug?: string; src?: string }

/** Listen for `film:reload` (a no-op outside vite dev); returns the detach function. `apply` returns null when applied, else the engine's error text. */
export function attachFilmHot(slug: () => string, apply: (src: string) => string | null, report: (msg: string) => void): () => void {
	const hot = import.meta.hot;
	if (!hot) return () => {};
	const on = (ev: FilmReloadEvent) => {
		if (!ev.src || (ev.slug && ev.slug !== slug())) return;
		const err = apply(ev.src);
		if (err !== null) report(`${slug()}/film.flecs: ${err}`);
	};
	hot.on('film:reload', on);
	return () => hot.off?.('film:reload', on);
}
