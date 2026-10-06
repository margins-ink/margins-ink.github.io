// Minimal CDP client for the headless-Chrome tests (CDP_PORT, default 9333; see the flecs-scene skill). One tab per `open`.
export interface Msg {
	type: string;
	text: string;
	ts: number;
}

export async function open(url: string, w = 1280, h = 800) {
	const port = process.env.CDP_PORT ?? '9333';
	const t = (await (await fetch(`http://localhost:${port}/json/new?about:blank`, { method: 'PUT' })).json()) as { id: string; webSocketDebuggerUrl: string };
	const ws = new WebSocket(t.webSocketDebuggerUrl);
	await new Promise((r) => (ws.onopen = r));
	let id = 0;
	const pending = new Map<number, (v: any) => void>();
	const msgs: Msg[] = [];
	ws.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		if (m.id && pending.has(m.id)) pending.get(m.id)!(m);
		else if (m.method === 'Runtime.consoleAPICalled')
			msgs.push({ type: m.params.type, text: m.params.args.map((a: any) => a.value ?? a.description ?? '').join(' '), ts: m.params.timestamp });
		else if (m.method === 'Page.frameNavigated' && !m.params.frame.parentId) msgs.push({ type: 'nav', text: m.params.frame.url, ts: Date.now() });
		else if (m.method === 'Inspector.targetCrashed') msgs.push({ type: 'crash', text: 'target crashed', ts: Date.now() });
		else if (m.method === 'Runtime.exceptionThrown') msgs.push({ type: 'exception', text: JSON.stringify(m.params.exceptionDetails).slice(0, 400), ts: Date.now() });
	};
	const send = (method: string, params: object = {}) =>
		new Promise<any>((res, rej) => {
			const i = ++id;
			pending.set(i, (m) => (m.error ? rej(new Error(`${method}: ${m.error.message}`)) : res(m.result)));
			ws.send(JSON.stringify({ id: i, method, params }));
		});
	await send('Runtime.enable');
	await send('Page.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
	await send('Emulation.setFocusEmulationEnabled', { enabled: true });
	await send('Page.bringToFront');
	await send('Page.navigate', { url });
	const evalJs = async <T = unknown>(expression: string): Promise<T> => {
		const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
		return r.result.value as T;
	};
	return {
		send,
		eval: evalJs,
		msgs,
		shot: async (): Promise<string> => (await send('Page.captureScreenshot', { format: 'png' })).data as string,
		/** mean rgb of a rect of a base64 png (decoded in the page) */
		avg: (b64: string, x: number, y: number, rw: number, rh: number) =>
			evalJs<number[]>(`(async()=>{const i=new Image();i.src='data:image/png;base64,${b64}';await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const g=c.getContext('2d');g.drawImage(i,0,0);const d=g.getImageData(${x},${y},${rw},${rh}).data;let r=0,gg=0,b=0;const n=d.length/4;for(let k=0;k<d.length;k+=4){r+=d[k];gg+=d[k+1];b+=d[k+2]}return [r/n,gg/n,b/n]})()`),
		close: async () => {
			ws.close();
			await fetch(`http://localhost:${port}/json/close/${t.id}`);
		}
	};
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
