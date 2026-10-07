// URL fragment state of exhibits (docs/MUSEUM.md 2.6): `#x:<id>=<base64url(snapshot text)>`, several joined by `&`, next to whatever else the hash holds
// (`#intro&x:turing=...`). Pure string functions; the reader debounces and calls history.replaceState (never pushState).
const enc = new TextEncoder();

/** base64url (no padding) of the UTF-8 bytes of `text` */
export function toBlob(text: string): string {
	const bytes = enc.encode(text);
	let bin = '';
	for (let i = 0; i < bytes.length; i += 0x2000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
	return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The text of a blob, or null when it is not valid base64url / UTF-8 */
export function fromBlob(blob: string): string | null {
	try {
		const b64 = blob.replace(/-/g, '+').replace(/_/g, '/');
		const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
		const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return null;
	}
}

const isX = (p: string) => p.startsWith('x:');
const parts = (hash: string): string[] => (hash.startsWith('#') ? hash.slice(1) : hash).split('&').filter((p) => p !== '');

/** `{ id, blob }` of every `x:` part of a hash */
export function parseExhibitFragment(hash: string): { id: string; blob: string }[] {
	const out: { id: string; blob: string }[] = [];
	for (const p of parts(hash)) {
		if (!isX(p)) continue;
		const eq = p.indexOf('=');
		if (eq < 3) continue;
		let id = p.slice(2, eq);
		try { id = decodeURIComponent(id); } catch { /* raw */ }
		out.push({ id, blob: p.slice(eq + 1) });
	}
	return out;
}

/** The hash without its `x:` parts (what the anchor logic sees); '' when nothing else is left */
export function stripExhibitFragment(hash: string): string {
	const rest = parts(hash).filter((p) => !isX(p));
	return rest.length ? `#${rest.join('&')}` : '';
}

/** `hash` with exhibit `id` set to `blob` (or removed when blob is null); every other part is kept in order, exhibit parts go last. */
export function setExhibitFragment(hash: string, id: string, blob: string | null): string {
	const others = parts(hash).filter((p) => !isX(p));
	const xs = parts(hash).filter(isX);
	const key = `x:${encodeURIComponent(id)}=`;
	const at = xs.findIndex((p) => p.startsWith(key));
	if (blob === null) { if (at >= 0) xs.splice(at, 1); }
	else if (at >= 0) xs[at] = key + blob;
	else xs.push(key + blob);
	const all = [...others, ...xs];
	return all.length ? `#${all.join('&')}` : '';
}

/** `anchorHash` (what the section spy wants, `#id` or '') with the `x:` parts of the current hash carried over */
export function keepExhibitFragment(anchorHash: string, currentHash: string): string {
	const xs = parts(currentHash).filter(isX);
	if (!xs.length) return anchorHash;
	const base = parts(anchorHash).filter((p) => !isX(p));
	return `#${[...base, ...xs].join('&')}`;
}
