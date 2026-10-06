// Per-article art direction (docs/MAGAZINE.md 3.2): accent hue plus the Instrument Sans display voice.
// The voice is the per-article art direction. A sidecar spread.json may override hue / wdth / wght for one article.
import { DISPLAY_AXES } from '../reader/fonts';

export interface Voice {
	slug: string;
	hue: number; // OKLCH hue, degrees
	wdth: number; // Instrument Sans 75..100
	wght: number; // Instrument Sans 400..700
}

const v = (slug: string, hue: number, wdth: number, wght: number): Voice => ({ slug, hue, wdth, wght });

export const VOICES: readonly Voice[] = [
	v('ifd', 265, 80, 600),
	v('hyperion', 148, 75, 700),
	v('notes-on-errors', 28, 90, 600),
	v('mcp-not-enough', 78, 85, 700),
	v('nushell-tui', 195, 85, 500),
	v('optimal-parkour', 330, 80, 500),
	v('snuon', 350, 75, 700),
	v('rust-named-parameters', 55, 90, 600),
	v('gpt4-hals-and-rest-libs', 295, 85, 600),
	v('commit', 205, 80, 600),
	v('initial-thought', 120, 80, 600)
];

/** Validate the table: unique slugs, axes in range, and "two articles never share hue and voice together". */
export function checkVoices(list: readonly Voice[] = VOICES): void {
	const seen = new Set<string>(), combo = new Set<string>();
	for (const x of list) {
		if (seen.has(x.slug)) throw new Error(`voices: duplicate slug ${x.slug}`);
		seen.add(x.slug);
		const [w0, w1] = DISPLAY_AXES.wdth, [g0, g1] = DISPLAY_AXES.wght;
		if (x.wdth < w0 || x.wdth > w1 || x.wght < g0 || x.wght > g1) throw new Error(`voices: ${x.slug} wdth ${x.wdth} wght ${x.wght} outside Instrument Sans axes`);
		if (x.hue < 0 || x.hue >= 360) throw new Error(`voices: ${x.slug} hue ${x.hue} outside [0, 360)`);
		const k = `${x.hue}/${x.wdth}/${x.wght}`;
		if (combo.has(k)) throw new Error(`voices: ${x.slug} shares hue and voice with another article`);
		combo.add(k);
	}
}

export function voiceFor(slug: string, override: Partial<Pick<Voice, 'hue' | 'wdth' | 'wght'>> = {}): Voice {
	const base = VOICES.find((x) => x.slug === slug);
	if (!base) throw new Error(`voices: no voice for slug "${slug}" (add it to scripts/magazine/voices.ts)`);
	const out = { ...base, ...override };
	checkVoices([out]);
	return out;
}
