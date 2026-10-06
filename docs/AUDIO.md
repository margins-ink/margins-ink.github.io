# Audio

Procedural sound for the room. Nothing is sampled: every sound is synthesised at run time by [fundsp](https://github.com/SamiPerttu/fundsp) 0.23.0 compiled to `wasm32-unknown-unknown` (no WASI, no imports, about 275 KB) and run inside an AudioWorklet.

```
audio/src/lib.rs        Synth: voices, elevator drone, reverb, raw wasm exports (audio_event, audio_set_elevator, ...)
audio/build.ts          `bun run build:audio`  -> src/lib/audio/audio.wasm (committed, like world.wasm; wasm-opt -O3 if bunx finds it)
audio/test/render.ts    `bun run test:audio`   -> WAVs in /Volumes/Projects/tmp/audio/ plus peak/RMS/determinism table
src/lib/audio/index.ts  createAudio()  (main thread: context, mute, reduced motion, message passing)
src/lib/audio/worklet.js  AudioWorkletProcessor: owns the wasm instance, renders 128-frame quanta
```

## Sounds

| Event | Synthesis |
|---|---|
| elevator (continuous) | motor hum: sines at f, 2f, f/2 plus a low-passed saw at 3f, pitch 30 + 34*speed Hz (smoothed, 0.25 s); level follows speed over a faint parked hum; brown-noise cable rumble and band-passed 6 Hz ticking scaled by speed squared |
| `floorPass` | faint band-passed tick plus a 110 Hz blip; fired by `setElevator` when `floor` changes while moving |
| `ding` | hotel-bell partials 880 Hz x 1, 2.76, 5.40, 8.93 plus a 1.7 Hz beating pair; fired by `setElevator` when speed falls to 0 (arrival) |
| `grab` | cloth/cardboard scrape: two band-passed noise layers (1.9 kHz, 520 Hz) with irregular amplitude chatter |
| `place` | modal thump: decaying sines at f0 x 1, 2.32, 4.25, 6.63 plus a low-passed click; f0 = 210 - 130*intensity Hz, so intensity doubles as weight (heavier is lower and longer) |
| `paperTurn` | 3.8 kHz and 7 kHz band-passed noise with 24 to 37 Hz flutter |
| `open` / `close` | cover scrape plus page whisper / soft low thud plus click |

Room reverb: fundsp `reverb_stereo`, RT60 from Sabine (`0.161 V / (0.3 S)`, clamped 0.3 to 2.5 s) and size from the cube root of the volume; wet mix 0.22. `setReverbRoom(w,d,h)` rebuilds it (the old tail is dropped).

Gain staging: voices sum into a master with a soft limiter, `0.6 * tanh(x / 0.6)`: smooth knee, hard loudness ceiling 0.6 (-4.4 dBFS), so output cannot clip. Default master 0.6 on the host side. Measured stress mix (all 8 kinds x4 at velocity 1 plus the elevator at full speed, master 1.0): peak 0.595. `prefers-reduced-motion: reduce` halves everything (live, via the media-query listener). Master is 0 until the first `resume()` (a user gesture, per the autoplay policy); events before that are dropped, and `setMuted(true)` ramps to 0 over about 15 ms and also drops events.

## Velocity

Everything is velocity-aware so slow motion is near silent. Constants live at the top of `audio/src/lib.rs`.

Elevator: `setElevator(speed, floor)` is unchanged. The target speed is smoothed per sample (one pole, 0.3 s) and the smoothed value drives everything, so there is no step at start or stop (first 20 ms after a full-speed command stays under 0.02 RMS).
- hum level = `0.02 + 0.98 * s^1.5` (parked hum -34 dB below full speed)
- hum pitch = `30 + 34 * s` Hz (plus 0.4 Hz per floor mod 8)
- rattle (rumble and ticks) = `s^2.5`
- floorPass fired with velocity `s`

One-shots: `event(kind, intensity, pan, velocity)`, velocity 0..1 (impact speed or scroll speed). Omitted gives 0.8 (-7 dB), so existing calls keep working.
- gain = `10^(-36 (1 - v) / 20)`: dB-linear, 0 dB at 1, -36 dB at 0 (multiplies the intensity gain)
- brightness: two one-pole lowpasses, cutoff `500 * (16000/500)^v` Hz (500 Hz at 0, 16 kHz at 1)
- duration: `secs * (0.5 + 0.5 v)` with a 25 % fade-out, so soft hits are shorter
- `scroll` (kind 7) is a short dry rustle for scroll or page-flick speed; `paperTurn` takes the same argument.

Wasm: new export `audio_event_v(kind, intensity, pan, velocity)`; `audio_event` calls it with 0.8. The worklet uses `audio_event_v` only when the message carries `velocity`.

Measured (cargo test and `bun run test:audio`, master 0.5, RMS of the 1.5 s render with the parked hum power subtracted, velocity 0.15 / 0.5 / 1.0, slow vs fast): elevator (steady state, speed 0.15/0.5/1.0) 2.6e-3 / 1.3e-2 / 4.4e-2, -24.7 dB; grab -41.7 dB; place -30.7; paperTurn -53.3; open -34.2; close -31.2; scroll -52.0. Required: strictly rising and slow at least 12 dB below fast.

## Contract

```ts
createAudio(): {
  resume(): Promise<void>                     // call from pointerdown/keydown; creates the context lazily
  setElevator(speed: number, floor: number)   // speed normalised 0..1; call every frame, cheap
  event(kind, intensity = 0.6, pan = 0, velocity?)  // 'floorPass'|'ding'|'grab'|'place'|'paperTurn'|'open'|'close'|'scroll'; intensity 0..1, pan -1..1, velocity 0..1 (default 0.8)
  setReverbRoom(w, d, h)                      // metres
  setMuted(b: boolean)
}
```

Raw wasm exports: `audio_init(sr)`, `audio_render(frames <= 4096)`, `audio_left_ptr/right_ptr`, `audio_event(kind,i,pan)`, `audio_event_v(kind,i,pan,velocity)`, `audio_set_elevator(speed,floor)`, `audio_set_room(w,d,h)`, `audio_set_master(g)`, `audio_set_scale(g)`. Kind ids follow the order above (0 floorPass ... 6 close, 7 scroll).

## Hooks for the root (about 6 lines)

`src/lib/components/World.svelte`:
1. `import { createAudio } from '$lib/audio';` and `const audio = createAudio();` at the top of the script.
2. In the existing `pointerdown` handler `down` (line ~215): `audio.resume();` (also on `keydown`/wheel if wanted).
3. In `r?.onReader((e) => ...)`: `if (e.kind === 'opened') audio.event('open', 0.7, 0); else if (e.kind === 'closed') audio.event('close', 0.7, 0);` and for `page` also `audio.event('paperTurn', 0.6, 0)`.

`src/lib/gpu/room/room.ts` (take `audio` as a `createRoom` option or import a module-level instance):
4. After `shown` is updated (around line 726): `audio.setElevator(settling ? Math.min(1, Math.abs(diff) * (levels.length - 1) / 1.5) : 0, Math.round(shown * (levels.length - 1)));`. The 1.5 is the number of floors of remaining travel that counts as full speed; tune by ear.
5. Once after the world loads: `audio.setReverbRoom(<room width>, ROOM_D, ROOM_H)`; and where a magazine is picked up or put back (shelf grab and return, when that interaction exists): `audio.event('grab', 0.6, panFromNdcX)` and `audio.event('place', weight, panFromNdcX)`.

The auto-fired `floorPass` and arrival `ding` come from `setElevator`; do not also call `event('ding')`.

## Licence notes

fundsp 0.23.0 is `MIT OR Apache-2.0` (read from `LICENSE-MIT` and `LICENSE-APACHE` in the crate and `license` in its `Cargo.toml`). Built with `default-features = false, features = ["std"]`, which drops `symphonia` (file decoding) and `fft-convolver`. Transitive crates pulled for wasm (wide, glam, funutd, microfft, num-*, resampler, thingbuf, ahash/hashbrown and friends) were checked with `cargo metadata` (2026-10-06): all MIT, Apache-2.0, Zlib, BSD-2-Clause alternatives, or Unicode-3.0 (`unicode-ident`, build-time only); re-check if the lock changes. No GPL or AGPL anywhere; no samples, so no asset licences.

## Verification

`cargo test --release` in `audio/` (native, no wasm) renders slow/medium/fast (0.15/0.5/1.0) of the elevator and every one-shot to WAVs in `/Volumes/Projects/tmp/audio-velocity/`, asserts strictly rising RMS and slow at least 12 dB below fast, that the limiter holds the 0.6 ceiling, and that the elevator has no start step. Planted-bug control: `Synth.flat` bypasses every velocity curve; the same check must fail with it (it does: elevator -0.0 dB slow vs fast). `bun run test:audio` renders each sound through the real wasm twice in fresh instances and requires identical SHA-256 of the output (deterministic), peak below 0.61 (the limiter ceiling), the same velocity monotonicity check through the real wasm, RMS above 1e-4 (non-silent), and silence when master is 0. WAVs (stereo float32, 48 kHz) land in `/Volumes/Projects/tmp/audio/`. Not tested here: browser playback (AudioWorklet host), which needs a real page.
