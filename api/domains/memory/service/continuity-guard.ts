import type { ContinuityService } from "../../continuity";
import { noteLines, renderShortTerm } from "./context-render";

/**
 * Continuity additions are checked in their own transaction against the memory and history budget (tokens): the
 * short-term notes alone may not outgrow it. `invalid_continuity_limit` is the refusal the caller counts.
 */
export function guardContinuity(
	continuity: ContinuityService,
	budgetTokens: () => number,
) {
	continuity.setGuard((db, conversationId) => {
		const { tokens } = renderShortTerm(
			[],
			noteLines(continuity.snapshotInTransaction(db, conversationId).items),
		);
		if (tokens > budgetTokens()) throw new Error("invalid_continuity_limit");
	});
}
