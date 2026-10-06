import type { Cover } from './types';

function hexToRgb(hex: string): [number, number, number] | null {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return null;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function saturation([r, g, b]: [number, number, number]) {
	const max = Math.max(r, g, b) / 255;
	const min = Math.min(r, g, b) / 255;
	const l = (max + min) / 2;
	return max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
}

/** The most saturated ink colour of a palette is the cover's accent. */
function pick(ink: Record<string, string>, fallback: string): string {
	let best = fallback;
	let bestS = 0.18;
	for (const colour of Object.values(ink)) {
		const rgb = hexToRgb(colour);
		if (!rgb) continue;
		const s = saturation(rgb);
		if (s > bestS) {
			bestS = s;
			best = colour;
		}
	}
	return best;
}

export function accentOf(cover: Cover) {
	return { light: pick(cover.light.ink, '#57534e'), dark: pick(cover.dark.ink, '#d6d3d1') };
}
