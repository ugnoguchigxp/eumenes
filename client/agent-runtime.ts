import { z } from "zod";
import {
	taskDtoSchema,
	reportSchema,
} from "../api/domains/agent-runtime/contracts";
import { publicUrl } from "../api/domains/capabilities/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";
const report = reportSchema.extend({
	coverage: z.enum(["complete", "partial"]),
	verification: z.literal("evidence_linked"),
	sources: z.array(
		z.object({
			sourceId: z.string(),
			url: publicUrl,
			title: z.string(),
			basis: z.enum(["page", "snippet"]),
			fetchedAt: z.string(),
			truncated: z.boolean(),
		}),
	),
});
const catalog = z.object({
	items: z.array(
		z.object({ id: z.string(), title: z.string(), summary: z.string() }),
	),
	nextCursor: z.string().nullable(),
});
export function agentRuntimeClient(t: Transport) {
	return {
		capabilities: async (signal?: AbortSignal) =>
			catalog.parse(
				await (await t.call("/api/capabilities", { signal })).json(),
			),
		agentTasks: async (rootRunId: string, signal?: AbortSignal) =>
			taskDtoSchema
				.array()
				.parse(
					await (
						await t.call(
							`/api/agent-tasks?rootRunId=${encodeURIComponent(rootRunId)}`,
							{ signal },
						)
					).json(),
				),
		agentTask: async (id: string, signal?: AbortSignal) =>
			taskDtoSchema.parse(
				await (
					await t.call(`/api/agent-tasks/${encodeURIComponent(id)}`, { signal })
				).json(),
			),
		agentReport: async (id: string, signal?: AbortSignal) =>
			report.nullable().parse(
				await (
					await t.call(`/api/agent-tasks/${encodeURIComponent(id)}/report`, {
						signal,
					})
				).json(),
			),
		cancelAgentTask: async (id: string) =>
			taskDtoSchema.parse(
				await (
					await t.call(
						`/api/agent-tasks/${encodeURIComponent(id)}/cancel`,
						json({}),
					)
				).json(),
			),
	};
}
