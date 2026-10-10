import { z } from "zod";
import {
	taskDtoSchema,
	reportSchema,
} from "../api/domains/agent-runtime/contracts";
import { publicUrl } from "../api/domains/capabilities/contracts";
import type { Transport } from "./transport";
import { json } from "./transport";
const legacyReport = reportSchema.extend({
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
const sourceV2 = z.object({
	kind: z.enum(["web_source", "conversation_source"]).optional(),
	sourceId: z.string(),
	url: publicUrl.optional(),
	title: z.string(),
	basis: z.enum(["page", "snippet", "conversation"]),
	fetchedAt: z.string(),
	truncated: z.boolean(),
	sourceRef: z.string().optional(),
	sourceRevision: z.string().optional(),
	viewId: z.string(),
	viewDigest: z.string(),
	messageId: z.string().optional(),
	messageRef: z.string().optional(),
	conversationId: z.string().optional(),
	speaker: z.enum(["user", "assistant"]).optional(),
	createdAt: z.string().optional(),
	revision: z.string().optional(),
	digest: z.string().optional(),
	scopeRef: z.string().optional(),
});
const canonicalV2 = z
	.object({
		version: z.literal(2),
		outcome: z.enum([
			"answered",
			"partial",
			"not_found",
			"clarification_required",
			"failed",
		]),
		summary: z.string(),
		claims: z.array(
			z.object({
				text: z.string(),
				evidence: z.array(
					z.object({
						sourceId: z.string(),
						quote: z.string(),
						viewId: z.string().optional(),
					}),
				),
			}),
		),
		limitations: z.array(z.string()),
		exploration: z.array(z.string()),
		coverage: z.enum(["complete", "partial"]),
		verification: z.literal("evidence_linked"),
		sources: z.array(sourceV2),
	})
	.refine((v) =>
		["answered", "partial"].includes(v.outcome)
			? v.claims.length > 0
			: v.claims.length === 0,
	);
const report = z.union([canonicalV2, legacyReport]);
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
