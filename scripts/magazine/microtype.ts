// Microtypography for the full text layer (MAGAZINE.md 1.4 step 4): optical margin alignment
// (hanging punctuation) and fixed non-breaking glue before units.

/** Fraction of the glyph advance that hangs into the left margin when the char starts a line. */
export function leftHang(ch: string): number {
	switch (ch) {
		case '“': case '‘': case '"': case "'": case '«': case '‹': case '„': case '‚': return 0.7;
		default: return 0;
	}
}

/** Fraction of the glyph advance that hangs into the right margin when the char ends a line. */
export function rightHang(ch: string): number {
	switch (ch) {
		case '”': case '’': case '"': case "'": case '»': case '›': case '-': case '‐': case '­': return 0.7;
		case '.': case ',': return 0.4;
		default: return 0;
	}
}

/** Hang of the trailing hyphen shown at a discretionary break (same 70% as a typed hyphen). */
export const HYPHEN_HANG = 0.7;

const UNITS = 'ms|s|min|h|KB|MB|GB|TB|KiB|MiB|GiB|TiB|B|kHz|MHz|GHz|Hz|px|em|rem|pt|cm|mm|km|m|kg|g|%|x|ns|us|µs|ms|fps|GB/s|MB/s|W|V|A|K|C|F';
const UNIT_RE = new RegExp(`(\\d) (${UNITS})(?![A-Za-z0-9])`, 'g');

/** Replace the space between a number and its unit by U+00A0 (the breaker turns it into fixed glue). */
export function bindUnits(text: string): string {
	return text.replace(UNIT_RE, '$1 $2');
}
