import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { wasiImportsFor } from './wasi';

const bytes = readFileSync(new URL('./gpu/room/world.wasm', import.meta.url));
const module = new WebAssembly.Module(bytes);
const mem = () => undefined as unknown as WebAssembly.Memory;

test('every wasi import of the committed world.wasm is callable and the module instantiates', () => {
	const imports = wasiImportsFor(module, mem);
	const wasi = (imports as Record<string, Record<string, unknown>>).wasi_snapshot_preview1;
	for (const i of WebAssembly.Module.imports(module))
		if (i.module === 'wasi_snapshot_preview1') expect(typeof wasi[i.name], i.name).toBe('function');
	const inst = new WebAssembly.Instance(module, imports);
	expect(inst.exports.world_build).toBeFunction();
});

test('control: an import object missing one function fails to link', () => {
	const imports = wasiImportsFor(module, mem) as Record<string, Record<string, unknown>>;
	delete imports.wasi_snapshot_preview1.fd_fdstat_set_flags;
	expect(() => new WebAssembly.Instance(module, imports as WebAssembly.Imports)).toThrow(/fd_fdstat_set_flags|LinkError/);
});
