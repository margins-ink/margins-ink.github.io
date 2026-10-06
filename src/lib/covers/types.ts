/**
 * A cover is hand-drawn pixel art: COLS x ROWS characters, one character per pixel.
 * '.' is transparent (shows the panel `bg`). Every other character must be a key of
 * `palette.light` and `palette.dark`. Rendered crisp (no smoothing) at any width.
 */
export const COLS = 64;
export const ROWS = 24;

export interface CoverPalette {
	/** Panel background behind the sprite. */
	bg: string;
	/** char -> CSS colour. */
	ink: Record<string, string>;
}

export interface Cover {
	rows: string[]; // exactly ROWS strings, each exactly COLS characters
	light: CoverPalette;
	dark: CoverPalette;
}
