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
/** The specialist's complete proposal for the work in progress (title and OpenUI definition). */
export const uiDraftApply = z.strictObject({
	title: z
		.string()
		.trim()
		.min(1)
		.max(120)
		.describe("作品のタイトル（AIが付ける）"),
	definition: z
		.record(z.string(), z.unknown())
		.describe(
			"完全なOpenUI定義のJSONオブジェクト。差分ではなく、変更しない部分も含めた全体を渡す",
		),
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
