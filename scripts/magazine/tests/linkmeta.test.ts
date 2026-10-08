import { describe, expect, test } from 'bun:test';
import { bakeLinks, collectLinks, parseHtmlMeta } from '../linkmeta';

describe('linkmeta', () => {
	test('collectLinks finds external and article hrefs, drops fragments and duplicates', () => {
		const src = 'See [a](https://a.example/x#frag) and [b](/thoughts/nix-cycles#top), <a href="https://b.example/">b</a>, [again](https://a.example/x#frag), [local](#sec), <https://c.example/p>.';
		expect(collectLinks(src)).toEqual({ external: ['https://a.example/x#frag', 'https://b.example/', 'https://c.example/p'], articles: ['/thoughts/nix-cycles'] });
	});
	test('parseHtmlMeta prefers og tags, decodes entities, falls back to <title>', () => {
		const html = `<html><head><title> Plain &amp; title </title><meta property="og:title" content="OG &quot;Title&quot;"><meta name="description" content="meta desc"><meta property='og:description' content='og desc'></head></html>`;
		expect(parseHtmlMeta(html)).toEqual({ title: 'OG "Title"', description: 'og desc' });
		expect(parseHtmlMeta('<title>Only\n title</title>')).toEqual({ title: 'Only title', description: '' });
		expect(parseHtmlMeta('<p>nothing</p>')).toEqual({ title: '', description: '' });
	});
	test('bakeLinks keeps successful external fetches and resolves article links from the posts', () => {
		const cache = { 'https://a.example/': { title: 'A', description: 'd', ok: true, fetched: 'x' }, 'https://dead.example/': { title: '', description: '', ok: false, fetched: 'x' } };
		const out = bakeLinks('[a](https://a.example/) [d](https://dead.example/) [n](/thoughts/foo)', cache, new Map([['foo', { title: 'Foo', dek: 'About foo' }]]));
		expect(out).toEqual({ 'https://a.example/': { t: 'A', d: 'd' }, '/thoughts/foo': { t: 'Foo', d: 'About foo' } });
	});
});
