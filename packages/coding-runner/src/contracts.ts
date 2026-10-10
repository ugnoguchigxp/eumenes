import { z } from "zod";
import {
	messageMetadataSchema,
	runObservationSchema,
	unknownObservation,
} from "./observation";

export { messageMetadataSchema, runObservationSchema, unknownObservation };
export type { MessageMetadata, RunObservation } from "./observation";

export const protocolVersion = "eumenes-coding/2" as const;
/** Protocol digests use code-point ordering, independent of the host's locale. */
export function canonicalJSON(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
	if (value !== null && typeof value === "object")
		return `{${Object.entries(value)
			.filter(([, v]) => v !== undefined)
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([key, v]) => `${JSON.stringify(key)}:${canonicalJSON(v)}`)
			.join(",")}}`;
	return JSON.stringify(value) ?? "null";
}
export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const executionStates = [
	"reserved",
	"running",
	"stopping",
	"stopped",
	"exited",
	"outcome_unknown",
] as const;
export const eventKinds = [
	"session",
	"message",
	"command_started",
	"command_finished",
	"file_changed",
	"question",
	"turn_finished",
	"process_exited",
	"error",
	"heartbeat",
] as const;
export const executionSpecSchema = z.strictObject({
	version: z.literal(protocolVersion),
	executionId: id,
	operationId: id,
	taskId: z.string().min(1).max(160),
	workspaceId: id,
	generation: z.number().int().positive(),
	authorityEpoch: z.number().int().positive(),
	kind: z.enum(["implement", "review", "continue"]),
	instruction: z.string().min(1).max(32768),
	sessionId: z.uuid().nullable(),
	deadlineAt: z.number().int().positive(),
	operations: z
		.array(z.enum(["read", "edit", "check", "review", "commit", "push"]))
		.min(1)
		.max(6)
		.refine((v) => new Set(v).size === v.length),
	network: z.enum(["none", "registered"]),
	previousExecutionId: id.nullable(),
});
/** v1 specs/receipts stay readable for viewing and stop reconciliation; nothing new is started from them. */
export const legacyProtocolVersion = "eumenes-coding/1" as const;
export const storedSpecSchema = z.union([
	executionSpecSchema,
	executionSpecSchema.extend({ version: z.literal(legacyProtocolVersion) }),
]);
export type ExecutionSpec = z.infer<typeof executionSpecSchema>;
export type StoredSpec = z.infer<typeof storedSpecSchema>;
export const eventSchema = z.strictObject({
	executionId: id,
	generation: z.number().int().positive(),
	seq: z.number().int().positive(),
	observedAt: z.number().int().positive(),
	kind: z.enum(eventKinds),
	payloadRef: id,
	payloadDigest: digestSchema,
	message: messageMetadataSchema.optional(),
});
export type CodingEvent = z.infer<typeof eventSchema>;
export const receiptSchema = z
	.strictObject({
		executionId: id,
		operationId: id,
		specDigest: digestSchema,
		generation: z.number().int().positive(),
		state: z.enum(executionStates),
		sessionId: z.uuid().nullable(),
		seq: z.number().int().nonnegative(),
		observation: runObservationSchema.default(unknownObservation),
		turnFinished: z.boolean(),
		childrenStopped: z.boolean(),
		evidenceComplete: z.boolean(),
		reason: z.string().max(100).nullable(),
		exitCode: z.number().int().nullable(),
		updatedAt: z.number().int().positive(),
	})
	.refine((r) => {
		if (
			["reserved", "running", "stopping"].includes(r.state) &&
			r.childrenStopped
		)
			return false;
		if (["stopped", "exited"].includes(r.state) && !r.childrenStopped)
			return false;
		if (r.state === "reserved" && (r.turnFinished || r.exitCode !== null))
			return false;
		return true;
	}, "runner_receipt_inconsistent");
export type ExecutionReceipt = z.infer<typeof receiptSchema>;
export const inspectSchema = z.strictObject({
	receipt: receiptSchema,
	events: z.array(eventSchema).max(100),
	nextCursor: z.number().int().nonnegative(),
	hasMore: z.boolean(),
	observedAt: z.number().int().positive(),
});
export type Inspection = z.infer<typeof inspectSchema>;
export const evidenceSchema = z.strictObject({
	text: z.string(),
	digest: digestSchema,
	truncated: z.boolean(),
	totalBytes: z.number().int().nonnegative(),
	nextOffset: z.number().int().nonnegative(),
});
export const probeSchema = z.strictObject({
	version: z.literal(protocolVersion),
	adapter: z.literal("codex-exec"),
	cliVersion: z.string().max(100).nullable(),
	available: z.boolean(),
	reason: z.string().max(100).nullable(),
	capabilities: z.array(z.string().max(100)),
});
export const gitSpecSchema = z.discriminatedUnion("kind", [
	z.strictObject({
		version: z.literal(protocolVersion),
		kind: z.literal("commit"),
		operationId: id,
		executionId: id,
		generation: z.number().int().positive(),
		snapshotDigest: digestSchema,
		files: z.array(z.string().min(1).max(4096)).min(1).max(1000),
		message: z
			.string()
			.min(1)
			.max(1024)
			.refine((s) => !s.toLowerCase().includes("eumenes-operation:")),
		authorName: z.string().min(1).max(100),
		authorEmail: z.string().email().max(200),
	}),
	z.strictObject({
		version: z.literal(protocolVersion),
		kind: z.literal("push"),
		operationId: id,
		executionId: id,
		generation: z.number().int().positive(),
		remoteId: id,
		commitSha: z.string().regex(/^[a-f0-9]{40,64}$/),
		expectedRemoteSha: z
			.string()
			.regex(/^[a-f0-9]{40,64}$/)
			.nullable(),
	}),
]);
export type GitSpec = z.infer<typeof gitSpecSchema>;
export const gitReceiptSchema = z.strictObject({
	operationId: id,
	executionId: id,
	digest: digestSchema,
	kind: z.enum(["commit", "push"]),
	state: z.enum(["confirmed", "outcome_unknown", "rejected", "in_progress"]),
	commitSha: z.string().nullable(),
	treeSha: z.string().nullable(),
	baseSha: z.string().nullable(),
	reason: z.string().max(100).nullable(),
	updatedAt: z.number().int(),
});
export const toolInputs = {
	"runner.probe": z.strictObject({
		version: z.literal(protocolVersion),
		workspaceId: id,
	}),
	"runner.start": z.strictObject({
		version: z.literal(protocolVersion),
		operationId: id,
		executionId: id,
		specRef: id,
	}),
	"runner.continue": z.strictObject({
		version: z.literal(protocolVersion),
		operationId: id,
		executionId: id,
		specRef: id,
	}),
	"runner.inspect": z.strictObject({
		version: z.literal(protocolVersion),
		executionId: id,
		afterSeq: z.number().int().nonnegative(),
		limit: z.number().int().min(1).max(100),
		renewLease: z.boolean().default(false),
	}),
	"runner.stop": z.strictObject({
		version: z.literal(protocolVersion),
		operationId: id,
		executionId: id,
		generation: z.number().int().positive(),
		reason: z.enum(["cancel", "pause", "authority_revoked", "shutdown"]),
	}),
	"runner.read_evidence": z.strictObject({
		version: z.literal(protocolVersion),
		executionId: id,
		evidenceRef: id,
		offset: z.number().int().nonnegative(),
		limit: z.number().int().min(4).max(65536),
	}),
	"runner.git_operation": z.strictObject({
		version: z.literal(protocolVersion),
		operationId: id,
		specRef: id,
	}),
} as const;
export type RunnerTool = keyof typeof toolInputs;
export interface RunnerPort {
	probe(
		workspaceId: string,
		signal?: AbortSignal,
	): Promise<z.infer<typeof probeSchema>>;
	start(
		specRef: string,
		spec: ExecutionSpec,
		signal?: AbortSignal,
	): Promise<ExecutionReceipt>;
	inspect(
		executionId: string,
		afterSeq: number,
		limit: number,
		renewLease?: boolean,
		signal?: AbortSignal,
	): Promise<Inspection>;
	stop(
		executionId: string,
		generation: number,
		operationId: string,
		reason: "cancel" | "pause" | "authority_revoked" | "shutdown",
		signal?: AbortSignal,
	): Promise<ExecutionReceipt>;
	readEvidence(
		executionId: string,
		evidenceRef: string,
		offset: number,
		limit: number,
		signal?: AbortSignal,
	): Promise<z.infer<typeof evidenceSchema>>;
	gitOperation(
		specRef: string,
		operationId: string,
		signal?: AbortSignal,
	): Promise<z.infer<typeof gitReceiptSchema>>;
	close(): Promise<void>;
}
