import { z } from "zod";
export const uiResponseFields = z.record(
	z.string(),
	z.union([z.string().max(2000), z.boolean()]),
);
export const uiSubmitRequest = z.strictObject({
	projectId: z.string().uuid(),
	expectedGeneration: z.number().int().positive(),
	values: uiResponseFields,
});
/** The user's own edit of the work's source on the screen: the whole canonical text, checked like the specialist's. */
export const uiSourceApply = z.strictObject({
	workRef: z.string().uuid(),
	expectedRevision: z.number().int().min(0),
	text: z.string().min(1).max(100_000),
});
/** Undo or redo of the work in progress; the host fixes which work, the screen names the revision it saw. */
export const uiWorkStep = z.strictObject({
	workRef: z.string().uuid(),
	expectedRevision: z.number().int().min(0),
});
/** Saving the work in progress; `expectedSavedRevision` is 0 while the work was never saved. */
export const uiWorkSave = z.strictObject({
	workRef: z.string().uuid(),
	expectedRevision: z.number().int().min(0),
	expectedSavedRevision: z.number().int().min(0),
});
/** Deleting a saved composition; the screen names the saved revision it showed. */
export const uiCompositionDelete = z.strictObject({
	projectId: z.string().uuid(),
	expectedSavedRevision: z.number().int().positive(),
});
/** A saved composition the user may start editing from (host-issued ref). */
export const uiTargetRef = z.strictObject({ target: z.string().uuid() });
