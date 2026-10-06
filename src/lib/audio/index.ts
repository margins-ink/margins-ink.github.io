import wasmUrl from './audio.wasm?url';
import workletUrl from './worklet.js?url';

export type AudioEventKind = 'floorPass' | 'ding' | 'grab' | 'place' | 'paperTurn' | 'open' | 'close' | 'scroll' | 'gateRattle' | 'doorSlide' | 'latchClunk';
const KIND_ID: Record<AudioEventKind, number> = {
	floorPass: 0, ding: 1, grab: 2, place: 3, paperTurn: 4, open: 5, close: 6, scroll: 7, gateRattle: 8, doorSlide: 9, latchClunk: 10
};

export interface RoomAudio {
	/** Call from a user gesture (pointerdown/keydown). Idempotent; starts the context and unmutes. */
	resume(): Promise<void>;
	/** speed normalised 0..1 (|v| / max v). Fires floorPass on floor change and the arrival ding on stop. */
	setElevator(speed: number, floor: number): void;
	/**
	 * intensity 0..1 (for 'place' also the book's weight: heavier is lower), pan -1..1.
	 * velocity 0..1 is the impact or scroll speed: scales gain (dB curve, 36 dB range), brightness and duration.
	 * Omitted means a firm default (0.8, -7 dB).
	 */
	event(kind: AudioEventKind, intensity?: number, pan?: number, velocity?: number): void;
	/** Room size in world metres; sets reverb time and size. */
	setReverbRoom(w: number, d: number, h: number): void;
	setMuted(muted: boolean): void;
}

const MASTER = 0.6; // default level, quiet on purpose
const REDUCED_MOTION_SCALE = 0.5;

export function createAudio(): RoomAudio {
	let ctx: AudioContext | null = null;
	let node: AudioWorkletNode | null = null;
	let ready = false;
	let starting: Promise<void> | null = null;
	let muted = false;
	let started = false; // first user gesture seen
	let elevator = { speed: 0, floor: 0 };
	let room: [number, number, number] | null = null;

	const post = (m: object) => node?.port.postMessage(m);
	const applyMaster = () => post({ t: 'master', g: started && !muted ? MASTER : 0 });

	async function start() {
		ctx = new AudioContext({ latencyHint: 'interactive' });
		const [module] = await Promise.all([
			fetch(wasmUrl).then((r) => r.arrayBuffer()).then((b) => WebAssembly.compile(b)),
			ctx.audioWorklet.addModule(workletUrl)
		]);
		node = new AudioWorkletNode(ctx, 'room-audio', {
			numberOfInputs: 0,
			outputChannelCount: [2],
			processorOptions: { module }
		});
		node.connect(ctx.destination);
		await new Promise<void>((res) => {
			node!.port.onmessage = (e) => e.data?.t === 'ready' && res();
		});
		ready = true;
		const rm = matchMedia('(prefers-reduced-motion: reduce)');
		const scale = () => post({ t: 'scale', g: rm.matches ? REDUCED_MOTION_SCALE : 1 });
		scale();
		rm.addEventListener('change', scale);
		if (room) post({ t: 'room', w: room[0], d: room[1], h: room[2] });
		post({ t: 'elevator', ...elevator });
		applyMaster();
	}

	return {
		async resume() {
			started = true;
			if (typeof AudioContext === 'undefined') return;
			starting ??= start().catch((e) => {
				console.warn('audio unavailable', e);
			});
			await starting;
			if (ctx?.state === 'suspended') await ctx.resume();
			applyMaster();
		},
		setElevator(speed, floor) {
			elevator = { speed, floor: Math.round(floor) };
			if (ready) post({ t: 'elevator', ...elevator });
		},
		event(kind, intensity = 0.6, pan = 0, velocity) {
			if (ready && started && !muted) post({ t: 'event', kind: KIND_ID[kind], intensity, pan, velocity });
		},
		setReverbRoom(w, d, h) {
			room = [w, d, h];
			if (ready) post({ t: 'room', w, d, h });
		},
		setMuted(m) {
			muted = m;
			if (ready) applyMaster();
		}
	};
}
