import { error } from '@sveltejs/kit';
import type { LayoutLoad } from './$types';

function calculateReadingTime(content: string): number {
	const withoutFrontmatter = content.replace(/^---[\s\S]*?---/, '');
	const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/g, '');
	const withoutTags = withoutCode
		.replace(/<script[\s\S]*?<\/script>/g, '')
		.replace(/<style[\s\S]*?<\/style>/g, '');
	const withoutHtml = withoutTags.replace(/<[^>]+>/g, '');
	const words = withoutHtml.trim().split(/\s+/).filter((w) => w.length > 0).length;
	return Math.max(1, Math.ceil(words / 200));
}

export const load: LayoutLoad = async ({ url }) => {
	const modules = import.meta.glob('./**/+page.svx', { eager: true });
	const rawModules = import.meta.glob('./**/+page.svx', {
		eager: true,
		query: '?raw',
		import: 'default'
	}) as Record<string, string>;

	const currentPath = url.pathname.replace('/thoughts', '').replace(/\/$/, '') || '/';

	if (!currentPath || currentPath === '/') {
		return {};
	}

	for (const [path, module] of Object.entries(modules)) {
		const routePath = path.replace('.', '').replace('/+page.svx', '');

		if (routePath === currentPath) {
			const metadata = (module as any).metadata;

			if (metadata?.visible === false) {
				throw error(404, 'Not found');
			}

			const toc = (module as any).toc || [];
			const pageCount = (module as any).pageCount || 1;

			const rawContent = rawModules[path] || '';
			const readingTime = calculateReadingTime(rawContent);

			return {
				title: metadata?.title || 'Thought',
				status: metadata?.status,
				username: metadata?.username,
				date: metadata?.date,
				prompts: (metadata?.prompts ?? []) as string[],
				related: {
					users: (metadata?.related?.users ?? []) as string[],
					repos: (metadata?.related?.repos ?? []) as string[]
				},
				readingTime,
				toc,
				pageCount
			};
		}
	}

	return {};
};
