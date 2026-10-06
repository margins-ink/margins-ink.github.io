import type { Cover } from './types';
import { cover as placeholder } from './placeholder';

// Auto-registers every `<slug>.ts` in this folder that exports `cover: Cover`.
const modules = import.meta.glob<{ cover: Cover }>('./*.ts', { eager: true });

export const covers: Record<string, Cover> = {};
for (const [path, mod] of Object.entries(modules)) {
	const slug = path.replace('./', '').replace('.ts', '');
	if (['types', 'index', 'placeholder'].includes(slug) || !mod.cover) continue;
	covers[slug] = mod.cover;
}
export const fallbackCover: Cover = placeholder;
export type { Cover };
