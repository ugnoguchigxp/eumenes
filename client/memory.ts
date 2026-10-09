import type { MemoryItemDto } from "../api/domains/memory";
import type { Remember } from "../api/domains/memory/contracts";
import { json, type Transport } from "./transport";
export function memoryClient(t: Transport) {
	const post = async <T>(path: string, body: unknown) =>
		(await (await t.call(path, json(body))).json()) as T;
	return {
		memoryStatus: async () =>
			(await (await t.call("/api/memory/status")).json()) as {
				enabled: boolean;
				healthy: boolean;
			},
		setMemoryEnabled: (enabled: boolean) =>
			post<{ enabled: boolean; healthy: boolean }>("/api/memory/settings", {
				enabled,
			}),
		memoryItems: async (all = false) =>
			(
				(await (
					await t.call(`/api/memory/items${all ? "?all=1" : ""}`)
				).json()) as { items: MemoryItemDto[] }
			).items,
		rememberItem: (
			input: Omit<Remember, "polarity"> & { polarity?: Remember["polarity"] },
		) => post<MemoryItemDto>("/api/memory/items", input),
		memoryAction: (
			id: string,
			action: "stop" | "resume" | "retract",
			expectedRevision: number,
		) =>
			post<MemoryItemDto>(
				`/api/memory/items/${encodeURIComponent(id)}/${action}`,
				{
					expectedRevision,
				},
			),
		forgetItem: (id: string) =>
			post<{ forgetId: string; completed: boolean }>(
				`/api/memory/items/${encodeURIComponent(id)}/forget`,
				{},
			),
	};
}
