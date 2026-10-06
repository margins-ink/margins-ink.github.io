// Thin wiring for the elevator (docs/ELEVATOR.md). All logic lives in world/src/elevator.rs; this only forwards scroll,
// reads the state buffer, hands out the cab rows and turns events into audio calls.
import type { RoomAudio } from '$lib/audio';

interface ElevatorExports {
	memory: WebAssembly.Memory;
	elevator_tick(dtMs: number): void;
	elevator_scroll(p: number): void;
	elevator_goto(floor: number, snap: number): void;
	elevator_hold(on: number): void;
	elevator_event_poll(): number;
	elevator_state_ptr(): number;
	elevator_rows_ptr(): number;
}

export const STATE_LEN = 40;
/** state[] indices, see docs/ELEVATOR.md */
export const ES = {
	posM: 0, frac: 1, speed: 2, floor: 3, target: 4, gate: 5, doors: 6, lens: 7, needle: 9, car: 10, doorsCode: 11, gateCode: 12, sway: 13, push: 14,
	yaw: 16, pitch: 17, thCab: 18, settled: 19, cabStart: 36, cabCount: 37, eye: 38, pushM: 39
} as const;

export interface Elevator {
	/** Call every frame before reader.tick (which runs the Flecs pipeline). */
	tick(dtMs: number): void;
	scroll(p: number): void;
	goto(floor: number, snap?: boolean): void;
	hold(on: boolean): void;
	state(): Float32Array;
	/** Live cab rows (count * 28 f32); write them to the objs buffer at cabStart * 28 * 4 bytes. */
	rows(): Float32Array;
	/** Drain events into the audio engine. Returns the number handled. */
	pump(audio: RoomAudio): number;
}

export function elevatorApi(x: ElevatorExports): Elevator {
	const state = () => new Float32Array(x.memory.buffer, x.elevator_state_ptr(), STATE_LEN);
	return {
		tick: (dt) => x.elevator_tick(dt),
		scroll: (p) => x.elevator_scroll(p),
		goto: (f, snap = false) => x.elevator_goto(f, snap ? 1 : 0),
		hold: (on) => x.elevator_hold(on ? 1 : 0),
		state,
		rows() {
			const s = state();
			return new Float32Array(x.memory.buffer, x.elevator_rows_ptr(), s[ES.cabCount] * 28);
		},
		pump(audio) {
			let n = 0;
			for (let v = x.elevator_event_poll(); v !== 0; v = x.elevator_event_poll(), n++) {
				const kind = v >>> 24;
				const arg = v & 0xffffff;
				if (kind === 1) audio.event('gateRattle', 0.6);
				else if (kind === 2) audio.event('doorSlide', 0.6);
				else if (kind === 3) audio.event('latchClunk', Math.max(0.2, arg / 255), 0, 0.5 + 0.5 * (arg / 255));
				else if (kind === 4) audio.event('ding', 0.8);
				else if (kind === 5) audio.event('floorPass', 0.4);
			}
			return n;
		}
	};
}
