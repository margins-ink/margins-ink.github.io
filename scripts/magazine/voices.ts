// Per-article display voice (Instrument Sans width and weight). Colour is NOT per article: one colour system (src/lib/reading/theme.ts).
// A sidecar spread.json may override wdth / wght for one article.
import { DISPLAY_AXES } from '../reader/fonts';

export interface Voice {
	slug: string;
	wdth: number; // Instrument Sans 75..100
	wght: number; // Instrument Sans 400..700
}

const v = (slug: string, wdth: number, wght: number): Voice => ({ slug, wdth, wght });

export const VOICES: readonly Voice[] = [
	v('ifd', 80, 600),
	v('hyperion', 75, 700),
	v('notes-on-errors', 90, 600),
	v('mcp-not-enough', 85, 700),
	v('nushell-tui', 85, 500),
	v('optimal-parkour', 80, 500),
	v('snuon', 75, 700),
	v('rust-named-parameters', 90, 600),
	v('gpt4-hals-and-rest-libs', 85, 600),
	v('commit', 80, 600),
	v('initial-thought', 80, 600)
];

/** Validate the table: unique slugs, axes in range, and axes inside Instrument Sans range. */
export function checkVoices(list: readonly Voice[] = VOICES): void {
	const seen = new Set<string>();
	for (const x of list) {
		if (seen.has(x.slug)) throw new Error(`voices: duplicate slug ${x.slug}`);
		seen.add(x.slug);
		const [w0, w1] = DISPLAY_AXES.wdth, [g0, g1] = DISPLAY_AXES.wght;
		if (x.wdth < w0 || x.wdth > w1 || x.wght < g0 || x.wght > g1) throw new Error(`voices: ${x.slug} wdth ${x.wdth} wght ${x.wght} outside Instrument Sans axes`);
	}
}

export function voiceFor(slug: string, override: Partial<Pick<Voice, 'wdth' | 'wght'>> = {}): Voice {
	const base = VOICES.find((x) => x.slug === slug);
	if (!base) throw new Error(`voices: no voice for slug "${slug}" (add it to scripts/magazine/voices.ts)`);
	const out = { ...base, ...override };
	checkVoices([out]);
	return out;
}
