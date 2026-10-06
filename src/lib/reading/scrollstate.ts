// Scroll restore by block anchor, hash handling, scroll-spy and section jumps (docs/READING.md section 5).
// The pure parts (block lookup, fold mapping, anchor keys) are exported for tests; createScrollState wires them to a scroller.
import { BlockFlag, BlockKind, stringAt, type ReadingModel } from '../magazine/format';
import { LINE_EM } from './metrics';
import type { LineRange } from './textlayer';

export interface SavedState {
	blockId: number;
	offsetEm: number;
	fold: boolean;
	scale: number;
	fromWorld?: boolean;
	/** for a restore at another width class (block ids differ per class): the block's text range and the fraction through it */
	textOff?: number;
	textLen?: number;
	frac?: number;
	cls?: number;
	headingId?: string;
}

// ---- pure ---------------------------------------------------------------------------------------------------------

/** First block with y1 > yEm (blocks are sorted by y0 and stack vertically); the last block when below the end; -1 when empty. */
export function blockAtY(blocks: readonly { y1: number }[], yEm: number): number {
	const n = blocks.length;
	if (n === 0) return -1;
	let lo = 0, hi = n - 1;
	if (blocks[hi].y1 <= yEm) return hi;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (blocks[mid].y1 > yEm) hi = mid;
		else lo = mid + 1;
	}
	return lo;
}

type FoldGeom = Pick<ReadingModel, 'foldY' | 'foldH'>;
/** layout em the content after the folded region is moved up by while the fold is not fully open (clipEm = RD.foldClipEm) */
export const foldShiftEm = (m: FoldGeom, clipEm: number): number => (m.foldH > 0 ? Math.max(0, m.foldY + m.foldH - clipEm) : 0);

/** document (scroll) y in em to layout y: below the fold clip the layout is the full-height one */
export function docToLayoutY(m: FoldGeom, yEm: number, clipEm: number): number {
	return m.foldH > 0 && yEm >= clipEm ? yEm + foldShiftEm(m, clipEm) : yEm;
}
/** layout y to document y: content after the folded region (tail) is moved up by the shift */
export function layoutToDocY(m: FoldGeom, layoutEm: number, clipEm: number): number {
	return m.foldH > 0 && layoutEm >= m.foldY + m.foldH - 1e-6 ? layoutEm - foldShiftEm(m, clipEm) : layoutEm;
}

/** Anchor of a scroll position: the block at the top and the offset into it, plus the cross-class key. */
export function anchorAt(m: ReadingModel, scrollEm: number, clipEm: number): Omit<SavedState, 'fold' | 'scale'> | null {
	const ly = docToLayoutY(m, scrollEm, clipEm);
	const i = blockAtY(m.blocks, ly);
	if (i < 0) return null;
	const b = m.blocks[i];
	const h = Math.max(1e-6, b.y1 - b.y0);
	const off = ly - b.y0;
	let headingId: string | undefined;
	for (let j = i; j >= 0; j--) if (m.blocks[j].kind === BlockKind.heading && m.blocks[j].anchor) { headingId = stringAt(m.strings, m.blocks[j].anchor); break; }
	return { blockId: i, offsetEm: off, textOff: b.textOff, textLen: b.textLen, frac: Math.min(1, Math.max(0, off / h)), cls: m.widthClass, headingId };
}

/** Resolve a saved anchor in a model; same class: the block id and exact offset, other class: the same text range by fraction, else the heading. Returns layout em. */
export function resolveAnchor(m: ReadingModel, s: SavedState): number | null {
	const n = m.blocks.length;
	if (n === 0) return null;
	if (s.cls === m.widthClass || s.cls === undefined) {
		const b = m.blocks[Math.min(n - 1, Math.max(0, s.blockId))];
		if (b && (s.textOff === undefined || b.textOff === s.textOff || s.cls === undefined)) return b.y0 + s.offsetEm;
	}
	if (s.textLen && s.textOff !== undefined) {
		const b = m.blocks.find((x) => x.textOff === s.textOff && x.textLen === s.textLen);
		if (b) return b.y0 + (s.frac ?? 0) * (b.y1 - b.y0);
	}
	if (s.headingId) {
		for (const a of m.anchors) if (stringAt(m.strings, a.idOffset) === s.headingId) return a.y;
	}
	return null;
}

/** The lines of blocks intersecting layout y span [y0, y1] em, for calibration. */
export function lineRangeForYSpan(m: ReadingModel, y0: number, y1: number): LineRange {
	const a = blockAtY(m.blocks, y0);
	if (a < 0) return { first: 0, last: 0 };
	let z = blockAtY(m.blocks, y1);
	if (z < a) z = a;
	const A = m.blocks[a], Z = m.blocks[z];
	return { first: A.firstLine, last: Z.firstLine + Z.lineCount };
}
/** Note line ranges intersecting y span (notes overlap blocks in y, few: linear scan). */
export function noteRangesForYSpan(m: ReadingModel, y0: number, y1: number): LineRange[] {
	const out: LineRange[] = [];
	for (const n of m.notes) if (n.y1 > y0 && n.y0 < y1 && n.lineCount > 0) out.push({ first: n.firstLine, last: n.firstLine + n.lineCount });
	return out;
}

/** Level-2 (section) heading blocks in order. */
export const sectionBlocks = (m: ReadingModel): number[] => {
	const out: number[] = [];
	m.blocks.forEach((b, i) => { if (b.kind === BlockKind.heading && (b.level || 2) <= 2) out.push(i); });
	return out;
};

/** id to anchor record */
export function anchorMap(m: ReadingModel): Map<string, { block: number; y: number }> {
	const out = new Map<string, { block: number; y: number }>();
	for (const a of m.anchors) {
		const id = stringAt(m.strings, a.idOffset);
		if (id && !out.has(id)) out.set(id, { block: a.block, y: a.y });
	}
	return out;
}

// ---- controller ---------------------------------------------------------------------------------------------------

export interface ScrollEnv {
	scroller: HTMLElement;
	getModel(): ReadingModel;
	getEmPx(): number;
	/** RD.foldClipEm now */
	getClipEm(): number;
	getBarPx(): number;
	isFoldExpanded(): boolean;
	setFold(expanded: boolean, instant: boolean): void;
	/** push a pending fold or geometry change into the DOM height now (so scrollTop is valid) */
	syncLayout(): void;
	reduced(): boolean;
	blockEl(i: number): HTMLElement | undefined;
	scale(): number;
	fromWorld(): boolean;
	/** history entries: replace or push the hash (the host routes through SvelteKit) */
	replaceHash(hash: string): void;
	pushHash(hash: string): void;
}

export interface ScrollController {
	/** the anchor key of the current position (for a reload at another class) */
	key(): SavedState | null;
	save(): void;
	scheduleSave(): void;
	restore(s: SavedState): boolean;
	/** restore from history.state when it carries an anchor */
	restoreFromHistory(): boolean;
	goToAnchor(id: string, o?: { smooth?: boolean; push?: boolean }): boolean;
	goToHash(hash: string, o?: { smooth?: boolean }): boolean;
	scrollToBlock(i: number, smooth?: boolean): void;
	jump(dir: 1 | -1): void;
	spy(block: number): void;
	wash(block: number): void;
	dispose(): void;
}

const nativeReplace: History['replaceState'] | null = typeof History !== 'undefined' ? History.prototype.replaceState : null;

export function readHistoryState(): SavedState | null {
	const s = (typeof history !== 'undefined' ? history.state : null) as Partial<SavedState> | null;
	return s && typeof s.blockId === 'number' && typeof s.offsetEm === 'number' ? (s as SavedState) : null;
}

export function createScrollState(env: ScrollEnv): ScrollController {
	if (typeof history !== 'undefined') history.scrollRestoration = 'manual';
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let washTimer: ReturnType<typeof setTimeout> | undefined;
	let washEl: HTMLElement | null = null;
	let spyTimer: ReturnType<typeof setTimeout> | undefined;
	let spyLast = -2;
	let spyHold = 0;
	let amapModel: ReadingModel | null = null;
	let amap = new Map<string, { block: number; y: number }>();
	let secs: number[] = [];
	const maps = () => {
		const m = env.getModel();
		if (amapModel !== m) { amapModel = m; amap = anchorMap(m); secs = sectionBlocks(m); }
		return m;
	};
	const instant = (): ScrollToOptions['behavior'] => 'auto';
	const smooth = (want: boolean): ScrollToOptions['behavior'] => (want && !env.reduced() ? 'smooth' : 'auto');
	const marginPx = () => env.getBarPx() + LINE_EM * env.getEmPx();
	const topFor = (layoutY: number) => {
		const m = env.getModel();
		return Math.max(0, layoutToDocY(m, layoutY, env.getClipEm()) * env.getEmPx() - marginPx());
	};

	function key(): SavedState | null {
		const m = env.getModel();
		const a = anchorAt(m, env.scroller.scrollTop / env.getEmPx(), env.getClipEm());
		return a ? { ...a, fold: env.isFoldExpanded(), scale: env.scale(), fromWorld: env.fromWorld() } : null;
	}
	function save() {
		const k = key();
		if (!k || !nativeReplace || typeof history === 'undefined') return;
		try { nativeReplace.call(history, { ...(history.state ?? {}), ...k }, ''); } catch { /* quota or sandboxed frames */ }
	}
	function scheduleSave() {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(save, 250);
	}
	function restore(s: SavedState): boolean {
		maps();
		if (s.fold && !env.isFoldExpanded()) { env.setFold(true, true); env.syncLayout(); }
		const m = env.getModel();
		const ly = resolveAnchor(m, s);
		if (ly === null) return false;
		env.scroller.scrollTo({ top: Math.max(0, layoutToDocY(m, ly, env.getClipEm()) * env.getEmPx()), behavior: instant() });
		return true;
	}
	function wash(block: number) {
		const el = env.blockEl(block);
		if (!el) return;
		washEl?.classList.remove('wash');
		clearTimeout(washTimer);
		el.classList.add('wash');
		washEl = el;
		washTimer = setTimeout(() => { el.classList.remove('wash'); if (washEl === el) washEl = null; }, 1200);
	}
	function goToAnchor(id: string, o: { smooth?: boolean; push?: boolean } = {}): boolean {
		const m = maps();
		const a = amap.get(id);
		if (!a) return false;
		const b = m.blocks[a.block];
		if (b && (b.flags & BlockFlag.folded) && !env.isFoldExpanded()) { env.setFold(true, true); env.syncLayout(); }
		if (o.push) { save(); env.pushHash(`#${encodeURIComponent(id)}`); }
		spyHold = performance.now() + 900;
		env.scroller.scrollTo({ top: topFor(a.y), behavior: smooth(o.smooth !== false) });
		wash(a.block);
		return true;
	}
	function goToHash(hash: string, o: { smooth?: boolean } = {}): boolean {
		if (!hash || hash === '#') return false;
		let id = hash.startsWith('#') ? hash.slice(1) : hash;
		try { id = decodeURIComponent(id); } catch { /* keep raw */ }
		if (id === 'full') { env.setFold(true, false); return true; }
		return goToAnchor(id, { smooth: o.smooth, push: false });
	}
	function scrollToBlock(i: number, sm = true) {
		const m = maps();
		const b = m.blocks[i];
		if (!b) return;
		if ((b.flags & BlockFlag.folded) && !env.isFoldExpanded()) { env.setFold(true, true); env.syncLayout(); }
		spyHold = performance.now() + 900;
		env.scroller.scrollTo({ top: b.kind === BlockKind.hero ? 0 : topFor(b.y0), behavior: smooth(sm) });
	}
	function jump(dir: 1 | -1) {
		const m = maps();
		const cur = env.scroller.scrollTop;
		const collapsed = !env.isFoldExpanded();
		const ok = (i: number) => !(collapsed && (m.blocks[i].flags & BlockFlag.folded));
		if (dir === 1) {
			for (const i of secs) if (ok(i) && topFor(m.blocks[i].y0) > cur + 2) { scrollToBlock(i); return; }
		} else {
			for (let k = secs.length - 1; k >= 0; k--) {
				const i = secs[k];
				if (ok(i) && topFor(m.blocks[i].y0) < cur - 2) { scrollToBlock(i); return; }
			}
			env.scroller.scrollTo({ top: 0, behavior: smooth(true) });
		}
	}
	function spy(block: number) {
		if (block === spyLast) return;
		spyLast = block;
		clearTimeout(spyTimer);
		spyTimer = setTimeout(() => {
			if (performance.now() < spyHold) return;
			const m = maps();
			const b = m.blocks[block];
			const id = b && b.anchor ? stringAt(m.strings, b.anchor) : '';
			env.replaceHash(id ? `#${encodeURIComponent(id)}` : '');
		}, 250);
	}

	return {
		key, save, scheduleSave, restore,
		restoreFromHistory() {
			const s = readHistoryState();
			return s ? restore(s) : false;
		},
		goToAnchor, goToHash, scrollToBlock, jump, spy, wash,
		dispose() { clearTimeout(saveTimer); clearTimeout(washTimer); clearTimeout(spyTimer); washEl?.classList.remove('wash'); }
	};
}
