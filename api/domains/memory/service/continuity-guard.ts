import { estimateTextTokens } from "../../../infrastructure/context-budget";
import { referenceJson } from "../../../infrastructure/reference-json";
import type { ContinuityService } from "../../continuity";

/**
 * Continuity additions are checked in their own transaction against the `state` section of the window plan
 * (tokens): the short-term notes alone may not outgrow it. `invalid_continuity_limit` is the refusal the caller
 * counts.
 */
export function guardContinuity(
	continuity: ContinuityService,
	budgetTokens: () => number,
) {
	continuity.setGuard((db, conversationId) => {
		const notes = continuity
			.snapshotInTransaction(db, conversationId)
			.items.map((note) => ({ id: note.id, kind: note.kind, text: note.text }));
		if (estimateTextTokens(referenceJson(notes)) > budgetTokens())
			throw new Error("invalid_continuity_limit");
	});
}
