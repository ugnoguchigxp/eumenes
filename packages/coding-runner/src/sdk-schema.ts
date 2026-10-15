import { sdkSnapshotSchema, sdkGitResultSchema } from "./sdk-git-contracts";
import { z } from "zod";
import {
	sdkId,
	sdkReportSchema,
	type SdkReceipt,
	type SdkActivity,
} from "./sdk-contracts";

export const sdkReceiptSchema = z
	.object({
		protocol: z.literal("eumenes-codex-sdk/1"),
		executionId: sdkId,
		ownerId: sdkId,
		workspaceId: sdkId,
		digest: z.string().regex(/^[a-f0-9]{64}$/),
		epoch: sdkId,
		state: z.enum([
			"accepted",
			"starting",
			"running",
			"settling",
			"stopping",
			"succeeded",
			"blocked",
			"failed",
			"cancelled",
			"unknown",
		]),
		seq: z.number().int().min(0).max(8000),
		threadId: sdkId.optional(),
		report: sdkReportSchema.optional(),
		snapshot: sdkSnapshotSchema.optional(),
		git: sdkGitResultSchema.optional(),
		gitEligible: z.boolean().optional(),
		reason: z
			.string()
			.regex(/^[a-z_]+$/)
			.optional(),
		managedExecutionStopped: z.boolean(),
		workspaceReleaseConfirmed: z.boolean(),
		workspaceHeld: z.boolean(),
		createdAt: z.iso.datetime(),
		updatedAt: z.iso.datetime(),
	})
	.strict() satisfies z.ZodType<SdkReceipt>;
export const sdkListSchema = z
	.object({
		executions: z
			.array(
				sdkReceiptSchema.pick({
					executionId: true,
					ownerId: true,
					workspaceId: true,
					state: true,
					threadId: true,
					updatedAt: true,
				}),
			)
			.max(200),
	})
	.strict();
export const sdkActivitySchema: z.ZodType<SdkActivity> = z
	.object({
		seq: z.number().int().min(1).max(8000),
		at: z.iso.datetime(),
		type: z.string().max(80),
		itemId: z.string().max(120).optional(),
		itemType: z.string().max(80).optional(),
		status: z.string().max(80).optional(),
		exitCode: z.number().int().optional(),
		outputBytes: z.number().int().min(0).optional(),
	})
	.strict();
export const sdkEventsSchema = z
	.object({
		receipt: sdkReceiptSchema,
		events: z.array(sdkActivitySchema).max(500),
	})
	.strict();
