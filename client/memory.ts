import type { z } from "zod";
import {
	forgetResultSchema,
	memoryContextSchema,
	memoryItemSchema,
	memoryItemsSchema,
	memoryStatusSchema,
	memoryTendenciesSchema,
	okSchema,
	shortTermSchema,
	type Remember,
} from "../api/domains/memory/contracts";
import { continuityItemSchema } from "../api/domains/continuity/contracts";
import { json, type Transport } from "./transport";
export function memoryClient(t: Transport) {
	const post = async <S extends z.ZodType>(
		schema: S,
		path: string,
		body: unknown,
	): Promise<z.infer<S>> =>
		schema.parse(await (await t.call(path, json(body))).json());
	return {
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
		rememberItem: (
			input: Omit<Remember, "polarity"> & { polarity?: Remember["polarity"] },
		) => post(memoryItemSchema, "/api/memory/items", input),
		memoryAction: (
			id: string,
			action: "stop" | "resume" | "retract",
			expectedRevision: number,
		) =>
			post(
				memoryItemSchema,
				`/api/memory/items/${encodeURIComponent(id)}/${action}`,
				{
					expectedRevision,
				},
			),
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
		deleteTendency: async (id: string) =>
			okSchema.parse(
				await (
					await t.call(`/api/memory/tendencies/${encodeURIComponent(id)}`, {
						method: "DELETE",
					})
				).json(),
			),
		/** The ContextWindow as it would be read now; `{ disabled: true }` while memory is off or unhealthy. */
		memoryContext: async (conversationId: string) =>
			memoryContextSchema.parse(
				await (
					await t.call(
						`/api/memory/context?conversationId=${encodeURIComponent(conversationId)}`,
					)
				).json(),
			),
		/** Closes a short-term note: done (`resolved`) or withdrawn (`retracted`). */
		continuityTransition: (
			itemId: string,
			status: "resolved" | "retracted",
			expectedRevision: number,
		) =>
			post(
				continuityItemSchema,
				`/api/continuity/${encodeURIComponent(itemId)}/transition`,
				{ expectedRevision, status },
			),
		forgetItem: (id: string) =>
			post(
				forgetResultSchema,
				`/api/memory/items/${encodeURIComponent(id)}/forget`,
				{},
			),
	};
}
