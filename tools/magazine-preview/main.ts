// Preview page: one flat orthographic WebGPU render of a spread (or a sheet of template variants) fed by
// scripts/magazine/watch.ts over a WebSocket. No fallback: without WebGPU or after device loss it says so.
// See query.ts for the URL keys. Keys: arrows spread, D dark, G grid, F frames, V variants, Z zoom, hold T and move
// the mouse to scrub time (time reaches the shader as a uniform; figure channels are not evaluated yet, see HUD).
import { unpackMagazine, SPREAD_H, SPREAD_W, LINE_H, type MagazineModel } from '../../src/lib/magazine/format';
import { readFontsBin, type GlyphTable } from '../../src/lib/reader/format';
import type { Meta } from './fixture';
import { packPreview } from './pack';
import { PREVIEW_WGSL } from './preview.wgsl';
import { fit, panelRect, parseQuery, type Query } from './query';

const hud = document.getElementById('hud')!;
const gpuCanvas = document.getElementById('gpu') as HTMLCanvasElement;
const ov = document.getElementById('overlay') as HTMLCanvasElement;
const say = (s: string) => { hud.textContent = s; };

let q: Query;
try { q = parseQuery(location.search); } catch (e) { say((e as Error).message); throw e; }
let dark = q.dark ?? matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.style.colorScheme = dark ? 'dark' : 'light';

interface Entry { key: string; model: MagazineModel; meta: Meta | null; buf: GPUBuffer; bind: GPUBindGroup; ubuf: GPUBuffer; ms: number; changedAt: number; views: number[] }
const entries = new Map<string, Entry>();
let fonts: GlyphTable | null = null;
let lastPaintMs = 0;

if (!navigator.gpu) { say('This preview needs WebGPU (no fallback by design).'); throw new Error('no WebGPU'); }
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) { say('No WebGPU adapter.'); throw new Error('no adapter'); }
const device = await adapter.requestDevice();
device.lost.then((i) => say(`WebGPU device lost (${i.reason}): reload the page.`));
const ctx = gpuCanvas.getContext('webgpu')!;
const format = navigator.gpu.getPreferredCanvasFormat();
ctx.configure({ device, format, alphaMode: 'opaque' });
const mod = device.createShaderModule({ code: PREVIEW_WGSL });
const pipeline = device.createRenderPipeline({
	layout: 'auto',
	vertex: { module: mod, entryPoint: 'vs' },
	fragment: { module: mod, entryPoint: 'fs', targets: [{ format }] }
});
mod.getCompilationInfo().then((ci) => {
	const errs = ci.messages.filter((m) => m.type === 'error');
	if (errs.length) say('WGSL error: ' + errs.map((m) => `${m.lineNum}:${m.message}`).join(' | '));
});

const wantList = () => {
	const t = q.variants.length ? q.variants : [undefined];
	return t.map((template) => ({ slug: q.slug, cls: q.cls, template, layer: q.layer }));
};
const keyOf = (r: { slug: string; cls: string; template?: string; layer: string }) => `${r.slug}|${r.cls}|${r.template ?? ''}|${r.layer}`;

const wsUrl = new URLSearchParams(location.search).get('ws') ?? `ws://${location.hostname}:5179/ws`;
const ws = new WebSocket(wsUrl);
ws.binaryType = 'arraybuffer';
ws.onopen = () => { ws.send(JSON.stringify({ type: 'want', reqs: wantList() })); say(`connected ${wsUrl}`); };
ws.onclose = () => say(`disconnected from ${wsUrl}: start scripts/magazine/watch.ts and reload`);
let pending: { type: string; [k: string]: unknown } | null = null;
ws.onmessage = (e) => {
	if (typeof e.data === 'string') {
		const h = JSON.parse(e.data);
		if (h.type === 'error') { say(`build error (${h.key}): ${h.message}`); pending = null; return; }
		pending = h;
		return;
	}
	const head = pending;
	pending = null;
	const bytes = new Uint8Array(e.data as ArrayBuffer);
	if (!head) return;
	try {
		if (head.type === 'fonts') fonts = readFontsBin(bytes).table;
		else if (head.type === 'article') onArticle(head as { key: string; ms: number; changedAt: number; meta: Meta | null }, bytes);
	} catch (err) { say(`bad frame: ${(err as Error).message}`); }
};

function onArticle(h: { key: string; ms: number; changedAt: number; meta: Meta | null }, bytes: Uint8Array) {
	if (!fonts) throw new Error('article before fonts');
	const model = unpackMagazine(bytes);
	const { data } = packPreview(fonts, model);
	const old = entries.get(h.key);
	old?.buf.destroy();
	old?.ubuf.destroy();
	const buf = device.createBuffer({ size: Math.max(16, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
	device.queue.writeBuffer(buf, 0, data);
	const ubuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
	const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }, { binding: 1, resource: { buffer: ubuf } }] });
	// spreads of the requested layer (the `layer` field arrives with the contract amendment; absent = all distilled)
	const want = q.layer === 'full' ? 1 : 0;
	const views = model.spreads.map((s, i) => [i, (s as { layer?: number }).layer ?? 0] as const).filter(([, l]) => l === want).map(([i]) => i);
	entries.set(h.key, { key: h.key, model, meta: h.meta, buf, bind, ubuf, ms: h.ms, changedAt: h.changedAt, views });
	draw(h.changedAt);
}

let t = typeof q.t === 'number' ? q.t : 0;
let zoom = q.zoom;
let showGrid = q.grid, showFrames = q.frames;
const panelsWanted = () => wantList().map((r) => entries.get(keyOf(r)) ?? null);

function draw(changedAt = 0) {
	const dpr = devicePixelRatio;
	const W = Math.floor(innerWidth * dpr), Hh = Math.floor(innerHeight * dpr);
	for (const c of [gpuCanvas, ov]) { c.width = W; c.height = Hh; c.style.width = innerWidth + 'px'; c.style.height = innerHeight + 'px'; }
	const panels = panelsWanted();
	const enc = device.createCommandEncoder();
	const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: dark ? { r: 0.04, g: 0.04, b: 0.05, a: 1 } : { r: 0.78, g: 0.78, b: 0.8, a: 1 }, loadOp: 'clear', storeOp: 'store' }] });
	pass.setPipeline(pipeline);
	const g = ov.getContext('2d')!;
	g.clearRect(0, 0, W, Hh);
	g.font = `${11 * dpr}px ui-monospace, monospace`;
	const flags = (q.gutter ? 1 : 0) | (q.bow ? 2 : 0);
	panels.forEach((en, i) => {
		const rect = panels.length > 1 ? panelRect(i, panels.length, W, Hh, 12 * dpr) : ([0, 0, W, Hh] as [number, number, number, number]);
		if (!en) return;
		const si = en.views[Math.min(q.spread, en.views.length - 1)] ?? 0;
		const sp = en.model.spreads[si];
		const f = fit(sp.w, sp.h, rect[2], rect[3], zoom);
		device.queue.writeBuffer(en.ubuf, 0, new Float32Array([
			rect[0], rect[1], rect[2], rect[3], f.x0, f.y0, f.ppe, si, dark ? 1 : 0, flags, t, q.tone ? 1 : 0, W, Hh, 0, 0
		]));
		pass.setViewport(rect[0], rect[1], rect[2], rect[3], 0, 1);
		pass.setScissorRect(Math.floor(rect[0]), Math.floor(rect[1]), Math.floor(rect[2]), Math.floor(rect[3]));
		pass.setBindGroup(0, en.bind);
		pass.draw(3);
		overlay(g, en, rect, f, sp.w, sp.h, dpr);
	});
	pass.end();
	device.queue.submit([enc.finish()]);
	const t0 = performance.now();
	device.queue.onSubmittedWorkDone().then(() => {
		lastPaintMs = performance.now() - t0;
		const first = panels.find(Boolean);
		const loop = changedAt ? ` | edit to paint ${Date.now() - changedAt} ms` : '';
		say(`${q.slug} ${q.cls} ${q.layer} spread ${q.spread}${q.variants.length ? ' variants ' + q.variants.join(',') : ''} | build ${first ? first.ms.toFixed(0) : '?'} ms | gpu ${lastPaintMs.toFixed(1)} ms${loop}${q.fig || q.sheet.length ? ' | figure tuning (fig, play, sheet) is not wired: needs the fig and shader lanes' : ''}`);
	});
}

function overlay(g: CanvasRenderingContext2D, en: Entry, r: [number, number, number, number], f: { ppe: number; x0: number; y0: number }, sw: number, sh: number, dpr: number) {
	const X = (em: number) => r[0] + (em - f.x0) * f.ppe, Y = (em: number) => r[1] + (em - f.y0) * f.ppe;
	g.save();
	g.beginPath(); g.rect(r[0], r[1], r[2], r[3]); g.clip();
	if (showGrid) {
		// baseline grid (top margin 3 baselines, 4 baselines of folio at the bottom) and the 6 + 6 column geometry (section 1.2)
		g.lineWidth = 1; g.strokeStyle = 'rgba(0,140,255,0.35)';
		for (let y = 3 * LINE_H; y <= SPREAD_H - 4 * LINE_H + 1e-6; y += LINE_H) { g.beginPath(); g.moveTo(X(0), Y(y)); g.lineTo(X(sw), Y(y)); g.stroke(); }
		g.strokeStyle = 'rgba(255,0,120,0.45)';
		const col = (32 - 5 * 1.2) / 6;
		for (const sheet of [0, 1]) {
			const x0 = sheet === 0 ? 4.5 : sw / 2 + 3.5;
			for (let c = 0; c < 6; c++) { const a = x0 + c * (col + 1.2); g.strokeRect(X(a), Y(0), col * f.ppe, sh * f.ppe); }
		}
		g.strokeStyle = 'rgba(255,160,0,0.8)';
		g.beginPath(); g.moveTo(X(sw / 2), Y(0)); g.lineTo(X(sw / 2), Y(sh)); g.stroke();
	}
	if (showFrames && en.meta) {
		g.lineWidth = 1.5 * dpr;
		en.meta.frames.forEach((fr, k) => {
			g.strokeStyle = 'rgba(0,200,120,0.9)';
			g.strokeRect(X(fr.x0), Y(fr.y0), (fr.x1 - fr.x0) * f.ppe, (fr.y1 - fr.y0) * f.ppe);
			g.fillStyle = 'rgba(0,200,120,0.95)';
			g.fillText(`${k + 1}:${fr.label}`, X(fr.x0) + 3, Y(fr.y0) + 12 * dpr);
		});
		for (const l of en.meta.ratios) {
			// left-edge tint: neutral up to 1.0, red above 1.5 (section 7)
			const a = Math.min(1, Math.max(0, (l.r - 0.5) / 1.5));
			g.fillStyle = `rgba(${Math.round(255 * a)},${Math.round(160 * (1 - a))},60,0.8)`;
			g.fillRect(X(l.x0) - 5 * dpr, Y(l.y0), 3 * dpr, (l.y1 - l.y0) * f.ppe);
		}
	}
	g.restore();
}

addEventListener('resize', () => draw());
let tDown = false;
addEventListener('keydown', (e) => {
	const k = e.key.toLowerCase();
	if (k === 'arrowright' || k === 'arrowdown') q.spread++;
	else if (k === 'arrowleft' || k === 'arrowup') q.spread = Math.max(0, q.spread - 1);
	else if (k === 'd') { dark = !dark; document.documentElement.style.colorScheme = dark ? 'dark' : 'light'; }
	else if (k === 'g') showGrid = !showGrid;
	else if (k === 'f') showFrames = !showFrames;
	else if (k === 'z') zoom = zoom >= 4 ? 1 : zoom * 2;
	else if (k === 'v') {
		q.variants = q.variants.length ? [] : ['duo', 'solo', 'compare'];
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'want', reqs: wantList() }));
	} else if (k === 't') { tDown = true; return; }
	else return;
	draw();
});
addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 't') tDown = false; });
addEventListener('mousemove', (e) => { if (tDown) { t = (e.clientX / innerWidth) * 16; draw(); } });
void SPREAD_W;
