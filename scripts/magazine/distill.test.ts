import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import {
	checkDistill, countWords, lintDistill, normalise, parseDistill, parsePost, postSha, reviewGate, DistillError, type DistillBlock
} from './distill';

const IFD = path.resolve(import.meta.dir, '../../src/routes/(site)/thoughts/ifd/+page.svx');
const ifdSource = () => fs.readFileSync(IFD, 'utf8');

const BODY = `
# Title here

Import From Derivation: the evaluator [stops](https://x.y)<Cite id="a" /> and \`waits\`
for the build.

## A section

**Bold** claim with *emphasis*. A thunk nobody forces is a derivation nobody builds.
`;
const post = (extra = '') => parsePost(`---\ntitle: "Title here"\ndek: "A dek sentence."\n${extra}---\n${BODY}`);

// A block of >= 100 words, all verbatim from a generated post.
const filler = Array.from({ length: 120 }, (_, i) => `w${i}`).join(' ');
const bigPost = () => parsePost(`---\ntitle: "T"\n---\n\n# H\n\n${filler}\n\n## Sec\n\nok.\n`);
const goodBlock = (): DistillBlock => ({
	headline: 'T', figures: ['a'], quote: { text: 'w1 w2 w3', from: 'Sec' },
	captions: [{ fig: 'a', text: filler.split(' ').slice(0, 110).join(' ') }], synth: []
});

describe('post text extraction', () => {
	test('strips markdown, links, inline html, keeps code and headings', () => {
		const p = post();
		expect(p.corpus).toContain('the evaluator stops and waits for the build.');
		expect(p.corpus).toContain('Bold claim with emphasis.');
		expect(p.corpus).not.toContain('Cite');
		expect(p.corpus).not.toContain('https');
		expect(p.headings).toEqual(['Title here', 'A section']);
		expect(p.corpus).toContain('A dek sentence.');
	});
	test('normalise folds whitespace', () => {
		expect(normalise('  a \n\t b c ')).toBe('a b c');
		expect(countWords(' a  b\nc ')).toBe(3);
		expect(countWords('')).toBe(0);
	});
	test('sha depends on the body, not the frontmatter', () => {
		expect(post('').sha).toBe(post('extra: 1\n').sha);
		expect(postSha('a')).not.toBe(postSha('a '));
	});
});

describe('parseDistill', () => {
	test('absent block is null', () => expect(parseDistill({})).toBeNull());
	test('unknown key, bad template, missing headline fail closed', () => {
		expect(() => parseDistill({ distill: { headline: 'x', bogus: 1 } })).toThrow(DistillError);
		expect(() => parseDistill({ distill: { template: 'duo', headline: 'x' } })).toThrow(/unknown key/);
		expect(() => parseDistill({ distill: {} })).toThrow(/headline: required/);
		expect(() => parseDistill({ distill: { headline: 'x', captions: [{ fig: 'a', text: 't', z: 1 }] } })).toThrow(/unknown key/);
	});
	test('empty review mapping means unreviewed', () => {
		const b = parseDistill({ distill: { headline: 'x', review: {} } });
		expect(b?.review).toBeUndefined();
	});
	test('review date from YAML Date', () => {
		const b = parseDistill({ distill: { headline: 'x', review: { by: 'a', at: new Date('2026-10-07'), post_sha: 'abc' } } });
		expect(b?.review?.at).toBe('2026-10-07');
	});
});

describe('lint: planted-bug controls (MAGAZINE.md 1.7 step 4)', () => {
	test('baseline block passes', () => {
		const r = lintDistill(goodBlock(), bigPost());
		expect(r.errors).toEqual([]);
		expect(r.ok).toBe(true);
	});
	test('CONTROL 1: a planted caption that is not in the post fails the substring check', () => {
		const b = goodBlock();
		b.captions.push({ fig: 'a', text: 'Snix is forty-five percent faster.' });
		const r = lintDistill(b, bigPost());
		expect(r.ok).toBe(false);
		expect(r.errors.map((e) => e.path)).toEqual(['captions[1]']);
		expect(r.errors[0].message).toContain('verbatim');
		// the same string passes when declared synthesised
		b.synth = ['captions.1'];
		expect(lintDistill(b, bigPost()).ok).toBe(true);
	});
	test('CONTROL 2: a wrong post_sha fails the gate (preview and production)', () => {
		const p = bigPost();
		const b = { ...goodBlock(), review: { by: 'a', at: '2026-10-07', post_sha: '0'.repeat(64) } };
		for (const mode of ['preview', 'production'] as const) {
			const g = reviewGate(b, p, mode);
			expect(g.length).toBe(1);
			expect(g[0].message).toContain('stale');
		}
		// the right sha passes
		expect(reviewGate({ ...b, review: { ...b.review, post_sha: p.sha } }, p, 'production')).toEqual([]);
	});
	test('CONTROL 3: a 4th caption fails', () => {
		const b = goodBlock();
		for (let i = 0; i < 3; i++) b.captions.push({ fig: 'a', text: 'w1 w2' });
		expect(b.captions.length).toBe(4);
		const r = lintDistill(b, bigPost());
		expect(r.errors.some((e) => e.path === 'captions' && /at most 3/.test(e.message))).toBe(true);
	});
	test('control sanity: a near-miss (one word changed) is caught, whitespace differences are not', () => {
		const b = goodBlock();
		b.quote = { text: 'w1   w2\nw3', from: 'Sec' };
		expect(lintDistill(b, bigPost()).ok).toBe(true);
		b.quote = { text: 'w1 w2 w4', from: 'Sec' };
		expect(lintDistill(b, bigPost()).errors.map((e) => e.path)).toEqual(['quote.text']);
	});
});

describe('lint: other rules', () => {
	test('word count bounds: error below 100 and above 250, warning below 150', () => {
		const p = bigPost();
		const words = (n: number): DistillBlock => ({ ...goodBlock(), captions: [{ fig: 'a', text: filler.split(' ').slice(0, n).join(' ') }] });
		// headline 1 + quote 3 + caption n
		expect(lintDistill(words(50), p).errors.map((e) => e.path)).toEqual(['words']);
		const mid = lintDistill(words(110), p);
		expect(mid.ok && mid.warnings.length === 1 && mid.words === 114).toBe(true);
		const hi = lintDistill(words(110), p, { figureLabels: { a: [Array.from({ length: 40 }, () => 'l').join(' ')] } }); // 154 words
		expect(hi.ok && hi.warnings.length === 0).toBe(true);
		// 120-word filler caps the caption at 120; add labels to cross 250
		const labels = { a: [Array.from({ length: 140 }, () => 'l').join(' ')] };
		expect(lintDistill({ ...words(120) }, p, { figureLabels: labels }).errors.some((e) => /maximum 250/.test(e.message))).toBe(true);
	});
	test('figure labels count toward the budget', () => {
		const p = bigPost();
		const b: DistillBlock = { ...goodBlock(), captions: [{ fig: 'a', text: filler.split(' ').slice(0, 90).join(' ') }] };
		expect(lintDistill(b, p).ok).toBe(false);
		expect(lintDistill(b, p, { figureLabels: { a: ['CppNix', 'Snix eval build stops waits resumes'] } }).ok).toBe(true);
	});
	test('figure count, ids, caption fig reference, quote.from heading', () => {
		const p = bigPost();
		const b = goodBlock();
		expect(lintDistill({ ...b, figures: ['a', 'b', 'c'] }, p).errors.some((e) => e.path === 'figures')).toBe(true);
		expect(lintDistill({ ...b, figures: [] }, p).errors.some((e) => e.path === 'figures')).toBe(true);
		expect(lintDistill(b, p, { figureIds: ['z'] }).errors.some((e) => /exhibit/.test(e.message))).toBe(true);
		expect(lintDistill({ ...b, captions: [{ ...b.captions[0], fig: 'q' }] }, p).errors.some((e) => e.path === 'captions[0].fig')).toBe(true);
		expect(lintDistill({ ...b, quote: { text: 'w1 w2', from: 'Nope' } }, p).errors.some((e) => e.path === 'quote.from')).toBe(true);
	});
	test('synth naming a missing slot is an error (typo cannot silently exempt)', () => {
		expect(lintDistill({ ...goodBlock(), synth: ['headlin'] }, bigPost()).errors.some((e) => e.path === 'synth')).toBe(true);
	});
});

describe('review gate', () => {
	test('unreviewed: fine in preview, refused in production', () => {
		const p = bigPost();
		expect(reviewGate(goodBlock(), p, 'preview')).toEqual([]);
		expect(reviewGate(goodBlock(), p, 'production')[0].path).toBe('review');
	});
	test('a post edit invalidates a review', () => {
		const src = `---\ntitle: "T"\ndistill:\n  headline: T\n  figures: [a]\n  review: { by: a, at: 2026-10-07, post_sha: SHA }\n---\n\n# H\n\nbody\n`;
		const sha = parsePost(src).sha;
		const ok = checkDistill(src.replace('SHA', sha), 'x', 'production');
		expect(ok.gate).toEqual([]);
		const edited = checkDistill(src.replace('SHA', sha).replace('body', 'body changed'), 'x', 'production');
		expect(edited.gate.length).toBe(1);
		expect(edited.ok).toBe(false);
	});
});

describe('the real ifd post', () => {
	test('block parses, every string is verbatim, counts hold', () => {
		const r = checkDistill(ifdSource(), IFD, 'preview');
		expect(r.errors).toEqual([]);
		// 115 words without diagram labels (the doc hand-counted 116): warn below 150, pass above 100
		expect(r.words).toBe(115);
		expect(r.warnings.map((w) => w.path)).toEqual(['words']);
	});
	test('production refuses it until Andrew reviews', () => {
		const r = checkDistill(ifdSource(), IFD, 'production');
		expect(r.ok).toBe(false);
		expect(r.errors.map((e) => e.path)).toEqual(['review']);
	});
	test('planted bug on the real post: altering one caption word fails', () => {
		const bad = ifdSource().replace('waits for the build, resumes.', 'waits for the build, resumes quickly.');
		expect(bad).not.toBe(ifdSource());
		// the replace also hits the post body copy of that sentence; plant in the frontmatter only
		const [head, ...rest] = ifdSource().split('\n---\n');
		const planted = [head.replace('calls out to the daemon', 'calls out to the scheduler'), ...rest].join('\n---\n');
		const r = checkDistill(planted, IFD, 'preview');
		expect(r.errors.map((e) => e.path)).toEqual(['captions[0]']);
	});
	test('review pins the body: adding the block does not change post_sha', () => {
		const body = ifdSource().split('\n---\n').slice(1).join('\n---\n');
		expect(parsePost(ifdSource()).body.trim()).toBe(body.trim());
	});
});
