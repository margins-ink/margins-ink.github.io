// Build the Flecs world to wasm: bun scripts/build-world.ts
// Toolchain: Rust stable + wasm32-wasip1, wasi-sdk (clang + wasi-libc headers) for flecs.c.
import { $ } from 'bun';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const world = resolve(root, 'world');
const tc = resolve(world, '.toolchain');
const SDK_VERSION = '34';
const SDK_SHA256 = '9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9';
const SDK_FILE = `wasi-sdk-${SDK_VERSION}.0-arm64-macos`;
const sdk = resolve(tc, SDK_FILE);

if (process.platform !== 'darwin' || process.arch !== 'arm64')
	throw new Error(`pin the wasi-sdk archive for ${process.platform}/${process.arch} in scripts/build-world.ts`);

if (!existsSync(resolve(sdk, 'bin/clang'))) {
	mkdirSync(tc, { recursive: true });
	const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${SDK_VERSION}/${SDK_FILE}.tar.gz`;
	const tgz = resolve(tc, `${SDK_FILE}.tar.gz`);
	console.log('fetching', url);
	await $`curl -fsSL -o ${tgz} ${url}`;
	const sha = createHash('sha256').update(new Uint8Array(await Bun.file(tgz).arrayBuffer())).digest('hex');
	if (sha !== SDK_SHA256) throw new Error(`wasi-sdk sha256 mismatch: ${sha}`);
	await $`tar xzf ${tgz} -C ${tc}`;
}

const sysroot = resolve(sdk, 'share/wasi-sysroot');
// -D__COSMOCC__: flecs.h only takes its POSIX paths (no windows *_s functions) and skips
// execinfo.h for this macro; wasi-libc has neither otherwise.
const cflags = `--sysroot=${sysroot} -D__COSMOCC__ -Os`;
await $`cargo build --release --target wasm32-wasip1 --manifest-path ${world}/Cargo.toml`.env({
	...process.env,
	CC_wasm32_wasip1: resolve(sdk, 'bin/clang'),
	AR_wasm32_wasip1: resolve(sdk, 'bin/llvm-ar'),
	CFLAGS_wasm32_wasip1: cflags
});

const built = resolve(world, 'target/wasm32-wasip1/release/world.wasm');
const dest = resolve(root, 'src/lib/gpu/room/world.wasm');
// binaryen's wasm-opt (Apache-2.0) from npm: ~25% smaller than the linker output
await $`bunx --package binaryen@132.0.0 wasm-opt --enable-bulk-memory --enable-sign-ext --enable-nontrapping-float-to-int --enable-mutable-globals --enable-multivalue -Oz ${built} -o ${dest}`;
console.log(`world.wasm ${statSync(dest).size} bytes`);
