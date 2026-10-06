// The one WASI preview1 host for world.wasm (a wasm32-wasip1 module). Every `wasi_snapshot_preview1` import the module
// declares gets a callable, built from `WebAssembly.Module.imports`: the few calls we need are real, all others return
// ERRNO_NOSYS (52). A rebuild that pulls in new std/libc functions (flecs file loading brings path_open, fd_read,
// fd_fdstat_set_flags) can therefore never break instantiation. Test: src/lib/wasi.test.ts.
const ERRNO_NOSYS = 52;
const ERRNO_BADF = 8;
type Fn = (...a: never[]) => number;

function known(getMem: () => WebAssembly.Memory): Record<string, Fn> {
	const dv = () => new DataView(getMem().buffer);
	const dec = new TextDecoder();
	const fns: Record<string, (...a: any[]) => number> = {
		environ_sizes_get: (a: number, b: number) => (dv().setUint32(a, 0, true), dv().setUint32(b, 0, true), 0),
		environ_get: () => 0,
		args_sizes_get: (a: number, b: number) => (dv().setUint32(a, 0, true), dv().setUint32(b, 0, true), 0),
		args_get: () => 0,
		clock_time_get: (_id: number, _prec: bigint, out: number) => {
			dv().setBigUint64(out, BigInt(Math.round(performance.now() * 1e6)), true);
			return 0;
		},
		fd_close: () => 0,
		fd_fdstat_get: () => ERRNO_BADF,
		fd_prestat_get: () => ERRNO_BADF,
		fd_prestat_dir_name: () => ERRNO_BADF,
		fd_seek: () => ERRNO_BADF,
		fd_write: (fd: number, iov: number, n: number, out: number) => {
			const v = dv();
			let total = 0;
			for (let i = 0; i < n; i++) {
				const p = v.getUint32(iov + i * 8, true);
				const l = v.getUint32(iov + i * 8 + 4, true);
				total += l;
				if (fd >= 1) console.warn('world.wasm:', dec.decode(new Uint8Array(getMem().buffer, p, l)));
			}
			v.setUint32(out, total, true);
			return 0;
		},
		poll_oneoff: () => ERRNO_BADF,
		random_get: (p: number, n: number) => {
			// getRandomValues takes at most 64 KiB per call
			for (let o = 0; o < n; o += 65536) crypto.getRandomValues(new Uint8Array(getMem().buffer, p + o, Math.min(65536, n - o)));
			return 0;
		},
		proc_exit: (code: number) => {
			throw new Error(`world.wasm exited with ${code}`);
		}
	};
	return fns as Record<string, Fn>;
}

/** Imports for a compiled module: real functions where we have them, ERRNO_NOSYS for every other WASI import. */
export function wasiImportsFor(module: WebAssembly.Module, getMem: () => WebAssembly.Memory): WebAssembly.Imports {
	const real = known(getMem);
	const wasi: Record<string, Fn> = {};
	for (const i of WebAssembly.Module.imports(module)) {
		if (i.module === 'wasi_snapshot_preview1' && i.kind === 'function') wasi[i.name] = real[i.name] ?? (() => ERRNO_NOSYS);
	}
	return { wasi_snapshot_preview1: wasi } as WebAssembly.Imports;
}

/** For callers that instantiate from bytes without a Module in hand (tests, smoke scripts): any name resolves to a callable. */
export function wasiImports(getMem: () => WebAssembly.Memory): WebAssembly.Imports {
	const real = known(getMem);
	return { wasi_snapshot_preview1: new Proxy(real, { get: (t, k) => t[k as string] ?? (() => ERRNO_NOSYS), has: () => true }) } as WebAssembly.Imports;
}

/** Compile (streaming when given a Response promise, else from bytes) and instantiate a wasip1 module; `getMem` is read lazily. */
export async function instantiateWasi(src: Promise<Response> | BufferSource, getMem: () => WebAssembly.Memory): Promise<WebAssembly.Instance> {
	const module = src instanceof Promise ? await WebAssembly.compileStreaming(src) : await WebAssembly.compile(src);
	return WebAssembly.instantiate(module, wasiImportsFor(module, getMem));
}
