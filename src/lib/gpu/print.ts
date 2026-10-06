import { COLS, ROWS, type Cover, type CoverPalette } from '$lib/covers/types';

/**
 * Riso-print renderer for pixel-art covers.
 *
 * The cover is uploaded as a 64x24 texture and drawn by one fragment shader that
 * adds what a printing press adds: per-channel plate misregistration, a rotated
 * halftone screen over the ink, paper fibre grain and ink dropout. One static
 * frame, redrawn only on resize or colour-scheme change. No animation.
 */

const WGSL = /* wgsl */ `
struct U {
  res: vec2f,
  grid: vec2f,
  paper: vec4f,
  seed: f32,
  dark: f32,
  pad: vec2f,
};
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var art: texture_2d<f32>;

@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn hash(p: vec2f) -> f32 {
  var q = fract(p * vec2f(123.34, 456.21) + u.seed);
  q += dot(q, q + 45.32);
  return fract(q.x * q.y);
}

fn noise(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let s = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2f(1.0, 0.0)), s.x),
             mix(hash(i + vec2f(0.0, 1.0)), hash(i + vec2f(1.0, 1.0)), s.x), s.y);
}

fn plate(px: vec2f) -> vec3f {
  let uv = px / u.res;
  let c = clamp(vec2i(floor(uv * u.grid)), vec2i(0), vec2i(u.grid) - vec2i(1));
  return textureLoad(art, c, 0).rgb;
}

@fragment
fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let px = pos.xy;
  let cell = u.res.x / u.grid.x;
  let off = max(cell * 0.09, 1.0);

  // each channel is its own plate, nudged out of register
  let r = plate(px + vec2f(off, 0.4 * off)).r;
  let g = plate(px + vec2f(-0.3 * off, -off)).g;
  let b = plate(px + vec2f(-off, 0.5 * off)).b;
  var col = vec3f(r, g, b);

  // halftone screen at 45 degrees, only darkens ink slightly so flat colour stays flat
  let s = 0.7071;
  let q = vec2f(px.x * s + px.y * s, -px.x * s + px.y * s) / (cell * 0.42);
  let d = length(fract(q) - 0.5);
  let dots = smoothstep(0.34, 0.46, d);
  let lum = dot(col, vec3f(0.299, 0.587, 0.114));
  let ink = clamp(abs(lum - dot(u.paper.rgb, vec3f(0.299, 0.587, 0.114))) * 3.0, 0.0, 1.0);
  col = mix(col, col * (0.82 + 0.18 * dots), ink * 0.9);

  // paper fibres and ink dropout
  let fibre = noise(px * vec2f(0.9, 0.12)) * 0.5 + noise(px * 0.55) * 0.5;
  col *= 0.94 + 0.08 * fibre;
  let drop = step(0.985, hash(floor(px * 0.7)));
  col = mix(col, mix(col, u.paper.rgb, 0.6), drop * ink);

  // press vignette
  let v = (px / u.res) - 0.5;
  col *= 1.0 - 0.14 * dot(v, v);
  return vec4f(col, 1.0);
}
`;

function hexRgb(hex: string): [number, number, number] {
	const n = parseInt(hex.replace('#', ''), 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function pixels(cover: Cover, pal: CoverPalette): Uint8Array {
	const out = new Uint8Array(COLS * ROWS * 4);
	const bg = hexRgb(pal.bg);
	for (let y = 0; y < ROWS; y++) {
		for (let x = 0; x < COLS; x++) {
			const ch = cover.rows[y]?.[x] ?? '.';
			const [r, g, b] = ch !== '.' && pal.ink[ch] ? hexRgb(pal.ink[ch]) : bg;
			out.set([r, g, b, 255], (y * COLS + x) * 4);
		}
	}
	return out;
}

export interface Print {
	redraw(): void;
	destroy(): void;
}

let devicePromise: Promise<GPUDevice | null> | null = null;
function getDevice(): Promise<GPUDevice | null> {
	devicePromise ??= (async () => {
		if (!('gpu' in navigator)) return null;
		const adapter = await navigator.gpu.requestAdapter();
		return adapter ? adapter.requestDevice() : null;
	})().catch(() => null);
	return devicePromise;
}

/** Returns null when WebGPU is unavailable or setup fails; the caller keeps its static poster. */
export async function createPrint(
	canvas: HTMLCanvasElement,
	cover: Cover,
	seed = 1
): Promise<Print | null> {
	const device = await getDevice();
	const ctx = canvas.getContext('webgpu');
	if (!device || !ctx) return null;

	device.pushErrorScope('validation');
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: 'opaque' });

	const module = device.createShaderModule({ code: WGSL });
	const pipeline = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module, entryPoint: 'vs' },
		fragment: { module, entryPoint: 'fs', targets: [{ format }] }
	});
	const uniform = device.createBuffer({
		size: 48,
		usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
	});
	const texture = device.createTexture({
		size: [COLS, ROWS],
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
	});
	const bind = device.createBindGroup({
		layout: pipeline.getBindGroupLayout(0),
		entries: [
			{ binding: 0, resource: { buffer: uniform } },
			{ binding: 1, resource: texture.createView() }
		]
	});
	if (await device.popErrorScope()) return null;

	const mq = matchMedia('(prefers-color-scheme: dark)');
	let dead = false;

	const draw = () => {
		if (dead) return;
		const dark = mq.matches;
		const pal = dark ? cover.dark : cover.light;
		const dpr = Math.min(devicePixelRatio || 1, 2);
		const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
		const h = Math.max(1, Math.round((w * ROWS) / COLS));
		canvas.width = w;
		canvas.height = h;
		device.queue.writeTexture(
			{ texture },
			pixels(cover, pal) as BufferSource,
			{ bytesPerRow: COLS * 4 },
			[COLS, ROWS]
		);
		const bg = hexRgb(pal.bg).map((v) => v / 255);
		device.queue.writeBuffer(
			uniform,
			0,
			new Float32Array([w, h, COLS, ROWS, bg[0], bg[1], bg[2], 1, seed, dark ? 1 : 0, 0, 0])
		);
		const enc = device.createCommandEncoder();
		const pass = enc.beginRenderPass({
			colorAttachments: [
				{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }
			]
		});
		pass.setPipeline(pipeline);
		pass.setBindGroup(0, bind);
		pass.draw(3);
		pass.end();
		device.queue.submit([enc.finish()]);
	};

	const ro = new ResizeObserver(draw);
	ro.observe(canvas);
	mq.addEventListener('change', draw);
	draw();

	return {
		redraw: draw,
		destroy() {
			dead = true;
			ro.disconnect();
			mq.removeEventListener('change', draw);
			texture.destroy();
			uniform.destroy();
		}
	};
}
