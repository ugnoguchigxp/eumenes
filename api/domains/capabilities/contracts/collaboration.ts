import { z } from "zod";

/** Public tool inputs; session/owner/source identities always come from the host. */
export const collaborationInputs = {
	collaborationTaskFind: z.strictObject({
		query: z.string().trim().min(1).max(1000),
	}),
	collaborationTaskStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
		revisionId: z.string().min(1).max(160),
		request: z.string().trim().min(1).max(8000),
		arguments: z.record(z.string(), z.unknown()).optional(),
		refs: z.array(z.string().min(1).max(160)).max(32).optional(),
	}),
	collaborationTaskAttach: z.strictObject({
		expectedRevision: z.number().int().min(0),
		childId: z.uuid(),
	}),
	collaborationTaskHandoff: z.strictObject({
		revisionId: z.string().min(1).max(160),
		request: z.string().trim().min(1).max(8000),
	}),
	collaborationTaskAmend: z.strictObject({
		childRevision: z.number().int().min(0),
		request: z.string().trim().min(1).max(8000),
	}),
	collaborationPipelineStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
	}),
	collaborationReviewStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
	}),
	collaborationInteractStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
		startUrl: z.url().max(2048),
	}),
	collaborationBraveStart: z.strictObject({
		expectedRevision: z.number().int().min(0),
		request: z.string().trim().min(1).max(4000),
		tabRef: z.uuid().optional(),
		url: z.url().max(2048).optional(),
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
