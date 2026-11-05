import { z } from "zod";

/** New keys only: existing browser tool revisions retain their schemas. */
export const browserInteractStart = z.strictObject({
	request: z.string().trim().min(1).max(4000),
	startUrl: z.url().max(2048),
	conversationId: z.string().min(1).max(512).optional(),
	maxModelCalls: z.number().int().min(1).max(10).optional(),
});
export const browserInteractTarget = z.strictObject({
	runId: z.uuid(),
	conversationId: z.string().min(1).max(512).optional(),
});
export const browserInteractAnswer = z.strictObject({
	runId: z.uuid(),
	conversationId: z.string().min(1).max(512),
	questionId: z.uuid(),
	generation: z.number().int().min(0),
	expectedRevision: z.number().int().min(0),
	approved: z.boolean().optional(),
	text: z.string().trim().min(1).max(4000).optional(),
});
