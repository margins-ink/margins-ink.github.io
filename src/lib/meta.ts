import { error } from '@sveltejs/kit';
import { thoughtBySlug } from '$lib/thoughts';
import { plainTitle } from '$lib/title';

/** Head tags only: the page body is the WebGPU render (docs/READING.md). */
export interface Meta {
	title: string;
	description: string;
	canonical: string;
	type: 'website' | 'article';
	published?: string;
}

export const ORIGIN = 'https://margins-ink.github.io';
export const SITE = 'Andrew Gazelka';
const HOME_DESCRIPTION = 'Essays by Andrew Gazelka on software and systems, drawn in a room you can walk through.';

export function metaFor(pathname: string): Meta {
	const m = /^\/thoughts\/([^/]+)\/?$/.exec(pathname);
	if (m) {
		const t = thoughtBySlug(m[1]);
		// hidden (visible: false) and unknown slugs are not pages
		if (!t) throw error(404, 'Not found');
		return {
			title: `${plainTitle(t.title)} | ${SITE}`,
			description: t.dek || HOME_DESCRIPTION,
			canonical: `${ORIGIN}${t.route}/`,
			type: 'article',
			published: t.date
		};
	}
	return { title: SITE, description: HOME_DESCRIPTION, canonical: `${ORIGIN}/`, type: 'website' };
}
