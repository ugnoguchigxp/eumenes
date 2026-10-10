import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";

const bytes = (limit: number) =>
	z
		.string()
		.trim()
		.min(1)
		.refine((v) => new TextEncoder().encode(v).length <= limit);
export const taskStates = [
	"registered",
	"queued",
	"active",
	"waiting_user",
	"paused",
	"reconciling",
	"stopping",
	"completed",
	"failed",
	"cancelled",
] as const;
export const codingPhases = [
	"preparing",
	"implementing",
	"verifying",
	"reviewing",
	"repairing",
	"committing",
	"pushing",
	"finalizing",
] as const;
export const taskOperations = [
	"read",
	"edit",
	"check",
	"review",
	"commit",
	"push",
] as const;
const identifier = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
const gitName = z
	.string()
	.min(1)
	.max(200)
	.regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/)
	.refine((v) => !v.includes("..") && !v.endsWith("/") && !v.endsWith(".lock"));
export const taskGrantSchema = z
	.strictObject({
		workspaceId: identifier,
		operations: z
			.array(z.enum(taskOperations))
			.min(1)
			.max(6)
			.refine((v) => new Set(v).size === v.length),
		branch: gitName.nullable().default(null),
		remote: gitName.nullable().default(null),
		network: z.enum(["none", "registered"]).default("none"),
		expiresAt: z.iso.datetime({ offset: true }),
		maxRuntimeMs: z
			.number()
			.int()
			.min(60_000)
			.max(7_200_000)
			.default(7_200_000),
		maxDecisions: z.number().int().min(1).max(80).default(80),
		progressIntervalMs: z
			.number()
			.int()
			.min(60_000)
			.max(3_600_000)
			.default(300_000),
	})
	.refine(
		(v) =>
			!v.operations.includes("push") ||
			(v.operations.includes("commit") &&
				v.branch !== null &&
				v.remote !== null),
		{ message: "push requires commit, branch and remote" },
	);
export type TaskGrant = z.infer<typeof taskGrantSchema>;

export const createTaskSchema = z.strictObject({
	requestId: z.uuid(),
	kind: z.literal("coding"),
	version: z.literal(1),
	title: z.string().trim().min(1).max(120),
	request: bytes(32 * 1024),
	completionConditions: z.array(bytes(1024)).min(1).max(20),
	startMode: z.enum(["register_only", "start"]),
	grant: taskGrantSchema,
});
export type CreateTask = z.input<typeof createTaskSchema>;
export type TaskGrantInput = z.input<typeof taskGrantSchema>;
export const taskCommandSchema = z.strictObject({
	requestId: z.uuid(),
	expectedRevision: z.number().int().min(0),
});
export const amendTaskSchema = taskCommandSchema.extend({
	grant: taskGrantSchema,
});
export const stopTaskSchema = taskCommandSchema.extend({
	intent: z.enum(["pause", "cancel"]),
});
export const answerTaskSchema = taskCommandSchema.extend({
	questionId: identifier,
	answer: bytes(8192),
});
export const taskOriginSchema = z.discriminatedUnion("source", [
	z.strictObject({ source: z.literal("manual") }),
	z.strictObject({
		source: z.literal("conversation"),
		conversationId: identifier,
		messageId: identifier,
		runId: identifier.nullable(),
		operationKey: identifier,
	}),
]);
export type TaskOrigin = z.infer<typeof taskOriginSchema>;
export const taskReceiptSchema = z.object({
	taskId: z.string(),
	state: z.enum(taskStates),
	revision: z.number().int(),
	authorityEpoch: z.number().int(),
	executionGeneration: z.number().int(),
});
export type TaskReceipt = z.infer<typeof taskReceiptSchema>;
export const taskResultSchema = z.strictObject({
	summary: bytes(4096),
	evidenceRefs: z.array(identifier).min(1).max(20),
	conditionsMet: z.array(z.boolean()).max(20),
});
export type TaskResult = z.infer<typeof taskResultSchema>;
export const workTaskSchema = z.object({
	id: z.string(),
	kind: z.literal("coding"),
	version: z.literal(1),
	title: z.string(),
	request: z.string().nullable(),
	completionConditions: z.array(z.string()),
	origin: taskOriginSchema,
	state: z.enum(taskStates),
	phase: z.enum(codingPhases).nullable(),
	revision: z.number().int(),
	authorityEpoch: z.number().int(),
	executionGeneration: z.number().int(),
	eventSeq: z.number().int(),
	grant: taskGrantSchema,
	stopIntent: z.enum(["pause", "cancel"]).nullable(),
	result: taskResultSchema.nullable(),
	bodyExpired: z.boolean(),
	metadataExpired: z.boolean(),
	forgottenAt: z.string().nullable(),
	executionDeadlineAt: z.string().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
	finishedAt: z.string().nullable(),
});
export type WorkTask = z.infer<typeof workTaskSchema>;
export const taskQuestionInputSchema = z
	.strictObject({
		questionId: identifier,
		prompt: bytes(8192),
		answerType: z.enum(["text", "choice"]),
		choices: z.array(bytes(1024)).max(10),
	})
	.refine((v) =>
		v.answerType === "text"
			? v.choices.length === 0
			: v.choices.length >= 2 && new Set(v.choices).size === v.choices.length,
	);
export type TaskQuestionInput = z.infer<typeof taskQuestionInputSchema>;
export const taskQuestionSchema = z.object({
	id: z.string(),
	taskId: z.string(),
	prompt: z.string(),
	answerType: z.enum(["text", "choice"]),
	choices: z.array(z.string()),
	executionGeneration: z.number().int(),
	authorityEpoch: z.number().int(),
	state: z.enum(["open", "answered", "superseded"]),
	answer: z.string().nullable(),
	answeredFrom: taskOriginSchema.nullable(),
	createdAt: z.string(),
});
export type TaskQuestion = z.infer<typeof taskQuestionSchema>;
export const taskDetailSchema = z.object({
	task: workTaskSchema,
	question: taskQuestionSchema.nullable(),
	availableActions: z.array(
		z.enum(["start", "amend", "answer", "pause", "cancel", "forget"]),
	),
	execution: z.null(),
	supervisor: z.null(),
	latestReport: z.null(),
});
export const taskListSchema = z.object({
	items: z.array(workTaskSchema),
	nextCursor: z.string().nullable(),
});
export const taskEventSchema = z.object({
	seq: z.number().int(),
	taskId: z.string(),
	reason: z.string(),
	state: z.enum(taskStates),
	phase: z.enum(codingPhases).nullable(),
	revision: z.number().int(),
	authorityEpoch: z.number().int(),
	executionGeneration: z.number().int(),
	createdAt: z.string(),
});
export type TaskEvent = z.infer<typeof taskEventSchema>;
export const taskEventListSchema = z.object({
	items: z.array(taskEventSchema),
	nextCursor: z.string(),
	historyExpired: z.boolean(),
});
export const taskListQuerySchema = z.strictObject({
	state: z.enum(taskStates).optional(),
	conversationId: identifier.optional(),
	cursor: z
		.string()
		.regex(/^[1-9]\d*$/)
		.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** HTTP status of each error code this domain throws; merged by `api/application/error-status.ts`. */
export const errorStatus = {
	task_not_found: 404,
	task_execution_unavailable: 503,
	task_grant_expired: 409,
	task_runtime_expired: 409,
	task_state_conflict: 409,
	task_fence_conflict: 409,
	task_origin_conflict: 409,
	task_question_conflict: 409,
	task_capacity: 429,
} as const satisfies Record<string, HttpErrorStatus>;
