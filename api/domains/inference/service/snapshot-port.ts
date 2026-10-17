import type { Database } from "bun:sqlite";
import type { Settings } from "../../settings/contracts";
import type { SettingsService } from "../../settings";
import type { LarmPort } from "../../larm";
import type { InferencePort } from "../contracts";
import { get } from "../repository";

/**
 * The model window (tokens) the LLM route of these settings gives: the saved resource's `contextWindow` on a
 * cloud-only route; on a route where LARM answers, the window of the LARM lease held now (null while none is
 * held: a claim is made only to serve a call).
 */
function routeWindow(
	snapshot: Settings,
	port: (settings: Settings) => LarmPort,
): number | null {
	const route = snapshot.routes.llm;
	if (route.mode !== "cloud-only")
		return port(snapshot).llmContextWindow?.() ?? null;
	return (
		snapshot.resources.find(
			(resource) =>
				resource.id === route.fallbackId && resource.purpose === "llm",
		)?.contextWindow ?? null
	);
}

/** The settings a captured request stands on, and the model window those settings (or the saved ones) give. */
export function snapshotPort(
	settings: Pick<SettingsService, "get" | "inTransaction">,
	port: (settings: Settings) => LarmPort,
): Required<
	Pick<
		InferencePort,
		| "snapshotInTransaction"
		| "llmContextWindowInTransaction"
		| "savedLlmContextWindow"
	>
> {
	return {
		snapshotInTransaction: settings.inTransaction,
		llmContextWindowInTransaction(db: Database, requestId: string) {
			const snapshot = get(db, requestId)?.snapshot;
			return snapshot ? routeWindow(snapshot, port) : null;
		},
		savedLlmContextWindow: () => routeWindow(settings.get(), port),
	};
}
