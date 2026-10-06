// Guard: every registered post (thoughts/<slug>/+page.svx) has a built article in static/magazine, and the index is not stale.
// Run after `bun scripts/magazine/build.ts`; a failure here is what the reader would show as "magazine: unknown article <slug>".
import { expect, test } from 'bun:test';
import fs from 'node:fs';
import { inputsHash } from './build';
import { shelfProblems } from './vite-plugin';

test('every registered post has a built article', () => {
	expect(shelfProblems()).toEqual([]);
});
test('static/magazine/index.json matches the sources', () => {
	expect(JSON.parse(fs.readFileSync('static/magazine/index.json', 'utf8')).stamp).toBe(inputsHash());
});
