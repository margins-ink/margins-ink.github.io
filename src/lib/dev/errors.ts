// DEV-ONLY error overlay. Loaded from +layout.svelte behind `import.meta.env.DEV`, so it is tree-shaken out of production.
// Plain DOM on purpose: it must still work when WebGPU or the whole world fails. Entries also POST to the vite dev
// middleware (scripts/dev-errors.ts) which appends JSON lines to /Volumes/Projects/tmp/site-browser-errors.log.

type Level = 'error' | 'warn';
type Entry = { level: Level; source: string; message: string; stack: string[]; count: number; first: number; last: number };

const CAP = 200;
const ACCENT = '#f5a524';
const RED = '#ef4444';
const entries: Entry[] = [];
let busy = false; // re-entrancy guard: our own errors never loop back in
let installed = false;
let badge: HTMLButtonElement, panel: HTMLDivElement, list: HTMLDivElement;

const fmt = (a: unknown): string => {
	if (a instanceof Error) return `${a.name}: ${a.message}`;
	if (typeof a === 'string') return a;
	try { return JSON.stringify(a) ?? String(a); } catch { return String(a); }
};
const stackOf = (e: unknown): string[] =>
	e instanceof Error && e.stack ? e.stack.split('\n').filter((l) => /:\d+:\d+/.test(l)).slice(0, 4).map((l) => l.trim()) : [];

export function reportError(source: string, err: unknown, level: Level = 'error'): void {
	if (busy) return;
	busy = true;
	try {
		const message = fmt(err);
		const stack = stackOf(err).length ? stackOf(err) : stackOf(new Error()).filter((l) => !l.includes('/dev/errors')).slice(0, 3);
		const now = Date.now();
		const dup = entries.find((e) => e.level === level && e.source === source && e.message === message);
		if (dup) { dup.count++; dup.last = now; entries.splice(entries.indexOf(dup), 1); entries.unshift(dup); }
		else { entries.unshift({ level, source, message, stack, count: 1, first: now, last: now }); if (entries.length > CAP) entries.pop(); }
		render();
		try {
			fetch('/__dev-errors', { method: 'POST', body: JSON.stringify({ t: new Date(now).toISOString(), level, source, message, stack, url: location.href }), keepalive: true }).catch(() => {});
		} catch { /* ignore */ }
	} finally { busy = false; }
}

const time = (t: number) => new Date(t).toTimeString().slice(0, 8);
const fileLink = (l: string) => {
	const m = l.match(/(https?:\/\/[^/]+)?(\/[^\s():]+?)(?:\?[^\s:]*)?:(\d+):(\d+)/);
	return m ? m[2].replace(/^\/@fs/, '') + ':' + m[3] : l;
};
const text = (all: boolean) =>
	entries.map((e) => `[${time(e.last)}] ${e.level.toUpperCase()} ${e.source}${e.count > 1 ? ` x${e.count}` : ''}: ${e.message}${all ? '\n' + e.stack.map((s) => '    ' + s).join('\n') : ''}`).join('\n');

function render() {
	if (!badge) return;
	const errs = entries.filter((e) => e.level === 'error').reduce((n, e) => n + e.count, 0);
	const warns = entries.filter((e) => e.level === 'warn').reduce((n, e) => n + e.count, 0);
	badge.style.display = errs + warns ? 'block' : 'none';
	badge.textContent = errs ? `${errs} err${warns ? ` / ${warns} warn` : ''}` : `${warns} warn`;
	badge.style.background = errs ? RED : ACCENT;
	if (!errs + warns) panel.style.display = 'none';
	list.replaceChildren(...entries.map((e) => {
		const d = document.createElement('div');
		d.style.cssText = 'padding:6px 0;border-bottom:1px solid #2a2a2e;white-space:pre-wrap;word-break:break-word';
		const head = document.createElement('div');
		head.textContent = `${time(e.last)}  ${e.source}${e.count > 1 ? `  x${e.count}` : ''}`;
		head.style.cssText = `color:${e.level === 'error' ? RED : ACCENT}`;
		const msg = document.createElement('div');
		msg.textContent = e.message.length > 600 ? e.message.slice(0, 600) + '...' : e.message;
		const st = document.createElement('div');
		st.textContent = e.stack.slice(0, 3).map(fileLink).join('\n');
		st.style.cssText = 'color:#8b8b93;font-size:10px';
		d.append(head, msg, st);
		return d;
	}));
}

export function installDevErrors(): void {
	if (installed || typeof document === 'undefined') return;
	installed = true;

	for (const level of ['error', 'warn'] as const) {
		const orig = console[level].bind(console);
		console[level] = (...args: unknown[]) => {
			orig(...args);
			const err = args.find((a) => a instanceof Error);
			reportError('console.' + level, args.map(fmt).join(' '), level);
			if (err && !busy) { /* stack of the Error is more useful than ours */
				const e = entries.find((x) => x.source === 'console.' + level);
				if (e && !e.stack.length) e.stack = stackOf(err);
			}
		};
	}
	window.addEventListener('error', (ev) => {
		if (ev.error) reportError('window.onerror', ev.error);
		else reportError('window.onerror', `${ev.message} (${ev.filename}:${ev.lineno}:${ev.colno})`);
	});
	window.addEventListener('unhandledrejection', (ev) => reportError('unhandledrejection', ev.reason));

	const css = 'font:11px/1.4 ui-monospace,Menlo,monospace;color:#e6e6ea;';
	const root = document.createElement('div');
	root.id = 'dev-errors';
	root.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;pointer-events:none;' + css;
	badge = document.createElement('button');
	badge.tabIndex = -1;
	badge.style.cssText = `display:none;pointer-events:auto;cursor:pointer;border:0;border-radius:4px;padding:3px 8px;color:#fff;font:600 11px ui-monospace,Menlo,monospace`;
	badge.onmousedown = (e) => e.preventDefault(); // never take focus
	badge.onclick = () => { panel.style.display = panel.style.display === 'none' ? 'block' : 'none'; };
	panel = document.createElement('div');
	panel.style.cssText = `display:none;pointer-events:auto;position:absolute;left:0;bottom:30px;width:min(640px,90vw);max-height:60vh;overflow:auto;background:#141416;border:1px solid ${ACCENT};border-radius:6px;padding:8px;box-shadow:0 4px 24px #0008`;
	const bar = document.createElement('div');
	bar.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;position:sticky;top:0;background:#141416';
	const btn = (label: string, fn: () => void) => {
		const b = document.createElement('button');
		b.tabIndex = -1; b.textContent = label; b.onmousedown = (e) => e.preventDefault(); b.onclick = fn;
		b.style.cssText = `cursor:pointer;background:#1f1f23;color:${ACCENT};border:1px solid #3a3a40;border-radius:3px;padding:2px 8px;font:11px ui-monospace,Menlo,monospace`;
		return b;
	};
	bar.append(
		btn('Copy all', () => { void navigator.clipboard?.writeText('Browser errors from the dev site (newest first):\n' + text(true)).catch(() => {}); }),
		btn('Clear', () => { entries.length = 0; render(); }),
		btn('Dismiss', () => { panel.style.display = 'none'; })
	);
	list = document.createElement('div');
	panel.append(bar, list);
	root.append(badge, panel);
	document.body.append(root);
	render();
}
