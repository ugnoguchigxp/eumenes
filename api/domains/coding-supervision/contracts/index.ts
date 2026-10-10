import { z } from "zod";
import {
	messageMetadataSchema,
	runObservationSchema,
} from "../../../../packages/coding-runner/src/contracts";
const ref = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const actions = [
	"wait",
	"inspect_more",
	"answer_question",
	"request_change",
	"run_checks",
	"request_review",
	"request_commit",
	"request_push",
	"escalate",
	"finish_candidate",
	"fail_candidate",
] as const;
/** The approval prompt shows the whole instruction; keep it within the question budget. */
export const INSTRUCTION_MAX_BYTES = 5000;
const byteLength = (s: string) => new TextEncoder().encode(s).length;
export const decisionSchema = z
	.strictObject({
		action: z.enum(actions),
		reason: z.string().min(1).max(600),
		evidenceRefs: z.array(ref).max(20),
		instruction: z.string().min(1).max(4000).nullable(),
		questionId: ref.nullable(),
	})
	.refine(
		(v) =>
			!["answer_question", "request_change"].includes(v.action) ||
			v.instruction !== null,
	)
	.refine((v) => v.action !== "answer_question" || v.questionId !== null)
	.refine(
		(v) =>
			v.instruction === null ||
			byteLength(v.instruction) <= INSTRUCTION_MAX_BYTES,
	)
	// Only approval-gated actions may carry an instruction.
	.refine(
		(v) =>
			["answer_question", "request_change"].includes(v.action) ||
			v.instruction === null,
	);
export type Decision = z.infer<typeof decisionSchema>;
/** Execution facts kept apart: speech, turn terminal, process, capture and report limits. */
export const executionObservationSchema = z.strictObject({
	run: runObservationSchema,
	processState: z.enum([
		"intent",
		"accepted",
		"reserved",
		"running",
		"stopping",
		"stopped",
		"exited",
		"outcome_unknown",
	]),
	messages: z
		.array(
			z.strictObject({
				seq: z.number().int().positive(),
				ref,
				digest: hash,
				metadata: messageMetadataSchema,
			}),
		)
		.max(4),
	publicReport: z.enum([
		"nonempty_observed",
		"empty_only",
		"none_observed",
		"not_fully_observed",
	]),
	finalReport: z.enum([
		"observed",
		"missing",
		"unidentifiable",
		"not_fully_observed",
	]),
	limitations: z.array(z.string().max(100)).max(16),
	/** Fixed code of the last failed observation; null when the latest read succeeded. */
	issue: z.string().max(100).nullable(),
	/** Per reference, within this one observation only. */
	coverage: z
		.array(
			z.strictObject({
				ref,
				digest: hash,
				totalBytes: z.number().int().nonnegative(),
				ranges: z
					.array(
						z.tuple([
							z.number().int().nonnegative(),
							z.number().int().nonnegative(),
						]),
					)
					.max(8),
			}),
		)
		.max(4),
	excerptTruncated: z.boolean(),
});
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;
export const observationSchema = z.strictObject({
	details: executionObservationSchema.optional(),
	executionId: ref,
	eventSeq: z.number().int().min(0),
	sessionId: ref.nullable(),
	snapshotHash: hash.nullable(),
	turnFinished: z.boolean(),
	childrenStopped: z.boolean(),
	evidenceComplete: z.boolean(),
	exitCode: z.number().int().nullable(),
	question: z
		.strictObject({
			id: ref,
			kind: z.enum([
				"local_repair",
				"specification",
				"authorization",
				"environment",
			]),
			summary: z.string().min(1).max(2000),
		})
		.nullable(),
	evidenceRefs: z.array(ref).max(20),
	facts: z.array(z.string().min(1).max(600)).max(8),
	excerpt: z.string().max(16000),
});
/** Filled by a trusted reader of persisted receipts, never by the decision model. */
export type Observation = z.infer<typeof observationSchema>;
export const stepKinds = [
	"inspect_more",
	"answer_question",
	"request_change",
	"run_checks",
	"request_review",
	"request_commit",
	"request_push",
] as const;
export type StepKind = (typeof stepKinds)[number];
export interface WorkflowPolicy {
	checkIds: string[];
	checksDigest: string;
	reviewPolicyDigest: string;
}
export interface StepIntent {
	id: string;
	taskId: string;
	generation: number;
	authorityEpoch: number;
	revision: number;
	kind: StepKind;
	executionId: string;
	snapshotHash: string | null;
	implementationSessionId: string | null;
	observationDigest: string;
	instruction: string | null;
	questionId: string | null;
	deadline: number;
	policy: WorkflowPolicy;
	branch: string | null;
	remote: string | null;
}
export const stepReceiptSchema = z.strictObject({
	operationId: ref,
	kind: z.enum(stepKinds),
	snapshotHash: hash.nullable(),
	evidenceRefs: z.array(ref).min(1).max(20),
	turnFinished: z.boolean(),
	childrenStopped: z.boolean(),
	evidenceComplete: z.boolean(),
	checks: z
		.strictObject({
			digest: hash,
			results: z
				.array(z.strictObject({ id: ref, passed: z.boolean() }))
				.min(1)
				.max(20),
		})
		.nullable(),
	review: z
		.strictObject({
			policyDigest: hash,
			sessionId: ref,
			readOnly: z.literal(true),
			findings: z.array(z.string().min(1).max(600)).max(20),
		})
		.nullable(),
	commit: z
		.strictObject({
			sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
			branch: z.string().min(1).max(200),
		})
		.nullable(),
	push: z
		.strictObject({
			sha: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
			branch: z.string().min(1).max(200),
			remote: z.string().min(1).max(200),
			confirmed: z.literal(true),
		})
		.nullable(),
	conditionsMet: z.array(z.boolean()).max(20),
});
export type StepReceipt = z.infer<typeof stepReceiptSchema>;
/** Read-only access for diagnosis; it has no shell, mutation, question or Git operation. */
export interface ObservationReadPort {
	/** `focus` continues one stored reference from an offset; its coverage is not merged with older reads. */
	inspect(
		taskId: string,
		signal: AbortSignal,
		focus?: ReadFocus,
	): Promise<Observation>;
}
export interface ReadFocus {
	ref: string;
	offset: number;
}
/** The only kind of failure fact kept from a failed observation: fixed code and position. */
export interface ObservationFailure {
	code: string;
	generation: number;
	authorityEpoch: number;
	executionId: string | null;
	lastCursor: number | null;
}
export interface DiagnosticIntent {
	id: string;
	taskId: string;
	generation: number;
	authorityEpoch: number;
	executionId: string;
	code: string;
	deadline: number;
	focus?: ReadFocus;
}
export interface DiagnosticBudget {
	/** executionId:generation:authorityEpoch; the budget never resets for the same key. */
	scope: string;
	total: number;
	codes: Record<string, number>;
	activeId: string | null;
	/** Automatic diagnosis ended with a hold and one blocker report. */
	blocked?: boolean;
	/** Fingerprint a diagnostic read was already requested for. */
	requestedFor?: string;
}
export interface WorkflowPort {
	available(): boolean;
	/** Configured by the host. CLI output cannot change these definitions. */
	policy(taskId: string): WorkflowPolicy;
	observe(taskId: string, signal: AbortSignal): Promise<Observation>;
	/** Persisted operation ID must be enforced by the worker; never replay an unknown write. */
	execute(intent: StepIntent, signal: AbortSignal): Promise<StepReceipt>;
}
/** Reason code shown to the user while a supervisor instruction awaits approval. */
export const instructionApprovalRequired = "instruction_approval_required";
/** Answer values of the approval question; any other answer is treated as a rejection. */
export const approvalChoices = {
	approve: "承認する",
	reject: "却下する",
} as const;
export interface PendingApproval {
	/** Task question that carries the approval prompt. */
	questionId: string;
	/** The exact decision to replay once approved; its instruction is the stored text. */
	decision: Decision;
	observationDigest: string;
	resolution: "pending" | "approved" | "rejected" | "expired";
}
export interface Supervisor {
	taskId: string;
	generation: number;
	authorityEpoch: number;
	lastObservedAt: number | null;
	lastProgressAt: number | null;
	nextCheckAt: number;
	monitorHealth: "healthy" | "monitoring_delayed";
	failures: number;
	fingerprint: string | null;
	handledFingerprint: string | null;
	observation: Observation | null;
	decisionId: string | null;
	stepId: string | null;
	checks: StepReceipt | null;
	review: StepReceipt | null;
	commit: StepReceipt | null;
	push: StepReceipt | null;
	decisionsUsed: number;
	repairLoops: number;
	blockerAttempts: Record<string, number>;
	lastReportAt: number | null;
	lastReportFingerprint: string | null;
	holdReason: string | null;
	/** Last failed observation (fixed code), for a different story than "network was down". */
	observationIssue?: {
		code: string;
		executionId: string | null;
		lastCursor: number | null;
		at: number;
	} | null;
	diagnostics?: DiagnosticBudget | null;
	/** Absent in rows saved before the approval gate existed. */
	pendingApproval?: PendingApproval | null;
}

export const supervisorViewSchema = z.object({
	diagnosticDue: z.boolean(),
	taskId: z.string(),
	generation: z.number().int(),
	authorityEpoch: z.number().int(),
	lastObservedAt: z.number().nullable(),
	lastProgressAt: z.number().nullable(),
	nextCheckAt: z.number(),
	monitorHealth: z.enum(["healthy", "monitoring_delayed"]),
	failures: z.number().int(),
	fingerprint: z.string().nullable(),
	handledFingerprint: z.string().nullable(),
	decisionId: z.string().nullable(),
	stepId: z.string().nullable(),
	decisionsUsed: z.number().int(),
	repairLoops: z.number().int(),
	lastReportAt: z.number().nullable(),
	lastReportFingerprint: z.string().nullable(),
	holdReason: z.string().nullable(),
	pendingApproval: z
		.object({
			reasonCode: z.literal(instructionApprovalRequired),
			questionId: z.string(),
			action: z.enum(["request_change", "answer_question"]),
			reason: z.string(),
			instruction: z.string(),
		})
		.nullable(),
});
