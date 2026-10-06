import type { Thought } from '$lib/thoughts';
import { accentFor } from '$lib/theme';
import { ATLAS, buildAtlas } from './atlas';
import { buildLightmapLayout } from './lightmap';
import { TRACE } from './shader';
import { loadWorld, type Floor } from './world';

export type { Floor };

export interface Hotspot {
	id: string;
	/** CSS pixels relative to the canvas. */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Room {
	/** 0 (top floor) .. 1 (bottom floor): where the elevator is. */
	setProgress(p: number): void;
	/** Zoom about a screen point given in ndc (-1..1, y up). */
	zoomAt(factor: number, nx: number, ny: number): void;
	panBy(dnx: number, dny: number): void;
	resetView(): void;
	readonly zoom: number;
	floors: Floor[];
	destroy(): void;
}

const SPP = 160;
/** Lightmap samples per texel at convergence, and the GPU time one bake dispatch should take. */
const LM_SPP = 640;
const LM_BUDGET_MS = 5;
/** Reflection probe: octahedral map size, mip count, samples per texel at convergence and per bake step. */
const PROBE_N = 128;
const PROBE_MIPS = 5;
const PROBE_SPP = 256;
const PROBE_STEP = 2;
/** Floats in the Scene uniform (see shader.ts). */
const SCENE_FLOATS = 64;
const CAM_Z = 5.2;
type V3 = [number, number, number];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: V3): V3 => {
	const l = Math.hypot(...a);
	return [a[0] / l, a[1] / l, a[2] / l];
};
const cross = (a: V3, b: V3): V3 => [
	a[1] * b[2] - a[2] * b[1],
	a[2] * b[0] - a[0] * b[2],
	a[0] * b[1] - a[1] * b[0]
];

export async function createRoom(
	canvas: HTMLCanvasElement,
	items: Thought[],
	onLayout: (spots: Hotspot[]) => void,
	opts: { focus?: string } = {}
): Promise<Room | null> {
	if (!('gpu' in navigator)) return null;
	const adapter = await navigator.gpu.requestAdapter();
	const device = adapter && (await adapter.requestDevice());
	const ctx = canvas.getContext('webgpu');
	if (!device || !ctx) return null;

	const DBG = Number(new URLSearchParams(location.search).get('dbg') ?? 0);
	device.addEventListener("uncapturederror", (e) => console.error("webgpu:", (e as GPUUncapturedErrorEvent).error.message));
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: 'opaque' });
	const mq = matchMedia('(prefers-color-scheme: dark)');
	// the scene is declared in the Flecs world (world/scene/*.flecs) and packed in world.wasm
	const world = await loadWorld(items).catch((e) => {
		console.error('room: world.wasm failed', e);
		return null;
	});
	if (!world) return null;
	const { levelH: LEVEL_H, roomH: ROOM_H, roomD: ROOM_D } = world;
	const levels = world.floors;
	const data = world.objs;
	const focusIdx = opts.focus ? items.findIndex((t) => t.slug === opts.focus) : -1;
	const focusObj = focusIdx >= 0 && world.links[focusIdx] >= 0 ? world.links[focusIdx] : undefined;
	/** Linked (magazine) objects in object order. */
	const linked = [...items.keys()]
		.filter((i) => world.links[i] >= 0)
		.map((i) => ({ id: items[i].slug, o: world.links[i] }))
		.sort((a, b) => a.o - b.o);

	device.pushErrorScope('validation');
	const module = device.createShaderModule({ code: TRACE });
	const pipe = (entryPoint: string) =>
		device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
	const compute = pipe('cs');
	const atrous = pipe('atrous');
	const viewPipe = pipe('cs_view');
	const bakeLmPipe = pipe('bake_lightmap');
	const denoiseLmPipe = pipe('denoise_lightmap');
	const bakeProbePipe = pipe('bake_probe');
	const probeMipPipe = pipe('probe_mip');
	const stepBufs = [1, 2, 4, 8].map((st) => {
		const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, new Float32Array([st, 0, 0, 0]));
		return b;
	});
	const bakePipe = pipe('bake_sun');
	const presentPipe = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module, entryPoint: 'vs' },
		fragment: { module, entryPoint: 'fs', targets: [{ format }] }
	});

	const storage = (size: number) =>
		device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	const objBuf = storage(data.byteLength);
	device.queue.writeBuffer(objBuf, 0, data);

	const paneBuf = storage(world.panes.byteLength);
	device.queue.writeBuffer(paneBuf, 0, world.panes);

	const lvlBuf = storage(world.lvl.byteLength);
	device.queue.writeBuffer(lvlBuf, 0, world.lvl);

	const sceneBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
	const atlasTex = device.createTexture({
		size: [ATLAS, ATLAS],
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
	});
	// lightmaps: metadata and f16x3 texels live for the session; the f32 accumulator only while baking
	const lmLayout = buildLightmapLayout(data, world.lvl);
	const lmMetaBuf = storage(lmLayout.meta.byteLength);
	device.queue.writeBuffer(lmMetaBuf, 0, lmLayout.meta);
	const lmBuf = storage(lmLayout.texels * 8);
	let lmAcc: GPUBuffer | null = null;
	// raw progressive mean and the two a-trous ping-pong buffers; they live only during the bake
	let lmRaw: GPUBuffer | null = null;
	let lmTmp: GPUBuffer[] = [];
	let bindD: GPUBindGroup[] = [];
	const lmGroups = Math.ceil(lmLayout.texels / 64);
	const lmGroupsX = Math.min(lmGroups, 4096);
	console.debug('room: lightmap texels', lmLayout.texels);
	// reflection probes: mip 0 is the path-traced radiance seen from the room centre, the rest is blurred for rough surfaces
	const probeTex = device.createTexture({
		size: [PROBE_N, PROBE_N, levels.length * 6],
		format: 'rgba16float',
		mipLevelCount: PROBE_MIPS,
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.STORAGE_BINDING
	});
	const probeAll = probeTex.createView({ dimension: 'cube-array' });
	const probeMip0 = probeTex.createView({ dimension: 'cube-array', baseMipLevel: 0, mipLevelCount: 1 });
	const probeStore = (m: number) =>
		probeTex.createView({ dimension: '2d-array', baseMipLevel: m, mipLevelCount: 1 });
	const probeSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear' });
	let probeAcc: GPUBuffer | null = null;
	let bindProbe: GPUBindGroup | null = null;
	let bindProbeMips: GPUBindGroup[] = [];
	let probeN = 0;
	let probeSpp = PROBE_STEP;
	const VOL = [96, 48, 64];
	const volBuf = storage(levels.length * VOL[0] * VOL[1] * VOL[2] * 4);
	{
		const bind = device.createBindGroup({
			layout: bakePipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 1, resource: { buffer: objBuf } },
				{ binding: 5, resource: { buffer: paneBuf } },
				{ binding: 7, resource: { buffer: lvlBuf } },
				{ binding: 17, resource: { buffer: volBuf } }
			]
		});
		// one-off bake: needs the pane/level uniform, so write a rest-state scene first
		const u = new Float32Array(SCENE_FLOATS);
		u.set([0.27, 0.37, 0.0905, 0], 28);
		u.set([levels.length, LEVEL_H, ROOM_D, ROOM_H], 32);
		device.queue.writeBuffer(sceneBuf, 0, u);
		const enc = device.createCommandEncoder();
		const cp = enc.beginComputePass();
		cp.setPipeline(bakePipe);
		cp.setBindGroup(0, bind);
		cp.dispatchWorkgroups(VOL[0] / 4, VOL[1] / 4, Math.ceil((levels.length * VOL[2]) / 4));
		cp.end();
		device.queue.submit([enc.finish()]);
	}
	if (await device.popErrorScope()) return null;

	// working buffers (sized for the screen)
	let accum: GPUBuffer | null = null;
	let gbuf: GPUBuffer | null = null;
	let bufB: GPUBuffer | null = null;
	let bufC: GPUBuffer | null = null;
	let bindA: GPUBindGroup[] = [];
	let bindC: GPUBindGroup;
	let bindV: GPUBindGroup;
	let bindP: GPUBindGroup;
	let bindPV: GPUBindGroup;
	let bindL: GPUBindGroup | null = null;
	let w = 0;
	let h = 0;
	let frame = 0;
	let raf = 0;
	let dead = false;
	let atlasDark: boolean | null = null;
	let target = 0;
	let shown = 0;
	let moving = false;
	let lastChange = 0;
	// lightmap bake: samples per texel so far, next pass index, samples in the pass being written, adaptive target
	let lmN = 0;
	let lmPass = 0;
	let lmSpp = 4;
	let lmTarget = 4;
	let lmBusy = false;
	let lmDark: boolean | null = null;
	let lmT0 = 0;
	let vm: [number, number] = [0, 0];
	let vs = 1;
	let spots: Hotspot[] = [];

	const accents = items.map((t) => (mq.matches ? accentFor(t.slug).dark : accentFor(t.slug).light));
	const signs = levels;

	async function upload() {
		if (atlasDark === mq.matches) return;
		atlasDark = mq.matches;
		const c = await buildAtlas(items, accents, mq.matches, signs);
		device!.queue.copyExternalImageToTexture({ source: c }, { texture: atlasTex }, [ATLAS, ATLAS]);
	}

	/** Camera pose for a given y (the basis is the same on every floor). */
	const camera = (aspect: number, y: number) => {
		if (focusObj) {
			// close, slightly low, hero-lit look at one magazine, framed on the right third
			const mx = data[focusObj * 28];
			const my = data[focusObj * 28 + 1];
			const pos: V3 = [mx - 0.15, my - 0.05, 2.3];
			const fwd = norm(sub([mx - 0.85, my + 0.02, 0.3], pos));
			const rgt = norm(cross(fwd, [0, 1, 0]));
			const up = cross(rgt, fwd);
			return { pos, fwd, rgt, up, th: Math.tan((17 * Math.PI) / 180) };
		}
		const pos: V3 = [0, y, CAM_Z];
		const fwd = norm(sub([0, y - 0.05, 0.3], pos));
		const rgt = norm(cross(fwd, [0, 1, 0]));
		const up = cross(rgt, fwd);
		const th = Math.max(Math.tan((22 * Math.PI) / 180), 3.0 / (CAM_Z * aspect));
		return { pos, fwd, rgt, up, th };
	};
	const liveY = () => 1.55 - shown * LEVEL_H * (levels.length - 1);

	function writeScene(rw: number, rh: number, y: number, seed: number, blend: number, windowed: boolean) {
		const aspect = canvas.clientWidth / canvas.clientHeight;
		const cam = camera(aspect, y);
		const night = mq.matches;
		const sky = night ? [0.5, 0.8, 1.7] : [7.5, 7.0, 6.0];
		// outside radiance fades from open sky to underground as the elevator descends
		const t = Math.min(1, shown * 1.4);
		const base = night ? [0.05, 0.07, 0.15] : [0.55, 0.62, 0.72];
		const fade = 1 - 0.85 * t;
		const sk = Math.max(...sky);
		const sun = sky.map((c) => (c / sk) * (night ? 5.0 : 14.0));
		const amb = [0, 0, 0];
		const vw = windowed ? [vm[0], vm[1], vs] : [0, 0, 1];
		device!.queue.writeBuffer(
			sceneBuf,
			0,
			new Float32Array([
				rw, rh, seed, blend,
				...sky, night ? 5.0 : 14.0,
				...base, fade,
				...cam.pos, cam.th,
				...cam.fwd, 0,
				...cam.rgt, 0,
				...cam.up, 0,
				0.27, 0.37, 0.0905, 0,
				levels.length, LEVEL_H, ROOM_D, ROOM_H,
				night ? 3.4 : 2.6, seed, w, h,
				...vw, 0,
				lmN, lmSpp, lmLayout.texels, lmGroupsX,
				...sun, 0,
				...amb, 0,
				DBG, 0, 0, 0,
				probeN, probeSpp, 0, 0
			])
		);
	}

	function layoutSpots() {
		const cssW = canvas.clientWidth;
		const cssH = canvas.clientHeight;
		const aspect = cssW / cssH;
		const cam = camera(aspect, liveY());
		const out: Hotspot[] = [];
		for (const { id, o } of linked) {
			const b = o * 28;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			let behind = false;
			for (const sx of [-1, 1])
				for (const sy of [-1, 1])
					for (const sz of [-1, 1]) {
						const l: V3 = [sx * data[b + 4], sy * data[b + 5], sz * data[b + 6]];
						const wp: V3 = [
							data[b] + l[0] * data[b + 8] + l[1] * data[b + 12] + l[2] * data[b + 16],
							data[b + 1] + l[0] * data[b + 9] + l[1] * data[b + 13] + l[2] * data[b + 17],
							data[b + 2] + l[0] * data[b + 10] + l[1] * data[b + 14] + l[2] * data[b + 18]
						];
						const v = sub(wp, cam.pos);
						const z = dot(v, cam.fwd);
						if (z <= 0.1) behind = true;
						const rx = dot(v, cam.rgt) / z / (cam.th * aspect);
						const ry = dot(v, cam.up) / z / cam.th;
						const sxn = (rx - vm[0]) / vs;
						const syn = (ry - vm[1]) / vs;
						const x = ((sxn + 1) / 2) * cssW;
						const y = ((1 - syn) / 2) * cssH;
						x0 = Math.min(x0, x); x1 = Math.max(x1, x);
						y0 = Math.min(y0, y); y1 = Math.max(y1, y);
					}
			if (behind || y1 < 0 || y0 > cssH || x1 < 0 || x0 > cssW) continue;
			out.push({ id, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
		}
		spots = out;
		onLayout(out);
	}

	function resize() {
		const cssW = canvas.clientWidth;
		const cssH = canvas.clientHeight;
		let dpr = Math.min(devicePixelRatio || 1, 2);
		while (cssW * dpr * cssH * dpr > 2.4e6 && dpr > 0.5) dpr -= 0.25;
		const nw = Math.max(8, Math.round(cssW * dpr));
		const nh = Math.max(8, Math.round(cssH * dpr));
		if (nw === w && nh === h && accum) return;
		w = nw;
		h = nh;
		canvas.width = w;
		canvas.height = h;
		for (const b of [accum, gbuf, bufB, bufC]) b?.destroy();
		accum = storage(w * h * 16);
		gbuf = storage(w * h * 48);
		bufB = storage(w * h * 16);
		bufC = storage(w * h * 16);
		bindC = device!.createBindGroup({
			layout: compute.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 1, resource: { buffer: objBuf } },
				{ binding: 2, resource: { buffer: accum } },
				{ binding: 3, resource: atlasTex.createView() },
				{ binding: 4, resource: sampler },
				{ binding: 5, resource: { buffer: paneBuf } },
				{ binding: 7, resource: { buffer: lvlBuf } },
				{ binding: 8, resource: { buffer: gbuf } }
			]
		});
		bindV = device!.createBindGroup({
			layout: viewPipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 1, resource: { buffer: objBuf } },
				{ binding: 2, resource: { buffer: accum } },
				{ binding: 3, resource: atlasTex.createView() },
				{ binding: 4, resource: sampler },
				{ binding: 5, resource: { buffer: paneBuf } },
				{ binding: 7, resource: { buffer: lvlBuf } },
				{ binding: 8, resource: { buffer: gbuf } },
				{ binding: 14, resource: { buffer: lmMetaBuf } },
				{ binding: 19, resource: { buffer: lmBuf } },
				{ binding: 22, resource: probeAll },
				{ binding: 23, resource: probeSampler }
			]
		});
		const chain = [
			[accum, bufB],
			[bufB, bufC],
			[bufC, bufB],
			[bufB, bufC]
		] as GPUBuffer[][];
		bindA = chain.map(([i, o], k) =>
			device!.createBindGroup({
				layout: atrous.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: sceneBuf } },
					{ binding: 9, resource: { buffer: gbuf! } },
					{ binding: 10, resource: { buffer: i } },
					{ binding: 11, resource: { buffer: o } },
					{ binding: 13, resource: { buffer: stepBufs[k] } }
				]
			})
		);
		const mkP = (finalBuf: GPUBuffer) =>
			device!.createBindGroup({
				layout: presentPipe.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: sceneBuf } },
					{ binding: 9, resource: { buffer: gbuf! } },
					{ binding: 12, resource: { buffer: finalBuf } },
					{ binding: 18, resource: { buffer: volBuf } }
				]
			});
		bindP = mkP(bufC);
		bindPV = mkP(accum);
		frame = 0;
	}

	const groups = (n: number) => Math.ceil(n / 8);

	function draw(enc: GPUCommandEncoder, bind: GPUBindGroup) {
		const rp = enc.beginRenderPass({
			colorAttachments: [{ view: ctx!.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }]
		});
		rp.setPipeline(presentPipe);
		rp.setBindGroup(0, bind);
		rp.draw(3);
		rp.end();
	}
	function denoise(cp: GPUComputePassEncoder, rw: number, rh: number, chain = bindA) {
		cp.setPipeline(atrous);
		for (const bg of chain) {
			cp.setBindGroup(0, bg);
			cp.dispatchWorkgroups(groups(rw), groups(rh));
		}
	}

	function startBake() {
		lmDark = mq.matches;
		lmN = 0;
		lmPass = 0;
		lmT0 = performance.now();
		lmAcc ??= storage(lmLayout.texels * 16);
		lmRaw ??= storage(lmLayout.texels * 8);
		if (!lmTmp.length) lmTmp = [storage(lmLayout.texels * 8), storage(lmLayout.texels * 8)];
		probeN = 0;
		probeAcc ??= storage(levels.length * 6 * PROBE_N * PROBE_N * 16);
		bindProbe = device!.createBindGroup({
			layout: bakeProbePipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 1, resource: { buffer: objBuf } },
				{ binding: 3, resource: atlasTex.createView() },
				{ binding: 4, resource: sampler },
				{ binding: 5, resource: { buffer: paneBuf } },
				{ binding: 7, resource: { buffer: lvlBuf } },
				{ binding: 24, resource: probeStore(0) },
				{ binding: 25, resource: { buffer: probeAcc } }
			]
		});
		bindProbeMips = [];
		for (let m = 1; m < PROBE_MIPS; m++)
			bindProbeMips.push(
				device!.createBindGroup({
					layout: probeMipPipe.getBindGroupLayout(0),
					entries: [
						{ binding: 0, resource: { buffer: sceneBuf } },
						{ binding: 23, resource: probeSampler },
						{ binding: 24, resource: probeStore(m) },
						{ binding: 26, resource: probeMip0 }
					]
				})
			);
		bindL = device!.createBindGroup({
			layout: bakeLmPipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 1, resource: { buffer: objBuf } },
				{ binding: 3, resource: atlasTex.createView() },
				{ binding: 4, resource: sampler },
				{ binding: 5, resource: { buffer: paneBuf } },
				{ binding: 7, resource: { buffer: lvlBuf } },
				{ binding: 14, resource: { buffer: lmMetaBuf } },
				{ binding: 15, resource: { buffer: lmAcc } },
				{ binding: 16, resource: { buffer: lmRaw } }
			]
		});
		// a-trous chain raw -> A -> B -> A -> lm with steps 1, 2, 4, 8
		const chain: [GPUBuffer, GPUBuffer][] = [
			[lmRaw, lmTmp[0]],
			[lmTmp[0], lmTmp[1]],
			[lmTmp[1], lmTmp[0]],
			[lmTmp[0], lmBuf]
		];
		bindD = chain.map(([i, o], k) =>
			device!.createBindGroup({
				layout: denoiseLmPipe.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: sceneBuf } },
					{ binding: 1, resource: { buffer: objBuf } },
					{ binding: 13, resource: { buffer: stepBufs[k] } },
					{ binding: 14, resource: { buffer: lmMetaBuf } },
					{ binding: 20, resource: { buffer: i } },
					{ binding: 21, resource: { buffer: o } }
				]
			})
		);
	}

	/** One progressive lightmap pass over every texel; the sample count adapts to keep a pass near LM_BUDGET_MS. */
	function bakeStep() {
		if ((lmN >= LM_SPP && probeN >= PROBE_SPP) || lmBusy || !bindL) return;
		lmBusy = true;
		const t0 = performance.now();
		lmSpp = Math.min(lmTarget, Math.max(0, LM_SPP - lmN));
		probeSpp = Math.min(PROBE_STEP, PROBE_SPP - probeN);
		writeScene(w, h, liveY(), ++lmPass, 0, false);
		const enc = device!.createCommandEncoder();
		const cp = enc.beginComputePass();
		if (lmSpp > 0) {
			cp.setPipeline(bakeLmPipe);
			cp.setBindGroup(0, bindL);
			cp.dispatchWorkgroups(lmGroupsX, Math.ceil(lmGroups / lmGroupsX));
			cp.setPipeline(denoiseLmPipe);
			for (const bg of bindD) {
				cp.setBindGroup(0, bg);
				cp.dispatchWorkgroups(lmGroupsX, Math.ceil(lmGroups / lmGroupsX));
			}
		}
		if (probeSpp > 0 && bindProbe) {
			cp.setPipeline(bakeProbePipe);
			cp.setBindGroup(0, bindProbe);
			cp.dispatchWorkgroups(PROBE_N / 8, PROBE_N / 8, levels.length * 6);
			cp.setPipeline(probeMipPipe);
			for (let m = 1; m < PROBE_MIPS; m++) {
				cp.setBindGroup(0, bindProbeMips[m - 1]);
				const sz = PROBE_N >> m;
				cp.dispatchWorkgroups(Math.ceil(sz / 8), Math.ceil(sz / 8), levels.length * 6);
			}
		}
		cp.end();
		device!.queue.submit([enc.finish()]);
		lmN += lmSpp;
		probeN += probeSpp;
		const pass = lmPass;
		const spp = Math.max(1, lmSpp);
		void device!.queue.onSubmittedWorkDone().then(() => {
			const dt = performance.now() - t0;
			lmBusy = false;
			lmTarget = Math.max(1, Math.min(32, Math.round((spp * (LM_BUDGET_MS - 1.5)) / Math.max(dt - 1.5, 0.5))));
			if (pass === lmPass && lmN >= LM_SPP && probeN >= PROBE_SPP) {
				console.debug(`room: lightmaps and probes converged in ${Math.round(performance.now() - lmT0)} ms`);
				lmAcc?.destroy();
				lmAcc = null;
				probeAcc?.destroy();
				probeAcc = null;
				bindL = null;
				bindProbe = null;
			}
		});
	}

	function tick() {
		raf = 0;
		if (dead) return;
		const now = performance.now();
		const diff = target - shown;
		const settling = Math.abs(diff) > 1e-4;
		if (settling) {
			shown += diff * 0.2;
			lastChange = now;
		} else shown = target;
		const nowMoving = !focusObj && (settling || now - lastChange < 120);
		if (!focusObj) bakeStep();
		const baking = !focusObj && (lmN < LM_SPP || probeN < PROBE_SPP);

		if (nowMoving) {
			// scroll or zoom: no history, lighting comes from the baked lightmaps plus the exact sun
			moving = true;
			writeScene(w, h, liveY(), frame, 1, true);
			const enc = device!.createCommandEncoder();
			const cp = enc.beginComputePass();
			cp.setPipeline(viewPipe);
			cp.setBindGroup(0, bindV);
			cp.dispatchWorkgroups(groups(w), groups(h));
			cp.end();
			draw(enc, bindPV);
			device!.queue.submit([enc.finish()]);
			frame = 1;
			layoutSpots();
			raf = requestAnimationFrame(tick);
			return;
		}
		if (moving) {
			// continue refining from the last scroll frame instead of starting over
			moving = false;
			frame = 1;
			layoutSpots();
		}
		if (frame < SPP) {
			writeScene(w, h, liveY(), frame, 0, true);
			const enc = device!.createCommandEncoder();
			const cp = enc.beginComputePass();
			cp.setPipeline(compute);
			cp.setBindGroup(0, bindC);
			cp.dispatchWorkgroups(groups(w), groups(h));
			denoise(cp, w, h);
			cp.end();
			draw(enc, bindP);
			device!.queue.submit([enc.finish()]);
			frame++;
			raf = requestAnimationFrame(tick);
			return;
		}
		if (baking) raf = requestAnimationFrame(tick);
	}

	/** Dev only: GPU cost of n back-to-back frames of the moving (view) or still (trace + denoise) path, ms per frame. */
	async function bench(n = 60, mode: 'view' | 'still' = 'view') {
		await device!.queue.onSubmittedWorkDone();
		const t0 = performance.now();
		if (mode === 'view') writeScene(w, h, liveY(), 1, 1, true);
		else writeScene(w, h, liveY(), 5, 0.02, true);
		for (let i = 0; i < n; i++) {
			const enc = device!.createCommandEncoder();
			const cp = enc.beginComputePass();
			cp.setPipeline(mode === 'view' ? viewPipe : compute);
			cp.setBindGroup(0, mode === 'view' ? bindV : bindC);
			cp.dispatchWorkgroups(groups(w), groups(h));
			if (mode === 'still') denoise(cp, w, h);
			cp.end();
			draw(enc, mode === 'view' ? bindPV : bindP);
			device!.queue.submit([enc.finish()]);
		}
		await device!.queue.onSubmittedWorkDone();
		return (performance.now() - t0) / n;
	}
	if (import.meta.env.DEV) (globalThis as unknown as { __roomBench?: typeof bench }).__roomBench = bench;

	const kick = () => {
		if (!raf && !dead) raf = requestAnimationFrame(tick);
	};
	const touch = () => {
		lastChange = performance.now();
		kick();
	};

	async function restart() {
		if (dead) return;
		await upload();
		resize();
		// sky and sun change with the theme: that is the only thing that invalidates the lightmaps
		if (!focusObj && lmDark !== mq.matches) startBake();
		frame = 0;
		moving = false;
		layoutSpots();
		kick();
	}

	const ro = new ResizeObserver(() => void restart());
	ro.observe(canvas);
	mq.addEventListener('change', restart);
	device.lost.then(() => (dead = true));
	await restart();

	const clampView = () => {
		const lim = 1 - vs;
		vm = [Math.max(-lim, Math.min(lim, vm[0])), Math.max(-lim, Math.min(lim, vm[1]))];
	};

	return {
		floors: signs,
		get zoom() {
			return 1 / vs;
		},
		setProgress(p: number) {
			const t = Math.min(1, Math.max(0, p));
			if (t === target) return;
			target = t;
			touch();
		},
		zoomAt(factor: number, nx: number, ny: number) {
			const s1 = Math.min(1, Math.max(1 / 6, vs / factor));
			vm = [vm[0] + nx * (vs - s1), vm[1] + ny * (vs - s1)];
			vs = s1;
			clampView();
			touch();
		},
		panBy(dnx: number, dny: number) {
			vm = [vm[0] - dnx * vs, vm[1] - dny * vs];
			clampView();
			touch();
		},
		resetView() {
			vm = [0, 0];
			vs = 1;
			touch();
		},
		destroy() {
			dead = true;
			cancelAnimationFrame(raf);
			ro.disconnect();
			mq.removeEventListener('change', restart);
			for (const b of [accum, gbuf, bufB, bufC, volBuf, lmMetaBuf, lmBuf, lmAcc, lmRaw, probeAcc, ...lmTmp]) b?.destroy();
			probeTex.destroy();
			atlasTex.destroy();
		}
	};
}
