// DEV only: hot reload of exhibit scripts (docs/MUSEUM.md 2.8). The vite plugin sends `exhibit:reload { slug, id, src }` when exhibits/<id>.flecs of the open
// article changes, or `{ reload: true }` when the change cannot be applied in place (a new exhibit, a changed directive): then the page reloads.
// The engine dry-runs the script in a scratch world first; an error keeps the old exhibit running and goes to the overlay and a toast.
export interface ExhibitHotHost {
	slug(): string;
	/** `exhibit_reload` of the exhibit `id`: null when applied, else the engine's error text */
	reload(id: string, src: string): string | null;
	report(msg: string): void;
}

export interface ExhibitReloadEvent { slug?: string; id?: string; src?: string; reload?: boolean }

/** Apply one event; returns what happened (the tests drive this without vite). */
export function applyExhibitReload(host: ExhibitHotHost, ev: ExhibitReloadEvent, reloadPage: () => void): 'page' | 'skipped' | 'ok' | 'error' {
	if (ev.reload) { reloadPage(); return 'page'; }
	if (!ev.id || typeof ev.src !== 'string' || (ev.slug && ev.slug !== host.slug())) return 'skipped';
	const err = host.reload(ev.id, ev.src);
	if (err === null) return 'ok';
	host.report(`${ev.slug ?? host.slug()}/${ev.id}: ${err}`);
	return 'error';
}

/** Listen for `exhibit:reload` (a no-op outside vite dev); returns the detach function. */
export function attachExhibitHot(host: ExhibitHotHost): () => void {
	const hot = import.meta.hot;
	if (!hot) return () => {};
	const on = (ev: ExhibitReloadEvent) => { applyExhibitReload(host, ev, () => location.reload()); };
	hot.on('exhibit:reload', on);
	return () => hot.off?.('exhibit:reload', on);
}
