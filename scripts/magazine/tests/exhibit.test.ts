// Exhibits (docs/MUSEUM.md): the lint over an inspected script (pure, one fixture per rule, each failing exactly one), the directive and
// namespace rules, and the build of a timeline exhibit into an RDR4 record. The wasm-dependent tests skip when the committed world.wasm has no exhibit_inspect.
import { describe, expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as dsl from '../../../src/lib/magazine/dsl';
import { BlockKind, ExhibitKind, TIMELINE_STRIP, unpackReading } from '../../../src/lib/magazine/format';
import { buildMagazine } from '../build';
import { hasInspect, inspectScript, lintExhibit, type Inspect } from '../exhibit';
import { extractDirectives } from '../parse-directives';

mock.module('$lib/magazine/dsl', () => dsl); // the SvelteKit alias does not exist under bun test

const ROOT = path.resolve(import.meta.dir, '../../..');
const MODELS = `${ROOT}/src/routes/(site)/thoughts/models`;

const CLAIM = 'A table of rules, a tape and a head compute.';
const BODY = `Intro. ${CLAIM} A tape, a head and a table of rules decide each step of the machine.`;
const SRC = 'exhibit turing {\n  Title: {"t"}\n}\n';
const good = (): Inspect => ({
	title: 'Turing', claim: CLAIM, caption: '', frame: { w: 36, h: 21 }, items: 120,
	describe: 'A tape of cells, a head on one cell in one state, and a rule table that picks each step.',
	alt: 'A row of tape cells with a head marker below one of them.',
	controls: [{ label: 'Step', does: 'Step' }, { label: 'Reset', does: 'Reset' }],
	parts: [{ w: 3, h: 3, label: 'tape' }, { w: 3, h: 2, label: 'rules' }],
	tones: ['accent', 'ink', 'muted'], components: ['Title', 'Claim', 'Extent']
});
const lint = (over: Partial<Inspect>, src = SRC, body = BODY) => lintExhibit('turing', src, { ...good(), ...over }, body);

describe('exhibit lint (one rule per fixture)', () => {
	test('control: the good fixture is clean', () => {
		expect(lint({})).toEqual({ errors: [], warnings: [] });
	});
	const bad: [string, Partial<Inspect>, RegExp, string?][] = [
		['Describe under 40 chars', { describe: 'too short' }, /Describe/],
		['Alt missing', { alt: '' }, /Alt is required/],
		['Claim not in the post', { claim: 'A sentence the post never says.' }, /Claim must occur verbatim/],
		['a tone that is a hex number', { tones: ['accent', '#ff0000'] }, /tone "#ff0000"/],
		['uses Random', { components: ['Title', 'Random'] }, /Random/],
		['no Reset control', { controls: [{ label: 'Step', does: 'Step' }] }, /Reset control/],
		['no control at all', { controls: [] }, /at least one control/],
		['frame too wide', { frame: { w: 40, h: 21 } }, /exceeds 36 x 22/],
		['frame too tall', { frame: { w: 36, h: 23 } }, /exceeds 36 x 22/],
		['more than 400 items', { items: 401 }, /draw items/]
	];
	for (const [name, over, re] of bad) {
		test(`fails: ${name}`, () => {
			const r = lint(over);
			expect(r.errors).toHaveLength(1);
			expect(r.errors[0]).toMatch(re);
			expect(r.warnings).toEqual([]);
		});
	}
	test('fails: script over 250 lines', () => {
		const r = lint({}, 'exhibit turing {\n}\n'.repeat(1) + '// pad\n'.repeat(250));
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatch(/251 lines|lines \(limit 250\)/);
	});
	test('fails: Clock in the script text, even when the inspect does not list it', () => {
		const r = lint({}, 'exhibit turing {\n  Clock: {0}\n}\n');
		expect(r.errors).toHaveLength(1);
		expect(r.errors[0]).toMatch(/Clock/);
	});
	test('Clock in a comment is not a use', () => {
		expect(lint({}, '// no Clock here\nexhibit turing {}\n').errors).toEqual([]);
	});
	test('warns (not errors): a part under 1.6 em', () => {
		const r = lint({ parts: [{ w: 1, h: 3, label: 'tape' }] });
		expect(r.errors).toEqual([]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toMatch(/1\.6/);
	});
	test('warns: a label word that is not in the post, but control words and numbers are allowed', () => {
		const r = lint({ parts: [{ w: 3, h: 3, label: 'zebra 42 Step Play' }] });
		expect(r.errors).toEqual([]);
		expect(r.warnings).toHaveLength(1);
		expect(r.warnings[0]).toMatch(/"zebra"/);
	});
});

describe('directive and namespace rules', () => {
	test('::exhibit parses; ::fig is gone', () => {
		const ok = extractDirectives('a\n\n::exhibit{id="turing" place="wide"}\n\nb\n', 'x.svx');
		expect([...ok.events.values()][0]).toMatchObject({ kind: 'exhibit', id: 'turing', place: 'wide' });
		expect(() => extractDirectives('::fig{id="x" place="wide"}\n', 'x.svx')).toThrow(/unknown directive ::fig/);
		expect(() => extractDirectives('::exhibit{place="wide"}\n', 'x.svx')).toThrow(/needs id/);
	});
});

// ---- build: a temp thoughts dir with the models post and its art ------------------------------------------------------

function tmpThoughts(post: string, extra: Record<string, string> = {}) {
	const root = fs.mkdtempSync(path.join(process.env.TMPDIR_MAGAZINE ?? '/Volumes/Projects/tmp', 'exhibit-test-'));
	const dir = path.join(root, 'thoughts', 'models');
	fs.mkdirSync(path.join(dir, 'exhibits'), { recursive: true });
	fs.writeFileSync(path.join(dir, '+page.svx'), post);
	const art = fs.readFileSync(`${MODELS}/exhibits/art.ts`, 'utf8').replaceAll('$lib/', `${ROOT}/src/lib/`); // the alias only exists under vite and the repo tsconfig
	fs.writeFileSync(path.join(dir, 'exhibits/art.ts'), art);
	for (const f of fs.readdirSync(`${MODELS}/exhibits`).filter((n) => n.endsWith('.flecs'))) fs.copyFileSync(`${MODELS}/exhibits/${f}`, path.join(dir, 'exhibits', f)); // the post also places its script exhibits
	for (const [f, t] of Object.entries(extra)) fs.writeFileSync(path.join(dir, f), t);
	return { root, thoughts: path.join(root, 'thoughts'), out: path.join(root, 'out') };
}
const POST = fs.readFileSync(`${MODELS}/+page.svx`, 'utf8');
const run = async (t: ReturnType<typeof tmpThoughts>) => buildMagazine({ thoughts: t.thoughts, outDir: t.out, quiet: true, force: true });
const rm = (t: ReturnType<typeof tmpThoughts>) => fs.rmSync(t.root, { recursive: true, force: true });

describe('exhibit build', () => {
	test('a timeline exhibit is an RDR4 exhibit block with the control strip below the art', async () => {
		const t = tmpThoughts(POST);
		try {
			const r = await run(t);
			expect(r.index.magic).toBe('RDR4');
			expect(r.index.version).toBe(4);
			const a = r.index.articles.find((x: any) => x.slug === 'models');
			const m = unpackReading(new Uint8Array(fs.readFileSync(path.join(t.out, a.bins.wide.file))));
			expect(m.exhibits).toHaveLength(4); // two-machines (timeline), then turing, lambda and merkle (scripts)
			const ex = m.exhibits[0];
			const blk = m.blocks[ex.block];
			expect(blk.kind).toBe(BlockKind.exhibit);
			expect(blk.ex).toBe(0);
			expect(ex.kind).toBe(ExhibitKind.timeline);
			expect(ex.frameH).toBeCloseTo(ex.y1 / ex.scale - ex.y0 / ex.scale, 3);
			// art h = frameH - strip; the block is (art h + strip) * scale tall, rounded up to the grid
			const artH = ex.frameH - TIMELINE_STRIP;
			expect(artH).toBeGreaterThan(0);
			expect(blk.y1 - blk.y0).toBeGreaterThanOrEqual(ex.frameH * ex.scale - 1e-3);
			expect(ex.src).toBe(0);
			expect(ex.gridCols).toBeGreaterThan(0);
		} finally { rm(t); }
	}, 120_000);

	test('fails closed: unknown id, duplicate directive, id in both namespaces', async () => {
		const unknown = tmpThoughts(POST.replace('id="two-machines"', 'id="nope"'));
		const dup = tmpThoughts(POST.replace('::exhibit{id="two-machines" place="wide"}', '::exhibit{id="two-machines" place="wide"}\n\n::exhibit{id="two-machines" place="column"}'));
		const both = tmpThoughts(POST, { 'exhibits/two-machines.flecs': 'exhibit x {}\n' });
		try {
			await expect(run(unknown)).rejects.toThrow(/neither exhibits\/nope\.flecs nor an entry of exhibits\/art\.ts/);
			await expect(run(dup)).rejects.toThrow(/two ::exhibit directives for "two-machines"/);
			await expect(run(both)).rejects.toThrow(/both as exhibits\/<id>\.flecs and in exhibits\/art\.ts/);
		} finally { rm(unknown); rm(dup); rm(both); }
	}, 240_000);
});

describe('exhibit_inspect (the committed world.wasm and models/exhibits/turing.flecs)', () => {
	const file = `${MODELS}/exhibits/turing.flecs`;
	test('the wasm exports exhibit_inspect (rebuild: bun run build:world)', () => {
		expect(hasInspect()).toBe(true);
	});
	test('the Turing script is described as JSON that lints clean against the post', () => {
		const src = fs.readFileSync(file, 'utf8');
		const ins = inspectScript(src);
		expect(ins.frame.w).toBeGreaterThan(0);
		expect(ins.items).toBeGreaterThan(0);
		expect(ins.items).toBeLessThanOrEqual(400);
		expect(ins.controls.some((c) => c.does === 'Reset')).toBe(true);
		expect(ins.components).toContain('Extent');
		expect(ins.components).not.toContain('Random');
		expect(lintExhibit('turing', src, ins, POST).errors).toEqual([]);
	});
	test('control: a script that does not parse is an error with text', () => {
		expect(() => inspectScript('this is not { flecs')).toThrow();
	});
});
