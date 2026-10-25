import type { QueryClient } from "@tanstack/react-query";

/** First element of every react-query key. Keys are `[root, identity, ...]`. */
export const queryRoots = {
	music: "music",
	image: "image",
	model3d: "model3d",
	browser: "browser",
	drawings: "drawings",
	drawingOperations: "drawing-operations",
	objectRecognition: "object-recognition",
	ocr: "ocr",
	agentTasks: "agent-tasks",
	agentReports: "agent-reports",
	toolchainSelections: "toolchain-selections",
	conversation: "conversation",
	dialogue: "dialogue",
	larm: "larm",
	larmDetails: "larm-details",
	larmProfiles: "larm-profiles",
	larmVoices: "larm-voices",
	connectionModels: "connection-models",
	settings: "settings",
	settingsDiagnostics: "settings-diagnostics",
	inferenceUsage: "inference-usage",
	monitoring: "monitoring",
	voiceDialogue: "voice-dialogue",
	timers: "timers",
	shell: "shell",
	terminals: "terminals",
	kanban: "kanban",
	toolchainArtifacts: "toolchain-artifacts",
	toolchainInteractions: "toolchain-interactions",
	steward: "steward",
} as const;

/**
 * Roots refreshed when the backend reports a change. Diagnostics and probes
 * hit live providers and are fetched on demand, so the ~10s lease-write
 * `change` events do not re-run them.
 */
export const changeRoots = [
	queryRoots.objectRecognition,
	queryRoots.ocr,
	queryRoots.music,
	queryRoots.image,
	queryRoots.model3d,
	queryRoots.browser,
	queryRoots.drawings,
	queryRoots.drawingOperations,
	queryRoots.agentTasks,
	queryRoots.agentReports,
	queryRoots.conversation,
	queryRoots.dialogue,
	queryRoots.larm,
	queryRoots.larmDetails,
	queryRoots.settings,
	queryRoots.inferenceUsage,
	queryRoots.voiceDialogue,
	queryRoots.timers,
	queryRoots.shell,
	queryRoots.terminals,
	queryRoots.kanban,
	queryRoots.toolchainInteractions,
	queryRoots.steward,
] as const;

/** Roots whose queries call live providers; they are fetched on demand only. */
const liveProviderRoots: readonly string[] = [
	queryRoots.settingsDiagnostics,
	queryRoots.connectionModels,
	queryRoots.larmVoices,
];

/**
 * Refreshes everything except live-provider queries. Those are only marked
 * stale (no refetch) so they load the next time a screen asks for them.
 */
export async function invalidateAllButLive(cache: QueryClient) {
	await Promise.all([
		...liveProviderRoots.map((root) =>
			cache.invalidateQueries({ queryKey: [root], refetchType: "none" }),
		),
		cache.invalidateQueries({
			predicate: (query) =>
				!liveProviderRoots.includes(String(query.queryKey[0])),
		}),
	]);
}
