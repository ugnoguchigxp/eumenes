import { z } from "zod";
import { saveDrawing } from "../../../../api/domains/excalidraw/contracts";
// Revision 0 is a new drawing that has no upstream document yet.
const candidate = saveDrawing.extend({
	key: z.string().min(1).max(128),
	expectedRevision: z.number().int().nonnegative(),
});
/** referenceId is the saved reference, or the draft id of a new drawing. */
export const draftSchema = candidate.extend({
	referenceId: z.uuid(),
	pending: candidate.optional(),
});
export type DrawingDraft = z.infer<typeof draftSchema>;
export function drawingDrafts(
	storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
) {
	const name = (id: string) => `eumenes-excalidraw-draft:${id}`;
	return {
		read(id: string): DrawingDraft | null {
			const raw = storage.getItem(name(id));
			if (!raw) return null;
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				return null;
			}
			const value = draftSchema.safeParse(parsed);
			return value.success && value.data.referenceId === id ? value.data : null;
		},
		write(draft: DrawingDraft) {
			storage.setItem(
				name(draft.referenceId),
				JSON.stringify(draftSchema.parse(draft)),
			);
		},
		remove(id: string) {
			storage.removeItem(name(id));
		},
	};
}

export function makeDrawingDraft(
	referenceId: string,
	expectedRevision: number,
	latest: Pick<DrawingDraft, "title" | "scene">,
	pending: DrawingDraft | null,
): DrawingDraft {
	return {
		...latest,
		key: crypto.randomUUID(),
		expectedRevision,
		referenceId,
		...(pending
			? {
					pending: {
						title: pending.title,
						scene: pending.scene,
						expectedRevision: pending.expectedRevision,
						key: pending.key,
					},
				}
			: {}),
	};
}
