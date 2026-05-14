export const REPO_URL = 'https://github.com/margins-ink/margins-ink.github.io';

/**
 * GitHub URL for the source folder of a given route inside the (site) layout group.
 * e.g. /thoughts/foo -> https://github.com/.../tree/main/src/routes/(site)/thoughts/foo
 */
export function sourceFolderUrl(routePath: string): string {
	const path = routePath.replace(/\/+$/, '');
	if (!path) return REPO_URL;
	return `${REPO_URL}/tree/main/src/routes/(site)${path}`;
}
