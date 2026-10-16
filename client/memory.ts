import type { z } from "zod";
import {
	memoryContextSchema,
	memoryItemsSchema,
	memoryStatusSchema,
	memoryTendenciesSchema,
	shortTermSchema,
} from "../api/domains/memory/contracts";
import { decisionsResponseSchema } from "../api/domains/steward/contracts";
import {
	memorySeedResultSchema,
	type MemorySeed,
} from "../api/domains/memory/contracts";
import { json, type Transport } from "./transport";
export function memoryClient(t: Transport) {
	const post = async <S extends z.ZodType>(
		schema: S,
		path: string,
		body: unknown,
	): Promise<z.infer<S>> =>
		schema.parse(await (await t.call(path, json(body))).json());
	return {
		previewMemorySeeds: (seeds: readonly MemorySeed[]) =>
			post(memorySeedResultSchema, "/api/memory/seeds/preview", { seeds }),
		importMemorySeeds: (seeds: readonly MemorySeed[]) =>
			post(memorySeedResultSchema, "/api/memory/seeds/import", { seeds }),
		memoryStatus: async () =>
			memoryStatusSchema.parse(
				await (await t.call("/api/memory/status")).json(),
			),
		setMemoryEnabled: (enabled: boolean) =>
			post(memoryStatusSchema, "/api/memory/settings", { enabled }),
		memoryItems: async (all = false) =>
			memoryItemsSchema.parse(
				await (await t.call(`/api/memory/items${all ? "?all=1" : ""}`)).json(),
			).items,
		/** Active, unexpired notes of one conversation (the caller always names it). */
		memoryShortTerm: async (conversationId: string) =>
			shortTermSchema.parse(
				await (
					await t.call(
						`/api/memory/short-term?conversationId=${encodeURIComponent(conversationId)}`,
					)
				).json(),
			).items,
		memoryTendencies: async () =>
			memoryTendenciesSchema.parse(
				await (await t.call("/api/memory/tendencies")).json(),
			).items,
		/** The ContextWindow as it would be read now; `{ disabled: true }` while memory is off or unhealthy. */
		memoryContext: async (conversationId: string) =>
			memoryContextSchema.parse(
				await (
					await t.call(
						`/api/memory/context?conversationId=${encodeURIComponent(conversationId)}`,
					)
				).json(),
			),
		/** What the steward decided in a conversation, newest first. */
		stewardDecisions: async (conversationId: string, limit?: number) =>
			decisionsResponseSchema.parse(
				await (
					await t.call(
						`/api/steward/decisions?conversationId=${encodeURIComponent(conversationId)}${limit === undefined ? "" : `&limit=${limit}`}`,
					)
				).json(),
			).items,
	};
}
