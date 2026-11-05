import { z } from "zod";

/** Public tool inputs; session/owner/source identities always come from the host. */
export const collaborationInputs = {
	collaborationPipelineStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
	}),
	collaborationInteractStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
		startUrl: z.url().max(2048),
	}),
	collaborationAnswer: z.strictObject({
		questionId: z.uuid(),
		childRevision: z.number().int().min(0),
		input: z.unknown(),
	}),
	collaborationCurrent: z.strictObject({
		conversationId: z.string().min(1).max(512),
	}),
};
