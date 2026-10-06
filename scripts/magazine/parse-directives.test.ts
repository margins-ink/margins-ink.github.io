import { describe, expect, test } from 'bun:test';
import { extractDirectives, parseDistill, bodyOf, DirectiveError } from './parse-directives';
import { gateDistill, bodySha, blockText } from './build';
import { parseArticle } from '../reader/parse';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FM = '---\ntitle: T\n---\n';

describe('directives', () => {
	test('fig and code-wide are extracted line for line', () => {
		const src = `${FM}\nIntro.\n\n::fig{id="eval-timeline" place="wide"}\n\n:::code-wide\n\`\`\`ts\nconst a = 1;\n\`\`\`\n:::\n`;
		const ex = extractDirectives(src, 'f.svx');
		expect(ex.source.split('\n')).toHaveLength(src.split('\n').length);
		expect([...ex.events.values()].map((e) => e.kind)).toEqual(['fig', 'code-wide-open', 'code-wide-close']);
		expect(ex.events.get(7)).toMatchObject({ kind: 'fig', id: 'eval-timeline', place: 'wide' });
	});
	test('plain svx is unchanged', () => {
		const src = `${FM}\nJust text with :: inside and ::: not at line start.\n`;
		expect(extractDirectives(src, 'f').source).toBe(src);
	});
	test('directive-looking lines inside code fences are left alone', () => {
		const src = `${FM}\n\`\`\`\n::spread{layout="x"}\n\`\`\`\n`;
		expect(extractDirectives(src, 'f').events.size).toBe(0);
	});
	test('control: unknown directive, bad place, missing id, unclosed container all fail with file:line', () => {
		expect(() => extractDirectives(`${FM}::spread{layout="essay"}\n`, 'a.svx')).toThrow(/a\.svx:4: unknown directive ::spread/);
		expect(() => extractDirectives(`${FM}::fig{id="x" place="huge"}\n`, 'a.svx')).toThrow(/a\.svx:4.*place/);
		expect(() => extractDirectives(`${FM}::fig{place="wide"}\n`, 'a.svx')).toThrow(/needs id/);
		expect(() => extractDirectives(`${FM}:::code-wide\ntext\n`, 'a.svx')).toThrow(/never closed/);
		expect(() => extractDirectives(`${FM}:::aside\n:::\n`, 'a.svx')).toThrow(DirectiveError);
	});
});

describe('distill block shape', () => {
	const ok = { template: 'duo', headline: 'H', figures: ['a', 'b'], captions: [{ fig: 'a', text: 't' }] };
	test('accepts a valid block, absent is undefined', () => {
		expect(parseDistill(ok, 'f')?.template).toBe('duo');
		expect(parseDistill(undefined, 'f')).toBeUndefined();
	});
	test('control: a 4th caption, 3 figures, or a retired template fail', () => {
		expect(() => parseDistill({ ...ok, captions: [1, 2, 3, 4].map(() => ({ fig: 'a', text: 't' })) }, 'f')).toThrow(/3 captions/);
		expect(() => parseDistill({ ...ok, figures: ['a', 'b', 'c'] }, 'f')).toThrow(/at most 2/);
		expect(() => parseDistill({ ...ok, template: 'opener' }, 'f')).toThrow(/template/);
	});
});

describe('distill review gate (1.7 controls)', () => {
	const body = 'The post body.\n';
	const d = { template: 'duo', headline: 'H', figures: [] } as any;
	test('no block, unreviewed, reviewed', () => {
		expect(gateDistill({ file: 'f', body, distill: undefined })).toBe('none');
		expect(gateDistill({ file: 'f', body, distill: { ...d, review: null } })).toBe('unreviewed');
		expect(gateDistill({ file: 'f', body, distill: { ...d, review: { by: 'a', at: '2026-10-07', post_sha: bodySha(body) } } })).toBe('reviewed');
	});
	test('control: a wrong post_sha fails the build', () => {
		expect(() => gateDistill({ file: 'f.svx', body, distill: { ...d, review: { post_sha: bodySha('older body') } } })).toThrow(/f\.svx: distill review\.post_sha .* does not match/);
	});
	test('bodyOf strips only the frontmatter', () => {
		expect(bodyOf(`${FM}Hello\n`)).toBe('Hello\n');
		expect(bodyOf('No frontmatter\n')).toBe('No frontmatter\n');
	});
});

describe('parseArticle with directives and distill', () => {
	test('fig block, wide code, distill frontmatter, body', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mag-'));
		const sub = path.join(dir, 'demo');
		fs.mkdirSync(sub);
		const f = path.join(sub, '+page.svx');
		fs.writeFileSync(f, `---\ntitle: Demo\ndistill:\n  template: solo\n  headline: Hi\n  figures: [x]\n---\n\nHello world.\n\n::fig{id="x" place="column"}\n\n:::code-wide\n\`\`\`ts\nlet a = 1;\n\`\`\`\n:::\n\n\`\`\`ts\nlet b = 2;\n\`\`\`\n`);
		const p = await parseArticle(f);
		expect(p.distill?.template).toBe('solo');
		expect(p.body.startsWith('\nHello world.')).toBe(true);
		const fig = p.blocks.find((b) => b.t === 'fig');
		expect(fig).toMatchObject({ id: 'x', place: 'column' });
		const codes = p.blocks.filter((b) => b.t === 'code') as any[];
		expect(codes.map((c) => !!c.wide)).toEqual([true, false]);
		expect(blockText(p.blocks)).toContain('Hello world.');
	});
});
