import { z } from "zod";

const path = z
	.string()
	.startsWith("/")
	.max(2_048)
	.refine((value) => !value.includes("\0"));
export const claudeCheck = z.strictObject({
	executable: path,
	args: z
		.array(
			z
				.string()
				.max(2_048)
				.refine((value) => !value.includes("\0")),
		)
		.max(64),
	cwd: path,
});
export const claudeAuthorization = z
	.strictObject({
		workspaceRef: z.string().min(1).max(160),
		mode: z.enum(["read", "verify", "edit"]),
		targetRevision: z.string().min(1).max(160),
		baselineInputDigest: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		deadline: z.number().int().positive(),
		readablePaths: z.array(path).max(128),
		writablePaths: z.array(path).max(128),
		checks: z.array(claudeCheck).max(16),
	})
	.refine(
		({ mode, writablePaths, checks }) =>
			(mode === "edit" || !writablePaths.length) &&
			(mode !== "read" || !checks.length) &&
			(mode !== "verify" || !!checks.length),
	);

const claudeLease = z.strictObject({
	ownerRef: z.string().min(1).max(160),
	executorId: z.string().min(1).max(160),
	epoch: z.string().min(1).max(160),
	slot: z.enum(["read", "edit", "exclusive"]),
});
const claudeDelegatedRun = z.strictObject({
	lease: claudeLease,
	authorization: claudeAuthorization,
});

export const claudeStart = z.strictObject({
	id: z.uuid(),
	workId: z.uuid(),
	generation: z.number().int().nonnegative(),
	instruction: z.string().min(1).max(8_000),
	priorExecutionId: z.uuid().nullable(),
	deadline: z.number().int().positive(),
	maxTurns: z.number().int().min(1).max(30),
	readOnly: z.boolean(),
	supervised: claudeDelegatedRun.optional(),
});
export const claudeQuestion = z.strictObject({
	id: z.uuid(),
	prompt: z.string().min(1).max(2_000),
	expiresAt: z.number().int(),
	inputSchema: z.record(z.string(), z.unknown()),
	presentation: z.enum(["waiting", "presented"]).optional(),
});
export const claudeEvidence = z.strictObject({
	ref: z.string().max(160),
	kind: z.enum(["read", "edit", "check"]),
	executionId: z.uuid(),
	targetRevision: z.string().min(1).max(160),
	inputDigest: z.string().min(1).max(160).optional(),
	text: z.string().max(1_024),
	path: path.optional(),
	passed: z.boolean().optional(),
	check: claudeCheck.optional(),
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
	answerReceipt: z
		.strictObject({ operationId: z.uuid(), questionId: z.uuid() })
		.optional(),
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
	supervised: claudeDelegatedRun.optional(),
	structuredEvidence: z.array(claudeEvidence).max(64).optional(),
	toolRequests: z
		.array(
			z.strictObject({
				id: z.uuid(),
				tool: z.enum([
					"Read",
					"Glob",
					"Grep",
					"Write",
					"Edit",
					"Bash",
					"AskUserQuestion",
				]),
			}),
		)
		.max(8)
		.optional(),
	blocked: z
		.enum([
			"verification_isolation_unavailable",
			"runner_quarantined",
			"runner_busy",
			"workspace_inputs_changed",
		])
		.optional(),
});
export const claudeRequest = z.discriminatedUnion("operation", [
	z.strictObject({ operation: z.literal("health") }),
	z.strictObject({ operation: z.literal("start"), spec: claudeStart }),
	z.strictObject({ operation: z.literal("inspect"), id: z.uuid() }),
	z.strictObject({
		operation: z.literal("approve_tool"),
		id: z.uuid(),
		requestId: z.uuid(),
		lease: claudeLease,
	}),
	z.strictObject({
		operation: z.literal("present"),
		id: z.uuid(),
		questionId: z.uuid(),
		expiresAt: z.number().int().positive(),
	}),
	z.strictObject({
		operation: z.literal("recover"),
		id: z.uuid(),
		lease: claudeLease,
		proof: z.enum(["process_exit", "host_reboot"]),
	}),
	z.strictObject({
		operation: z.literal("stop"),
		id: z.uuid(),
		operationId: z.uuid(),
		supervised: claudeDelegatedRun.optional(),
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
export type ClaudeRunAuthorization = z.infer<typeof claudeAuthorization>;
export type ClaudeCheck = z.infer<typeof claudeCheck>;
export type ClaudeEvidence = z.infer<typeof claudeEvidence>;
export type ClaudeLease = z.infer<typeof claudeLease>;
