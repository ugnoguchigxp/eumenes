import type { Database } from "bun:sqlite";
import { researchSourceIds } from "../../domains/dialogue";
import { forgetPursuitReports } from "../../domains/pursuit";

/**
 * Forget hook for retired research. Dialogue still holds the source id after it clears the TODO text,
 * so this reads those ids in the same writer transaction and asks Pursuit to erase only those runs.
 */
export function forgetRetiredResearch(
	db: Database,
	messageIds: readonly string[],
	now: number,
	forgetWeb: (id: string) => void,
	revokeNotice: (id: string) => void,
) {
	forgetPursuitReports(
		db,
		researchSourceIds(db, messageIds),
		now,
		forgetWeb,
		revokeNotice,
	);
}
