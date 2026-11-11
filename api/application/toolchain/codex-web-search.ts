import { duckDuckGo, type SearchProvider } from "llm-fetch";
import type { InferenceService } from "../../domains/inference";
import type { SettingsService } from "../../domains/settings";
import {
	codexSearchMessages,
	codexSearchProvider,
	parseCodexSearchHits,
} from "../../domains/web-research";
import type { SqliteStore } from "../../infrastructure/sqlite";

/** Acquires search candidates for the existing Web research worker, using the explicitly selected cloud route. */
export function createCodexWebSearch(
	store: SqliteStore,
	settings: SettingsService,
	inference: InferenceService,
): SearchProvider {
	const existing = duckDuckGo({ timeoutMs: 10_000 });
	return {
		name: codexSearchProvider,
		async search(input) {
			const signal = input.signal ?? new AbortController().signal;
			signal.throwIfAborted();
			const taskId = `web-search-${crypto.randomUUID()}`;
			const deadline = Date.now() + 30_000;
			const requestId = await store.write((db) => {
				signal.throwIfAborted();
				const snapshot = settings.inTransaction(db);
				const route = snapshot.routes.llm;
				const resource = snapshot.resources.find(
					(r) => r.id === route.fallbackId && r.purpose === "llm",
				);
				const connection = snapshot.connections.find(
					(c) => c.id === resource?.connectionId,
				);
				if (
					route.mode !== "cloud-only" ||
					!route.cloudAllowed ||
					!resource ||
					!connection?.enabled ||
					connection.kind !== "codex-sdk"
				)
					return null;
				return inference.captureBackgroundControlInTransaction(db, {
					taskId,
					decisionId: "lookup",
					authorityEpoch: 1,
					executionGeneration: 1,
					deadline,
					taskDeadline: deadline,
					maxOutputTokens: 1500,
					route: { resourceId: resource.id, strict: true },
					structuredOutput: true,
				});
			});
			if (!requestId) return existing.search(input);
			try {
				const { instructions, outputSchema, messages } =
					codexSearchMessages(input);
				const receipt = await inference.executeControl(
					requestId,
					messages,
					signal,
					{
						instructions,
						outputSchema,
						reasoningEffort: "low",
						nativeWebSearch: true,
					},
					{ sessionRole: "auxiliary" },
				);
				signal.throwIfAborted();
				if (typeof receipt.value !== "string")
					throw new Error("web_search_invalid_output");
				const hits = parseCodexSearchHits(receipt.value, input.limit);
				const accepted = await store.write(
					(db) => !signal.aborted && inference.acceptInTransaction(db, receipt),
				);
				if (!accepted) throw new Error("web_search_stale");
				return hits;
			} finally {
				await inference.cancelSubject(`background:${taskId}:lookup`);
			}
		},
	};
}
