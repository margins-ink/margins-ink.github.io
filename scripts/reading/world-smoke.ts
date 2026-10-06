// Headless smoke test of the ReadingModule in world.wasm (reader-only mode, no scene): bun scripts/reading/world-smoke.ts
// Build the wasm first (bun scripts/build-world.ts). Exits 1 when a check fails.
import fs from 'node:fs';
import { wasiImports } from '../../src/lib/gpu/room/world.ts';
import { createReading } from '../../src/lib/ecs/reading.ts';
import { INPUT, RD, READING_EVENTS, type ReadingExports } from '../../src/lib/reading/abi.ts';
import { BlockFlag, BlockKind, FigureMode, sampleReading, type BlockRec, type ReadingModel } from '../../src/lib/magazine/format.ts';

let memory!: WebAssembly.Memory;
const bytes = fs.readFileSync(new URL('../../src/lib/gpu/room/world.wasm', import.meta.url));
const { instance } = await WebAssembly.instantiate(bytes, wasiImports(() => memory) as WebAssembly.Imports);
const x = instance.exports as unknown as ReadingExports;
memory = x.memory;
if (x.reading_init() !== 0) throw new Error('reading_init failed');
const r = createReading(x);

let failed = 0;
const check = (name: string, ok: boolean, extra: unknown = '') => {
	console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : JSON.stringify(extra));
	if (!ok) failed++;
};
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;
const tick = (n: number, dtMs = 16) => {
	for (let i = 0; i < n; i++) r.tick(dtMs);
};
const drain = () => {
	const out: string[] = [];
	for (let e = r.poll(); e; e = r.poll()) out.push(`${e.kind}:${e.arg === 0xffffff ? 'none' : e.arg}`);
	return out;
};
const S = RD;
const st = () => r.state();
const clock = (fig: number) => st()[S.figBase + 2 * fig];
const onscreen = (fig: number) => st()[S.figBase + 2 * fig + 1];
const EM = 16;
const scrollTo = (yEm: number) => r.setScroll(yEm * EM);
const NONE = 'none';

// ---- the model: 12 blocks, a fold at 100..160 (peek 10), two figures, two notes ----
function model(): ReadingModel {
	const m = sampleReading();
	const blk = (y0: number, y1: number, kind: number, o: Partial<BlockRec> = {}) =>
		({ x0: 0, y0, x1: 34, y1, firstItem: 0, itemCount: 0, firstLine: 0, lineCount: 0, anchor: 0, fig: -1, kind, level: 0, flags: 0, section: 0, textOff: 0, textLen: 0, ...o }) as BlockRec;
	m.docH = 200;
	m.foldY = 100;
	m.foldH = 60;
	m.peekH = 10;
	m.blocks = [
		blk(4, 9, BlockKind.hero, { level: 1 }), // 0
		blk(10, 20, BlockKind.para), // 1
		blk(22, 40, BlockKind.figure, { fig: 0, flags: BlockFlag.wide, x0: -3, x1: 49 }), // 2
		blk(42, 45, BlockKind.heading, { level: 2, section: 1, anchor: 2 }), // 3
		blk(46, 70, BlockKind.para, { section: 1 }), // 4
		blk(72, 96, BlockKind.para, { section: 1 }), // 5
		blk(98, 100, BlockKind.fold, { section: 1 }), // 6
		blk(100, 130, BlockKind.para, { section: 1, flags: BlockFlag.folded }), // 7
		blk(130, 160, BlockKind.para, { section: 1, flags: BlockFlag.folded }), // 8
		blk(160, 163, BlockKind.heading, { level: 2, section: 2, anchor: 4 }), // 9
		blk(165, 190, BlockKind.para, { section: 2 }), // 10
		blk(192, 199, BlockKind.figure, { fig: 1, section: 2 }) // 11
	];
	m.notes = [
		{ ...m.notes[0], x0: 37, x1: 54, y0: 22, y1: 25, anchorBlock: 2 },
		{ ...m.notes[0], x0: 37, x1: 54, y0: 47, y1: 50, anchorBlock: 4 }
	];
	const fig = (id: number, mode: number, duration: number, poster: number, block: number) => ({ ...m.figures[0], id, mode, duration, poster, block, alt: 6 });
	m.figures = [fig(0, FigureMode.loop, 10, 2, 2), fig(1, FigureMode.scrub, 8, 0, 11)];
	m.anchors = [
		{ idOffset: 2, block: 3, y: 42 },
		{ idOffset: 4, block: 9, y: 160 }
	];
	m.links = [{ ...m.links[0], kind: 1, offset: 2, line: 0 }];
	return m;
}

// reference culling: the same definition as world/src/reading.rs, written as a linear scan
function expectVis(m: ReadingModel, yEm: number, viewEm: number, clip: number) {
	const off = m.foldH > 0 ? m.foldY + m.foldH - clip : 0;
	const toDoc = (p: number) => (m.foldH > 0 && p > clip ? p + off : p);
	const lo = toDoc(yEm - 0.25 * viewEm);
	const hi = toDoc(yEm + viewEm + 0.25 * viewEm);
	let pmax = -Infinity;
	let first = m.blocks.length;
	m.blocks.forEach((b, i) => {
		pmax = Math.max(pmax, b.y1);
		if (pmax >= lo && first === m.blocks.length) first = i;
	});
	const smin = m.blocks.map((_, i) => Math.min(...m.blocks.slice(i).map((b) => b.y0)));
	const end = smin.findIndex((v) => v > hi);
	const count = Math.max(0, (end < 0 ? m.blocks.length : end) - first);
	// every block that truly touches the window must be inside the range
	const touching = m.blocks.map((b, i) => [b, i] as const).filter(([b]) => b.y1 >= lo && b.y0 <= hi).map(([, i]) => i);
	return { first, count, covers: touching.every((i) => i >= first && i < first + count) };
}

const m = model();
const VIEW_EM = 40; // 640 px at 16 px per em
r.setViewport(800, 640, 1, EM, 0);
drain();

// ---- load, entities, events ----
r.load(m);
const ev0 = drain();
check('load emits layout and the first figure entering the data range', ev0.includes(`layout:0`) && ev0.includes('figureVisible:0'), ev0);
const count1 = r.entityCount();
check('entities: article, 12 blocks, 2 notes, 1 link', count1 >= 1 + 12 + 2 + 1, count1);
check('blockAt is a binary search over y1', r.blockAt(0) === 0 && r.blockAt(50) === 4 && r.blockAt(1000) === 11, [r.blockAt(0), r.blockAt(50), r.blockAt(1000)]);
check('a second load replaces the first (no leak)', (r.load(m), r.entityCount()) <= count1 + 2, r.entityCount());
drain();
tick(1);
{
	const s = st();
	check('collapsed fold: clip, height, max', near(s[S.foldClipEm], 110) && near(s[S.docHeightEm], 150) && near(s[S.scrollMaxEm], 110), [s[S.foldClipEm], s[S.docHeightEm], s[S.scrollMaxEm]]);
	check('viewport em and typography', near(s[S.viewportEm], VIEW_EM) && s[S.emPx] === EM && s[S.widthClass] === 0, [s[S.viewportEm], s[S.emPx]]);
	check('relations start empty', s[S.section] === -1 && s[S.readingBlock] === -1 && s[S.hoverBlock] === -1 && s[S.scrubFig] === -1 && s[S.openBlock] === -1);
	check('fold starts settled and collapsed', s[S.foldSettled] === 1 && s[S.foldT] === 0 && s[S.foldTarget] === 0);
}

// ---- culling ranges at several scroll positions, collapsed and expanded ----
for (const [fold, clip] of [[0, 110], [1, 160]] as const) {
	r.input(INPUT.foldSet, fold, 1);
	tick(1);
	for (const y of [0, 15, 30, 60, 100, 110, 150, 160]) {
		scrollTo(y);
		tick(1);
		const s = st();
		const e = expectVis(m, y, VIEW_EM, clip);
		check(`cull fold=${fold} y=${y}: [${e.first}, +${e.count})`, s[S.visFirst] === e.first && s[S.visCount] === e.count && e.covers, [s[S.visFirst], s[S.visCount], e]);
	}
}
r.input(INPUT.foldSet, 0, 1);
tick(1);
scrollTo(0);
tick(1);
check('cull y=0 collapsed is blocks 0..4 and both notes', st()[S.visFirst] === 0 && st()[S.visCount] === 5 && st()[S.noteFirst] === 0 && st()[S.noteCount] === 2, Array.from(st().slice(6, 10)));
scrollTo(100);
tick(1);
check('cull y=100 collapsed skips the first five blocks and all notes', st()[S.visFirst] === 5 && st()[S.visCount] === 7 && st()[S.noteCount] === 0, Array.from(st().slice(6, 10)));
check('figure data range at y=100 holds both figures', st()[S.figVisFirst] === 0 && st()[S.figVisCount] === 2, [st()[S.figVisFirst], st()[S.figVisCount]]);

// ---- dirty bits: idle frames cost nothing ----
tick(5);
r.ackDirty();
tick(10);
check('idle at y=100 sets no dirty bit', st()[S.dirty] === 0, st()[S.dirty]);
scrollTo(101);
tick(1);
check('a scroll sets bit 0', (st()[S.dirty] & 1) === 1, st()[S.dirty]);
r.ackDirty();
check('ack clears the bits', st()[S.dirty] === 0);
scrollTo(100);
tick(1);
r.ackDirty();

// ---- figure clock: advances only when on screen (60 percent) and the page is idle ----
scrollTo(0);
tick(1);
check('figure 0 is on screen at y=0', onscreen(0) === 1 && onscreen(1) === 0, [onscreen(0), onscreen(1)]);
const t0 = clock(0);
check('the clock starts at the poster', near(t0, 2), t0);
tick(8); // 128 ms of idle: not yet
check('not before the page has been idle for 0.2 s', near(clock(0), t0, 1e-4), clock(0));
tick(30);
check('advances once idle', clock(0) > t0 + 0.2 && clock(0) < t0 + 0.7, clock(0));
check('a live figure marks bit 2', (st()[S.dirty] & 4) === 4, st()[S.dirty]);
scrollTo(100); // figure 0 off screen
tick(1);
const tOff = clock(0);
tick(40);
check('paused while off screen', near(clock(0), tOff, 1e-4) && onscreen(0) === 0, [clock(0), onscreen(0)]);
scrollTo(30); // 10 of 18 em inside: 55 percent, below the 60 percent bar
tick(40);
check('paused while less than 60 percent inside', onscreen(0) === 1 && near(clock(0), tOff, 1e-4), [clock(0), tOff]);
scrollTo(0);
for (let i = 0; i < 30; i++) {
	r.setScroll(i % 2); // a 1 px wiggle every frame keeps the page busy
	r.tick(16);
}
const tBusy = clock(0);
for (let i = 0; i < 30; i++) {
	r.setScroll(i % 2);
	r.tick(16);
}
check('paused while scrolling', near(clock(0), tBusy, 1e-4), [clock(0), tBusy]);
r.setScroll(0);
tick(40);
check('resumes after the scroll stops', clock(0) > tBusy + 0.2, [clock(0), tBusy]);

// ---- scrub, step, home, play ----
r.input(INPUT.scrubBegin, 0);
r.input(INPUT.scrubTo, 0, 5);
check('scrubTo moves the clock and Scrubbing is set', near(clock(0), 5) && st()[S.scrubFig] === 0, [clock(0), st()[S.scrubFig]]);
tick(30);
check('a held figure does not autoplay', near(clock(0), 5), clock(0));
r.input(INPUT.scrubEnd, 0, 2);
tick(5);
check('momentum after release', clock(0) > 5.05 && st()[S.scrubFig] === -1, [clock(0), st()[S.scrubFig]]);
tick(65);
const rest = clock(0);
tick(20);
check('autoplay waits after a touch', near(clock(0), rest, 0.01), [clock(0), rest]);
tick(40);
check('then resumes', clock(0) > rest + 0.2, [clock(0), rest]);
r.input(INPUT.figureHome, 0);
check('figureHome returns to the poster', near(clock(0), 2), clock(0));
r.input(INPUT.figureStep, 0, 0.25);
check('figureStep adds seconds', near(clock(0), 2.25), clock(0));
r.input(INPUT.figureStep, 0, -100);
check('figureStep clamps at 0', clock(0) === 0, clock(0));
r.input(INPUT.figureStep, 0, 100);
check('figureStep clamps at the duration', clock(0) === 10, clock(0));
r.input(INPUT.scrubTo, 1, 100);
check('a scrub-mode figure clamps to its duration', clock(1) === 8, clock(1));
r.input(INPUT.scrubTo, 1, -5);
check('and to zero', clock(1) === 0, clock(1));
r.input(INPUT.figureHome, 0);
r.input(INPUT.figurePlay, 0, 2); // toggle: pause
tick(130);
check('paused by the user', near(clock(0), 2), clock(0));
r.input(INPUT.figurePlay, 0, 1);
tick(30);
check('play resumes it', clock(0) > 2.2, clock(0));

// ---- hover, focus, open ----
drain();
r.ackDirty();
r.input(INPUT.hoverBlock, 3);
tick(1);
check('hover is in the state and raises an event', st()[S.hoverBlock] === 3 && (st()[S.dirty] & 8) === 8 && drain().includes('hover:3'), [st()[S.hoverBlock], st()[S.dirty]]);
r.input(INPUT.hoverBlock, 4);
tick(1);
const evHover = drain();
check('replacing the hover target emits one event, not a clear and a set', evHover.filter((e) => e.startsWith('hover')).join() === 'hover:4', evHover);
r.input(INPUT.hoverBlock, -1);
tick(1);
check('clearing hover', st()[S.hoverBlock] === -1 && drain().includes(`hover:${NONE}`));
r.input(INPUT.focusBlock, 2);
r.input(INPUT.open, 2);
tick(1);
check('focus and open', st()[S.focusBlock] === 2 && st()[S.openBlock] === 2 && drain().join().includes('focus:2'), [st()[S.focusBlock], st()[S.openBlock]]);
r.input(INPUT.focusBlock, -1);
r.input(INPUT.open, -1);
tick(1);
drain();

// ---- fold spring ----
scrollTo(0);
tick(1);
drain();
r.input(INPUT.foldSet, 1, 0);
tick(5);
{
	const s = st();
	check('mid spring: t strictly between, height between, not settled, bit 1 set', s[S.foldT] > 0 && s[S.foldT] < 1 && s[S.docHeightEm] > 150 && s[S.docHeightEm] < 200 && s[S.foldSettled] === 0 && (s[S.dirty] & 2) === 2, [s[S.foldT], s[S.docHeightEm], s[S.foldSettled], s[S.dirty]]);
}
tick(120);
{
	const s = st();
	check('the fold spring reaches 1 and the document grows to 200 em', s[S.foldT] === 1 && near(s[S.docHeightEm], 200) && near(s[S.foldClipEm], 160) && near(s[S.scrollMaxEm], 160) && s[S.foldSettled] === 1, Array.from(s.slice(0, 8)));
}
const evFold = drain();
check('foldExpand and foldSettled events', evFold.includes('foldExpand:1') && evFold.includes('foldSettled:0'), evFold);
r.input(INPUT.foldSet, 0, 0);
tick(120);
{
	const s = st();
	check('and back to collapsed', s[S.foldT] === 0 && near(s[S.docHeightEm], 150) && drain().includes('foldExpand:0'), [s[S.foldT], s[S.docHeightEm]]);
}
r.input(INPUT.foldSet, 1, 1);
check('instant: no spring', st()[S.foldT] === 1 && st()[S.foldSettled] === 1 && near(st()[S.docHeightEm], 200), [st()[S.foldT], st()[S.docHeightEm]]);
r.input(INPUT.foldSet, 0, 1);
tick(1);
drain();

// ---- Reading: the current section ----
scrollTo(0);
tick(1);
drain();
check('before the first h2: no section', st()[S.section] === -1 && st()[S.readingBlock] === -1);
scrollTo(40); // heading 3 at y 42 is within 3 em of the top
tick(1);
check('section 1 at heading 3', st()[S.section] === 1 && st()[S.readingBlock] === 3, [st()[S.section], st()[S.readingBlock]]);
scrollTo(108); // collapsed: heading 9 sits at page y 160 - 50 = 110
tick(1);
check('section 2 at heading 9 (page space, fold collapsed)', st()[S.section] === 2 && st()[S.readingBlock] === 9 && near(st()[S.progress], 108 / 110, 1e-3), [st()[S.section], st()[S.readingBlock]]);
r.input(INPUT.foldSet, 1, 1);
tick(1);
check('expanding moves heading 9 down: back to section 1', st()[S.section] === 1 && st()[S.readingBlock] === 3, [st()[S.section], st()[S.readingBlock]]);
scrollTo(0);
r.input(INPUT.foldSet, 0, 1);
tick(1);
const evSec = drain().filter((e) => e.startsWith('section'));
check('section events follow the relation', evSec.join() === 'section:1,section:2,section:1,section:' + NONE, evSec);

// ---- reduced motion pins the poster ----
scrollTo(0);
tick(40);
r.input(INPUT.reducedMotion, 1);
check('reduced motion snaps figures to the poster', near(clock(0), 2), clock(0));
tick(80);
check('and keeps them there while live and idle', near(clock(0), 2) && onscreen(0) === 1, clock(0));
r.input(INPUT.foldSet, 1, 0);
check('reduced motion makes the fold instant', st()[S.foldT] === 1 && near(st()[S.docHeightEm], 200), [st()[S.foldT], st()[S.docHeightEm]]);
r.input(INPUT.foldSet, 0, 0);
r.input(INPUT.reducedMotion, 0);
tick(40);
check('clearing it lets the figure play again', clock(0) > 2.2, clock(0));

// ---- viewport change: layout event and new height in em ----
drain();
r.setViewport(400, 800, 2, 14, 2);
tick(1);
check('viewport change: layout event, em and class', drain().includes('layout:2') && near(st()[S.viewportEm], 800 / 14, 1e-3) && st()[S.widthClass] === 2 && st()[S.emPx] === 14, [st()[S.viewportEm], st()[S.widthClass]]);
check('event names match the ABI', READING_EVENTS[0] === 'section' && READING_EVENTS[8] === 'layout');

console.log(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
