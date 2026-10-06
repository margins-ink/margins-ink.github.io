// The object Reader.svelte shares with the chrome components (src/lib/components/reader/*) through Svelte context 'reader'.
// Reactive values are svelte/store stores (this is a .ts file, no runes): read them with `$ctx.scale` style auto-subscription
// (`const { scale } = ctx; $scale`). Functions and plain fields are set by Reader.svelte when the article is ready; chrome components
// are only rendered after that and are remounted on every article or width-class reload.
import { getContext } from 'svelte';
import { writable, type Writable } from 'svelte/store';
import { goto } from '$app/navigation';
import type { ReadingModel } from '../magazine/format';
import type { Reading, ReadingEventKind } from './abi';
import type { PageFrame, Overlay } from './page-api';
import type { ArticleMeta } from './load';
import type { HeadingInfo, TextLayer } from './textlayer';

export const READER_CTX = 'reader';

export interface ReaderCtx {
	mode: 'only' | 'world';
	slug: string;
	fromWorld: boolean;
	reading: Reading | null;
	model: ReadingModel | null;
	meta: ArticleMeta | null;
	root: HTMLElement | null;
	scroller: HTMLElement | null;
	doc: HTMLElement | null;
	layer: TextLayer | null;
	/** headings of the loaded model in order (id, text, level, section) for the contents list */
	headings: HeadingInfo[];

	/** CSS px per em now */
	em(): number;
	widthClass(): number;
	barPx(): number;
	reduced(): boolean;

	/** text-size step (scaleSteps); write through setScale */
	scale: Writable<number>;
	setScale(s: number): void;
	foldExpanded: Writable<boolean>;
	expandFold(instant?: boolean): void;
	collapseFold(): void;
	toggleFold(): void;
	/** RD.section and RD.readingBlock, RD.progress */
	section: Writable<number>;
	readingBlock: Writable<number>;
	progress: Writable<number>;
	/** exclusive relations as the wasm reports them: block under the pointer, focused block, figure being scrubbed, popover/lightbox target */
	hoverBlock: Writable<number>;
	focusBlock: Writable<number>;
	openBlock: Writable<number>;
	/** the Aa text-size menu is open (Bar toggles it, AaMenu renders it) */
	aaOpen: Writable<boolean>;

	scrollToBlock(i: number, smooth?: boolean): void;
	scrollToAnchor(id: string, o?: { smooth?: boolean; push?: boolean }): boolean;
	/** reading_input(kind, a, b), see INPUT in abi.ts */
	input(kind: number, a: number, b?: number): void;
	/** ask for one more page draw (an overlay or a chrome-driven animation changed) */
	requestDraw(): void;
	/** chrome overlay contributors: push Overlay objects into `out`, return true while still animating (keeps the frame loop drawing) */
	overlayProviders: Set<(out: Overlay[], nowMs: number, f: PageFrame) => boolean>;
	/** the world host may adjust each frame before it is drawn (ground alpha, clip, only) */
	frameHook: ((f: PageFrame) => void) | null;
	/** wasm events (section, foldSettled, figureVisible ...) */
	onEvent(cb: (kind: ReadingEventKind, arg: number) => void): () => void;

	/** chrome sets these when it is mounted */
	openLightbox?: (block: number) => void;
	openPopover?: (anchor: HTMLElement, linkIndex: number) => void;
	toggleContents?: () => void;
	/** Esc handlers, called from the last to the first until one returns true (it closed something); then onClose / closeArticle */
	closeStack: (() => boolean)[];

	/** the latest toast message; the Toast component renders it. toast() sets it */
	toastMsg: Writable<{ msg: string; id: number } | null>;
	toast(msg: string): void;
	/** history.back() when the article was opened from the world, else goto('/') */
	closeArticle(): void;
}

export function closeArticle(): void {
	if (typeof history !== 'undefined' && (history.state as { fromWorld?: boolean } | null)?.fromWorld) history.back();
	else void goto('/');
}

export function createReaderCtx(init: { mode: 'only' | 'world'; slug: string; fromWorld: boolean }): ReaderCtx {
	const toastMsg = writable<{ msg: string; id: number } | null>(null);
	let toastId = 0;
	const noop = () => {};
	return {
		...init,
		reading: null, model: null, meta: null, root: null, scroller: null, doc: null, layer: null, headings: [],
		em: () => 18, widthClass: () => 0, barPx: () => 40, reduced: () => false,
		scale: writable(1), setScale: noop,
		foldExpanded: writable(false), expandFold: noop, collapseFold: noop, toggleFold: noop,
		section: writable(-1), readingBlock: writable(-1), progress: writable(0),
		hoverBlock: writable(-1), focusBlock: writable(-1), openBlock: writable(-1), aaOpen: writable(false),
		scrollToBlock: noop, scrollToAnchor: () => false, input: noop, requestDraw: noop,
		overlayProviders: new Set(), frameHook: null, onEvent: () => noop,
		closeStack: [],
		toastMsg, toast(msg: string) { toastMsg.set({ msg, id: ++toastId }); },
		closeArticle
	};
}

export const getReaderCtx = (): ReaderCtx => getContext<ReaderCtx>(READER_CTX);
