// Liang hyphenation (Liang 1983, "Word Hyphenation by Computer") over the Kuiken hyph-en-us patterns.
// Patterns and licence: docs/upstream/magazine/hyph/ (copy-with-notice licence, read).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HYPH_DIR = path.resolve(HERE, '../../docs/upstream/magazine/hyph');

export interface HyphenOptions {
	leftMin?: number; // TeX hyphenmins for en-us: 2 and 3
	rightMin?: number;
	/** words shorter than this are never hyphenated */
	minLength?: number;
}

export class Hyphenator {
	private patterns = new Map<string, Uint8Array>();
	private maxLen = 0;
	private exceptions = new Map<string, number[]>();
	private cache = new Map<string, number[]>();
	leftMin: number;
	rightMin: number;
	minLength: number;

	/** `patterns`: one Liang pattern per line (`.ach4`, `a1b2c`); `exceptions`: `as-so-ciate` per line. */
	constructor(patterns: string, exceptions: string[] = [], opts: HyphenOptions = {}) {
		this.leftMin = opts.leftMin ?? 2;
		this.rightMin = opts.rightMin ?? 3;
		this.minLength = opts.minLength ?? 5;
		for (const raw of patterns.split('\n')) {
			const line = raw.trim();
			if (!line || line.startsWith('%')) continue;
			let letters = '';
			const vals: number[] = [0];
			for (const ch of line) {
				if (ch >= '0' && ch <= '9') vals[vals.length - 1] = +ch;
				else { letters += ch; vals.push(0); }
			}
			this.patterns.set(letters, Uint8Array.from(vals));
			if (letters.length > this.maxLen) this.maxLen = letters.length;
		}
		for (const e of exceptions) this.addException(e);
	}

	/** `ta-ble` adds a fixed hyphenation; a word without hyphens forbids all breaks. Overrides patterns. */
	addException(entry: string) {
		const e = entry.trim().toLowerCase();
		if (!e) return;
		const pos: number[] = [];
		let n = 0;
		for (const ch of e) {
			if (ch === '-') pos.push(n);
			else n++;
		}
		this.exceptions.set(e.replaceAll('-', ''), pos);
		this.cache.clear();
	}

	/**
	 * Break points of `word` as UTF-16 indexes k (a hyphen may follow word.slice(0, k)), ascending.
	 * Only pure ASCII-letter words are hyphenated; anything else returns [].
	 */
	hyphenate(word: string): number[] {
		if (word.length < this.minLength || !/^[A-Za-z]+$/.test(word)) return [];
		const w = word.toLowerCase();
		let hit = this.cache.get(w);
		if (hit) return hit;
		const ex = this.exceptions.get(w);
		if (ex) hit = ex.filter((k) => k >= 1 && k < w.length);
		else {
			const dotted = '.' + w + '.';
			const pts = new Uint8Array(dotted.length + 1);
			for (let i = 0; i < dotted.length; i++) {
				const top = Math.min(dotted.length, i + this.maxLen);
				for (let j = i + 1; j <= top; j++) {
					const p = this.patterns.get(dotted.slice(i, j));
					if (!p) continue;
					for (let k = 0; k < p.length; k++) if (p[k] > pts[i + k]) pts[i + k] = p[k];
				}
			}
			// pts[i] sits before dotted[i]; dotted[i] is w[i - 1]; a break after w[0..k) is pts[k + 1]
			hit = [];
			for (let k = this.leftMin; k <= w.length - this.rightMin; k++) if (pts[k + 1] & 1) hit.push(k);
		}
		this.cache.set(w, hit);
		return hit;
	}
}

let en: Hyphenator | null = null;
/** The en-us hyphenator from docs/upstream (shared instance when no extra exceptions are given). */
export function loadEnUs(extraExceptions: string[] = []): Hyphenator {
	const make = () => {
		const pat = fs.readFileSync(path.join(HYPH_DIR, 'hyph-en-us.pat.txt'), 'utf8');
		const hyp = fs.readFileSync(path.join(HYPH_DIR, 'hyph-en-us.hyp.txt'), 'utf8').split('\n');
		return new Hyphenator(pat, [...hyp, ...extraExceptions]);
	};
	if (extraExceptions.length) return make();
	return (en ??= make());
}
