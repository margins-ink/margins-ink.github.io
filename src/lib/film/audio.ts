// The voice track of a film: one HTMLAudioElement (Opus, AAC fallback) laid out by scripts/film/narrate.py, plus its align.json.
// The film clock follows `time()` while the voice plays; without a voice file (404, offline, no codec) the film runs on its own clock and the
// captions use the reading-speed estimate (nothing here is required to play).

export interface AlignFile {
	voice: string;
	hash: string;
	total: number;
	files: { opus?: string; m4a?: string };
	lines: Record<string, { key: string; start: number; dur: number; words: [string, number, number][] }>;
}

export interface Voice {
	/** seconds into the voice file */
	time(): number;
	/** true once the element can play from any position */
	readonly ready: boolean;
	play(): Promise<boolean>;
	pause(): void;
	seek(t: number): void;
	rate(r: number): void;
	readonly ended: boolean;
	dispose(): void;
}

export const filmBase = (slug: string): string => `/film/${slug}`;

/** `align.json` of a film, or null when none was generated (the film plays on the estimate). */
export async function fetchAlign(slug: string, fetcher: typeof fetch = fetch): Promise<AlignFile | null> {
	try {
		const r = await fetcher(`${filmBase(slug)}/align.json`, { cache: 'no-cache' });
		if (!r.ok) return null;
		const j = (await r.json()) as AlignFile;
		return j && j.lines && typeof j.total === 'number' ? j : null;
	} catch {
		return null;
	}
}

/** The source this browser can play: Opus where supported, else AAC. */
export function pickSource(slug: string, a: AlignFile, el: Pick<HTMLAudioElement, 'canPlayType'>): string | null {
	const base = filmBase(slug);
	if (a.files.opus && el.canPlayType('audio/ogg; codecs="opus"') !== '') return `${base}/${a.files.opus}`;
	if (a.files.opus && el.canPlayType('audio/webm; codecs="opus"') !== '' && a.files.opus.endsWith('.webm')) return `${base}/${a.files.opus}`;
	if (a.files.m4a && el.canPlayType('audio/mp4; codecs="mp4a.40.2"') !== '') return `${base}/${a.files.m4a}`;
	return a.files.opus ? `${base}/${a.files.opus}` : a.files.m4a ? `${base}/${a.files.m4a}` : null;
}

export function createVoice(slug: string, a: AlignFile, onChange: () => void): Voice | null {
	if (typeof Audio === 'undefined') return null;
	const el = new Audio();
	const src = pickSource(slug, a, el);
	if (!src) return null;
	el.preload = 'auto';
	el.src = src;
	el.preservesPitch = true;
	let ready = false;
	const onReady = () => { ready = true; onChange(); };
	el.addEventListener('canplay', onReady);
	el.addEventListener('ended', onChange);
	el.addEventListener('error', () => { ready = false; onChange(); });
	return {
		time: () => el.currentTime,
		get ready() { return ready; },
		play: () => el.play().then(() => true, () => false),
		pause: () => el.pause(),
		seek: (t) => { try { el.currentTime = t; } catch { /* not seekable yet */ } },
		rate: (r) => { el.playbackRate = r; },
		get ended() { return el.ended; },
		dispose() { el.pause(); el.removeAttribute('src'); el.load(); }
	};
}

// ---- resume position -----------------------------------------------------------------------------------------------------

export interface Saved { t: number; speed: number; cc: boolean }
const key = (slug: string) => `film:${slug}`;

export function loadSaved(slug: string, total: number, store: Pick<Storage, 'getItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): Saved {
	const none: Saved = { t: 0, speed: 1, cc: true };
	try {
		const j = JSON.parse(store?.getItem(key(slug)) ?? 'null') as Partial<Saved> | null;
		if (!j) return none;
		const t = typeof j.t === 'number' && j.t > 3 && j.t < total - 3 ? j.t : 0;
		return { t, speed: typeof j.speed === 'number' && j.speed >= 0.5 && j.speed <= 3 ? j.speed : 1, cc: j.cc !== false };
	} catch {
		return none;
	}
}

export function save(slug: string, s: Saved, store: Pick<Storage, 'setItem'> | undefined = typeof localStorage === 'undefined' ? undefined : localStorage): void {
	try { store?.setItem(key(slug), JSON.stringify(s)); } catch { /* private mode or full */ }
}
