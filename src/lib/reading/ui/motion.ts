// ONE motion system for the reader's chrome, taken from ix (packages/web/src/styles/site.css `--ease`, `--dur-fast`; SearchPalette.svelte `pop` 0.2s).
// Every chrome animation is a time-based tween: linear progress over a duration, shaped by EASE. `reduced` snaps (see widgets.ts `track`).
import { cubicBezier } from '../metrics';

/** ix --ease */
export const EASE_POINTS = [0.2, 0.7, 0.2, 1] as const;
export const ease = cubicBezier(...EASE_POINTS);

/** durations in ms */
export const DUR = {
	/** ix --dur-fast: hover colour and background, link underline, popover close */
	fast: 150,
	/** ix SearchPalette `pop`: popovers and cards opening */
	pop: 200,
	/** ix HoverWord .tip: opacity and 4 px slide, 150 ms. (The hover wash fade is `wash`.) */
	tip: 150,
	wash: 110,
	/** hover-intent pauses before showing (ms): link card, code tip */
	linkIntent: 150,
	codeIntent: 250
} as const;
