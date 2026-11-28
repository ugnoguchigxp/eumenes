import type { Query, QueryClient } from "@tanstack/react-query";
import type { ChangeKind } from "../../client/events";

/** First element of every react-query key. Keys are `[root, identity, ...]`. */
export const queryRoots = {
	docling: "docling",
	music: "music",
	resources: "resources",
	screen: "screen",
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
	steward: "steward",
} as const;

/**
 * Roots refreshed when the backend reports a change. Diagnostics and probes
 * hit live providers and are fetched on demand, so the ~10s lease-write
 * `change` events do not re-run them.
 */
export const changeRoots = [
	queryRoots.docling,
	queryRoots.objectRecognition,
	queryRoots.ocr,
	queryRoots.music,
	queryRoots.resources,
	queryRoots.screen,
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
	queryRoots.steward,
] as const;
const savedRoots: ReadonlySet<unknown> = new Set(changeRoots);

/** Roots whose queries call live providers; they are fetched on demand only. */
const liveProviderRoots: readonly string[] = [
	queryRoots.settingsDiagnostics,
	queryRoots.connectionModels,
	queryRoots.larmVoices,
];

function isLiveProviderQuery(query: Query) {
	return liveProviderRoots.includes(String(query.queryKey[0]));
}

/**
 * A save during an in-flight read needs one later read. Wait separately for
 * each query so slow or paused reads do not hold up the rest of the screen.
 */
export function subscribeQueryRefresh(
	cache: QueryClient,
	subscribe: (notify: (kind: ChangeKind) => void) => () => void,
) {
	const queries = cache.getQueryCache();
	const pending = new Set<Query>();
	let scheduled = false;
	function schedule() {
		if (scheduled) return;
		scheduled = true;
		queueMicrotask(() => {
			scheduled = false;
			const ready = new Set<Query>();
			for (const query of pending) {
				if (query.state.fetchStatus !== "idle") continue;
				pending.delete(query);
				ready.add(query);
			}
			if (ready.size)
				void cache.invalidateQueries(
					{ predicate: (query) => ready.has(query) },
					{ cancelRefetch: false },
				);
		});
	}
	const unwatch = queries.subscribe((event) => {
		if (event.type === "removed") pending.delete(event.query);
		if (
			event.type === "updated" &&
			event.query.state.fetchStatus === "idle" &&
			pending.has(event.query)
		)
			schedule();
	});
	const unsubscribe = subscribe((kind) => {
		for (const query of queries.getAll()) {
			if (kind === "change" && !savedRoots.has(query.queryKey[0])) continue;
			if (isLiveProviderQuery(query)) query.invalidate();
			else pending.add(query);
		}
		schedule();
	});
	return () => {
		unsubscribe();
		unwatch();
		pending.clear();
	};
}

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
			predicate: (query) => !isLiveProviderQuery(query),
		}),
	]);
}
