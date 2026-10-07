// DOM events to the engine-owned scroll (world/src/scroll.rs). Pure mappers (tested) plus one `attachScroll` that wires a canvas.
// The engine decides everything (units, glide, fling, rubber band, keys); this file only translates and forwards.
import { POINTER_KIND, SCROLL_KEY, type ScrollApi } from './abi';

export interface WheelLike { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean }
export interface PointerLike { pointerId: number; pointerType: string; clientX: number; clientY: number; timeStamp: number }
export interface KeyLike { code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target?: unknown }

/** [dx, dy, deltaMode, ctrl] for `reading_wheel` */
export const wheelArgs = (e: WheelLike): [number, number, number, boolean] => [e.deltaX, e.deltaY, e.deltaMode, e.ctrlKey];

/** 0 mouse, 1 touch, 2 pen (anything else counts as a mouse) */
export const pointerTypeCode = (t: string): number => (t === 'touch' ? 1 : t === 'pen' ? 2 : 0);

/** The id word of `reading_pointer`: the pointer id in the low 16 bits, its type above. */
export const pointerWord = (e: Pick<PointerLike, 'pointerId' | 'pointerType'>): number => (e.pointerId & 0xffff) | (pointerTypeCode(e.pointerType) << 16);

const KEYS: Record<string, number> = {
	Space: SCROLL_KEY.space, PageDown: SCROLL_KEY.pageDown, PageUp: SCROLL_KEY.pageUp, Home: SCROLL_KEY.home, End: SCROLL_KEY.end,
	ArrowDown: SCROLL_KEY.arrowDown, ArrowUp: SCROLL_KEY.arrowUp
};

/** Text fields and controls keep their own keys (Space types a space, activates a button). */
export function isEditable(t: unknown): boolean {
	const el = t as { tagName?: string; isContentEditable?: boolean } | null | undefined;
	if (!el || typeof el.tagName !== 'string') return false;
	return el.isContentEditable === true || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'SUMMARY'].includes(el.tagName.toUpperCase());
}

/** The `reading_key` code of a keydown, or 0 when the page must not scroll for it (modifiers, text fields, other keys).
 *  Shift counts only with Space (page up); Shift+arrow, Shift+Home and the like are selection keys for the engine's select lane. */
export function keyCode(e: KeyLike): number {
	if (e.ctrlKey || e.metaKey || e.altKey || isEditable(e.target)) return 0;
	const c = KEYS[e.code] ?? 0;
	if (c && e.shiftKey && c !== SCROLL_KEY.space) return 0;
	return c;
}

export interface ScrollTarget {
	addEventListener(type: string, fn: (e: never) => void, opts?: AddEventListenerOptions | boolean): void;
	removeEventListener(type: string, fn: (e: never) => void, opts?: EventListenerOptions | boolean): void;
	setPointerCapture?(id: number): void;
	releasePointerCapture?(id: number): void;
}

export interface ScrollOptions {
	/** Called first for every wheel and pointer event (mouse too); return true to swallow it: the engine never sees it. The reader's exhibit routing sits here. */
	filter?: (kind: 'wheel' | 'down' | 'move' | 'up' | 'cancel', e: WheelEvent | PointerEvent) => boolean;
}

/** Wire wheel, touch/pen drag (pointer capture, coalesced moves) and keys of `el` and `keyTarget` (default window) to the engine.
 *  The element needs `touch-action: none` so the browser does not pan it. Returns the detach function. */
export function attachScroll(el: ScrollTarget, api: ScrollApi, keyTarget: ScrollTarget = window as unknown as ScrollTarget, opts: ScrollOptions = {}): () => void {
	const { filter } = opts;
	const onWheel = (e: WheelEvent) => {
		if (filter?.('wheel', e)) return;
		// ctrl + wheel is the browser's zoom: not ours, so it is not prevented
		if (api.wheel(...wheelArgs(e)) && !e.ctrlKey) e.preventDefault();
	};
	const send = (kind: number, e: PointerEvent) => api.pointer(kind, pointerWord(e), e.clientX, e.clientY, e.timeStamp);
	const onDown = (e: PointerEvent) => {
		if (filter?.('down', e)) return;
		if (pointerTypeCode(e.pointerType) === 0 || (e.pointerType === 'mouse' && e.button !== 0)) return;
		if (send(POINTER_KIND.down, e)) el.setPointerCapture?.(e.pointerId);
	};
	const onMove = (e: PointerEvent) => {
		if (filter?.('move', e)) return;
		if (pointerTypeCode(e.pointerType) === 0) return;
		const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
		for (const c of list.length ? list : [e]) send(POINTER_KIND.move, c);
		e.preventDefault();
	};
	const end = (kind: number) => (e: PointerEvent) => {
		if (filter?.(kind === POINTER_KIND.up ? 'up' : 'cancel', e)) return;
		if (pointerTypeCode(e.pointerType) === 0) return;
		send(kind, e);
		el.releasePointerCapture?.(e.pointerId);
	};
	const onUp = end(POINTER_KIND.up), onCancel = end(POINTER_KIND.cancel);
	const onKey = (e: KeyboardEvent) => {
		const c = keyCode(e);
		if (c && api.key(c, e.shiftKey)) e.preventDefault();
	};
	el.addEventListener('wheel', onWheel as never, { passive: false });
	el.addEventListener('pointerdown', onDown as never);
	el.addEventListener('pointermove', onMove as never, { passive: false });
	el.addEventListener('pointerup', onUp as never);
	el.addEventListener('pointercancel', onCancel as never);
	keyTarget.addEventListener('keydown', onKey as never);
	return () => {
		el.removeEventListener('wheel', onWheel as never);
		el.removeEventListener('pointerdown', onDown as never);
		el.removeEventListener('pointermove', onMove as never);
		el.removeEventListener('pointerup', onUp as never);
		el.removeEventListener('pointercancel', onCancel as never);
		keyTarget.removeEventListener('keydown', onKey as never);
	};
}
