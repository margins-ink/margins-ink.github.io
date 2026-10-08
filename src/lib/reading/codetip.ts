// Code hover explanations (ix: packages/web/src/lib/syntax-tips.ts). Pure model lookup, no DOM: which token is under the pointer, its soft wash rect,
// and the explanation text. Exact words win (WORDS, ix's wording style: lowercase, short, why the sample needs it); otherwise the token's grammatical
// role supplies the text (ROLES, ix's wording).
// Roles come from the glyph's palette slot (20 + index in SYNTAX_ORDER). The build maps each Shiki hex to the FIRST slot with that hex and ix reuses six colours
// across the twelve slots, so a slot names a colour family, not one role: blue is type/property/built-in, orange is number/marker, code-ink is
// operator/punctuation/variable. `roleOf` splits those families by the token's text; it does not know the grammar.
import { BlockKind, GlyphFlag, type ReadingModel } from '../magazine/format';
import { SYNTAX_ORDER } from './theme';

/** exact words and dotted words (ix's WORDS plus the nix words the samples use) */
export const WORDS: Record<string, string> = {
	// shell (ix)
	ix: 'the cli: `new` boots a machine from an image, `shell` opens a shell in it.',
	mkdir: 'make a directory.',
	cd: 'move into it.',
	git: 'version control. ix works inside a repo; the directory name becomes the machine’s name.',
	'&&': 'run the next command only if the previous one succeeded.',
	curl: 'downloads the installer script.',
	sh: 'runs the downloaded script.',
	// nix
	let: 'opens local bindings: the names defined here are visible until `in`.',
	in: 'ends the bindings. the expression after it is the value of the whole block.',
	inherit: 'shorthand: `inherit schema;` means `schema = schema;`.',
	builtins: 'the functions nix ships with, always in scope.',
	'builtins.readFile': 'reads a file while nix evaluates. if the path is a build output, that build must finish first: this is ifd.',
	'builtins.fromJSON': 'parses json text into nix values: sets, lists, strings.',
	runCommand: 'a derivation that runs a shell script. the script must write its result to `$out`.',
	$out: 'the path the build must write its result to.',
	buildPackage: 'a function from the sample’s own build setup: it takes the parsed schema as input.'
};

/** ix's ROLES, by role name */
export const ROLES: Record<string, string> = {
	keyword: 'keyword: a fixed word of the language. the parser keys on it to know what follows.',
	literal: 'literal constant (true / false / null).',
	string: 'string literal: taken as data, character for character.',
	number: 'number literal.',
	comment: 'comment: a note for the reader; the evaluator skips it.',
	title: 'a name being defined or called.',
	type: 'type or built-in name.',
	built_in: 'built-in provided by the language or library.',
	attribute: 'attribute name: the setting being assigned.',
	property: 'property access: picks one field from the value before the dot.',
	variable: 'a variable: a named value defined elsewhere in the file.',
	operator: 'operator: combines the values around it.',
	punctuation: 'structural punctuation: groups or separates the neighboring tokens.',
	meta: 'meta marker, read by tooling rather than the program.'
};

const SLOT0 = 20;
const slotName = (colour: number): string | null => SYNTAX_ORDER[colour - SLOT0] ?? null;

/** the role text for a token with palette slot `colour` and source text `text` (null = no tip) */
export function roleOf(colour: number, text: string): string | null {
	switch (slotName(colour)) {
		case 'keyword': return ROLES.keyword;
		case 'function': return ROLES.title;
		case 'string': return ROLES.string;
		case 'comment': return ROLES.comment;
		case 'type': case 'constant': case 'property': return /^[A-Z]/.test(text) ? ROLES.type : /^(true|false|null)$/.test(text) ? ROLES.literal : ROLES.property;
		case 'number': case 'attribute': return /^[\d_.xXa-fA-F]+$/.test(text) && /\d/.test(text) ? ROLES.number : ROLES.meta;
		case 'operator': case 'variable':
			return /^[A-Za-z_$]/.test(text) ? ROLES.variable : /^[{}()[\],;:.]+$/.test(text) ? ROLES.punctuation : ROLES.operator;
		default: return null;
	}
}

/** the explanation for a word: the dotted word when the pointer is on its last segment, else the token, else the role */
export function tipText(token: string, dotted: string, colour: number): string | null {
	const w = dotted && token === dotted.slice(dotted.lastIndexOf('.') + 1) ? WORDS[dotted] : undefined;
	return w ?? WORDS[token] ?? roleOf(colour, token);
}

export interface CodeToken {
	/** glyph range [g0, g1] (absolute indices) */
	g0: number; g1: number; line: number; block: number;
	/** document em: left and right edge, baseline (layout y) and font size */
	x0: number; x1: number; base: number; size: number;
	text: string; dotted: string; colour: number;
	/** inline code span (wash only, no tip) */
	inline: boolean;
}

const dec = new TextDecoder();
const isWordCh = (c: string) => /[\w$@.&-]/.test(c);

/** the token under glyph j of line li, or null when j is not code or the pointer (x, em, shift already removed) is in the gap right of the glyph */
export function codeTokenAt(m: ReadingModel, li: number, j: number, x: number): CodeToken | null {
	const L = m.lines[li];
	const g = m.glyphs;
	if (!L || j < 0 || j >= g.length || !(g[j].flags & GlyphFlag.code)) return null;
	const first = L.firstGlyph, last = L.firstGlyph + L.glyphCount - 1;
	if (j < first || j > last) return null;
	// glyph pitch of the line (mono): the smallest step, so a space never widens a token
	let pitch = Infinity;
	for (let k = first; k < last; k++) pitch = Math.min(pitch, g[k + 1].x - g[k].x);
	if (!isFinite(pitch)) pitch = g[j].size * 0.6;
	const inline = m.blocks[L.block]?.kind !== BlockKind.code;
	// inline code sits in proportional text: its cell is the mono advance (0.6 em of the glyph size), never the line's smallest step
	if (inline) pitch = g[j].size * 0.6;
	if (x < g[j].x - 1e-4 || x > g[j].x + pitch + 1e-4) return null;
	const c = g[j].colour;
	// a code token is a run of one colour and one character class (word or not): `.readFile` is the dot, then the word
	const wordCh = (k: number) => /[\w$]/.test(String.fromCharCode(m.text[g[k].charOffset] ?? 0));
	const wj = wordCh(j);
	const same = (k: number) => g[k].colour === c && (g[k].flags & GlyphFlag.code) !== 0 && (inlineSpan || wordCh(k) === wj);
	const inlineSpan = inline;
	let a = j, b = j;
	if (inline) {
		while (a > first && same(a - 1)) a--;
		while (b < last && same(b + 1)) b++;
	} else {
		while (a > first && same(a - 1) && g[a].x - g[a - 1].x < pitch * 1.5) a--;
		while (b < last && same(b + 1) && g[b + 1].x - g[b].x < pitch * 1.5) b++;
	}
	const textOf = (k0: number, k1: number) => {
		const o0 = g[k0].charOffset, o1 = k1 < last ? g[k1 + 1].charOffset : L.textOff + L.textLen;
		return dec.decode(m.text.subarray(o0, Math.max(o0, o1))).trim();
	};
	const text = textOf(a, b);
	// the dotted word around the hovered glyph, from the line text
	let dotted = '';
	if (!inline) {
		const line = dec.decode(m.text.subarray(L.textOff, L.textOff + L.textLen));
		const at = dec.decode(m.text.subarray(L.textOff, Math.max(L.textOff, g[j].charOffset))).length;
		let s = at, e = at;
		while (s > 0 && isWordCh(line[s - 1])) s--;
		while (e < line.length && isWordCh(line[e])) e++;
		dotted = line.slice(s, e).replace(/^\.+|\.+$/g, '');
	}
	return { g0: a, g1: b, line: li, block: L.block, x0: g[a].x, x1: g[b].x + (inline ? g[b].size * 0.6 : pitch), base: g[a].y, size: g[a].size, text, dotted, colour: c, inline };
}

/** tip for a token: none for inline code and for unknown colours */
export const codeTipOf = (t: CodeToken): string | null => (t.inline ? null : tipText(t.text, t.dotted, t.colour));
