import { setContext, getContext } from 'svelte';
import Cite from './Cite.svelte';
import References from './References.svelte';

export interface Ref {
	id: string;
	title: string;
	url: string;
	note?: string;
}

const KEY = Symbol('thoughts:refs');

export function useRefs(refs: Ref[]): void {
	setContext(KEY, refs);
}

export function getRefs(): Ref[] {
	return getContext<Ref[]>(KEY) ?? [];
}

export { Cite, References };
