import type { QueryClient } from "@tanstack/react-query";

/** First element of every react-query key. Keys are `[root, identity, ...]`. */
export const queryRoots = {
	agentTasks: "agent-tasks",
	agentReports: "agent-reports",
	conversation: "conversation",
	dialogue: "dialogue",
	larm: "larm",
	larmDetails: "larm-details",
	larmVoices: "larm-voices",
	settings: "settings",
	settingsSchedules: "settings-schedules",
	settingsOccurrences: "settings-occurrences",
	settingsDiagnostics: "settings-diagnostics",
	inferenceUsage: "inference-usage",
	inferenceProbes: "inference-probes",
	memoryStatus: "memory-status",
	ttsDictionary: "tts-dictionary",
	serviceCatalog: "service-catalog",
	serviceRuns: "service-runs",
	voiceDialogue: "voice-dialogue",
	researchRoutes: "research-routes",
	timers: "timers",
	world: "world",
} as const;

/**
 * Roots refreshed when the backend reports a change. Diagnostics and probes
 * hit live providers and are fetched on demand, so the ~10s lease-write
 * `change` events do not re-run them.
 */
export const changeRoots = [
	queryRoots.agentTasks,
	queryRoots.agentReports,
	queryRoots.conversation,
	queryRoots.dialogue,
	queryRoots.larm,
	queryRoots.larmDetails,
	queryRoots.settings,
	queryRoots.settingsSchedules,
	queryRoots.settingsOccurrences,
	queryRoots.inferenceUsage,
	queryRoots.memoryStatus,
	queryRoots.ttsDictionary,
	queryRoots.serviceCatalog,
	queryRoots.serviceRuns,
	queryRoots.voiceDialogue,
	queryRoots.researchRoutes,
	queryRoots.timers,
	queryRoots.world,
] as const;

/** Roots whose queries call live providers; they are fetched on demand only. */
export const liveProviderRoots: readonly string[] = [
	queryRoots.settingsDiagnostics,
	queryRoots.inferenceProbes,
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
