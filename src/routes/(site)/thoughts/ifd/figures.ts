// Figures for "IFD is fine" (docs/MAGAZINE.md 2.6). Every word drawn is a word of the post:
// CppNix, Snix, eval, build, stops, waits, resumes, thunk, request, yields. No numbers or percentages are drawn:
// the post states none, so the claim is geometry only.
import { figure, rrect, circle, text, path, arrow, dots, track, type FigNode, type PathSpec, type Track } from '$lib/magazine/dsl';

// ---- eval-timeline: "the evaluator waits" -----------------------------------------------------------
// Axis: 10 units u of timeline map to x = 6 + 2.9u (6..35 em) and to 9 s of the 12 s loop (poster 9 s: everything
// has finished, 9..12 s holds the end state before the loop restarts).
const X = (u: number) => 6 + 2.9 * u;
const S = (u: number) => 0.9 * u; // units to seconds
const LANE_H = 3;
const CPP_Y = 4;
const SNIX_Y = 10;

const fill = (id: string, u0: number, u1: number, w: number): Track =>
	track(`${id}.size.x`, S(u0) === 0 ? [[0, 0], [S(u1), w]] : [[0, 0], [S(u0), 0], [S(u1), w]], 'linear');

function timeline() {
	const nodes: FigNode[] = [];
	const tracks: Track[] = [];
	const pad = 0.05; // blocks do not touch, so each reads as its own block
	const block = (id: string, lane: number, u0: number, u1: number, kind: 'eval' | 'build', color: 'muted' | 'accent') => {
		const w = (u1 - u0) * 2.9 - pad;
		if (kind === 'eval') nodes.push(rrect(id, { at: [X(u0), lane], size: [w, LANE_H], fill: color, label: 'eval' }));
		else {
			nodes.push(rrect(id, { at: [X(u0), lane], size: [w, LANE_H], fill: 'neutral2', hatch: true, stroke: { w: 0.1, color: 'muted', dash: [0.4, 0.3] }, label: 'build' }));
			tracks.push(track(`${id}.phase`, [[0, 0], [12, 7]], 'linear')); // hatch crawls: 10 periods of 0.7 em per loop
		}
		tracks.push(fill(id, u0, u1, w));
	};

	// CppNix: eval, then the evaluator sits behind each build.
	const cpp: ['eval' | 'build', number, number][] = [['eval', 0, 1.5], ['build', 1.5, 3], ['eval', 3, 4], ['build', 4, 6], ['eval', 6, 7], ['build', 7, 8.5], ['eval', 8.5, 10]];
	cpp.forEach(([k, a, b], i) => block(`c${i}`, CPP_Y, a, b, k, 'muted'));
	// Snix: eval never stops, so it ends first.
	const snix: [number, number][] = [[0, 1.5], [1.5, 2.5], [2.5, 3.5], [3.5, 4.5], [4.5, 5.5], [5.5, 6.5]];
	snix.forEach(([a, b], i) => block(`s${i}`, SNIX_Y, a, b, 'eval', 'accent'));

	// Builds Snix asked for run concurrently on the strip below, each tied to the eval block that requested it.
	// Lowest row = earliest request, so no arrow crosses a bar.
	const builds: [number, number, number][] = [[1.5, 3, 17.7], [2.5, 4.5, 16.6], [3.5, 5, 15.5]];
	builds.forEach(([a, b, y], i) => {
		const w = (b - a) * 2.9 - pad;
		nodes.push(rrect(`sb${i}`, { at: [X(a), y], size: [w, 0.8], fill: 'neutral2', radius: 0.2 }));
		tracks.push(fill(`sb${i}`, a, b, w));
		const x = X(a);
		nodes.push(arrow(`sa${i}`, `M ${x} ${SNIX_Y + LANE_H} L ${x} ${y}`, { w: 0.12, color: 'accent' }));
		tracks.push(track(`sa${i}.trim.t1`, [[0, 0], [S(a), 0], [S(a) + 0.4, 1]], ['linear', 'outCubic']));
	});

	// Lane names, and the three words of the first hatched block.
	nodes.push(text('CppNix', { id: 'lane-cpp', at: [0, CPP_Y + 1.9] }));
	nodes.push(text('Snix', { id: 'lane-snix', at: [0, SNIX_Y + 1.9], color: 'accent' }));
	const word = (id: string, s: string, at: [number, number], align: 'left' | 'center' | 'right', u: number) => {
		nodes.push(text(s, { id, at, align }));
		tracks.push(track(`${id}.opacity`, [[0, 0], [S(u) - 0.1, 0], [S(u) + 0.2, 1]], ['linear', 'outSine']));
	};
	word('w-stops', 'stops', [X(1.5) - 0.2, CPP_Y - 0.7], 'right', 1.5);
	word('w-waits', 'waits', [(X(1.5) + X(3)) / 2, CPP_Y + LANE_H + 1.2], 'center', 2.25);
	word('w-resumes', 'resumes', [X(3) + 0.2, CPP_Y - 0.7], 'left', 3);

	const paths: PathSpec[] = [path('playhead', `M 6 2.4 L 6 ${SNIX_Y + LANE_H + 1}`, { stroke: { w: 0.12, color: 'ink' } })];
	tracks.push(track('playhead.x', [[0, 0], [9, 29]], 'linear'));

	return figure({
		size: [36, 20],
		time: { duration: 12, mode: 'loop', poster: 9 },
		describe: 'When a thunk demands the contents of a derivation, the CppNix evaluator stops, waits for the build, resumes. Snix keeps eval going while the builds run.',
		alt: 'Two lanes, CppNix and Snix: eval blocks on CppNix are separated by hatched build blocks where it waits; Snix eval blocks run back to back and end first.',
		palette: { cpp: 'muted', snix: 'accent', build: 'neutral2' },
		nodes, paths, tracks
	});
}

// ---- eval-graph: "one graph that grows" -------------------------------------------------------------
// Hand-placed LR layout (the tree is small and the figure must read at poster; dagre is not needed).
function graph() {
	const R = 1.15; // eval circle radius
	const B = 2.6; // build square side
	const POS: Record<string, [number, number]> = {
		e0: [3, 10], e1: [8.5, 5.5], e2: [8.5, 14.5], e3: [14, 3], e4: [14, 8], e5: [14, 12.5], e6: [19.5, 12.5], e7: [25, 10], e8: [25, 14.5],
		b0: [14, 17.5], b1: [19.5, 3], b2: [19.5, 8], b3: [19.5, 16.5], b4: [25, 4.5], b5: [30.5, 10]
	};
	// discovery time in s (the graph grows as eval discovers more of it)
	const APPEAR: Record<string, number> = {
		e0: 0, e1: 0.8, e2: 0.8, e3: 1.6, e4: 1.6, e5: 1.6, e6: 2.2, b0: 2.6, b1: 2.4, b2: 2.6, b3: 3, e7: 3.4, e8: 4, b4: 4.4, b5: 5
	};
	const EDGES: [string, string][] = [
		['e0', 'e1'], ['e0', 'e2'], ['e1', 'e3'], ['e1', 'e4'], ['e2', 'e5'], ['e2', 'b0'], ['e3', 'b1'], ['e4', 'b2'],
		['e4', 'b4'], ['e5', 'e6'], ['e5', 'b3'], ['e6', 'e7'], ['e6', 'e8'], ['e7', 'b5']
	];
	const r = (id: string) => (id[0] === 'e' ? R : B / 2);
	const nodes: FigNode[] = [];
	const tracks: Track[] = [];
	const appear = (id: string): Track =>
		track(`${id}.opacity`, [[0, 0], [APPEAR[id] - 0.1, 0], [APPEAR[id] + 0.4, 1]], ['linear', 'outSine']);

	// lit: thunk resumes when its build lands (8 s); the rest light up with the parallel builds (10.4 s on).
	const LIT: Record<string, number> = { e0: 10.4, e1: 10.4, e2: 8, e3: 10.8, e4: 10.8, e5: 10.8, e6: 10.8, e7: 10.8, e8: 10.8 };

	for (const id of Object.keys(POS)) {
		const [x, y] = POS[id];
		if (id[0] === 'e') {
			nodes.push(circle(id, { at: [x, y], r: R, fill: { mix: ['muted', 'accent'], chan: `${id}.mix` } }));
			tracks.push(track(`${id}.mix`, [[0, 0], [LIT[id], 0], [LIT[id] + 0.4, 1]], ['linear', 'inOutSine']));
			if (id !== 'e2' && id !== 'e0') tracks.push(appear(id)); // e0 is there from the first frame
		} else {
			nodes.push(rrect(id, { at: [x - B / 2, y - B / 2], size: [B, B], radius: 0.3, fill: 'none', stroke: { w: 0.1, color: 'muted' } }));
			nodes.push(rrect(`${id}f`, { at: [x - 1, y - 1], size: [2, 2], radius: 0.2, fill: 'neutral2' }));
			tracks.push(appear(id));
		}
	}
	// the thunk dims while its build runs, then resumes
	tracks.push(track('e2.opacity', [[0, 0], [0.7, 0], [1.2, 1], [3, 1], [3.3, 0.35], [8, 0.35], [8.6, 1]], ['linear', 'outSine', 'linear', 'outSine', 'linear', 'outSine']));

	// builds fill: b0 runs alone (4.2 to 8 s), the rest run at once from 9 s
	tracks.push(track('b0f.scale', [[0, 0], [4.2, 0], [8, 1]], 'linear'));
	['b1', 'b2', 'b3', 'b4', 'b5'].forEach((b, i) => tracks.push(track(`${b}f.scale`, [[0, 0], [9 + i * 0.1, 0], [10.6 + i * 0.1, 1]], 'linear')));

	// edges: quadratic strokes that draw on once the target is discovered
	const edgePath = (a: string, b: string): string => {
		const [x0, y0] = POS[a], [x1, y1] = POS[b];
		const sx = x0 + r(a), ex = x1 - r(b);
		return `M ${sx} ${y0} Q ${sx + (ex - sx) * 0.5} ${y0 + (y1 - y0) * 0.15} ${ex} ${y1}`;
	};
	const edgeIds: Record<string, string> = {};
	for (const [a, b] of EDGES) {
		const id = `${a}${b}`;
		edgeIds[id] = edgePath(a, b);
		nodes.push(arrow(id, edgePath(a, b), { w: 0.1, color: 'muted' }));
		const t0 = Math.max(0, APPEAR[b] - 0.3);
		tracks.push(track(`${id}.trim.t1`, [[0, 0], [t0, 0], [t0 + 0.5, 1]], ['linear', 'outCubic']));
	}

	// the request travels to the build and the result travels back
	nodes.push(dots('req', { along: 'e2b0', count: 1, r: 0.24, color: 'accent' }));
	tracks.push(track('req.u', [[0, 0], [3.2, 0], [4.2, 1]], ['linear', 'inOutSine']));
	tracks.push(track('req.opacity', [[0, 0], [3.15, 0], [3.2, 1], [4.2, 1], [4.3, 0]], 'linear'));
	nodes.push(dots('ret', { along: 'e2b0', count: 1, r: 0.24, color: 'accent' }));
	tracks.push(track('ret.u', [[0, 1], [8, 1], [8.6, 0]], ['linear', 'inOutSine']));
	tracks.push(track('ret.opacity', [[0, 0], [7.95, 0], [8, 1], [8.6, 1], [8.7, 0]], 'linear'));

	// words: thunk stays; request and yields show while the build runs; resumes is the end state
	const word = (id: string, s: string, at: [number, number], align: 'left' | 'center' | 'right', keys: [number, number][]) => {
		nodes.push(text(s, { id, at, align }));
		tracks.push(track(`${id}.opacity`, keys, 'linear'));
	};
	nodes.push(text('thunk', { id: 'w-thunk', at: [8.5, 12.5], align: 'center' }));
	tracks.push(track('w-thunk.opacity', [[0, 0], [1.2, 0], [1.6, 1]], 'linear'));
	word('w-request', 'request', [11.8, 15.4], 'center', [[0, 0], [3.1, 0], [3.3, 1], [4.2, 1], [4.4, 0]]);
	word('w-yields', 'yields', [8.5, 17.4], 'center', [[0, 0], [3.3, 0], [3.5, 1], [7.8, 1], [8, 0]]);
	word('w-resumes', 'resumes', [8.5, 17.4], 'center', [[0, 0], [8.2, 0], [8.6, 1]]);

	// legend: what a circle and a square are
	nodes.push(circle('lg-eval', { at: [1.3, 18.7], r: 0.5, fill: 'accent' }));
	nodes.push(text('eval', { id: 'lg-eval-t', at: [2.3, 19], size: 0.78 }));
	nodes.push(rrect('lg-build', { at: [6, 18.2], size: [1, 1], radius: 0.15, fill: 'neutral2' }));
	nodes.push(text('build', { id: 'lg-build-t', at: [7.3, 19] }));

	return figure({
		size: [36, 20],
		time: { duration: 14, mode: 'loop', poster: 11 },
		describe: 'Eval and build are nodes in one graph. The graph grows as eval discovers more of it. A thunk that needs a build emits a request and yields; other thunks keep running, and every build runs at once.',
		alt: 'A graph of eval circles and build squares that grows over time: a thunk yields while its build runs, then resumes; the remaining builds run in parallel.',
		palette: { eval: 'accent', build: 'neutral2' },
		nodes, tracks
	});
}

export default {
	'eval-timeline': timeline(),
	'eval-graph': graph()
};
