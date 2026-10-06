import type { Thought } from '$lib/thoughts';
import { accentFor } from '$lib/theme';
import { ATLAS, MAP, buildAtlas, signRect, tileRect } from './atlas';
import { TRACE } from './shader';

export interface Hotspot {
	id: string;
	/** CSS pixels relative to the canvas. */
	x: number;
	y: number;
	w: number;
	h: number;
}

export interface Floor {
	label: string;
	title: string;
	sub: string;
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
const BUILD_SPP = 96;
const LEVEL_H = 3.28;
const ROOM_H = 3.2;
const ROOM_D = 4.0;
const CAM_Z = 5.2;
type V3 = [number, number, number];

interface ObjSpec {
	kind: number;
	c: V3;
	h: V3;
	rot?: [V3, V3, V3];
	alb?: V3;
	tex?: [number, number, number, number];
	link?: string;
}

const I3: [V3, V3, V3] = [
	[1, 0, 0],
	[0, 1, 0],
	[0, 0, 1]
];
const lean = (a: number): [V3, V3, V3] => [
	[1, 0, 0],
	[0, Math.cos(a), -Math.sin(a)],
	[0, Math.sin(a), Math.cos(a)]
];
const flat = (theta: number): [V3, V3, V3] => [
	[Math.cos(theta), 0, -Math.sin(theta)],
	[-Math.sin(theta), 0, -Math.cos(theta)],
	[0, 1, 0]
];

interface LevelSpec {
	floor: Floor;
	objs: ObjSpec[];
	panes: number[];
	lamp: V3;
	lampColour: V3;
	hasWindow: boolean;
}

const PALETTES: { plaster: V3; wainscot: V3 }[] = [
	{ plaster: [0.74, 0.66, 0.52], wainscot: [0.12, 0.27, 0.22] },
	{ plaster: [0.55, 0.62, 0.72], wainscot: [0.13, 0.17, 0.28] },
	{ plaster: [0.72, 0.58, 0.5], wainscot: [0.3, 0.12, 0.1] },
	{ plaster: [0.5, 0.5, 0.47], wainscot: [0.2, 0.2, 0.2] }
];

function buildLevels(items: Thought[]): LevelSpec[] {
	const rect = (i: number): [number, number, number, number] => {
		const r = tileRect(i);
		return [r.x, r.y, r.w, r.h];
	};
	const sign = (i: number): [number, number, number, number] => {
		const r = signRect(i);
		return [r.x, r.y, r.w, r.h];
	};

	const indexed = items.map((t, i) => ({ t, i }));
	const years = [...new Set(indexed.filter((x) => !x.t.archived).map((x) => x.t.date.slice(0, 4)))];
	const floors = years.map((y, k) => ({
		floor: { label: y, title: k === 0 ? 'Andrew Gazelka' : y, sub: k === 0 ? `${y} · latest` : '' } as Floor,
		mags: indexed.filter((x) => !x.t.archived && x.t.date.startsWith(y)),
		basement: false
	}));
	const archived = indexed.filter((x) => x.t.archived);
	if (archived.length)
		floors.push({
			floor: { label: 'Archive', title: 'Archive', sub: 'Common knowledge now, or I think differently' },
			mags: archived,
			basement: true
		});

	return floors.map((f, k) => {
		const pal = f.basement ? PALETTES[3] : PALETTES[Math.min(k, 2)];
		const dy = -k * LEVEL_H;
		const objs: ObjSpec[] = [];
		const add = (o: ObjSpec) =>
			objs.push({ rot: I3, alb: [0.5, 0.5, 0.5], tex: [0, 0, 1, 1], ...o, c: [o.c[0], o.c[1] + dy, o.c[2]] });

		add({
			kind: 4,
			c: [0, ROOM_H / 2, ROOM_D / 2],
			h: [3.3, ROOM_H / 2, ROOM_D / 2],
			alb: pal.plaster,
			tex: [...pal.wainscot, 0]
		});
		add({ kind: 6, c: [-0.3, 1.0, 0.27], h: [2.0, 0.03, 0.27], alb: [0.4, 0.25, 0.13] });

		const panes: number[] = [];
		const hasWindow = !f.basement;
		if (hasWindow) {
			add({ kind: 0, c: [2.0, 1.95, 0.04], h: [0.62, 0.82, 0.03], alb: [0.82, 0.8, 0.74] });
			for (const [dx, wy] of [
				[-0.3, 0.4],
				[0.3, 0.4],
				[-0.3, -0.4],
				[0.3, -0.4]
			]) {
				add({ kind: 1, c: [2.0 + dx, 1.95 + wy, 0.08], h: [0.27, 0.37, 0.01] });
				panes.push(2.0 + dx, 1.95 + wy + dy, 0, 0);
			}
		}

		add({ kind: 2, c: [0.2, 2.15, 0.03], h: [0.75, 0.132, 0.012], tex: sign(k) });

		add({ kind: 6, c: [0, 0.76, 1.3], h: [2.6, 0.03, 0.85], alb: [0.35, 0.22, 0.12] });
		for (const sx of [-2.5, 2.5])
			for (const z of [0.55, 2.05])
				add({ kind: 0, c: [sx, 0.365, z], h: [0.04, 0.365, 0.04], alb: [0.18, 0.12, 0.08] });
		add({ kind: 0, c: [0, 0.008, 3.0], h: [2.4, 0.008, 0.9], alb: [0.35, 0.1, 0.08] });

		if (k === 0) {
			add({ kind: 0, c: [-1.5, 2.4, 0.045], h: [0.96, 0.69, 0.045], alb: [0.1, 0.06, 0.03] });
			add({ kind: 2, c: [-1.5, 2.4, 0.095], h: [0.9, 0.6328, 0.006], tex: [MAP.x, MAP.y, MAP.w, MAP.h] });
		}
		if (!f.basement) {
			add({ kind: 0, c: [-1.0, 0.802, 1.2], h: [0.22, 0.012, 0.15], alb: [0.55, 0.55, 0.58] });
			add({ kind: 0, c: [-0.3, 0.84, 1.4], h: [0.04, 0.05, 0.04], alb: [0.85, 0.85, 0.8] });
			add({ kind: 0, c: [0.3, 0.8, 1.55], h: [0.12, 0.01, 0.17], rot: flat(0.3 + k), alb: [0.1, 0.12, 0.3] });
			add({ kind: 0, c: [1.45, 1.1, 0.3], h: [0.07, 0.07, 0.07], alb: [0.6, 0.3, 0.2] });
			for (const [x, y, z, r] of [
				[1.45, 1.3, 0.3, 0.1],
				[1.38, 1.4, 0.3, 0.08],
				[1.53, 1.37, 0.28, 0.08]
			])
				add({ kind: 8, c: [x, y, z], h: [r, 0, 0], alb: [0.15, 0.4, 0.18] });
		} else {
			for (const [x, z, s] of [
				[-2.2, 2.4, 0.4],
				[-1.5, 2.9, 0.3],
				[2.0, 2.6, 0.45]
			])
				add({ kind: 6, c: [x, s, z], h: [s, s, s], alb: [0.45, 0.33, 0.2] });
		}

		const lampPos: V3 = f.basement ? [0.0, 2.7, 1.4] : [-1.9, 1.2, 0.3];
		if (!f.basement) add({ kind: 0, c: [-1.9, 1.07, 0.3], h: [0.05, 0.04, 0.05], alb: [0.15, 0.15, 0.15] });
		const lampR = f.basement ? 0.1 : 0.07;
		add({ kind: 9, c: lampPos, h: [lampR, 0, 0] });

		const a = (8 * Math.PI) / 180;
		const n = f.mags.length;
		f.mags.forEach(({ t, i }, m) => {
			const x = n === 1 ? 0.15 : n > 3 ? (m - (n - 1) / 2) * 0.62 - 0.2 : -0.35 + m * 0.65;
			const hy = 0.29;
			add({
				kind: 2,
				c: [x, 1.03 + hy * Math.cos(a), 0.34 - hy * Math.sin(a)],
				h: [0.21, hy, 0.006],
				rot: lean(a),
				tex: rect(i),
				link: t.slug
			});
		});

		return {
			floor: f.floor,
			objs,
			panes,
			lamp: [lampPos[0], lampPos[1] + dy, lampPos[2]] as V3,
			lampColour: (f.basement ? [3.5, 2.2, 1.0] : [4, 2.4, 1.1]) as V3,
			hasWindow
		};
	});
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
	if (!('gpu' in navigator)) return null;
	const adapter = await navigator.gpu.requestAdapter();
	const device = adapter && (await adapter.requestDevice());
	const ctx = canvas.getContext('webgpu');
	if (!device || !ctx) return null;

	device.addEventListener("uncapturederror", (e) => console.error("webgpu:", (e as GPUUncapturedErrorEvent).error.message));
	const format = navigator.gpu.getPreferredCanvasFormat();
	ctx.configure({ device, format, alphaMode: 'opaque' });
	const mq = matchMedia('(prefers-color-scheme: dark)');
	const levels = buildLevels(items);
	const objs = levels.flatMap((l) => l.objs);
	const focusObj = opts.focus ? objs.find((o) => o.link === opts.focus) : undefined;
	const levelOf = levels.flatMap((l, k) => l.objs.map(() => k));

	device.pushErrorScope('validation');
	const module = device.createShaderModule({ code: TRACE });
	const pipe = (entryPoint: string) =>
		device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
	const compute = pipe('cs');
	const atrous = pipe('atrous');
	const viewPipe = pipe('cs_view');
	const packPipe = pipe('pack_cache');
	const stepBufs = [1, 2, 4, 8].map((st) => {
		const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
		device.queue.writeBuffer(b, 0, new Float32Array([st, 0, 0, 0]));
		return b;
	});
	const pkBuf = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const bakePipe = pipe('bake_sun');
	const presentPipe = device.createRenderPipeline({
		layout: 'auto',
		vertex: { module, entryPoint: 'vs' },
		fragment: { module, entryPoint: 'fs', targets: [{ format }] }
	});

	const data = new Float32Array(objs.length * 28);
	objs.forEach((o, i) => {
		const r = o.rot!;
		const alb = [...o.alb!, o.kind === 4 ? levelOf[i] * 2 : 0];
		data.set([...o.c, o.kind, ...o.h, 0, ...r[0], 0, ...r[1], 0, ...r[2], 0, ...alb, ...o.tex!], i * 28);
	});
	const storage = (size: number) =>
		device.createBuffer({ size, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	const objBuf = storage(data.byteLength);
	device.queue.writeBuffer(objBuf, 0, data);

	const paneData = new Float32Array(levels.length * 16);
	levels.forEach((l, k) => paneData.set(l.panes, k * 16));
	const paneBuf = storage(paneData.byteLength);
	device.queue.writeBuffer(paneBuf, 0, paneData);

	const lvlData = new Float32Array(levels.length * 12);
	let start = 0;
	levels.forEach((l, k) => {
		const lampR = l.hasWindow ? 0.07 : 0.1;
		lvlData.set([start, l.objs.length, l.hasWindow ? 4 : 0, 0], k * 12);
		lvlData.set([...l.lamp, lampR], k * 12 + 4);
		lvlData.set([...l.lampColour, 0], k * 12 + 8);
		start += l.objs.length;
	});
	const lvlBuf = storage(lvlData.byteLength);
	device.queue.writeBuffer(lvlBuf, 0, lvlData);

	const sceneBuf = device.createBuffer({ size: 256, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
	const atlasTex = device.createTexture({
		size: [ATLAS, ATLAS],
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
	});
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
		const u = new Float32Array(64);
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

	// working buffers (sized for the screen) and the per-floor irradiance cache
	let accum: GPUBuffer | null = null;
	let gbuf: GPUBuffer | null = null;
	let bufB: GPUBuffer | null = null;
	let bufC: GPUBuffer | null = null;
	let cache: GPUBuffer | null = null;
	// the cache is built in its own buffers so scrolling never disturbs it
	let baccum: GPUBuffer | null = null;
	let bgbuf: GPUBuffer | null = null;
	let bbufB: GPUBuffer | null = null;
	let bbufC: GPUBuffer | null = null;
	let bindCB: GPUBindGroup;
	let bindAB: GPUBindGroup[] = [];
	let bindKB: GPUBindGroup;
	let bindA: GPUBindGroup[] = [];
	let bindC: GPUBindGroup;
	let bindV: GPUBindGroup;
	let bindK: GPUBindGroup;
	let bindP: GPUBindGroup;
	let bindPV: GPUBindGroup;
	let w = 0;
	let h = 0;
	let cw = 0;
	let ch = 0;
	let frame = 0;
	let raf = 0;
	let dead = false;
	let atlasDark: boolean | null = null;
	let target = 0;
	let shown = 0;
	let moving = false;
	let lastChange = 0;
	let built: boolean[] = [];
	let building: { level: number; n: number } | null = null;
	let vm: [number, number] = [0, 0];
	let vs = 1;
	let spots: Hotspot[] = [];

	const accents = items.map((t) => (mq.matches ? accentFor(t.slug).dark : accentFor(t.slug).light));
	const signs = levels.map((l) => l.floor);

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
			const [mx, my] = focusObj.c;
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
	const levelY = (k: number) => 1.55 - k * LEVEL_H;
	const liveY = () => 1.55 - shown * LEVEL_H * (levels.length - 1);

	function writeScene(rw: number, rh: number, y: number, seed: number, blend: number, windowed: boolean) {
		const aspect = canvas.clientWidth / canvas.clientHeight;
		const cam = camera(aspect, y);
		const rest = camera(aspect, 1.55);
		const night = mq.matches;
		const sky = night ? [0.35, 0.55, 1.2] : [7.5, 7.0, 6.0];
		// outside radiance fades from open sky to underground as the elevator descends
		const t = Math.min(1, shown * 1.4);
		const base = night ? [0.03, 0.045, 0.1] : [0.55, 0.62, 0.72];
		const bg = base.map((v) => v * (1 - 0.85 * t));
		const vw = windowed ? [vm[0], vm[1], vs] : [0, 0, 1];
		device!.queue.writeBuffer(
			sceneBuf,
			0,
			new Float32Array([
				rw, rh, seed, blend,
				...sky, night ? 5.0 : 14.0,
				...bg, 0,
				...cam.pos, cam.th,
				...cam.fwd, 0,
				...cam.rgt, 0,
				...cam.up, 0,
				0.27, 0.37, 0.0905, 0,
				levels.length, LEVEL_H, ROOM_D, ROOM_H,
				night ? 2.4 : 2.6, seed, w, h,
				0, 1.55, CAM_Z, rest.th,
				...rest.fwd, 0,
				...rest.rgt, 0,
				...rest.up, 0,
				cw, ch, 0, 0,
				...vw, 0
			])
		);
	}

	function layoutSpots() {
		const cssW = canvas.clientWidth;
		const cssH = canvas.clientHeight;
		const aspect = cssW / cssH;
		const cam = camera(aspect, liveY());
		const out: Hotspot[] = [];
		for (const o of objs) {
			if (!o.link) continue;
			let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
			let behind = false;
			for (const sx of [-1, 1])
				for (const sy of [-1, 1])
					for (const sz of [-1, 1]) {
						const l: V3 = [sx * o.h[0], sy * o.h[1], sz * o.h[2]];
						const r = o.rot!;
						const wp: V3 = [
							o.c[0] + l[0] * r[0][0] + l[1] * r[1][0] + l[2] * r[2][0],
							o.c[1] + l[0] * r[0][1] + l[1] * r[1][1] + l[2] * r[2][1],
							o.c[2] + l[0] * r[0][2] + l[1] * r[1][2] + l[2] * r[2][2]
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
			out.push({ id: o.link, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
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
		const aspect = cssW / cssH;
		ch = Math.min(h, Math.floor(Math.sqrt(1e6 / aspect)));
		cw = Math.min(w, Math.round(ch * aspect));
		for (const b of [accum, gbuf, bufB, bufC, cache, baccum, bgbuf, bbufB, bbufC]) b?.destroy();
		accum = storage(w * h * 16);
		gbuf = storage(w * h * 32);
		bufB = storage(w * h * 16);
		bufC = storage(w * h * 16);
		cache = storage(Math.max(1, levels.length) * cw * ch * 16);
		baccum = storage(cw * ch * 16);
		bgbuf = storage(cw * ch * 32);
		bbufB = storage(cw * ch * 16);
		bbufC = storage(cw * ch * 16);
		bindCB = device!.createBindGroup({
			layout: compute.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 1, resource: { buffer: objBuf } },
				{ binding: 2, resource: { buffer: baccum } },
				{ binding: 3, resource: atlasTex.createView() },
				{ binding: 4, resource: sampler },
				{ binding: 5, resource: { buffer: paneBuf } },
				{ binding: 7, resource: { buffer: lvlBuf } },
				{ binding: 8, resource: { buffer: bgbuf } }
			]
		});
		bindKB = device!.createBindGroup({
			layout: packPipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 9, resource: { buffer: bgbuf } },
				{ binding: 10, resource: { buffer: bbufC } },
				{ binding: 15, resource: { buffer: cache } },
				{ binding: 16, resource: { buffer: pkBuf } }
			]
		});
		bindAB = ([
			[baccum, bbufB],
			[bbufB, bbufC],
			[bbufC, bbufB],
			[bbufB, bbufC]
		] as GPUBuffer[][]).map(([i, o], k) =>
			device!.createBindGroup({
				layout: atrous.getBindGroupLayout(0),
				entries: [
					{ binding: 0, resource: { buffer: sceneBuf } },
					{ binding: 9, resource: { buffer: bgbuf! } },
					{ binding: 10, resource: { buffer: i } },
					{ binding: 11, resource: { buffer: o } },
					{ binding: 13, resource: { buffer: stepBufs[k] } }
				]
			})
		);
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
				{ binding: 14, resource: { buffer: cache } }
			]
		});
		bindK = device!.createBindGroup({
			layout: packPipe.getBindGroupLayout(0),
			entries: [
				{ binding: 0, resource: { buffer: sceneBuf } },
				{ binding: 9, resource: { buffer: gbuf } },
				{ binding: 10, resource: { buffer: bufC } },
				{ binding: 15, resource: { buffer: cache } },
				{ binding: 16, resource: { buffer: pkBuf } }
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
		built = levels.map(() => false);
		building = null;
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

	function nextUnbuilt(): number | null {
		const here = Math.round(shown * (levels.length - 1));
		const order = levels.map((_, k) => k).sort((a, b) => Math.abs(a - here) - Math.abs(b - here));
		return order.find((k) => !built[k]) ?? null;
	}

	/** Render one floor from its rest pose into the cache. Several samples per animation frame. */
	function buildSteps(count: number) {
		if (!building) {
			const k = nextUnbuilt();
			if (k === null) return false;
			building = { level: k, n: 0 };
			const enc = device!.createCommandEncoder();
			enc.clearBuffer(baccum!);
			device!.queue.submit([enc.finish()]);
		}
		for (let i = 0; i < count && building; i++) {
			writeScene(cw, ch, levelY(building.level), building.n, 0, false);
			const enc = device!.createCommandEncoder();
			const cp = enc.beginComputePass();
			cp.setPipeline(compute);
			cp.setBindGroup(0, bindCB);
			cp.dispatchWorkgroups(groups(cw), groups(ch));
			building.n++;
			if (building.n >= BUILD_SPP) {
				denoise(cp, cw, ch, bindAB);
				device!.queue.writeBuffer(pkBuf, 0, new Float32Array([building.level, 0, 0, 0]));
				cp.setPipeline(packPipe);
				cp.setBindGroup(0, bindKB);
				cp.dispatchWorkgroups(groups(cw), groups(ch));
				built[building.level] = true;
				console.debug('room: cache built', building.level);
				building = null;
			}
			cp.end();
			device!.queue.submit([enc.finish()]);
		}
		return true;
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

		if (nowMoving) {
			// scroll or zoom: no history, lighting comes from the converged per-floor cache
			if (!focusObj) buildSteps(2);
			moving = true;
			writeScene(w, h, liveY(), frame, 1, true);
			const enc = device!.createCommandEncoder();
			const cp = enc.beginComputePass();
			cp.setPipeline(viewPipe);
			cp.setBindGroup(0, bindV);
			cp.dispatchWorkgroups(groups(w), groups(h));
			// two edge-aware passes mop up any pixels the cache could not light
			cp.setPipeline(atrous);
			for (const bg of bindA.slice(0, 2)) {
				cp.setBindGroup(0, bg);
				cp.dispatchWorkgroups(groups(w), groups(h));
			}
			cp.end();
			draw(enc, bindP);
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
			if (!focusObj) buildSteps(2);
			raf = requestAnimationFrame(tick);
			return;
		}
		if (!focusObj && buildSteps(4)) raf = requestAnimationFrame(tick);
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
		built = levels.map(() => false);
		building = null;
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
			for (const b of [accum, gbuf, bufB, bufC, cache, baccum, bgbuf, bbufB, bbufC, volBuf]) b?.destroy();
			atlasTex.destroy();
		}
	};
}
