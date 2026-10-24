import { z } from "zod";
import {
	taskDtoSchema,
	reportSchema,
	reportRequirements,
	candidateResultSchema,
	workQuery,
	type WorkQuery,
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
const canonicalBase = z.object({
	version: z.literal(2),
	outcome: z.enum([
		"answered",
		"candidates_found",
		"partial",
		"not_found",
		"clarification_required",
		"failed",
	]),
	candidateResults: z.array(candidateResultSchema).max(5).optional(),
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
});
const consistent = (v: {
	outcome: string;
	claims: unknown[];
	candidateResults?: unknown[];
}) =>
	v.outcome === "candidates_found"
		? !!v.candidateResults?.length && !v.claims.length
		: ["answered", "partial"].includes(v.outcome)
			? v.claims.length > 0
			: v.claims.length === 0;
const canonicalV2 = canonicalBase.refine(consistent);
const canonicalV3 = canonicalBase
	.extend({ version: z.literal(3), requirements: reportRequirements })
	.refine(consistent);
const report = z.union([canonicalV3, canonicalV2, legacyReport]);
const catalog = z.object({
	items: z.array(
		z.object({ id: z.string(), title: z.string(), summary: z.string() }),
	),
	nextCursor: z.string().nullable(),
});
const workItem = z.object({
	id: z.string(),
	request: z.string(),
	status: z.string(),
	pipeline: z.boolean(),
	resultSummary: z.string().nullable(),
	createdAt: z.number(),
	updatedAt: z.number(),
	heldEventId: z.string().nullable(),
});
/** The agency's TODO view of one conversation: open and held items, then archived (reported) ones. */
export const agencyWorkSchema = z.object({
	items: z.array(workItem),
	archived: z.array(workItem.extend({ releasedAt: z.number() })),
});
export type AgencyWork = z.infer<typeof agencyWorkSchema>;
export const agencyWorkPageSchema = z.object({
	rows: z.array(
		workItem.extend({
			state: z.enum(["todo", "done", "archived"]),
			releasedAt: z.number().nullable(),
		}),
	),
	counts: z.object({
		todo: z.number().int().nonnegative(),
		done: z.number().int().nonnegative(),
		archived: z.number().int().nonnegative(),
	}),
	total: z.number().int().nonnegative(),
	state: workQuery.shape.state,
	pageIndex: z.number().int().nonnegative(),
	pageSize: workQuery.shape.pageSize,
});
export type AgencyWorkPage = z.infer<typeof agencyWorkPageSchema>;

export function agentRuntimeClient(t: Transport) {
	return {
		agencyWorkPage: async (
			conversationId: string,
			query: WorkQuery,
			signal?: AbortSignal,
		) => {
			const params = new URLSearchParams({
				conversationId,
				...Object.fromEntries(
					Object.entries(workQuery.parse(query)).map(([key, value]) => [
						key,
						String(value),
					]),
				),
			});
			return agencyWorkPageSchema.parse(
				await (
					await t.call(`/api/agent-executions/work?${params}`, { signal })
				).json(),
			);
		},
		agencyWork: async (conversationId: string, signal?: AbortSignal) =>
			agencyWorkSchema.parse(
				await (
					await t.call(
						`/api/agent-executions/work?conversationId=${encodeURIComponent(conversationId)}`,
						{ signal },
					)
				).json(),
			),
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
