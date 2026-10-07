// Script exhibits (docs/MUSEUM.md): exhibits/<id>.flecs of an article. The build runs each script through `exhibit_inspect` of the committed
// world.wasm (the script evaluated in a scratch world, described as JSON), lints the description (fail closed) and hands the strings
// and the Extent to flow.ts. Everything the lint needs from the wasm is the `Inspect` shape below; the rest is plain text work.
import fs from 'node:fs';
import path from 'node:path';
import { wasiImports } from '../../src/lib/wasi';

/** What `exhibit_inspect` returns (JSON in the out buffer). All lengths are exhibit-local em. */
export interface Inspect {
	title?: string;
	claim: string;
	caption?: string;
	describe: string;
	alt: string;
	/** the Extent component (em) */
	frame: { w: number; h: number };
	/** draw items counted by packing every preset at step 0 and after 200 steps: the maximum */
	items: number;
	/** parts with a `Does` verb (`does` is the verb in Rust Debug form: Step, Run, Reset, Load, Scrub, Home; the script writes it lower case, `Does: {"reset"}`), `label` the shown text */
	controls: { label: string; does: string }[];
	/** every part with a Place: size and shown text, if any */
	parts: { w: number; h: number; label?: string }[];
	/** every Tone value as written in the script (must be a palette name; the museum has no Tone component yet, so this is empty) */
	tones: string[];
	/** names of every component the script uses, for the Random/Clock rule */
	components: string[];
}

/** An exhibit ready for flow.ts. */
export interface ScriptExhibit {
	id: string;
	src: string;
	frame: [number, number];
	title: string;
	claim: string;
	caption: string;
	describe: string;
	alt: string;
}

export const MAX_FRAME = { w: 36, h: 22 } as const;
export const MAX_SCRIPT_LINES = 250;
export const MAX_ITEMS = 400;
export const MIN_PART_EM = 1.6;
export const MIN_DESCRIBE = 40;
/** control labels that need not occur in the post */
export const CONTROL_WORDS = new Set([
	'step', 'run', 'pause', 'reset', 'load', 'cycle', 'toggle', 'scrub', 'copy', 'play', 'stop', 'next', 'prev', 'previous', 'back', 'start', 'undo', 'redo', 'clear', 'share', 'speed', 'rate', 'fast', 'slow'
]);

const words = (t: string) => t.toLowerCase().match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];

export interface Lint { errors: string[]; warnings: string[] }

/** Lint one inspected script. `body` is the .svx text (claims must occur in it verbatim, labels are checked against its words). Pure: no wasm. */
export function lintExhibit(id: string, src: string, ins: Inspect, body: string): Lint {
	const errors: string[] = [];
	const warnings: string[] = [];
	const e = (m: string) => errors.push(`exhibit ${id}: ${m}`);
	const w = (m: string) => warnings.push(`exhibit ${id}: ${m}`);
	if ((ins.describe ?? '').trim().length < MIN_DESCRIBE) e(`Describe must be at least ${MIN_DESCRIBE} characters (${(ins.describe ?? '').trim().length})`);
	if (!(ins.alt ?? '').trim()) e('Alt is required');
	if (!(ins.claim ?? '').trim()) e('Claim is required');
	else if (!body.includes(ins.claim.trim())) e(`Claim must occur verbatim in the post: "${ins.claim.trim()}"`);
	for (const t of ins.tones ?? []) if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(t)) e(`tone "${t}" is not a name (tones are palette names, never numbers or hex)`);
	for (const c of ins.components ?? []) if (c === 'Random' || c === 'Clock') e(`uses ${c}: exhibits are deterministic (no Random, no Clock)`);
	for (const m of src.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/\/\/.*$/gm, '').matchAll(/\b(Random|Clock)\b/g)) { e(`script text uses ${m[1]}: exhibits are deterministic (no Random, no Clock)`); break; }
	const controls = ins.controls ?? [];
	if (controls.length === 0) e('needs at least one control (a part with Does)');
	else if (!controls.some((c) => c.does === 'Reset')) e('needs a Reset control (a part with Does: {"reset"})');
	if (ins.frame.w > MAX_FRAME.w || ins.frame.h > MAX_FRAME.h) e(`Extent ${ins.frame.w} x ${ins.frame.h} em exceeds ${MAX_FRAME.w} x ${MAX_FRAME.h}`);
	if (!(ins.frame.w > 0 && ins.frame.h > 0)) e('Extent must be positive');
	const lines = src.split('\n').length - (src.endsWith('\n') ? 1 : 0);
	if (lines > MAX_SCRIPT_LINES) e(`script has ${lines} lines (limit ${MAX_SCRIPT_LINES})`);
	if (ins.items > MAX_ITEMS) e(`${ins.items} draw items (limit ${MAX_ITEMS})`);
	for (const p of ins.parts ?? []) if (Math.min(p.w, p.h) < MIN_PART_EM) w(`part${p.label ? ` "${p.label}"` : ''} is ${p.w} x ${p.h} em, under ${MIN_PART_EM} (hard to hit)`);
	const post = new Set(words(body));
	const labels = [...(ins.parts ?? []).map((p) => p.label), ...controls.map((c) => c.label)];
	const seen = new Set<string>();
	for (const l of labels) {
		if (!l) continue;
		for (const t of words(l)) {
			if (seen.has(t) || /^\d+$/.test(t) || CONTROL_WORDS.has(t) || post.has(t)) continue;
			seen.add(t);
			w(`label word "${t}" does not occur in the post`);
		}
	}
	return { errors, warnings };
}

// ---- the wasm side ----------------------------------------------------------------------------------------------

const WASM = new URL('../../src/lib/gpu/room/world.wasm', import.meta.url);
let cached: Record<string, any> | null | undefined;

/** The committed world.wasm instance, or null when it does not export `exhibit_inspect` yet. */
export function inspector(): Record<string, any> | null {
	if (cached !== undefined) return cached;
	let memory!: WebAssembly.Memory;
	const mod = new WebAssembly.Module(fs.readFileSync(WASM));
	const x = new WebAssembly.Instance(mod, wasiImports(() => memory)).exports as Record<string, any>;
	memory = x.memory;
	cached = typeof x.exhibit_inspect === 'function' && typeof x.exhibit_buf === 'function' ? x : null;
	return cached;
}

export const hasInspect = () => inspector() !== null;

/** Run a script text in a scratch world and return its description. Throws with the script error text on failure. */
export function inspectScript(src: string): Inspect {
	const hit = inspected.get(src);
	if (hit) return hit;
	const x = inspector();
	if (!x) throw new Error('world.wasm has no exhibit_inspect: rebuild it (bun run build:world) before building articles with .flecs exhibits');
	const bytes = new TextEncoder().encode(src);
	const p = x.exhibit_buf(bytes.length);
	new Uint8Array(x.memory.buffer, p, bytes.length).set(bytes);
	const rc = x.exhibit_inspect(bytes.length);
	const out = new TextDecoder().decode(new Uint8Array(x.memory.buffer, x.exhibit_out_ptr(), x.exhibit_out_len()));
	if (rc !== 0) throw new Error(out || `exhibit_inspect failed (${rc})`);
	const ins = JSON.parse(out) as Inspect;
	inspected.set(src, ins);
	return ins;
}
const inspected = new Map<string, Inspect>();

// ---- the article side ---------------------------------------------------------------------------------------------

export const exhibitsDir = (articleDir: string) => path.join(articleDir, 'exhibits');
export const artFile = (articleDir: string) => path.join(exhibitsDir(articleDir), 'art.ts');

/** Ids of exhibits/*.flecs, sorted. */
export function scriptIds(articleDir: string): string[] {
	const d = exhibitsDir(articleDir);
	if (!fs.existsSync(d)) return [];
	return fs.readdirSync(d).filter((f) => f.endsWith('.flecs')).map((f) => f.slice(0, -'.flecs'.length)).sort();
}

/** One namespace: an id in both exhibits/<id>.flecs and exhibits/art.ts is an error. */
export function checkNamespace(where: string, scripts: string[], art: string[]): void {
	const both = scripts.filter((s) => art.includes(s));
	if (both.length) throw new Error(`${where}: exhibit id(s) ${both.map((b) => `"${b}"`).join(', ')} exist both as exhibits/<id>.flecs and in exhibits/art.ts (one namespace)`);
}

/** Inspect and lint every script of an article; throws (fail closed) on any error, logs warnings. */
export function loadScriptExhibits(articleDir: string, body: string, where: string, log: (m: string) => void = () => {}): Map<string, ScriptExhibit> {
	const out = new Map<string, ScriptExhibit>();
	const errors: string[] = [];
	for (const id of scriptIds(articleDir)) {
		const src = fs.readFileSync(path.join(exhibitsDir(articleDir), `${id}.flecs`), 'utf8');
		let ins: Inspect;
		try { ins = inspectScript(src); } catch (e) { errors.push(`exhibit ${id}: ${(e as Error).message}`); continue; }
		const lint = lintExhibit(id, src, ins, body);
		for (const m of lint.warnings) log(`reading: ${where}: warning ${m}`);
		if (lint.errors.length) { errors.push(...lint.errors); continue; }
		out.set(id, {
			id, src, frame: [ins.frame.w, ins.frame.h], title: ins.title ?? '', claim: ins.claim.trim(), caption: ins.caption ?? '',
			describe: ins.describe.trim(), alt: ins.alt.trim()
		});
	}
	if (errors.length) throw new Error(`${where}: exhibit errors:\n    ${errors.join('\n    ')}`);
	return out;
}

// ---- CLI (the dev plugin): bun scripts/magazine/exhibit.ts --check <thoughts/<slug>/exhibits/<id>.flecs>
// prints {"id","frame":[w,h],"src"} on stdout and exits 0, or prints the errors on stderr and exits 1.
if (import.meta.main && process.argv[2] === '--check') {
	const file = path.resolve(process.argv[3]);
	const id = path.basename(file, '.flecs');
	const dir = path.dirname(path.dirname(file));
	try {
		const body = fs.readFileSync(path.join(dir, '+page.svx'), 'utf8');
		const src = fs.readFileSync(file, 'utf8');
		const ins = inspectScript(src);
		const lint = lintExhibit(id, src, ins, body);
		if (lint.errors.length) throw new Error(lint.errors.join('\n'));
		process.stdout.write(JSON.stringify({ id, frame: [ins.frame.w, ins.frame.h], src }));
	} catch (e) {
		process.stderr.write(`${(e as Error).message}\n`);
		process.exit(1);
	}
}
