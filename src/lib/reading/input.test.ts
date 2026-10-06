import { describe, expect, test } from 'bun:test';
import { createScrollApi, POINTER_KIND, SCROLL_KEY } from './abi';
import { attachScroll, isEditable, keyCode, pointerTypeCode, pointerWord, wheelArgs } from './input';

const key = (code: string, o: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: unknown }> = {}) =>
	keyCode({ code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...o });

describe('input mappers', () => {
	test('wheel args pass deltas, mode and ctrl untouched', () => {
		expect(wheelArgs({ deltaX: 1, deltaY: -120, deltaMode: 1, ctrlKey: true })).toEqual([1, -120, 1, true]);
		expect(wheelArgs({ deltaX: 0, deltaY: 3.5, deltaMode: 0, ctrlKey: false })).toEqual([0, 3.5, 0, false]);
	});
	test('pointer word holds id and type', () => {
		expect(pointerTypeCode('mouse')).toBe(0);
		expect(pointerTypeCode('touch')).toBe(1);
		expect(pointerTypeCode('pen')).toBe(2);
		expect(pointerWord({ pointerId: 7, pointerType: 'touch' })).toBe((1 << 16) | 7);
		expect(pointerWord({ pointerId: 0x1_0003, pointerType: 'pen' })).toBe((2 << 16) | 3);
		expect(pointerWord({ pointerId: 1, pointerType: 'mouse' }) >> 16).toBe(0);
	});
	test('scroll keys', () => {
		expect(key('Space')).toBe(SCROLL_KEY.space);
		expect(key('Space', { shiftKey: true })).toBe(SCROLL_KEY.space);
		expect(key('PageDown')).toBe(SCROLL_KEY.pageDown);
		expect(key('PageUp')).toBe(SCROLL_KEY.pageUp);
		expect(key('Home')).toBe(SCROLL_KEY.home);
		expect(key('End')).toBe(SCROLL_KEY.end);
		expect(key('ArrowDown')).toBe(SCROLL_KEY.arrowDown);
		expect(key('ArrowUp')).toBe(SCROLL_KEY.arrowUp);
	});
	test('keys the page must leave alone', () => {
		expect(key('KeyJ')).toBe(0); // J/K/E/T keep their own meaning elsewhere
		expect(key('ArrowDown', { shiftKey: true })).toBe(0);
		expect(key('End', { shiftKey: true })).toBe(0);
		for (const m of ['ctrlKey', 'metaKey', 'altKey'] as const) expect(key('Space', { [m]: true })).toBe(0);
		expect(key('Space', { target: { tagName: 'INPUT' } })).toBe(0);
		expect(key('Space', { target: { tagName: 'div', isContentEditable: true } })).toBe(0);
		expect(key('Space', { target: { tagName: 'CANVAS' } })).toBe(SCROLL_KEY.space);
		expect(isEditable(null)).toBe(false);
	});
});

describe('attachScroll', () => {
	type Fn = (e: never) => void;
	function fake() {
		const l = new Map<string, Fn>();
		const calls: unknown[][] = [];
		const el = {
			addEventListener: (t: string, f: Fn) => void l.set(t, f),
			removeEventListener: (t: string) => void l.delete(t),
			setPointerCapture: (id: number) => void calls.push(['capture', id]),
			releasePointerCapture: (id: number) => void calls.push(['release', id])
		};
		const api = createScrollApi({
			reading_wheel: (dx, dy, m, c) => (calls.push(['wheel', dx, dy, m, c]), c ? 0 : 1),
			reading_pointer: (k, id, x, y, t) => (calls.push(['pointer', k, id, x, y, t]), 1),
			reading_key: (c, s) => (calls.push(['key', c, s]), c === SCROLL_KEY.space ? 1 : 0),
			reading_scroll_to: (y, s) => void calls.push(['to', y, s])
		});
		const keys = new Map<string, Fn>();
		const detach = attachScroll(el, api, { addEventListener: (t, f) => void keys.set(t, f), removeEventListener: (t) => void keys.delete(t) });
		return { l, keys, calls, detach, api };
	}
	test('wheel prevents default only when the engine scrolls; pinch is passed but not prevented', () => {
		const { l, calls } = fake();
		let prevented = 0;
		l.get('wheel')!({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: false, preventDefault: () => prevented++ } as never);
		l.get('wheel')!({ deltaX: 0, deltaY: 100, deltaMode: 0, ctrlKey: true, preventDefault: () => prevented++ } as never);
		expect(prevented).toBe(1);
		expect(calls).toEqual([['wheel', 0, 100, 0, 0], ['wheel', 0, 100, 0, 1]]);
	});
	test('touch drag forwards down, coalesced moves, up, with capture; the mouse is not forwarded', () => {
		const { l, calls } = fake();
		const p = (type: string, y: number, t: number) => ({ pointerId: 3, pointerType: type, clientX: 5, clientY: y, timeStamp: t, button: 0, preventDefault() {}, getCoalescedEvents: () => [] });
		l.get('pointerdown')!(p('touch', 10, 1000.5) as never);
		const m = p('touch', 20, 1016);
		m.getCoalescedEvents = () => [p('touch', 15, 1008), p('touch', 20, 1016)] as never;
		l.get('pointermove')!(m as never);
		l.get('pointerup')!(p('touch', 20, 1020) as never);
		l.get('pointerdown')!(p('mouse', 10, 1) as never);
		const w = (1 << 16) | 3;
		expect(calls).toEqual([
			['pointer', POINTER_KIND.down, w, 5, 10, 1000.5], ['capture', 3],
			['pointer', POINTER_KIND.move, w, 5, 15, 1008], ['pointer', POINTER_KIND.move, w, 5, 20, 1016],
			['pointer', POINTER_KIND.up, w, 5, 20, 1020], ['release', 3]
		]);
	});
	test('keys: consumed ones are prevented, others untouched, detach removes the listeners', () => {
		const { keys, calls, detach, l } = fake();
		let prevented = 0;
		const ev = (code: string) => ({ code, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, target: {}, preventDefault: () => prevented++ });
		keys.get('keydown')!(ev('Space') as never);
		keys.get('keydown')!(ev('PageDown') as never);
		keys.get('keydown')!(ev('KeyJ') as never);
		expect(prevented).toBe(1);
		expect(calls).toEqual([['key', SCROLL_KEY.space, 0], ['key', SCROLL_KEY.pageDown, 0]]);
		detach();
		expect(keys.size).toBe(0);
		expect(l.size).toBe(0);
	});
});
