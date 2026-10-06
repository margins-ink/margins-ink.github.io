import { error } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';
import { thoughtBySlug } from '$lib/thoughts';

export const load: LayoutLoad = async ({ url }) => {
	const modules = import.meta.glob('./**/+page.svx', { eager: true });
	const currentPath = url.pathname.replace('/thoughts', '').replace(/\/$/, '') || '/';
	if (currentPath === '/') return {};

	for (const [path, module] of Object.entries(modules)) {
		const routePath = path.replace('.', '').replace('/+page.svx', '');
		if (routePath !== currentPath) continue;
		const metadata = (module as any).metadata;
		if (metadata?.visible === false) throw error(404, 'Not found');
		const slug = currentPath.split('/').pop() ?? '';
		const t = thoughtBySlug(slug);
		return {
			title: metadata?.title || 'Thought',
			dek: (metadata?.dek as string) ?? '',
			date: metadata?.date as string | undefined,
			slug,
			no: t?.no,
			toc: (module as any).toc || [],
			pageCount: (module as any).pageCount || 1
		};
	}
	return {};
};
