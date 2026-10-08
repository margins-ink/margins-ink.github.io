import { describe, expect, test } from 'bun:test';
import { LinkKind, type ReadingModel } from '../magazine/format';
import { linkTipContent } from './linktip';

const enc = new TextEncoder();
const strs = ['', 'https://ex.example/a', '#why', '/thoughts/foo', '#ref-1'];
const strBytes = enc.encode(strs.join('\0') + '\0');
const off = (i: number) => strs.slice(0, i).reduce((n, s) => n + s.length + 1, 0);
const heading = enc.encode('Why it works'), para = enc.encode('The first line after the heading.');
const text = new Uint8Array([...heading, ...para]);
const m = {
	strings: strBytes, text,
	blocks: [{ textOff: 0, textLen: heading.length }, { textOff: heading.length, textLen: para.length }],
	anchors: [{ idOffset: off(2) + 1, block: 0, y: 0 }],
	links: [
		{ kind: LinkKind.url, offset: off(1) }, { kind: LinkKind.anchor, offset: off(2) }, { kind: LinkKind.article, offset: off(3) }, { kind: LinkKind.ref, offset: off(4) }
	]
} as unknown as ReadingModel;
const baked = { 'https://ex.example/a': { t: 'Example', d: 'About example' }, '/thoughts/foo': { t: 'Foo', d: 'Dek of foo' } };

describe('linkTipContent', () => {
	test('external: baked meta and the url host; failed lookup: host and url only', () => {
		expect(linkTipContent(m, baked, 0, 'site.test')).toEqual({ host: 'ex.example', url: 'https://ex.example/a', title: 'Example', description: 'About example' });
		expect(linkTipContent(m, {}, 0, 'site.test')).toEqual({ host: 'ex.example', url: 'https://ex.example/a', title: '', description: '' });
	});
	test('anchor: the target heading and the first text after it', () => {
		expect(linkTipContent(m, baked, 1, 'site.test')).toEqual({ host: 'On this page', url: '#why', title: 'Why it works', description: 'The first line after the heading.' });
	});
	test('article: its title and dek under the site host; citations have their own popover', () => {
		expect(linkTipContent(m, baked, 2, 'site.test')).toEqual({ host: 'site.test', url: '/thoughts/foo', title: 'Foo', description: 'Dek of foo' });
		expect(linkTipContent(m, baked, 3, 'site.test')).toBeNull();
	});
});
