import type { z } from "zod";
import {
	forgetResultSchema,
	memoryItemSchema,
	memoryItemsSchema,
	memoryStatusSchema,
	type Remember,
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
		forgetItem: (id: string) =>
			post(
				forgetResultSchema,
				`/api/memory/items/${encodeURIComponent(id)}/forget`,
				{},
			),
	};
}
