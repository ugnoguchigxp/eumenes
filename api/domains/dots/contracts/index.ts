import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";

export const ref = z
	.string()
	.min(1)
	.max(160)
	.regex(/^[a-zA-Z0-9_.:-]+$/);
const https = z.url().refine((v) => {
	const u = new URL(v);
	return (
		u.protocol === "https:" &&
		!u.username &&
		!u.password &&
		!u.hash &&
		!u.search
	);
});
export const connectionInput = z.strictObject({
	id: ref,
	expectedRevision: z.number().int().min(0),
	title: z.string().trim().min(1).max(120),
	enabled: z.boolean(),
	oauth: z
		.strictObject({
			issuer: https,
			jwksUrl: https,
			resource: https,
			subject: z.string().min(1).max(200),
		})
		.nullable(),
});
export const connectionSchema = connectionInput
	.omit({ expectedRevision: true })
	.extend({ revision: z.number().int().min(1) });
export type Connection = z.infer<typeof connectionSchema>;
export const projectInput = z.strictObject({
	ref,
	connectionRef: ref,
	expectedRevision: z.number().int().min(0),
	title: z.string().trim().min(1).max(120),
	capabilityRevisionId: z
		.string()
		.regex(/^package:[a-z][a-z0-9._-]{0,100}@[1-9][0-9]*$/)
		.default("package:dots.orchestrate@1"),
	allowedOperations: z
		.array(
			z.enum([
				"read",
				"create_session",
				"continue_session",
				"edit",
				"check",
				"commit",
				"push",
				"publish",
				"send",
			]),
		)
		.min(1)
		.max(9)
		.default(["read", "create_session", "edit", "check"]),
	nativeProjectId: ref,
	hostId: ref,
	environment: z.enum(["local", "cloud"]),
	enabled: z.boolean(),
});
export const projectSchema = projectInput
	.omit({ expectedRevision: true })
	.extend({ revision: z.number().int().min(1) });
export type Project = z.infer<typeof projectSchema>;
export const commandRef = z.strictObject({ commandId: ref });
export const claimInput = commandRef.extend({ leaseId: z.uuid() });
export const nativeSession = z.strictObject({
	threadId: ref,
	projectId: ref,
	hostId: ref,
	parentThreadId: ref.nullable().default(null),
});
export type NativeSession = z.infer<typeof nativeSession>;
export const reportSchema = z
	.strictObject({
		reportId: z.uuid(),
		commandId: ref,
		taskId: ref,
		authorityEpoch: z.number().int().positive(),
		executionGeneration: z.number().int().positive(),
		sourceSequence: z.number().int().positive(),
		kind: z.enum([
			"accepted",
			"session_started",
			"progress",
			"blocked",
			"completed",
			"failed",
			"no_next_work",
			"reminder",
			"stopped",
		]),
		summary: z.string().trim().min(1).max(600),
		facts: z.array(z.string().min(1).max(600)).max(8).default([]),
		limitations: z.array(z.string().min(1).max(600)).max(8).default([]),
		evidenceRefs: z.array(ref).max(20).default([]),
		sessions: z.array(nativeSession).max(20).default([]),
		question: z
			.strictObject({
				questionId: ref,
				prompt: z.string().min(1).max(8000),
				answerType: z.enum(["text", "choice"]),
				choices: z.array(z.string().min(1).max(1000)).max(10),
			})
			.optional(),
		completionChecks: z
			.array(
				z.strictObject({
					status: z.enum(["satisfied", "unsatisfied", "unknown"]),
					evidenceRefs: z.array(ref).max(20),
				}),
			)
			.max(20)
			.optional(),
		childrenStopped: z.boolean().optional(),
		reminder: z
			.strictObject({ scheduleRef: ref, occurrenceRef: ref })
			.optional(),
	})
	.refine(
		(v) =>
			new TextEncoder().encode(
				JSON.stringify([v.summary, v.facts, v.limitations, v.evidenceRefs]),
			).length <= 12000,
		{ message: "invalid_dots_report_size" },
	)
	.describe(
		"summary, facts, limitations and evidenceRefs together must fit 12,000 UTF-8 JSON bytes; keep reports concise.",
	);
export type DotReport = z.infer<typeof reportSchema>;
export type Command = {
	commandId: string;
	taskId: string;
	connectionRef: string;
	kind: "start" | "answer" | "reconcile" | "stop" | "reminder";
	authorityEpoch: number;
	executionGeneration: number;
	createdAt: number;
	expiresAt: number;
	state: "pending" | "claimed" | "reported" | "superseded";
	leaseId: string | null;
	snapshot: Record<string, unknown>;
};
export const errorStatus = {
	dots_not_found: 404,
	dots_unavailable: 503,
	dots_stale: 409,
	dots_conflict: 409,
	dots_owner_immutable: 409,
	dots_sequence_gap: 409,
	dots_permission_denied: 403,
	dots_capacity: 429,
} as const satisfies Record<string, HttpErrorStatus>;
