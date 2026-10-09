import { z } from "zod";
export const submitSchema = z.object({
	requestId: z.uuid(),
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
	utteranceId: z.string().min(1).max(120).optional(),
});
export type Submit = z.infer<typeof submitSchema>;
export const runSchema = z.object({
	id: z.string(),
	agentTaskId: z.string().nullable().optional(),
	requestId: z.string(),
	conversationId: z.string(),
	utteranceId: z.string().nullable(),
	status: z.enum([
		"queued",
		"running",
		"completed",
		"failed",
		"cancelled",
		"interrupted",
	]),
	revision: z.number().int(),
	inputMessageId: z.string(),
	answerMessageId: z.string().nullable(),
	error: z.string().nullable(),
	jobId: z.string().nullable(),
	deadlineAt: z.string().nullable(),
	sourceKind: z.enum(["manual", "voice", "schedule"]),
	scheduleId: z.string().nullable(),
	occurrenceId: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type Run = z.infer<typeof runSchema>;
export const progressSchema = z.object({
	runId: z.string(),
	status: runSchema.shape.status,
	text: z.string().max(65_536),
});
export type RunProgress = z.infer<typeof progressSchema>;
export const promptTargetSchema = z.object({
	conversationId: z.string().min(1).max(120),
	text: z.string().trim().min(1).max(8000),
	deadlineMs: z.number().int().min(10_000).max(600_000).optional(),
});
export type PromptTarget = z.infer<typeof promptTargetSchema>;
