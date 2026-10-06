// Dev only (always behind `import.meta.env.DEV`): hot reload of world/scene/*.flecs without rebuilding world.wasm.
// scripts/scene-hot.ts (a Vite plugin) watches the files and pushes `{ name, src, saved }` over the HMR socket; the room calls
// `World.reloadScene` (Flecs `ecs_script_update` in the wasm) and re-uploads the packed buffers. See docs/WORLD.md "Hot reload".

/** The current .flecs sources by script name (`decor`, `rooms`, ...), read from disk by the plugin. */
export async function sceneSources(): Promise<Record<string, string>> {
	const m = await import('virtual:scene-sources');
	return m.default;
}

let toast: HTMLElement | null = null;
let toastTimer = 0;

/** A small on-screen dev toast: red with the Flecs error when a script is rejected, green and brief on success. */
export function showToast(kind: 'ok' | 'error', text: string) {
	if (!toast) {
		toast = document.createElement('pre');
		toast.id = 'scene-hot-toast';
		toast.setAttribute('role', 'status');
		Object.assign(toast.style, {
			position: 'fixed',
			left: '12px',
			bottom: '12px',
			maxWidth: 'min(720px, calc(100vw - 24px))',
			maxHeight: '40vh',
			overflow: 'auto',
			margin: '0',
			padding: '10px 12px',
			font: '12px/1.45 ui-monospace, Menlo, monospace',
			whiteSpace: 'pre-wrap',
			zIndex: '2147483000',
			borderRadius: '6px',
			colorScheme: 'light dark',
			background: 'Canvas',
			color: 'CanvasText',
			borderLeft: '4px solid',
			pointerEvents: 'none'
		});
		document.body.append(toast);
	}
	toast.style.borderLeftColor = kind === 'error' ? 'rgb(220 60 50)' : 'rgb(60 170 90)';
	toast.textContent = text;
	toast.style.display = 'block';
	clearTimeout(toastTimer);
	if (kind === 'ok') toastTimer = window.setTimeout(() => (toast!.style.display = 'none'), 1500);
}

export interface SceneReloadEvent {
	name: string;
	src: string;
	/** Date.now() on the dev server when the save was seen */
	saved: number;
}

/** Subscribe to saves. `apply` returns an error string, or null once the new scene is on screen. Returns the unsubscribe. */
export function attachSceneHot(apply: (name: string, src: string) => Promise<string | null>): () => void {
	const hot = import.meta.hot;
	if (!hot) return () => {};
	const on = async (e: SceneReloadEvent) => {
		const t0 = performance.now();
		// Vite swallows a rejected listener promise: report it here
		const err = await apply(e.name, e.src).catch((x: unknown) => `scene reload threw: ${x instanceof Error ? `${x.message}\n${x.stack}` : String(x)}`);
		const ms = performance.now() - t0;
		if (err) {
			console.error(`scene: ${e.name}.flecs rejected, the previous scene is kept:\n${err}`);
			showToast('error', `${e.name}.flecs rejected, previous scene kept\n${err}`);
		} else {
			const total = Date.now() - e.saved;
			console.debug(`scene: ${e.name}.flecs reloaded, ${ms.toFixed(0)} ms in the page, ${total} ms from save to pixels`);
			showToast('ok', `${e.name}.flecs reloaded (${total} ms)`);
		}
	};
	hot.on('scene:reload', on);
	(globalThis as { __sceneHot?: boolean }).__sceneHot = true; // the tests wait for this
	return () => hot.off?.('scene:reload', on);
}
