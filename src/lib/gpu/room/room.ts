import type { Thought } from '$lib/thoughts';
import { accentFor } from '$lib/theme';
import { ATLAS, buildAtlas } from './atlas';
import { buildLightmapLayout } from './lightmap';
import { TRACE } from './shader';
import { loadWorld, RS, type Floor } from './world';
import { elevatorApi, ES } from './elevator';
import { makeBookBuffer, writeRd, SHEET_W, SHEET_H, type BookUniforms } from './book';
import type { Reading } from '$lib/reading/abi';

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
	/** The URL is the source of truth: the route layer calls this with the slug in the path, or null on the shelf. */
	setReading(slug: string | null, opts?: { snap?: boolean }): void;
	/** Primary ray through a screen point (ndc, y up), the same basis the tracer uses. */
	rayAt(nx: number, ny: number): { o: [number, number, number]; d: [number, number, number] };
	/** The page module (blocks, scroll, fold, figures) living in the same wasm instance as the book: the in-world Reader drives it. */
	readonly page: Reading;
	/** Subscribe to book events: opened, closed, sound, phase. */
	onReader(cb: (e: { kind: string; arg: number }) => void): void;
	/** An article is open: the cab stays at its floor with the doors open (true), or is released (false). */
	hold(on: boolean): void;
	/** Sound sink: the room drives the elevator hum and floor dings from the scroll. */
	setAudio(a: import('$lib/audio').RoomAudio): void;
	/** Book phase 0 shelf .. 4 reading .. 5 closing; t is the reading blend 0..1. */
	readonly reading: { slug: string | null; t: number; phase: number; dim: number };
	floors: Floor[];
	destroy(): void;
}

const EM_M = 0.0155;
const SPP = 160;
const READ_PIX = 5.5e6;
/** Lightmap samples per texel at convergence, and the GPU time one bake dispatch should take. */
const LM_SPP = 640;
const LM_BUDGET_MS = 5;
/** Reflection probe: octahedral map size, mip count, samples per texel at convergence and per bake step. */
const PROBE_N = 128;
const PROBE_MIPS = 5;
const PROBE_SPP = 256;
const PROBE_STEP = 2;
/** Floats in the Scene uniform (see shader.ts). */
const SCENE_FLOATS = 104;
const CAM_Z = 5.2;
type V3 = [number, number, number];

/** Eye z at the door (lens 1): as far forward as the room view still fits through the hall door (its top ray 0.4 m above the eye at z 3.9). */
function doorEyeZ(thBase: number) {
	let z = 4.85;
	while (z > 4.3 && ((thBase * z) / CAM_Z) * (z - 3.9) > 0.4) z -= 0.01;
	return z;
}

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
	if (!('gpu' in navigator)) {
		console.error('room: navigator.gpu is missing (WebGPU unavailable)');
		return null;
	}
	const adapter = await navigator.gpu.requestAdapter();
	const device =
		adapter &&
		(await adapter.requestDevice({
			requiredLimits: {
				maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
				maxBufferSize: adapter.limits.maxBufferSize
			}
		}));
	const ctx = canvas.getContext('webgpu');
	if (!device || !ctx) {
		console.error('room: no WebGPU adapter/device/context', { adapter: !!adapter, device: !!device, ctx: !!ctx });
		return null;
	}

	const DBG = Number(new URLSearchParams(location.search).get('dbg') ?? 0);
	device.addEventListener("uncapturederror", (e) => console.error("webgpu:", (e as GPUUncapturedErrorEvent).error.message));
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: 'opaque' });
	// the scene is declared in the Flecs world (world/scene/*.flecs) and packed in world.wasm
	const world = await loadWorld(items).catch((e) => {
		console.error('room: world.wasm failed', e);
		return null;
	});
	if (!world) return null;
	let { levelH: LEVEL_H, roomH: ROOM_H, roomD: ROOM_D } = world;
	const elev = elevatorApi(world.exports as Parameters<typeof elevatorApi>[0]);
	/** Floor (index) whose object range holds object `o`. */
	const floorOfObj = (o: number) => {
		for (let l = 0; l < world.floors.length; l++) if (o >= world.lvl[l * 20] && o < world.lvl[l * 20] + world.lvl[l * 20 + 1]) return l;
		return 0;
	};
	const levels = world.floors;
	let data = world.objs;
	/** Dev hot reload (docs/WORLD.md): the GPU buffers get headroom so a scene that grows a little can be uploaded in place. */
	const CAP = import.meta.env.DEV ? 1.5 : 1;
	const focusIdx = opts.focus ? items.findIndex((t) => t.slug === opts.focus) : -1;
	const focusObj = focusIdx >= 0 && world.links[focusIdx] >= 0 ? world.links[focusIdx] : undefined;
	/** Linked (magazine) objects in object order. */
	const linkedOf = () =>
		[...items.keys()]
			.filter((i) => world.links[i] >= 0)
			.map((i) => ({ id: items[i].slug, o: world.links[i] }))
			.sort((a, b) => a.o - b.o);
	let linked = linkedOf();

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
	const objBuf = storage(Math.ceil((data.byteLength * CAP) / 16) * 16);
	device.queue.writeBuffer(objBuf, 0, data);

	const paneBuf = storage(world.panes.byteLength);
	device.queue.writeBuffer(paneBuf, 0, world.panes);

	const lvlBuf = storage(world.lvl.byteLength);
	device.queue.writeBuffer(lvlBuf, 0, world.lvl);

	const sceneBuf = device.createBuffer({ size: 512, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
	const atlasTex = device.createTexture({
		size: [ATLAS, ATLAS],
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
	});
	// lightmaps: metadata and f16x3 texels live for the session; the f32 accumulator only while baking
	let lmLayout = buildLightmapLayout(data, world.lvl);
	const lmMetaBuf = storage(Math.ceil(lmLayout.meta.byteLength * CAP));
	device.queue.writeBuffer(lmMetaBuf, 0, lmLayout.meta);
	const lmBuf = storage(Math.ceil(lmLayout.texels * 8 * CAP));
	let lmAcc: GPUBuffer | null = null;
	// raw progressive mean and the two a-trous ping-pong buffers; they live only during the bake
	let lmRaw: GPUBuffer | null = null;
	let lmTmp: GPUBuffer[] = [];
	let bindD: GPUBindGroup[] = [];
	let lmGroups = Math.ceil(lmLayout.texels / 64);
	let lmGroupsX = Math.min(lmGroups, 4096);
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
	const bakeSun = () => {
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
	};
	bakeSun();
	{
		const err = await device.popErrorScope();
		if (err) {
			console.error('room: pipeline setup failed', err.message);
			return null;
		}
	}

	// working buffers (sized for the screen)
	let accum: GPUBuffer | null = null;
	let gbuf: GPUBuffer | null = null;
	let bufB: GPUBuffer | null = null;
	let bufC: GPUBuffer | null = null;
	let bindA: GPUBindGroup[] = [];
	let bindC: GPUBindGroup;
	let bindV: GPUBindGroup;
	let mkBindV: () => GPUBindGroup = () => bindV;
	let bindP: GPUBindGroup;
	let bindPV: GPUBindGroup;
	let bindL: GPUBindGroup | null = null;
	let w = 0;
	let h = 0;
	let frame = 0;
	let raf = 0;
	let dead = false;
	let atlasBuilt = false;
	let target = 0;
	let progressSeen = false;
	let shown = 0;
	let moving = false;
	let lastChange = 0;
	// lightmap bake: samples per texel so far, next pass index, samples in the pass being written, adaptive target
	let lmN = 0;
	let lmPass = 0;
	let lmSpp = 4;
	let lmTarget = 4;
	let lmBusy = false;
	let lmStarted = false;
	let lmT0 = 0;
	let vm: [number, number] = [0, 0];
	let vs = 1;
	let spots: Hotspot[] = [];

	const accents = items.map((t) => accentFor(t.slug).dark);
	const signs = levels;

	async function upload() {
		if (atlasBuilt) return;
		atlasBuilt = true;
		const c = await buildAtlas(items, accents, signs);
		device!.queue.copyExternalImageToTexture({ source: c }, { texture: atlasTex }, [ATLAS, ATLAS]);
	}

	/** Camera pose for a given y (the basis is the same on every floor). */
	const shelfCamera = (aspect: number, y: number) => {
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
		// the camera rides in the cab: the car depth sets y, the lens blends from the cab's wide view to the room's as the doors open
		const st = elev.state();
		const lens = st[ES.lens];
		const thBase = Math.max(Math.tan((22 * Math.PI) / 180), 3.0 / (CAM_Z * aspect));
		const zc = doorEyeZ(thBase);
		const pos: V3 = [st[ES.sway], y, CAM_Z - (CAM_Z - zc) * lens];
		const room = norm(sub([0, y - 0.05, 0.3], pos));
		const cp = Math.cos(st[ES.pitch]);
		const cab: V3 = [Math.sin(st[ES.yaw]) * cp, Math.sin(st[ES.pitch]) - 0.02, -Math.cos(st[ES.yaw]) * cp];
		const fwd = norm([cab[0] + (room[0] - cab[0]) * lens, cab[1] + (room[1] - cab[1]) * lens, cab[2] + (room[2] - cab[2]) * lens]);
		const rgt = norm(cross(fwd, [0, 1, 0]));
		const up = cross(rgt, fwd);
		// room framing is the old one (the whole room width at the back wall), kept through the dolly
		const th = st[ES.thCab] + (thBase * (zc / CAM_Z) - st[ES.thCab]) * lens;
		return { pos, fwd, rgt, up, th };
	};
	const liveY = () => elev.state()[ES.eye] - elev.state()[ES.posM];

	// ---- the book: Flecs drives it (book.rs: lift, carry, open, close); this blends the camera and feeds the shader (magazine.wgsl.ts) ----
	const bookBuf = makeBookBuffer(device);
	const TH_READ = Math.tan((17 * Math.PI) / 180);
	let rs = world.reader.state();
	let rdLast = performance.now();
	let rdIdle = 0;
	let rdSig = '';
	let rdPix = 2.4e6;
	const magRow = new Float32Array(28);
	let wantSlug: string | null = null;
	let readCb: (e: { kind: string; arg: number }) => void = () => {};
	let slugIdx = -1;
	let readPose = { cx: 0, cy: 0, cz: 1, hw: 0.3, hh: 0.4, camX: 0, viewHW: 0.3, spineX: 0, topY: 0, planeZ: 1, dist: 1.5 };
	const readingOn = () => rs[RS.article] >= 0 || rs[RS.phase] > 0 || rs[RS.target] > 0 || rs[RS.t] > 0;

	/** Reading camera: frontal, centred on the sheet, distance fitted so the sheet fills the view. */
	function readCamera(aspect: number) {
		const D = 1.06 * Math.max(readPose.hh / TH_READ, readPose.viewHW / (TH_READ * aspect));
		readPose.dist = D;
		const pos: V3 = [readPose.camX, readPose.cy, readPose.cz + D];
		return { pos, fwd: [0, 0, -1] as V3, rgt: [1, 0, 0] as V3, up: [0, 1, 0] as V3, th: TH_READ };
	}
	const camera = (aspect: number, y: number) => {
		const a = shelfCamera(aspect, y);
		const c = rs[RS.camT];
		if (!(c > 0) || rs[RS.article] < 0) return a;
		const r = readCamera(aspect);
		const mix = (p: V3, q: V3): V3 => [p[0] + (q[0] - p[0]) * c, p[1] + (q[1] - p[1]) * c, p[2] + (q[2] - p[2]) * c];
		const pos = mix(a.pos, r.pos);
		const fwd = norm(mix(a.fwd, r.fwd));
		const rgt = norm(cross(fwd, [0, 1, 0]));
		return { pos, fwd, rgt, up: cross(rgt, fwd), th: a.th + (r.th - a.th) * c };
	};

	/** Place the sheet on the shelf magazine's spot: the cover flies to it. */
	function applyPose(idx: number) {
		const mo = world!.links[idx] * 28;
		const shelfX = data[mo];
		const cy = data[mo + 1] + 0.2;
		const cz = 1.0;
		const hw = (SHEET_W * EM_M) / 2;
		const hh = (SHEET_H * EM_M) / 2;
		readPose = { ...readPose, cx: shelfX, cy, cz, hw, hh, camX: shelfX, viewHW: hw, spineX: shelfX - hw, topY: cy + hh, planeZ: cz + 0.008 };
		readCamera(canvas.clientWidth / canvas.clientHeight);
		world!.reader.setReadingPose(shelfX, cy, cz, hw, hh);
	}

	async function openArticle(slug: string, snap: boolean) {
		const idx = items.findIndex((t) => t.slug === slug);
		if (idx < 0 || world!.links[idx] < 0) return;
		// another book is out: it goes home first (cover closes, card returns), then this one comes off the shelf
		if (!snap && rs[RS.phase] > 0) {
			world!.reader.close(false);
			touch();
			for (let i = 0; i < 400 && rs[RS.phase] !== 0; i++) {
				await new Promise((r) => setTimeout(r, 30));
				if (wantSlug !== slug) return;
			}
		}
		slugIdx = idx;
		// a cold deep link: the cab is already at the book's floor
		if (snap) elev.goto(floorOfObj(world!.links[slugIdx]), true);
		// the book leaves the shelf on the click; the page itself is loaded by the Reader while it is in the air
		if (!snap) world!.reader.begin(slugIdx);
		rdPix = READ_PIX;
		resize();
		applyPose(slugIdx);
		world!.reader.open(slugIdx, snap);
		touch();
	}

	/** Uniforms of the book as the shader sees them. */
	function bookUniforms(): BookUniforms {
		const open = rs[RS.article] >= 0;
		const hinge = dbg.hinge ?? rs[RS.hinge];
		return {
			k: open ? rs[RS.t] : 0,
			magObj: open ? rs[RS.magObj] : -1,
			spineX: readPose.spineX,
			topY: readPose.topY,
			z: readPose.planeZ,
			hinge,
			cover: open && rs[RS.pagesOn] > 0.5 && hinge < 0.9995 ? 1 : 0
		};
	}

	function writeScene(rw: number, rh: number, y: number, seed: number, blend: number, windowed: boolean) {
		const aspect = canvas.clientWidth / canvas.clientHeight;
		const cam = camera(aspect, y);
		const rdFloats = new Float32Array(24);
		writeRd(rdFloats, 0, bookUniforms());
		const sky = [0.5, 0.8, 1.7];
		// outside radiance fades from open sky to underground as the elevator descends
		const t = Math.min(1, shown * 1.4);
		const base = [0.05, 0.07, 0.15];
		const fade = 1 - 0.85 * t;
		const sk = Math.max(...sky);
		const sun = sky.map((c) => (c / sk) * 5.0);
		const es = elev.state();
		const cabOn = !focusObj && cam.pos[2] > 3.95 ? 1 : 0;
		const settled = es[ES.settled] > 0.5 && es[ES.lens] > 0.999 && es[ES.car] === 0 ? 1 : 0;
		const amb = [0, 0, 0];
		const vw = windowed ? [vm[0], vm[1], vs] : [0, 0, 1];
		device!.queue.writeBuffer(
			sceneBuf,
			0,
			new Float32Array([
				rw, rh, seed, blend,
				...sky, 5.0,
				...base, fade,
				...cam.pos, cam.th,
				...cam.fwd, 0,
				...cam.rgt, 0,
				...cam.up, 0,
				0.27, 0.37, 0.0905, 0,
				levels.length, LEVEL_H, ROOM_D, ROOM_H,
				3.4 * (1 - 0.45 * rs[RS.dim]), seed, w, h,
				...vw, 0,
				lmN, lmSpp, lmLayout.texels, lmGroupsX,
				...sun, 0,
				...amb, 0,
				DBG, 0, 0, 0,
				probeN, probeSpp, 0, 0,
				...rdFloats,
				es[ES.posM], settled, cabOn, levels.length
			])
		);
	}

	function layoutSpots() {
		// no click targets while reading or while the doors still hide the room
		if (readingOn() || elev.state()[ES.lens] < 0.97) {
			if (spots.length) onLayout((spots = []));
			return;
		}
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
		// the g-buffer is 48 B per pixel and must fit one storage binding
		const maxPix = Math.min(rdPix, device!.limits.maxStorageBufferBindingSize / 48);
		while (cssW * dpr * cssH * dpr > maxPix && dpr > 0.5) dpr -= 0.25;
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
		mkBindV = () => device!.createBindGroup({
			layout: viewPipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf! } },
				{ binding: 1, resource: { buffer: objBuf! } },
				{ binding: 2, resource: { buffer: accum! } },
				{ binding: 3, resource: atlasTex.createView() },
				{ binding: 4, resource: sampler },
				{ binding: 5, resource: { buffer: paneBuf! } },
				{ binding: 7, resource: { buffer: lvlBuf! } },
				{ binding: 8, resource: { buffer: gbuf! } },
				{ binding: 14, resource: { buffer: lmMetaBuf! } },
				{ binding: 19, resource: { buffer: lmBuf! } },
				{ binding: 22, resource: probeAll },
				{ binding: 23, resource: probeSampler },
				{ binding: 6, resource: { buffer: bookBuf } }
			]
		});
		bindV = mkBindV();
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
		lmStarted = true;
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

	/** Reading: the Flecs world advances Reading and the book, the animated magazine row is copied into the object buffer, one view pass per frame. */
	function readTick(now: number) {
		// a frame after an idle gap must not jump the springs: treat a long gap as one 60 Hz frame
		const gap = now - rdLast;
		const dt = (gap > 250 ? 16.7 : Math.min(50, gap)) * (dbg.timeScale ?? 1);
		rdLast = now;
		elev.tick(dt);
		world!.reader.tick(dt);
		rs = world!.reader.state();
		if (audio) elev.pump(audio);
		// the cab rows (gate, doors, needle, lamps) are rewritten by the Flecs systems every tick
		const es = elev.state();
		device!.queue.writeBuffer(objBuf, es[ES.cabStart] * 112, elev.rows());
		shown = es[ES.frac];
		for (let ev = world!.reader.poll(); ev; ev = world!.reader.poll()) {
			if (ev.kind === 'closed' && wantSlug === null) {
				rdPix = 2.4e6;
				for (const l of linked) device!.queue.writeBuffer(objBuf, l.o * 112, data, l.o * 28, 28);
				resize();
				frame = 0;
				moving = false;
			}
			readCb({ kind: ev.kind, arg: ev.arg });
		}
		if (rs[RS.phase] > 0) {
			// the animated magazine row; once the sheets have replaced it, park it below the room so it cannot show through the gap between sheets
			if (rs[RS.cardOn] < 0.5) {
				magRow.set(rs.subarray(RS.mag, RS.mag + 28));
				magRow[1] -= 50;
				device!.queue.writeBuffer(objBuf, rs[RS.magObj] * 112, magRow);
			} else device!.queue.writeBuffer(objBuf, rs[RS.magObj] * 112, rs, RS.mag, 28);
		}
		const sig = `${dbg.hinge ?? ''} ${es[ES.posM].toFixed(4)} ${es[ES.lens].toFixed(3)} ${es[ES.gate].toFixed(3)} ${rs[RS.t].toFixed(4)} ${rs[RS.dim].toFixed(4)} ${rs[RS.phase]} ${rs[RS.article]}`;
		rdIdle = sig === rdSig && !lmBusy ? rdIdle + 1 : 0;
		rdSig = sig;
	}

	let audio: import('$lib/audio').RoomAudio | null = null;

	function tick() {
		raf = 0;
		if (dead) return;
		const now = performance.now();
		readTick(now);
		if (readingOn() && !focusObj) {
			bakeStep();
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
			if (rdIdle < 3 || lmN < LM_SPP) raf = requestAnimationFrame(tick);
			return;
		}
		// the cab is at rest when parked with gate and doors open and the lens fully on the room
		const es = elev.state();
		const settling = !(es[ES.car] === 0 && es[ES.settled] > 0.5 && es[ES.lens] > 0.999 && es[ES.gateCode] === 2 && es[ES.doorsCode] === 2);
		if (settling) lastChange = now;
		audio?.setElevator(es[ES.speed], es[ES.floor]);
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
	if (import.meta.env.DEV) (globalThis as unknown as { __elev?: typeof elev }).__elev = elev;
	// dev probes for the cdp tools: reader state, a hinge override, slow motion, the audio event log
	const dbg: { hinge?: number; timeScale?: number; audio: [number, string, number][] } = { audio: [] };
	if (import.meta.env.DEV) {
		const g = globalThis as unknown as Record<string, unknown>;
		g.__dbg = dbg;
		g.__world = world;
		g.__rs = () => Array.from(rs.slice(0, 64));
	}

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
		if (!focusObj && !lmStarted) startBake();
		frame = 0;
		moving = false;
		layoutSpots();
		kick();
	}

	const w0 = world;
	/** Dev hot reload: the wasm re-ran the script (world/src/scene.rs `reload`); upload the new buffers, keep the camera, the cab and the book, rebake the lighting. Null when applied, else the error. */
	async function reloadScene(name: string, src: string): Promise<string | null> {
		const world = w0!;
		const r = world.reloadScene(name, src);
		if ('error' in r) return r.error;
		const lm = buildLightmapLayout(r.objs, r.lvl);
		if (r.lvl.length !== world.lvl.length || r.panes.length !== world.panes.length)
			return 'the floor count changed: reload the page';
		if (r.objs.byteLength > objBuf.size || lm.meta.byteLength > lmMetaBuf.size || lm.texels * 8 > lmBuf.size)
			return 'the scene outgrew the dev buffers (1.5x): reload the page';
		({ levelH: LEVEL_H, roomH: ROOM_H, roomD: ROOM_D } = r);
		data = r.objs;
		world.objs = r.objs;
		world.panes = r.panes;
		world.lvl = r.lvl;
		world.links = r.links;
		linked = linkedOf();
		device!.queue.writeBuffer(objBuf, 0, data);
		device!.queue.writeBuffer(paneBuf, 0, r.panes);
		device!.queue.writeBuffer(lvlBuf, 0, r.lvl);
		lmLayout = lm;
		device!.queue.writeBuffer(lmMetaBuf, 0, lm.meta);
		lmGroups = Math.ceil(lm.texels / 64);
		lmGroupsX = Math.min(lmGroups, 4096);
		// the bake buffers are sized by the texel count: drop them, startBake makes new ones
		for (const b of [lmAcc, lmRaw, probeAcc, ...lmTmp]) b?.destroy();
		lmAcc = lmRaw = probeAcc = null;
		lmTmp = [];
		bakeSun();
		startBake();
		frame = 0;
		moving = false;
		touch();
		await new Promise((res) => requestAnimationFrame(res));
		await device!.queue.onSubmittedWorkDone();
		return null;
	}
	let detachHot = () => {};
	if (import.meta.env.DEV && !focusObj) void import('./scene-hot').then((m) => (detachHot = m.attachSceneHot(reloadScene)));

	const ro = new ResizeObserver(() => void restart());
	ro.observe(canvas);
	device.lost.then(() => (dead = true));
	await restart();

	const rayAt = (nx: number, ny: number) => {
		const aspect = canvas.clientWidth / canvas.clientHeight;
		const cam = camera(aspect, liveY());
		const x = vm[0] + nx * vs;
		const y = vm[1] + ny * vs;
		const d = norm([
			cam.fwd[0] + cam.rgt[0] * x * cam.th * aspect + cam.up[0] * y * cam.th,
			cam.fwd[1] + cam.rgt[1] * x * cam.th * aspect + cam.up[1] * y * cam.th,
			cam.fwd[2] + cam.rgt[2] * x * cam.th * aspect + cam.up[2] * y * cam.th
		]);
		return { o: cam.pos, d };
	};
	const clampView = () => {
		const lim = 1 - vs;
		vm = [Math.max(-lim, Math.min(lim, vm[0])), Math.max(-lim, Math.min(lim, vm[1]))];
	};

	const api: Room = {
		floors: signs,
		get zoom() {
			return 1 / vs;
		},
		setProgress(p: number) {
			const t = Math.min(1, Math.max(0, p));
			if (t === target) return;
			target = t;
			// the first value is where the page was restored to: the car appears there instead of riding to it
			if (!progressSeen) {
				progressSeen = true;
				elev.goto(Math.round(t * (levels.length - 1)), true);
			}
			elev.scroll(t);
			touch();
		},
		hold(on: boolean) {
			elev.hold(on);
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
		setReading(slug: string | null, opts: { snap?: boolean } = {}) {
			if (slug === wantSlug) return;
			wantSlug = slug;
			if (slug === null) world.reader.close(!!opts.snap);
			else void openArticle(slug, !!opts.snap);
			touch();
		},
		rayAt,
		page: world.reading,
		onReader(cb: (e: { kind: string; arg: number }) => void) {
			readCb = cb;
		},
		setAudio(a: import('$lib/audio').RoomAudio) {
			audio = a;
			if (import.meta.env.DEV) {
				const ev0 = a.event.bind(a);
				a.event = ((k: string, v?: number, ...r: unknown[]) => {
					dbg.audio.push([Math.round(performance.now()), k, Math.round((v ?? 0) * 100) / 100]);
					return (ev0 as (...x: unknown[]) => unknown)(k, v, ...r);
				}) as typeof a.event;
			}
			a.setReverbRoom(6.6, ROOM_D, ROOM_H);
		},
		get reading() {
			return { slug: wantSlug, t: rs[RS.t], phase: rs[RS.phase], dim: rs[RS.dim] };
		},
		destroy() {
			dead = true;
			detachHot();
			cancelAnimationFrame(raf);
			ro.disconnect();
			for (const b of [accum, gbuf, bufB, bufC, volBuf, lmMetaBuf, lmBuf, lmAcc, lmRaw, probeAcc, ...lmTmp]) b?.destroy();
			probeTex.destroy();
			atlasTex.destroy();
			bookBuf.destroy();
		}
	};
	return api;
}
