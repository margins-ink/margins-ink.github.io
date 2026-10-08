// The Shiki (TextMate) theme of the reader, generated from the token table (src/lib/reading/theme.ts SYNTAX): twelve slots mapped onto the ix doc-code.css roles,
// replace `github-dark` (whose light-theme-derived values were low contrast on the dark panel). Scopes map to slots by hue family; the most
// specific scope wins in Shiki, so `keyword.operator` beats `keyword`, `storage.type.core` (Rust primitives) beats `storage.type`, and so on.
// Rust is covered explicitly (lifetimes, macros, attributes, `::`, self, constants), then TS/JS, JSON, HTML/Svelte, shell, CSS, markdown, diff.
import { SYNTAX_ORDER, syntaxHex, type SyntaxName } from '../../src/lib/reading/theme';

export const SHIKI_THEME_NAME = 'reader-dark';

/** TextMate scope prefixes per slot. */
export const SCOPES: Record<SyntaxName, string[]> = {
	keyword: [
		'keyword', 'keyword.control', 'keyword.other', 'storage', 'storage.type', 'storage.modifier', 'storage.type.struct', 'storage.type.enum', 'storage.type.trait',
		'storage.type.function', 'storage.type.class', 'storage.type.rust', 'variable.language', 'keyword.control.import', 'keyword.control.export', 'markup.heading.marker'
	],
	function: [
		'entity.name.function', 'support.function', 'meta.function-call entity.name.function', 'variable.function', 'entity.name.command', 'support.function.builtin',
		'markup.heading', 'entity.name.section'
	],
	type: [
		'entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.name.module', 'entity.other.inherited-class', 'support.type', 'support.class',
		'storage.type.core', 'storage.type.primitive', 'support.type.primitive', 'entity.name.type.parameter', 'meta.type.parameters entity.name.type', 'entity.name.scope-resolution'
	],
	string: [
		'string', 'punctuation.definition.string', 'string.regexp', 'markup.inserted', 'markup.inline.raw', 'string.quoted', 'string.template', 'punctuation.definition.string.template'
	],
	number: ['constant.numeric', 'constant.numeric.decimal', 'constant.numeric.integer', 'constant.numeric.float', 'constant.numeric.hex'],
	constant: [
		'constant', 'constant.language', 'constant.other', 'constant.character', 'constant.character.escape', 'support.constant', 'variable.other.constant', 'constant.other.caps',
		'variable.other.enummember', 'constant.language.boolean'
	],
	attribute: [
		'meta.attribute', 'punctuation.definition.attribute', 'entity.name.function.macro', 'entity.name.macro', 'support.function.macro', 'meta.macro entity.name.function',
		'storage.modifier.lifetime', 'entity.name.type.lifetime', 'punctuation.definition.lifetime', 'entity.other.attribute-name', 'meta.decorator', 'entity.name.function.decorator',
		'punctuation.decorator', 'meta.preprocessor', 'keyword.control.directive', 'entity.name.label', 'markup.italic'
	],
	property: [
		'variable.other.property', 'variable.other.object.property', 'variable.other.member', 'support.type.property-name', 'meta.object-literal.key', 'entity.name.tag',
		'support.variable.property', 'meta.property-name', 'support.type.vendored.property-name', 'markup.deleted', 'variable.other.field', 'meta.struct.field entity.name.type'
	],
	operator: [
		'keyword.operator', 'keyword.operator.arrow', 'keyword.operator.assignment', 'keyword.operator.comparison', 'keyword.operator.logical', 'keyword.operator.arithmetic',
		'keyword.operator.borrow', 'keyword.operator.dereference', 'keyword.operator.math', 'keyword.operator.expression', 'punctuation.definition.template-expression',
		'punctuation.separator.key-value', 'punctuation.vertical-bar', 'punctuation.definition.markdown',
		'punctuation', 'meta.brace', 'punctuation.separator', 'punctuation.terminator', 'punctuation.accessor', 'punctuation.definition.block', 'punctuation.definition.parameters',
		'punctuation.brackets', 'punctuation.section', 'keyword.operator.namespace', 'keyword.operator.scope-resolution', 'punctuation.separator.namespace', 'punctuation.separator.dot',
		'punctuation.definition.tag', 'meta.brace.round', 'meta.brace.square', 'punctuation.definition.typeparameters', 'keyword.operator.type.annotation', 'punctuation.definition.dictionary'
	
	],
	inline: [],
	comment: ['comment', 'punctuation.definition.comment', 'comment.block.documentation', 'comment.line.documentation', 'string.comment'],
	variable: ['variable', 'variable.other', 'variable.other.readwrite', 'variable.parameter', 'meta.definition.variable', 'variable.other.local', 'variable.other.normal', 'support.variable', 'meta.embedded', 'source']
};

/** The Shiki theme object, ThemeRegistrationRaw shaped (name, type, fg, bg, settings). `bg` is the code panel colour of no particular hue (shiki's own background is unused: we draw the panel). */
export function readerTheme() {
	const hex = syntaxHex();
	const settings: { scope: string[]; settings: { foreground?: string; fontStyle?: string } }[] = [
		{ scope: [], settings: { foreground: hex.variable } }
	];
	for (const slot of SYNTAX_ORDER) settings.push({ scope: SCOPES[slot], settings: { foreground: hex[slot] } });
	settings.push({ scope: ['markup.bold', 'markup.heading'], settings: { fontStyle: 'bold' } });
	return {
		name: SHIKI_THEME_NAME,
		type: 'dark' as const,
		colors: { 'editor.foreground': hex.variable, 'editor.background': '#000000' },
		fg: hex.variable,
		bg: '#000000',
		settings
	};
}
