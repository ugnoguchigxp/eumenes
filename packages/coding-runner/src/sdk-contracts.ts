import {
	sdkGitSpecSchema,
	sdkGitRemoteSchema,
	type SdkSnapshot,
	type SdkGitResult,
} from "./sdk-git-contracts";
import { z } from "zod";

export const sdkId = z.string().regex(/^[a-zA-Z0-9_-]{1,120}$/);
const text = z.string().max(16_000);
const detail = z.string().max(2048);
export const sdkReportSchema = z
	.object({
		outcome: z.enum(["done", "blocked"]),
		summary: text,
		verification: z.array(detail).max(100),
		files: z.array(z.string().max(1024)).max(200),
		unconfirmed: z.array(detail).max(100),
		blocker: text,
	})
	.strict();
export const sdkOutputSchema = z.toJSONSchema(sdkReportSchema);
export type SdkReport = z.infer<typeof sdkReportSchema>;
export const sdkSpecSchema = z
	.object({
		protocol: z.literal("eumenes-codex-sdk/1"),
		executionId: sdkId,
		ownerId: sdkId,
		workspaceId: sdkId,
		prompt: z.string().min(1).max(100_000),
		deadline: z.iso.datetime(),
		continuationOf: sdkId.optional(),
		replacementOf: sdkId.optional(),
		threadId: sdkId.optional(),
		git: sdkGitSpecSchema.optional(),
		model: z.string().min(1).max(200).optional(),
		effort: z
			.enum([
				"minimal",
				"low",
				"medium",
				"high",
				"xhigh",
				"max",
				"ultra",
				"persistent",
			])
			.optional(),
	})
	.strict()
	.refine(
		(s) =>
			!!s.threadId === !!s.continuationOf &&
			!(s.replacementOf && s.continuationOf),
		"continuation_pair_required",
	);
export type SdkSpec = z.infer<typeof sdkSpecSchema>;
export const sdkConfigSchema = z
	.object({
		root: z.string().min(1),
		workspaces: z.record(sdkId, z.string().min(1)),
		/** Host-only deny paths, never obtained from the model's request. */
		protectedPaths: z.array(z.string().min(1)),
		remotes: z.record(sdkId, sdkGitRemoteSchema).optional(),
	})
	.strict();
export type SdkConfig = z.infer<typeof sdkConfigSchema>;
export type SdkState =
	| "accepted"
	| "starting"
	| "running"
	| "settling"
	| "stopping"
	| "succeeded"
	| "blocked"
	| "failed"
	| "cancelled"
	| "unknown";
export type SdkReceipt = {
	protocol: "eumenes-codex-sdk/1";
	executionId: string;
	ownerId: string;
	workspaceId: string;
	digest: string;
	epoch: string;
	state: SdkState;
	seq: number;
	threadId?: string;
	report?: SdkReport;
	snapshot?: SdkSnapshot;
	gitEligible?: boolean;
	git?: SdkGitResult;
	reason?: string;
	/** Proof of the owned SDK transport, never proof of arbitrary OS descendants. */
	managedExecutionStopped: boolean;
	/** Separate handoff evidence. CLI exit / ps observations alone never set this. */
	workspaceReleaseConfirmed: boolean;
	workspaceHeld: boolean;
	createdAt: string;
	updatedAt: string;
};
export type SdkActivity = {
	seq: number;
	at: string;
	type: string;
	itemId?: string;
	itemType?: string;
	status?: string;
	exitCode?: number;
	outputBytes?: number;
};
export const sdkRequestSchema = z.discriminatedUnion("operation", [
	z.object({ operation: z.literal("list") }).strict(),
	z.object({ operation: z.literal("start"), spec: sdkSpecSchema }).strict(),
	z.object({ operation: z.literal("inspect"), executionId: sdkId }).strict(),
	z
		.object({
			operation: z.literal("events"),
			executionId: sdkId,
			after: z.number().int().min(0),
			limit: z.number().int().min(1).max(500).default(100),
		})
		.strict(),
	z
		.object({
			operation: z.literal("stop"),
			executionId: sdkId,
			operationId: sdkId,
		})
		.strict(),
	z
		.object({
			operation: z.literal("release"),
			executionId: sdkId,
			operationId: sdkId,
		})
		.strict(),
	z.object({ operation: z.literal("recover"), executionId: sdkId }).strict(),
]);
export type SdkRequest = z.input<typeof sdkRequestSchema>;
export const sdkTerminal = (state: SdkState) =>
	["succeeded", "blocked", "failed", "cancelled", "unknown"].includes(state);
