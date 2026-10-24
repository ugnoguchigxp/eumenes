import type { Database } from "bun:sqlite";
import type { GoalsLayerPort } from "../contracts";

/** The goals a generation's state section listed; kept for the adoption check. */
export type PreparedGoals = { goalIds: string[] };

/**
 * Only a goal FORGET invalidates a generation that showed that goal: it is stale when any goal it listed no longer
 * exists. Revising, completing, withdrawing or re-prioritising a goal, or adopting another, does not.
 */
export function goalsStale(
	goals: GoalsLayerPort | undefined,
	db: Database,
	prepared: PreparedGoals | undefined,
): boolean {
	if (!goals || !prepared || prepared.goalIds.length === 0) return false;
	const existing = goals.existingInTransaction(db, prepared.goalIds);
	return prepared.goalIds.some((id) => !existing.has(id));
}
