import { z } from "zod";
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
