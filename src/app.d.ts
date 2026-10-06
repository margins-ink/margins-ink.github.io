// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		// interface Error {}
		// interface Locals {}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
	interface Window {
		/** app.html: shows the one-line WebGPU error state (the only text the page ever draws in the DOM) */
		__gpuError?: () => void;
	}
}

export {};
