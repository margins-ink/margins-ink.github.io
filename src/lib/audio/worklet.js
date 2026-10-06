// AudioWorkletProcessor host for audio.wasm (see audio/src/lib.rs, docs/AUDIO.md).
// No allocation per quantum: it copies two planar f32 blocks out of wasm memory.
class RoomAudio extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const x = new WebAssembly.Instance(options.processorOptions.module, {}).exports;
		this.x = x;
		x.audio_init(sampleRate);
		x.audio_set_master(0);
		this.port.onmessage = ({ data: m }) => {
			switch (m.t) {
				case 'event': x.audio_event(m.kind, m.intensity, m.pan); break;
				case 'elevator': x.audio_set_elevator(m.speed, m.floor); break;
				case 'room': x.audio_set_room(m.w, m.d, m.h); break;
				case 'master': x.audio_set_master(m.g); break;
				case 'scale': x.audio_set_scale(m.g); break;
			}
		};
		this.port.postMessage({ t: 'ready' });
	}
	process(_in, outputs) {
		const out = outputs[0];
		const n = out[0].length;
		this.x.audio_render(n);
		const mem = this.x.memory.buffer;
		out[0].set(new Float32Array(mem, this.x.audio_left_ptr(), n));
		if (out[1]) out[1].set(new Float32Array(mem, this.x.audio_right_ptr(), n));
		return true;
	}
}
registerProcessor('room-audio', RoomAudio);
