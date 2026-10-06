// Theme tests (src/lib/reading/theme.ts): WCAG contrast of every token on its real ground (one theme for every article), the generated Shiki theme,
// the `::` ligature rule and the heading face. A planted-bug control swaps the old github-dark (light-theme) syntax values back in and must fail.
import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { codeToTokens, type BundledLanguage } from 'shiki';
import { F, FONT_SPECS, FontSet, ROOT } from '../reader/fonts';
import { readerTheme } from '../reader/shiki-theme';
import { buildPalette, PAL_SYNTAX_START } from './palette';
import {
	CONTRAST, ELEVATION, GROUND, SYNTAX, SYNTAX_ORDER, TEXT, contrast, deltaE, fromHex, fromRgb, THEME, toHex, type Rgb, type SyntaxName, type Theme
} from '../../src/lib/reading/theme';
import { quantiseSyntax } from './build';

/** Syntax colours must read on the code panel; comments are the floor (4.5:1) and no other syntax colour may be weaker. Returns the failures. */
function syntaxFailures(colours: Record<string, Rgb>, panel: Rgb, min = CONTRAST.text): string[] {
	return Object.entries(colours).filter(([, c]) => contrast(c, panel) < min).map(([k, c]) => `${k} ${toHex(c)} ${contrast(c, panel).toFixed(2)}:1 < ${min}`);
}

/** The values the reader shipped with before: github-light colours (github-dark in name, light-theme values in the render, docs/READING_GPU.md) on the dark panel. */
const OLD_GITHUB: Record<string, string> = {
	keyword: '#d73a49', function: '#6f42c1', constant: '#005cc5', string: '#032f62', comment: '#6a737d', variable: '#24292e', type: '#e36209', property: '#005cc5', punctuation: '#24292e'
};
const old = Object.fromEntries(Object.entries(OLD_GITHUB).map(([k, v]) => [k, fromHex(v)])) as Record<string, Rgb>;

const tolerance = (v: number) => Math.round(v * 100) / 100;

describe('token table', () => {
	test('ground is a deep tinted near-black, not #000, and elevations climb', () => {
		{
			const h = 'the theme';
			const t = THEME;
			const L = (c: Rgb) => fromRgb(c)[0];
			expect(toHex(t.surface.ground)).not.toBe('#000000');
			expect(L(t.surface.ground)).toBeGreaterThan(0.13);
			expect(L(t.surface.ground)).toBeLessThan(0.17);
			expect(L(t.surface.code)).toBeGreaterThan(L(t.surface.ground) + 0.03);
			expect(L(t.surface.card)).toBeGreaterThan(L(t.surface.code) + 0.02);
			expect(L(t.surface.popover)).toBeGreaterThan(L(t.surface.card) + 0.02);
			expect(fromRgb(t.surface.ground)[1]).toBeGreaterThan(0.008); // tinted, not grey
		}
		expect(ELEVATION.code.L).toBeCloseTo(0.2, 2);
			});

	test('text ramp: primary 9:1 on the ground, all three >= 4.5:1 on ground (lightest stop) and on all three elevations', () => {
		{
			const h = 'the theme';
			const t = THEME;
			const grounds: [string, Rgb][] = [['ground', t.surface.ground], ['code', t.surface.code], ['card', t.surface.card], ['popover', t.surface.popover]];
			for (const [gn, g] of grounds) for (const k of Object.keys(TEXT) as (keyof typeof TEXT)[]) {
				const r = contrast(t.text[k], g);
				if (r < CONTRAST.text) throw new Error(`hue ${h}: ${k} on ${gn} ${r.toFixed(2)}:1 < ${CONTRAST.text}`);
			}
			expect(contrast(t.text.primary, t.surface.ground)).toBeGreaterThanOrEqual(CONTRAST.body);
			expect(contrast(t.text.primary, t.surface.popover)).toBeGreaterThanOrEqual(CONTRAST.body);
			// large text (headings) needs only 3:1, and uses primary: covered above with margin
			expect(contrast(t.text.primary, t.surface.popover)).toBeGreaterThanOrEqual(CONTRAST.large);
		}
	});

	test('accent as text on the ground and the elevations; accent2 and accent as graphics; ink on accent fill; hairlines are visible but faint', () => {
		{
			const h = 'the theme';
			const t = THEME;
			for (const [gn, g] of [['ground', t.surface.ground], ['code', t.surface.code], ['card', t.surface.card], ['popover', t.surface.popover]] as [string, Rgb][]) {
				const a = contrast(t.accent, g);
				if (a < CONTRAST.text) throw new Error(`hue ${h}: accent text on ${gn} ${a.toFixed(2)}:1`);
				const a2 = contrast(t.accent2, g);
				if (a2 < CONTRAST.graphic) throw new Error(`hue ${h}: accent2 on ${gn} ${a2.toFixed(2)}:1`);
			}
			expect(contrast(t.accentInk, t.accent)).toBeGreaterThanOrEqual(CONTRAST.text);
			for (const k of Object.keys(t.surface) as (keyof typeof t.surface)[]) {
				const r = contrast(t.hairline[k], t.surface[k]);
				expect(r).toBeGreaterThan(1.3);
				expect(r).toBeLessThan(2.1);
			}
		}
	});

	test('syntax: twelve slots, every colour >= 4.5:1 on the code panel comments readable but quietest chroma, balanced chroma, no pure red or blue', () => {
		expect(SYNTAX_ORDER.length).toBe(32 - PAL_SYNTAX_START);
		{
			const h = 'the theme';
			const t = THEME;
			const fails = syntaxFailures(t.syntax, t.surface.code);
			if (fails.length) throw new Error(`hue ${h}: ${fails.join('; ')}`);
			// the comment slot is the dimmest syntax colour but still clears the floor with margin
			const cm = contrast(t.syntax.comment, t.surface.code);
			expect(cm).toBeGreaterThanOrEqual(4.5);
			for (const k of SYNTAX_ORDER) if (k !== 'comment' && k !== 'punctuation') expect(contrast(t.syntax[k], t.surface.code)).toBeGreaterThan(cm);
			// syntax also reads on a card and a popover (inline code in a callout) at the 4.5 floor
			expect(syntaxFailures(t.syntax, t.surface.card)).toEqual([]);
		}
		for (const k of SYNTAX_ORDER) {
			const [, C, hue] = SYNTAX[k];
			expect(C).toBeLessThanOrEqual(0.13);
			expect(hue < 5 || hue > 355 ? 'red' : hue > 255 && hue < 270 && C > 0.2 ? 'blue' : 'ok').toBe('ok'); // nothing at the saturated primaries
		}
	});

	test('syntax families are distinct: pairwise OKLab distance >= 0.04 between every two slots', () => {
		const t = THEME;
		const worst: [number, string][] = [];
		for (let i = 0; i < SYNTAX_ORDER.length; i++) for (let j = i + 1; j < SYNTAX_ORDER.length; j++) {
			const a = SYNTAX_ORDER[i], b = SYNTAX_ORDER[j];
			worst.push([deltaE(t.syntax[a], t.syntax[b]), `${a}/${b}`]);
		}
		worst.sort((x, y) => x[0] - y[0]);
		const bad = worst.filter(([d]) => d < 0.04);
		expect(bad.map(([d, n]) => `${n} ${tolerance(d)}`)).toEqual([]);
	});

	test('the built palette carries exactly the theme hex in the syntax slots', () => {
		const pal = buildPalette();
		const t = THEME;
		SYNTAX_ORDER.forEach((k, i) => {
			const w = pal[PAL_SYNTAX_START + i];
			const hex = '#' + [w & 255, (w >> 8) & 255, (w >> 16) & 255].map((v) => v.toString(16).padStart(2, '0')).join('');
			expect(hex).toBe(toHex(t.syntax[k]));
		});
	});

	test('planted-bug control: the old github-dark (light-theme) syntax values fail the same check', () => {
		const t = THEME;
		expect(syntaxFailures(t.syntax, t.surface.code)).toEqual([]);
		const fails = syntaxFailures(old, t.surface.code);
		expect(fails.length).toBeGreaterThanOrEqual(5);
		expect(fails.some((f) => f.startsWith('comment'))).toBe(true); // the nearly invisible comments of the complaint
		expect(fails.some((f) => f.startsWith('function'))).toBe(true); // dark violet identifiers
		// and on pure black the comment is the documented 4:1 ish value, the identifiers well below
		expect(contrast(old.function, [0, 0, 0])).toBeLessThan(CONTRAST.text);
	});
});

describe('shiki theme', () => {
	const hexes = new Set(Object.values(THEME.syntax).map(toHex));
	const rust = `#[entry]
fn main() -> ! {
    // Enable the GPIO clock
    let peripherals = stm32h7x3::Peripherals::take().unwrap();
    let pwr = &peripherals.PWR;
    let x: &'a str = "hi";
    println!("{}", 8_000_000);
    rcc.ahb4enr.modify(|_, w| w.gpioden().set_bit());
    loop { asm::delay(8_000_000); }
}`;
	const sample: [string, string][] = [
		['rust', rust],
		['typescript', 'import { a } from "x";\nconst n: number = 42; // c\nexport async function f<T>(x: T): Promise<T> { return x; }\nclass A extends B { prop = true; }'],
		['json', '{ "key": [1, 2.5, null, true], "s": "v" }'],
		['bash', 'echo "$HOME" | grep -v foo > /dev/null # comment\nif [ -f x ]; then ls -la; fi'],
		['svelte', '<script lang="ts">let n = $state(0);</script>\n<button onclick={() => n++}>{n}</button>\n<style>a { color: red; }</style>'],
		['nix', '{ pkgs, ... }: { x = pkgs.hello; y = "s"; z = 1; }'],
		['diff', '@@ -1 +1 @@\n-old\n+new'],
		['toml', '[package]\nname = "x"\nversion = "1.0"']
	];
	const tokenise = (lang: string, code: string) => codeToTokens(code, { lang: lang as BundledLanguage, themes: { dark: readerTheme() }, defaultColor: false }).then((r) => r.tokens);

	test('every emitted colour is one of the twelve theme colours and reads on the panel', async () => {
		for (const [lang, code] of sample) {
			const seen = new Set<string>();
			for (const line of await tokenise(lang, code)) for (const tk of line) seen.add(String((tk.htmlStyle as Record<string, string> | undefined)?.['--shiki-dark'] ?? '').toLowerCase());
			seen.delete('');
			for (const c of seen) expect(hexes.has(c)).toBe(true);
			expect(seen.size).toBeGreaterThanOrEqual(lang === 'diff' || lang === 'toml' ? 2 : 3);
		}
		expect(syntaxFailures(Object.fromEntries([...hexes].map((x) => [x, fromHex(x)])), THEME.surface.code)).toEqual([]);
	});

	test('Rust maps to the intended slots: keywords, functions, types, lifetimes, macros, attributes, comments, strings, numbers', async () => {
		const hex = THEME.syntax;
		const slot = (c: string) => SYNTAX_ORDER.find((k) => toHex(hex[k]) === c.toLowerCase());
		const lines = await tokenise('rust', rust);
		const by = new Map<string, SyntaxName | undefined>();
		for (const line of lines) for (const tk of line) by.set(tk.content.trim(), slot(String((tk.htmlStyle as Record<string, string>)['--shiki-dark'])));
		const want: [string, SyntaxName][] = [
			['fn', 'keyword'], ['let', 'keyword'], ['loop', 'keyword'], ['// Enable the GPIO clock', 'comment'], ['"', 'string'], ['8_000_000', 'number'],
			['Peripherals', 'type'], ['main', 'function'], ['unwrap', 'function'], ['println!', 'attribute'], ['entry', 'attribute'], ['PWR', 'constant']
		];
		const got = want.map(([t]) => [t, by.get(t)]);
		expect(got.filter(([, g], i) => g !== want[i][1]).map(([t, g]) => `${t}=${g}`)).toEqual([]);
		// the lifetime token ('a) is in the attribute family (pink), distinct from keywords
		const lt = [...by.entries()].find(([k]) => k.includes("'a"));
		expect(lt?.[1] ?? 'attribute').toBe('attribute');
	});

	test('quantiseSyntax maps each theme hex to its own slot', () => {
		const pairs = new Map(SYNTAX_ORDER.map((k) => [toHex(THEME.syntax[k]), 3]));
		const { idx } = quantiseSyntax(pairs);
		SYNTAX_ORDER.forEach((k, i) => expect(idx.get(toHex(THEME.syntax[k]))).toBe(PAL_SYNTAX_START + i));
	});
});

describe('typography', () => {
	const fonts = new FontSet();
	const mono = fonts.fonts[F.code];
	const gids = (s: { gid: number }[]) => s.map((g) => g.gid);

	test('`::` renders as two separate plain colons; other ligatures stay as the font draws them', () => {
		const colon = mono.shape(':')[0];
		for (const s of ['::', 'std::fmt::Display', 'a::<T>()', ':::', '::<', 'a::b::c::<T>::new()', 'x :: y']) {
			const out = mono.shapeCode(s);
			expect(out.length).toBe(s.length); // one glyph per character, no merged glyph
			expect(out.map((g) => g.cluster)).toEqual([...s].map((_, i) => i));
			[...s].forEach((ch, i) => { if (ch === ':') expect(out[i].gid).toBe(colon.gid); });
		}
		// control: the raw shaper merges `::` (this is what the split prevents)
		expect(gids(mono.shape('::'))).not.toEqual([colon.gid, colon.gid]);
		// the other ligatures are untouched: shapeCode equals shape and substitutes (differs from features off)
		for (const s of ['->', '=>', '!=', '<=', '>=', '==']) {
			expect(gids(mono.shapeCode(s))).toEqual(gids(mono.shape(s)));
			if (s !== '>=') expect(gids(mono.shapeCode(s))).not.toEqual(gids(mono.shape(s, [], ['liga', 'calt', 'clig'])));
		}
		expect(gids(mono.shapeCode('a -> b::c => d'))).toEqual([...gids(mono.shape('a -> b')), colon.gid, colon.gid, ...gids(mono.shape('c => d'))]);
	});

	test('no fallback font substitutes punctuation: every ASCII symbol and every punctuation or symbol char used in code blocks has a glyph in the mono family', () => {
		const ascii = [...Array(94)].map((_, i) => String.fromCharCode(33 + i));
		const missing = ascii.filter((c) => mono.shape(c)[0].gid === 0);
		expect(missing).toEqual([]);
		const thoughts = path.join(ROOT, 'src/routes/(site)/thoughts');
		const used = new Set<string>();
		for (const d of fs.readdirSync(thoughts)) {
			const f = path.join(thoughts, d, '+page.svx');
			if (!fs.existsSync(f)) continue;
			for (const m of fs.readFileSync(f, 'utf8').matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const ch of m[1]) if (/[\p{P}\p{S}]/u.test(ch)) used.add(ch);
		}
		const needsFallback = [...used].filter((c) => mono.shape(c)[0].gid === 0);
		// the only characters allowed to fall back are box drawing (U+2500..257F, ASCII diagrams); the fallback must keep the monospace cell
		expect(needsFallback.filter((c) => !/[\u2500-\u257f]/.test(c)).map((c) => `U+${c.codePointAt(0)!.toString(16)} ${c}`)).toEqual([]);
		for (const c of needsFallback) {
			const fb = fonts.fallback(c.codePointAt(0)!);
			expect(fb).not.toBeNull();
			expect(Math.abs(fb!.adv - mono.shape('0')[0].xAdvance)).toBeLessThan(1e-6);
		}
	});

	test('headings use Inter at tracking 0: the h2 face has no condensed width axis and is not Instrument Sans', () => {
		const head = FONT_SPECS[F.head];
		expect(head.file).toBe('Inter.ttf');
		expect(Object.keys(head.variations).sort()).toEqual(['opsz', 'wght']);
		expect(head.variations.wght).toBeGreaterThanOrEqual(500);
		const flow = fs.readFileSync(path.join(ROOT, 'scripts/magazine/flow.ts'), 'utf8');
		expect(flow).toContain('font: F.head');
		expect(flow).not.toMatch(/letterSpacing|tracking\s*[:=]/); // tracking stays at the font's own 0
	});
});
