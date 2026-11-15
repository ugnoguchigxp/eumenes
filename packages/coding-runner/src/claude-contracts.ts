import { z } from "zod";

export const claudeStart = z.strictObject({
	id: z.uuid(),
	workId: z.uuid(),
	generation: z.number().int().nonnegative(),
	instruction: z.string().min(1).max(8_000),
	priorExecutionId: z.uuid().nullable(),
	deadline: z.number().int().positive(),
	maxTurns: z.number().int().min(1).max(30),
	readOnly: z.boolean(),
});
export const claudeQuestion = z.strictObject({
	id: z.uuid(),
	prompt: z.string().min(1).max(2_000),
	expiresAt: z.number().int(),
	inputSchema: z.record(z.string(), z.unknown()),
});
export const claudeObservation = z.strictObject({
	executionId: z.uuid(),
	seq: z.number().int().nonnegative(),
	state: z.enum([
		"running",
		"waiting",
		"finished",
		"failed",
		"stopped",
		"unknown",
	]),
	question: claudeQuestion.optional(),
	summary: z.string().max(4_000).optional(),
	evidence: z
		.array(
			z.strictObject({ ref: z.string().max(160), text: z.string().max(1_024) }),
		)
		.max(12)
		.optional(),
	turns: z.number().int().nonnegative().optional(),
	canResume: z.boolean().optional(),
	managedExecutionStopped: z.boolean(),
});
export const claudeRequest = z.discriminatedUnion("operation", [
	z.strictObject({ operation: z.literal("health") }),
	z.strictObject({ operation: z.literal("start"), spec: claudeStart }),
	z.strictObject({ operation: z.literal("inspect"), id: z.uuid() }),
	z.strictObject({
		operation: z.literal("stop"),
		id: z.uuid(),
		operationId: z.uuid(),
	}),
	z.strictObject({
		operation: z.literal("reply"),
		id: z.uuid(),
		operationId: z.uuid(),
		questionId: z.uuid(),
		answer: z.string().min(1).max(2_000),
	}),
	z.strictObject({
		operation: z.literal("events"),
		id: z.uuid(),
		after: z.number().int().nonnegative().max(1_000_000),
	}),
]);
export type ClaudeStart = z.infer<typeof claudeStart>;
export type ClaudeObservation = z.infer<typeof claudeObservation>;
export type ClaudeRequest = z.infer<typeof claudeRequest>;
