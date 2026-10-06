import type { LayoutLoad } from './$types';
import { metaFor } from '$lib/meta';

export const load: LayoutLoad = ({ url }) => ({ meta: metaFor(url.pathname) });
