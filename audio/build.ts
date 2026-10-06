// bun run build:audio -> cargo (wasm32-unknown-unknown) -> wasm-opt -O3 (if available) -> src/lib/audio/audio.wasm (committed)
import { $ } from "bun";
import { dirname, join } from "node:path";

const root = join(dirname(import.meta.path), "..");
const manifest = join(root, "audio/Cargo.toml");
const built = join(root, "audio/target/wasm32-unknown-unknown/release/room_audio.wasm");
const out = join(root, "src/lib/audio/audio.wasm");

await $`cargo build --release --target wasm32-unknown-unknown --manifest-path ${manifest}`;
const opt = await $`bunx wasm-opt -O3 ${built} -o ${out}`.nothrow().quiet();
if (opt.exitCode !== 0) {
	console.warn("wasm-opt unavailable, copying the unoptimised build");
	await Bun.write(out, Bun.file(built));
}
const mod = new WebAssembly.Module(await Bun.file(out).arrayBuffer());
console.log(`audio.wasm ${(Bun.file(out).size / 1024).toFixed(0)} KB, imports: ${JSON.stringify(WebAssembly.Module.imports(mod))}`);
