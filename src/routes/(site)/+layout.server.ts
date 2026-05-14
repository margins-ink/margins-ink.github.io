import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async ({ url }) => {
	// Only set title for homepage
	if (url.pathname === '/') {
		const module = await import('./+page.svx');
		const metadata = (module as any).metadata;

		return {
			title: metadata?.title || 'Margins'
		};
	}

	return {};
};
