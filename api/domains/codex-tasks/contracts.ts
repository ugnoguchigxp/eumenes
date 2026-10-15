import { z } from "zod";
import {
	sdkSpecSchema,
	sdkId,
	type SdkSpec,
	type SdkState,
	type SdkReceipt,
} from "../coding";
export const enqueueSchema = z
	.object({
		scope: sdkId,
		cardId: sdkId,
		runId: sdkId,
		requestId: sdkId,
		spec: sdkSpecSchema,
		workerRevision: z.string().min(1).max(200),
		settingsRevision: z.number().int().min(0),
		runnerId: sdkId,
		executorRevision: z.number().int().min(1),
		workspaceRef: sdkId,
		guardEpoch: sdkId,
	})
	.strict()
	.refine(
		(input) => input.runId === input.spec.executionId,
		"attempt_owner_mismatch",
	);
export type CodexEnqueue = z.infer<typeof enqueueSchema>;
export type CodexAttempt = {
	id: string;
	scope: string;
	cardId: string;
	runId: string;
	requestId: string;
	spec: SdkSpec;
	digest: string;
	workerRevision: string;
	settingsRevision: number;
	runnerId: string;
	executorRevision: number;
	workspaceRef: string;
	guardEpoch: string;
	state: SdkState;
	published: boolean;
	epoch: string | null;
	seq: number;
	receipt: SdkReceipt | null;
	adopted: boolean;
	stopRequested: boolean;
};
export type CodexSettings = {
	revision: number;
	enabled: boolean;
	runnerId: string | null;
	workspaceId: string | null;
	resourceId: string | null;
};
export const configureSchema = z
	.object({
		expectedRevision: z.number().int().min(0),
		enabled: z.boolean(),
		runnerId: sdkId.nullable(),
		workspaceId: sdkId.nullable(),
		resourceId: z.uuid().nullable(),
	})
	.strict();
