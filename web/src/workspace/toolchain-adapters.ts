import type { WebArtifactAdapter } from "../domains/toolchain-artifacts/registry";

/**
 * Domain screens load when the user opens that screen. The first page keeps the registry,
 * and `get` returns an adapter only after its module has loaded. A ref with no loader is
 * drawn by the host's generic screen.
 */
type AdapterLoader = {
	match: (ref: string) => boolean;
	load: () => Promise<readonly WebArtifactAdapter[]>;
};
const collaborationRefs = new Set([
	"adapter:collaboration.pipeline@1",
	"adapter:collaboration.interact@1",
	"adapter:collaboration.brave@1",
]);
const loaders: readonly AdapterLoader[] = [
	{
		match: (ref) => collaborationRefs.has(ref),
		load: async () =>
			(await import("../domains/collaboration/toolchain-adapter"))
				.collaborationWebAdapters,
	},
	{
		match: (ref) => ref === "adapter:usage@1",
		load: async () => [
			(await import("../domains/usage/toolchain-adapter")).usageWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:docling@1",
		load: async () => [
			(await import("../domains/docling/toolchain-adapter")).doclingWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:canvas@1",
		load: async () => [
			(await import("../domains/canvas/toolchain-adapter")).canvasWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:markdown@1",
		load: async () => [
			(await import("../domains/markdown/toolchain-adapter"))
				.markdownWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:dots-messaging@1",
		load: async () => [
			(await import("../domains/dots/toolchain-adapter"))
				.dotsMessagingWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:dots-delegation@1",
		load: async () => [
			(await import("../domains/dots/work-adapter")).dotsWorkWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:google-accounts@1",
		load: async () => [
			(await import("../domains/google-accounts/toolchain-adapter"))
				.googleAccountsWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:timers@1",
		load: async () => [
			(await import("../domains/timers/toolchain-adapter")).timerWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:scheduler@1",
		load: async () => [
			(await import("../domains/scheduler/toolchain-adapter"))
				.schedulerWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:music-screen@1",
		load: async () => [
			(await import("../domains/music/toolchain-adapter"))
				.musicScreenWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:video@1",
		load: async () => [
			(await import("../domains/video/toolchain-adapter")).videoWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:image-screen@1",
		load: async () => [
			(await import("../domains/image/toolchain-adapter"))
				.imageScreenWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:model3d@1",
		load: async () => [
			(await import("../domains/model3d/toolchain-adapter")).model3dWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:compute@1",
		load: async () => [
			(await import("../domains/compute/toolchain-adapter")).computeWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:browser@1",
		load: async () => [
			(await import("../domains/browser/toolchain-adapter")).browserWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:browser.interact@1",
		load: async () => [
			(await import("../domains/browser/interact/toolchain-adapter"))
				.browserInteractWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:app-development@1",
		load: async () => [
			(await import("../domains/ui-compositions/toolchain-adapter"))
				.appDevelopmentWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:object-recognition-screen@1",
		load: async () => [
			(await import("../domains/object-recognition/toolchain-adapter"))
				.objectRecognitionScreenWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:ocr@1",
		load: async () => [
			(await import("../domains/ocr/toolchain-adapter")).ocrWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:settings@1",
		load: async () => [
			(await import("../domains/settings-data/adapter")).settingsWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:records@1",
		load: async () => [
			(await import("../domains/settings-data/records-adapter"))
				.recordsWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:service-tests@1",
		load: async () => [
			(await import("../domains/service-tests/toolchain-adapter"))
				.serviceTestsWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:terminals@1",
		load: async () => [
			(await import("../domains/terminals/toolchain-adapter"))
				.terminalsWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:shell@1",
		load: async () => [
			(await import("../domains/shell/toolchain-adapter")).shellWebAdapter,
		],
	},
	{
		match: (ref) => ref === "adapter:kanban@1" || ref === "adapter:kanban@2",
		load: async () => {
			const module = await import("../domains/kanban/toolchain-adapter");
			return [module.kanbanWebAdapter, module.sharedKanbanWebAdapter];
		},
	},
	{
		match: (ref) => ref === "adapter:codex-tasks@1",
		load: async () => [
			(await import("../domains/codex-tasks/toolchain-adapter"))
				.codexTasksWebAdapter,
		],
	},
];

const byRef = new Map<string, WebArtifactAdapter>();
const inflight = new Map<number, Promise<void>>();
const failed = new Set<number>();

function loaderIndex(ref: string) {
	return loaders.findIndex((loader) => loader.match(ref));
}

export type ToolchainAdapterPhase =
	"ready" | "pending" | "generic" | "unavailable";

/** Whether the open screen's adapter is loaded, still to load, generic, or failed to load. */
export function toolchainAdapterPhase(ref: string): ToolchainAdapterPhase {
	if (byRef.has(ref)) return "ready";
	const index = loaderIndex(ref);
	if (index < 0) return "generic";
	if (failed.has(index)) return "unavailable";
	return "pending";
}

/** Load the module for the screen the user opened. A ref with no domain screen resolves without one. */
export function loadToolchainAdapter(
	ref: string,
): Promise<WebArtifactAdapter | undefined> {
	const ready = byRef.get(ref);
	if (ready) return Promise.resolve(ready);
	const index = loaderIndex(ref);
	if (index < 0) return Promise.resolve(undefined);
	let pending = inflight.get(index);
	if (!pending) {
		pending = loaders[index]!.load()
			.then((loaded) => {
				for (const adapter of loaded) {
					const previous = byRef.get(adapter.adapterRef);
					if (previous && previous !== adapter)
						throw new Error("duplicate_web_adapter");
				}
				for (const adapter of loaded) {
					byRef.set(adapter.adapterRef, adapter);
				}
				failed.delete(index);
			})
			.catch((error: unknown) => {
				inflight.delete(index);
				failed.add(index);
				throw error;
			});
		inflight.set(index, pending);
	}
	return pending.then(() => byRef.get(ref));
}

/** Resolves once the open screen's module is loaded, or as generic when this app has no domain screen for it. */
export async function prepareToolchainAdapter(
	ref: string,
): Promise<"ready" | "generic" | "unavailable"> {
	if (toolchainAdapterPhase(ref) === "generic") return "generic";
	try {
		const adapter = await loadToolchainAdapter(ref);
		return adapter ? "ready" : "unavailable";
	} catch {
		return "unavailable";
	}
}

export const toolchainWebAdapters = {
	get(ref: string) {
		return byRef.get(ref);
	},
};
