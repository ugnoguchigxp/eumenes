import {
	memoryContextSchema,
	memoryItemsSchema,
	memoryStatusSchema,
	memoryTendenciesSchema,
	shortTermSchema,
} from "../api/domains/memory/contracts";
import {
	decisionsResponseSchema,
	stewardActivitySchema,
	stewardErrorReportSchema,
} from "../api/domains/steward/contracts";
import {
	memorySeedResultSchema,
	type MemorySeed,
} from "../api/domains/memory/contracts";
import { callJson, json, withQuery, type Transport } from "./transport";
export function memoryClient(t: Transport) {
	return {
		previewMemorySeeds: (seeds: readonly MemorySeed[]) =>
			callJson(
				t,
				memorySeedResultSchema,
				"/api/memory/seeds/preview",
				json({ seeds }),
			),
		importMemorySeeds: (seeds: readonly MemorySeed[]) =>
			callJson(
				t,
				memorySeedResultSchema,
				"/api/memory/seeds/import",
				json({ seeds }),
			),
		memoryStatus: async () =>
			callJson(t, memoryStatusSchema, "/api/memory/status"),
		setMemoryEnabled: (enabled: boolean) =>
			callJson(
				t,
				memoryStatusSchema,
				"/api/memory/settings",
				json({ enabled }),
			),
		memoryItems: async (all = false) =>
			(
				await callJson(
					t,
					memoryItemsSchema,
					withQuery("/api/memory/items", { all: all ? 1 : undefined }),
				)
			).items,
		/** Active, unexpired notes of one conversation (the caller always names it). */
		memoryShortTerm: async (conversationId: string) =>
			(
				await callJson(
					t,
					shortTermSchema,
					withQuery("/api/memory/short-term", { conversationId }),
				)
			).items,
		memoryTendencies: async () =>
			(await callJson(t, memoryTendenciesSchema, "/api/memory/tendencies"))
				.items,
		/** The ContextWindow as it would be read now; `{ disabled: true }` while memory is off or unhealthy. */
		memoryContext: async (conversationId: string) =>
			callJson(
				t,
				memoryContextSchema,
				withQuery("/api/memory/context", { conversationId }),
			),
		/** What the steward decided in a conversation, newest first. */
		stewardDecisions: async (conversationId: string, limit?: number) =>
			(
				await callJson(
					t,
					decisionsResponseSchema,
					withQuery("/api/steward/decisions", { conversationId, limit }),
				)
			).items,
		/** What the steward runs now and what failed last in a conversation. */
		stewardActivity: async (conversationId: string, signal?: AbortSignal) =>
			callJson(
				t,
				stewardActivitySchema,
				withQuery("/api/steward/activity", { conversationId }),
				{ signal },
			),
		/** The diagnostic text of the steward's failures in a conversation; 404 when none is failing. */
		stewardErrorReport: async (conversationId: string, signal?: AbortSignal) =>
			callJson(
				t,
				stewardErrorReportSchema,
				withQuery("/api/steward/error-report", { conversationId }),
				{ signal },
			),
	};
}
