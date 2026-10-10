import { z } from "zod";
import type { HttpErrorStatus } from "../../../infrastructure/http";
import {
	eventSchema,
	receiptSchema,
} from "../../../../packages/coding-runner/src/contracts";

export const executionViewSchema = z.strictObject({
	id: z.string(),
	taskId: z.string(),
	generation: z.number().int(),
	authorityEpoch: z.number().int(),
	state: z.enum([
		"intent",
		"accepted",
		"running",
		"stopping",
		"stopped",
		"exited",
		"outcome_unknown",
	]),
	cursor: z.number().int(),
	turnFinished: z.boolean(),
	childrenStopped: z.boolean(),
	evidenceComplete: z.boolean(),
	reason: z.string().nullable(),
	exitCode: z.number().nullable(),
	createdAt: z.string(),
	updatedAt: z.string(),
});
export type CodingExecutionView = z.infer<typeof executionViewSchema>;
export const codingEventsSchema = z.strictObject({
	events: z.array(eventSchema),
	cursor: z.number().int(),
	receipt: receiptSchema.nullable(),
});
export const codingWorkspaceViewSchema = z.strictObject({
	id: z.string(),
	branch: z.string(),
	available: z.boolean(),
	reason: z.string().nullable(),
});
export const codingExecutionEventsSchema = z.strictObject({
	execution: executionViewSchema,
	events: z.array(eventSchema),
});

/** HTTP status of each error code this domain throws; merged by `api/application/error-status.ts`. */
export const errorStatus = {
	coding_execution_not_found: 404,
	coding_invalid_cursor: 400,
	coding_workspace_unavailable: 503,
	coding_workspace_busy: 409,
	coding_branch_conflict: 409,
	coding_authority_stale: 409,
	coding_operation_conflict: 409,
} as const satisfies Record<string, HttpErrorStatus>;
