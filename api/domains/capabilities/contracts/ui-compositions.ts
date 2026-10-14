import { z } from "zod";
/** Flat command input shared by the registered UI creation tool and its action. */
export const uiComposeRequest = z.strictObject({
	prompt: z.string().trim().min(1).max(4000),
	projectId: z.string().max(64).optional(),
	motifId: z.string().max(128).optional(),
});
export const uiCancelRequest = z.strictObject({ projectId: z.string().uuid() });
export const uiResponseFields = z.record(
	z.string(),
	z.union([z.string().max(2000), z.boolean()]),
);
export const uiSubmitRequest = z.strictObject({
	projectId: z.string().uuid(),
	expectedGeneration: z.number().int().positive(),
	values: uiResponseFields,
});
