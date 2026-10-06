// Directives and frontmatter for the magazine pipeline (docs/MAGAZINE.md 1.5 and 1.7).
//
// remark-directive is not installed, so directives are read at the SOURCE level and replaced by an
// html comment on the SAME line (line numbers, and therefore file:line errors, stay exact). The block
// parser in scripts/reader/parse.ts turns those comments back into blocks via `directiveFromComment`.
//
// Grammar (fail closed: any other directive name throws with file:line):
//   ::fig{id="eval-timeline" place="inline"}          leaf; place: inline | wide | column | bleed
//   :::code-wide ... :::                              container; every fenced code block inside is wide
// Plain .svx with no directives is returned unchanged.
import YAML from 'yaml';

export type FigPlace = 'inline' | 'wide' | 'column' | 'bleed';
const PLACES: readonly FigPlace[] = ['inline', 'wide', 'column', 'bleed'];

export type DirectiveEvent =
	| { kind: 'fig'; id: string; place: FigPlace; line: number }
	| { kind: 'code-wide-open'; line: number }
	| { kind: 'code-wide-close'; line: number };

export class DirectiveError extends Error {}

const FENCE = /^(\s*)(```|~~~)/;
const LEAF = /^::([A-Za-z][\w-]*)(?:\{([^}]*)\})?\s*$/;
const CONTAINER_OPEN = /^:::([A-Za-z][\w-]*)(?:\{([^}]*)\})?\s*$/;
const CONTAINER_CLOSE = /^:::\s*$/;
const ATTR = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'}]+))/g;

const attrsOf = (s: string | undefined) => {
	const o: Record<string, string> = {};
	for (const m of (s ?? '').matchAll(ATTR)) o[m[1]] = m[2] ?? m[3] ?? m[4];
	return o;
};

const COMMENT = /^<!--magdir:(\d+)-->$/;

export interface Extracted {
	/** same line count as the input; directive lines are replaced by `<!--magdir:N-->` */
	source: string;
	events: Map<number, DirectiveEvent>;
}

/** Replace directive lines (outside fenced code) by comments and collect them, fail closed. */
export function extractDirectives(source: string, file: string): Extracted {
	const lines = source.split('\n');
	const events = new Map<number, DirectiveEvent>();
	let fence: string | null = null;
	let open: number | null = null;
	let inFrontmatter = lines[0]?.trim() === '---';
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const n = i + 1;
		if (inFrontmatter) {
			if (i > 0 && line.trim() === '---') inFrontmatter = false;
			continue;
		}
		const f = FENCE.exec(line);
		if (f) {
			if (fence === null) fence = f[2];
			else if (f[2] === fence) fence = null;
			continue;
		}
		if (fence !== null) continue;
		const where = `${file}:${n}`;
		const co = CONTAINER_OPEN.exec(line);
		if (co) {
			if (co[1] !== 'code-wide') throw new DirectiveError(`${where}: unknown container directive :::${co[1]} (known: code-wide)`);
			if (open !== null) throw new DirectiveError(`${where}: :::code-wide opened at line ${open} is not closed (containers do not nest)`);
			open = n;
			events.set(n, { kind: 'code-wide-open', line: n });
			lines[i] = `<!--magdir:${n}-->`;
			continue;
		}
		if (CONTAINER_CLOSE.test(line)) {
			if (open === null) throw new DirectiveError(`${where}: ::: closes nothing`);
			open = null;
			events.set(n, { kind: 'code-wide-close', line: n });
			lines[i] = `<!--magdir:${n}-->`;
			continue;
		}
		const lf = LEAF.exec(line);
		if (lf) {
			if (lf[1] !== 'fig') throw new DirectiveError(`${where}: unknown directive ::${lf[1]} (known: fig; the first-draft ::spread/::pullquote/::numeral/:::aside were removed, the distill block picks those)`);
			const a = attrsOf(lf[2]);
			if (!a.id) throw new DirectiveError(`${where}: ::fig needs id="..."`);
			const place = (a.place ?? 'inline') as FigPlace;
			if (!PLACES.includes(place)) throw new DirectiveError(`${where}: ::fig place="${a.place}" must be one of ${PLACES.join(', ')}`);
			for (const k of Object.keys(a)) if (k !== 'id' && k !== 'place') throw new DirectiveError(`${where}: ::fig has unknown attribute ${k}`);
			events.set(n, { kind: 'fig', id: a.id, place, line: n });
			lines[i] = `<!--magdir:${n}-->`;
		}
	}
	if (open !== null) throw new DirectiveError(`${file}:${open}: :::code-wide is never closed`);
	return { source: lines.join('\n'), events };
}

/** If an html node's value is a directive placeholder, return its event. */
export function directiveFromComment(html: string, events: Map<number, DirectiveEvent> | undefined): DirectiveEvent | null {
	const m = COMMENT.exec(html.trim());
	if (!m) return null;
	return events?.get(Number(m[1])) ?? null;
}

// ---- frontmatter: distill block (1.7) -----------------------------------------------------------

/** Structural copy of the frontmatter block; the `contract` lane's `Distill` type in types.ts replaces it. */
export interface DistillBlock {
	template: 'duo' | 'solo' | 'compare' | 'numerals';
	headline: string;
	definition?: string;
	deck?: string;
	figures: string[];
	quote?: { text: string; from?: string };
	captions?: { fig: string; text: string }[];
	numerals?: { value: string; label: string }[];
	synth?: string[];
	review?: { by?: string; at?: string; post_sha?: string } | null;
}

const TEMPLATES = ['duo', 'solo', 'compare', 'numerals'];

/** Validate the shape only (strings, counts); the substring lint belongs to scripts/magazine/distill.ts. */
export function parseDistill(raw: unknown, file: string): DistillBlock | undefined {
	if (raw === undefined || raw === null) return undefined;
	const bad = (m: string) => new DirectiveError(`${file}: frontmatter distill: ${m}`);
	if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('must be a mapping');
	const d = raw as Record<string, any>;
	if (!TEMPLATES.includes(d.template)) throw bad(`template must be one of ${TEMPLATES.join(' | ')}`);
	if (typeof d.headline !== 'string' || !d.headline.trim()) throw bad('headline is required');
	if (!Array.isArray(d.figures) || d.figures.length > 2 || d.figures.some((f: unknown) => typeof f !== 'string')) throw bad('figures must be a list of at most 2 ids');
	if (d.captions !== undefined && (!Array.isArray(d.captions) || d.captions.length > 3)) throw bad('at most 3 captions');
	for (const c of d.captions ?? []) if (typeof c?.text !== 'string' || typeof c?.fig !== 'string') throw bad('each caption needs fig and text');
	if (d.quote !== undefined && typeof d.quote?.text !== 'string') throw bad('quote needs text');
	for (const k of ['definition', 'deck']) if (d[k] !== undefined && typeof d[k] !== 'string') throw bad(`${k} must be a string`);
	return {
		template: d.template, headline: d.headline, definition: d.definition, deck: d.deck, figures: d.figures ?? [],
		quote: d.quote, captions: d.captions ?? [], numerals: d.numerals, synth: d.synth ?? [], review: d.review ?? null
	};
}

/** The post body: the source without its leading YAML frontmatter. Used for the review sha and word counts. */
export function bodyOf(source: string): string {
	if (!source.startsWith('---')) return source;
	const end = source.indexOf('\n---', 3);
	if (end < 0) return source;
	const nl = source.indexOf('\n', end + 4);
	return nl < 0 ? '' : source.slice(nl + 1);
}

export function readFrontmatter(source: string): Record<string, unknown> {
	if (!source.startsWith('---')) return {};
	const end = source.indexOf('\n---', 3);
	return end < 0 ? {} : ((YAML.parse(source.slice(3, end)) ?? {}) as Record<string, unknown>);
}
