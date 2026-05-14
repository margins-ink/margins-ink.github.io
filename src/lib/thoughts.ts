import type { ComponentType } from 'svelte';
import * as visuals from './components/visuals';

export interface Thought {
	title: string;
	route: string;
	visual?: ComponentType;
	date?: string;
	status?: 'WIP' | 'complete';
	username?: string;
	readingTime: number;
}

// Map of route slugs to visual components
const visualMap: Record<string, ComponentType> = {
	'rerun-million-tasks': visuals.RerunProblem,
	'deferred-ecs': visuals.GameDatabases,
	'bounty-pricing': visuals.BountyPricing,
	'snuon': visuals.TokenEfficient,
	'mcp-not-enough': visuals.McpNotEnough,
	'nushell-tui': visuals.AiGdb,
	'nix-cycles': visuals.NixCycles,
	'ifd': visuals.Ifd,
	'filesystems': visuals.Filesystems,
};

function calculateReadingTime(content: string): number {
	// Remove frontmatter
	const withoutFrontmatter = content.replace(/^---[\s\S]*?---/, '');
	// Remove code blocks
	const withoutCode = withoutFrontmatter.replace(/```[\s\S]*?```/g, '');
	// Remove script/style tags
	const withoutTags = withoutCode.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
	// Remove HTML tags
	const withoutHtml = withoutTags.replace(/<[^>]+>/g, '');
	// Count words (average reading speed: 200-250 wpm, using 200 for technical content)
	const words = withoutHtml.trim().split(/\s+/).filter(w => w.length > 0).length;
	return Math.max(1, Math.ceil(words / 200));
}

// Import all thought metadata from +page.svx files
// Need to escape parentheses in route groups: https://github.com/sveltejs/kit/issues/6239
const modules = import.meta.glob('/src/routes/\\(site\\)/thoughts/**/+page.svx', { eager: true });
const rawModules = import.meta.glob('/src/routes/\\(site\\)/thoughts/**/+page.svx', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

export const thoughts: Thought[] = Object.entries(modules)
	.map(([path, module]) => {
		// Extract route from file path: /src/routes/(site)/thoughts/foo/+page.svx -> /thoughts/foo
		const route = path
			.replace('/src/routes/(site)', '')
			.replace('/+page.svx', '');

		// Get slug for visual lookup
		const slug = route.split('/').pop() || '';

		// Get metadata from frontmatter
		const metadata = (module as any).metadata;

		// Get raw content for reading time calculation
		const rawContent = rawModules[path] || '';

		return {
			title: metadata?.title || 'Untitled',
			route,
			visual: visualMap[slug] || visuals.Default,
			date: metadata?.date,
			status: metadata?.status,
			username: metadata?.username,
			visible: metadata?.visible !== false, // Default to true if not specified
			readingTime: calculateReadingTime(rawContent)
		};
	})
	.filter(thought => thought.visible)
	.sort((a, b) => {
		// Pure date-desc. Drafts carry their own visual signal (tag + dim);
		// no reason to also reorder them out of chronology.
		if (a.date && b.date) {
			return new Date(b.date).getTime() - new Date(a.date).getTime();
		}
		if (a.date) return -1;
		if (b.date) return 1;
		return a.title.localeCompare(b.title);
	});
