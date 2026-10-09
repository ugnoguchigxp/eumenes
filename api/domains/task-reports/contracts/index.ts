import { z } from "zod";
export const reportKinds = [
	"progress",
	"blocker",
	"completed",
	"failed",
	"cancelled",
	"paused",
	"monitoring_issue",
] as const;
const ref = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
export const reportBodySchema = z
	.strictObject({
		kind: z.enum(reportKinds),
		summary: z.string().trim().min(1).max(2000),
		facts: z.array(z.string().min(1).max(600)).max(8),
		limitations: z.array(z.string().min(1).max(600)).max(8),
		evidenceRefs: z.array(ref).max(20),
		snapshotHash: ref.nullable(),
		questionId: ref.nullable(),
		git: z
			.strictObject({
				commitSha: z
					.string()
					.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
					.nullable(),
				remoteSha: z
					.string()
					.regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
					.nullable(),
				branch: z.string().max(200).nullable(),
				remote: z.string().max(200).nullable(),
			})
			.nullable()
			.optional(),
	})
	.refine((v) => v.kind === "completed" || v.summary.length <= 600);
export type ReportBody = z.infer<typeof reportBodySchema>;
export const taskReportSchema = reportBodySchema.safeExtend({
	id: z.string(),
	taskId: z.string(),
	sequence: z.number().int(),
	executionGeneration: z.number().int(),
	authorityEpoch: z.number().int(),
	taskRevision: z.number().int(),
	originConversationId: z.string().nullable(),
	phase: z.string().nullable(),
	observedAt: z.number().int(),
	createdAt: z.number().int(),
	dedupeKey: z.string(),
	priority: z.enum(["normal", "high"]),
});
export type TaskReport = z.infer<typeof taskReportSchema>;
export const reportListSchema = z.object({
	items: z.array(taskReportSchema),
	nextCursor: z.number().int().nullable(),
});
