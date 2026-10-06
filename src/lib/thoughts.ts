export interface Thought {
	slug: string;
	title: string;
	dek: string;
	route: string;
	date: string;
	archived: boolean;
	/** 1 = oldest. Shown as the issue number. */
	no: number;
}

// Import all article metadata from +page.svx files.
// Parentheses in route groups must be escaped: https://github.com/sveltejs/kit/issues/6239
const modules = import.meta.glob('/src/routes/\\(site\\)/thoughts/**/+page.svx', { eager: true });

const all = Object.entries(modules)
	.map(([path, module]) => {
		const route = path.replace('/src/routes/(site)', '').replace('/+page.svx', '');
		const metadata = (module as any).metadata;
		return {
			slug: route.split('/').pop() || '',
			title: (metadata?.title as string) || 'Untitled',
			dek: (metadata?.dek as string) || '',
			route,
			date: metadata?.date as string | undefined,
			archived: metadata?.archived === true,
			visible: metadata?.visible !== false
		};
	})
	.filter((t) => t.visible && t.date) as (Omit<Thought, 'no'> & { visible: boolean })[];

const oldestFirst = [...all].sort((a, b) => +new Date(a.date) - +new Date(b.date) || a.slug.localeCompare(b.slug));

/** Newest first. */
export const thoughts: Thought[] = oldestFirst
	.map((t, i) => ({ slug: t.slug, title: t.title, dek: t.dek, route: t.route, date: t.date, archived: t.archived, no: i + 1 }))
	.reverse();

export const thoughtBySlug = (slug: string) => thoughts.find((t) => t.slug === slug);
