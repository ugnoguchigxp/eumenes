import { z } from "zod";
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
	.refine((v) => v.action !== "answer_question" || v.questionId !== null);
export type Decision = z.infer<typeof decisionSchema>;
export const observationSchema = z.strictObject({
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
export interface WorkflowPort {
	available(): boolean;
	/** Configured by the host. CLI output cannot change these definitions. */
	policy(taskId: string): WorkflowPolicy;
	observe(taskId: string, signal: AbortSignal): Promise<Observation>;
	/** Persisted operation ID must be enforced by the worker; never replay an unknown write. */
	execute(intent: StepIntent, signal: AbortSignal): Promise<StepReceipt>;
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
});
