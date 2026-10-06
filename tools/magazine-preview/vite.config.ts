// Standalone Vite config: `bunx vite tools/magazine-preview` (not part of the site build or routes).
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
	root: __dirname,
	server: { port: 5178, fs: { allow: [path.resolve(__dirname, '../..')] } },
	build: { target: 'esnext' }
});
