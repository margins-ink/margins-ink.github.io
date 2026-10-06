declare module 'virtual:scene-sources' {
	/** Dev only (scripts/scene-hot.ts): world/scene/*.flecs by script name. */
	const sources: Record<string, string>;
	export default sources;
}
