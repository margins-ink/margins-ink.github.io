// Figures for "When you pay for computation" (docs/MAGAZINE.md 2.6). Every word drawn is a word of the post:
// Turing machine, lambda calculus, imperative and functional languages, same functions, do-notation.
import { figure, rrect, text, arrow, type FigNode } from '$lib/magazine/dsl';

// ---- two-machines: "two models, the same functions" -------------------------------------------------
// Hand-placed 2x2: the two models on top, the language families they grew into below, and do-notation as the
// bridge between the families. Static: the claim is the layout, nothing moves.
function twoMachines() {
	const W = 12;
	const H = 3.4;
	const L = 1; // left column x
	const R = 23; // right column x
	const TOP = 2;
	const BOT = 12.6;
	const box = (id: string, x: number, y: number, label: string, fill: 'neutral1' | 'neutral2') =>
		rrect(id, { at: [x, y], size: [W, H], fill, label });
	const cx = (x: number) => x + W / 2;
	const nodes: FigNode[] = [
		box('tm', L, TOP, 'Turing machine', 'neutral1'),
		box('lc', R, TOP, 'lambda calculus', 'neutral1'),
		box('imp', L, BOT, 'imperative languages', 'neutral2'),
		box('fun', R, BOT, 'functional languages', 'neutral2'),
		// the two models define the same functions (Turing, 1936): an arrow each way
		arrow('tm-lc', `M ${L + W + 0.4} ${TOP + 1.2} L ${R - 0.4} ${TOP + 1.2}`, { w: 0.12, color: 'muted' }),
		arrow('lc-tm', `M ${R - 0.4} ${TOP + 2.2} L ${L + W + 0.4} ${TOP + 2.2}`, { w: 0.12, color: 'muted' }),
		text('same functions', { id: 'w-same', at: [18, TOP + 0.6], align: 'center' }),
		text('Turing, 1936', { id: 'w-1936', at: [18, TOP + 3.9], align: 'center', color: 'muted' }),
		// each model grew a family of languages
		arrow('tm-imp', `M ${cx(L)} ${TOP + H + 0.4} L ${cx(L)} ${BOT - 0.4}`, { w: 0.12, color: 'muted' }),
		arrow('lc-fun', `M ${cx(R)} ${TOP + H + 0.4} L ${cx(R)} ${BOT - 0.4}`, { w: 0.12, color: 'muted' }),
		text('mutate the tape', { id: 'w-tape', at: [cx(L) + 0.8, 9.6], align: 'left' }),
		text('pass state along', { id: 'w-pass', at: [cx(R) - 0.8, 9.6], align: 'right' }),
		// do-notation writes the tape picture inside the functional one
		arrow('do', `M ${R - 0.4} ${BOT + H / 2} L ${L + W + 0.4} ${BOT + H / 2}`, { w: 0.16, color: 'accent' }),
		text('do-notation', { id: 'w-do', at: [18, BOT + H / 2 - 0.7], align: 'center', color: 'accent' })
	];
	return figure({
		size: [36, 17],
		time: { duration: 1, mode: 'static', poster: 0 },
		describe: 'A Turing machine and the lambda calculus define the same functions. Imperative languages grew from the first by mutating the tape, functional languages from the second by passing state along, and do-notation writes the imperative picture inside the functional one.',
		alt: 'Four boxes in a square: Turing machine and lambda calculus on top joined by arrows both ways labelled same functions, Turing 1936; imperative and functional languages below each; an accent arrow labelled do-notation runs from functional to imperative.',
		palette: { model: 'neutral1', family: 'neutral2', bridge: 'accent' },
		nodes
	});
}

export default {
	'two-machines': twoMachines()
};
