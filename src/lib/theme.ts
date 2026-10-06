import { covers, fallbackCover } from '$lib/covers';
import { accentOf } from '$lib/covers/accent';

export const coverFor = (slug: string) => covers[slug] ?? fallbackCover;
export const accentFor = (slug: string) => accentOf(coverFor(slug));

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function shortDate(iso: string) {
	const d = new Date(iso);
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
export function longDate(iso: string) {
	const d = new Date(iso);
	return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}
export const issue = (no: number) => String(no).padStart(2, '0');
