// bun run test:audio: renders every sound through the real audio.wasm to WAV, checks peak/RMS and determinism.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const wasmPath = join(dirname(import.meta.path), "../../src/lib/audio/audio.wasm");
const outDir = process.env.AUDIO_OUT ?? "/Volumes/Projects/tmp/audio";
mkdirSync(outDir, { recursive: true });
const SR = 48000;
const KINDS = ["floorPass", "ding", "grab", "place", "paperTurn", "open", "close"] as const;
const wasmBytes = await Bun.file(wasmPath).arrayBuffer();
const wasmModule = await WebAssembly.compile(wasmBytes);

type S = Awaited<ReturnType<typeof synth>>;
type Buf = readonly [Float32Array, Float32Array];

async function synth() {
	const instance = await WebAssembly.instantiate(wasmModule, {});
	const x = instance.exports as any;
	x.audio_init(SR);
	x.audio_set_master(0.5);
	return {
		x,
		render(secs: number): Buf {
			const n = Math.round(secs * SR);
			const L = new Float32Array(n), R = new Float32Array(n);
			for (let o = 0; o < n; o += 128) {
				const c = Math.min(128, n - o);
				x.audio_render(c);
				const mem = x.memory.buffer;
				L.set(new Float32Array(mem, x.audio_left_ptr(), c), o);
				R.set(new Float32Array(mem, x.audio_right_ptr(), c), o);
			}
			return [L, R];
		},
	};
}

function concat(parts: Buf[]): Buf {
	const cat = (i: 0 | 1) => {
		const a = new Float32Array(parts.reduce((n, p) => n + p[i].length, 0));
		let o = 0;
		for (const p of parts) { a.set(p[i], o); o += p[i].length; }
		return a;
	};
	return [cat(0), cat(1)];
}

function wav(L: Float32Array, R: Float32Array) {
	const n = L.length, b = Buffer.alloc(44 + n * 8);
	b.write("RIFF", 0); b.writeUInt32LE(36 + n * 8, 4); b.write("WAVEfmt ", 8);
	b.writeUInt32LE(16, 16); b.writeUInt16LE(3, 20); b.writeUInt16LE(2, 22);
	b.writeUInt32LE(SR, 24); b.writeUInt32LE(SR * 8, 28); b.writeUInt16LE(8, 32); b.writeUInt16LE(32, 34);
	b.write("data", 36); b.writeUInt32LE(n * 8, 40);
	for (let i = 0; i < n; i++) { b.writeFloatLE(L[i], 44 + i * 8); b.writeFloatLE(R[i], 48 + i * 8); }
	return b;
}

function stats(L: Float32Array, R: Float32Array) {
	let peak = 0, sum = 0;
	for (let i = 0; i < L.length; i++) {
		peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
		sum += L[i] * L[i] + R[i] * R[i];
	}
	return { peak, rms: Math.sqrt(sum / (2 * L.length)) };
}

const cases: { name: string; run: (s: S) => Buf }[] = [];
KINDS.forEach((k, id) =>
	cases.push({ name: k, run: (s) => { s.x.audio_event(id, 0.8, k === "grab" ? -0.6 : 0); return s.render(2.6); } }),
);
// velocity: slow/medium/fast one-shots through the real wasm; RMS must rise monotonically, slow >= 12 dB below fast
const velRms: Record<string, number[]> = {};
for (const k of ["grab", "place", "paperTurn", "open", "close", "scroll"] as const) {
	const id = [...KINDS, "scroll"].indexOf(k);
	for (const v of [0.15, 0.5, 1.0]) {
		cases.push({ name: `vel_${k}_${v}`, run: (s) => { s.x.audio_event_v(id, 0.7, 0, v); return s.render(1.5); } });
	}
}
for (const v of [0.15, 0.5, 1.0]) {
	cases.push({ name: `vel_elevator_${v}`, run: (s) => { s.x.audio_set_elevator(v, 0); return s.render(4); } });
}
cases.push({ name: "place_small", run: (s) => { s.x.audio_event(3, 0.1, 0); return s.render(1.2); } });
cases.push({ name: "place_heavy", run: (s) => { s.x.audio_event(3, 1.0, 0); return s.render(1.2); } });
cases.push({ name: "elevator_idle", run: (s) => { s.x.audio_set_elevator(0, 0); return s.render(1.5); } });
cases.push({
	name: "elevator_run",
	run: (s) => {
		const parts: Buf[] = [];
		s.x.audio_set_elevator(0, 0); parts.push(s.render(0.5));
		for (let f = 1; f <= 3; f++) { s.x.audio_set_elevator(1, f); parts.push(s.render(1.0)); }
		s.x.audio_set_elevator(0, 3); parts.push(s.render(3.0)); // arrival ding fires here
		return concat(parts);
	},
});
cases.push({ name: "room_large", run: (s) => { s.x.audio_set_room(30, 40, 12); s.x.audio_event(1, 0.8, 0); return s.render(4); } });
cases.push({
	name: "stress_all",
	run: (s) => {
		for (let r = 0; r < 4; r++) KINDS.forEach((_, i) => s.x.audio_event(i, 1, 0));
		s.x.audio_set_elevator(1, 1);
		return s.render(2);
	},
});

let fail = 0;
let idleRms = 0;
const h = (b: Buf) => createHash("sha256").update(b[0]).update(b[1]).digest("hex").slice(0, 8);
console.log("name              peak    rms     sha8      deterministic");
for (const c of cases) {
	const a = c.run(await synth());
	const b = c.run(await synth());
	const { peak, rms } = stats(a[0], a[1]);
	const det = h(a) === h(b);
	if (c.name === "elevator_idle") idleRms = rms;
	if (c.name.startsWith("vel_")) { const [, k, v] = c.name.split("_"); (velRms[k] ??= []).push(rms); }
	const ok = det && peak < 0.61 && (rms > 1e-4 || c.name.startsWith("vel_")) && Number.isFinite(peak);
	if (!ok) fail++;
	writeFileSync(join(outDir, `${c.name}.wav`), wav(a[0], a[1]));
	console.log(`${c.name.padEnd(17)} ${peak.toFixed(3)}   ${rms.toFixed(4)}  ${h(a)}  ${det ? "yes" : "NO"}${ok ? "" : "  FAIL"}`);
}
// the parked elevator hum (elevator_idle, same 1.5 s) is a noise floor under every one-shot: subtract its power
for (const [k, r0] of Object.entries(velRms)) {
	const r = k === "elevator" ? r0 : r0.map((x) => Math.sqrt(Math.max(x * x - idleRms * idleRms, 1e-12)));
	const db = 20 * Math.log10(r[0] / r[2]);
	const ok = r[0] < r[1] && r[1] < r[2] && db <= -12;
	if (!ok) fail++;
	console.log(`velocity ${k.padEnd(10)} rms ${r.map((x) => x.toExponential(2)).join(" < ")}  slow vs fast ${db.toFixed(1)} dB  ${ok ? "ok" : "FAIL"}`);
}
{
	const s = await synth();
	s.x.audio_set_master(0);
	s.x.audio_event(1, 1, 0);
	const [L, R] = s.render(0.5);
	const { peak } = stats(L, R);
	const ok = peak < 1e-6;
	if (!ok) fail++;
	console.log(`muted             ${peak.toExponential(1)}  ${ok ? "silent ok" : "FAIL"}`);
}
console.log(`wavs in ${outDir}; ${fail ? fail + " FAILED" : "all ok"}`);
process.exit(fail ? 1 : 0);
