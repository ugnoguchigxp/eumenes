import type { Database } from "bun:sqlite";
import type { BlockerReason, RunKind, RunState } from "../contracts";

export type LatestRun = {
	kind: RunKind;
	state: RunState;
	reason: BlockerReason | null;
	count: number;
};

/** The card's most recent run and how many runs it has had; null when it never ran. */
export function latestRunOfCard(
	db: Database,
	cardId: string,
): LatestRun | null {
	const row = db
		.query(
			`SELECT kind, state, reason, (SELECT COUNT(*) FROM kanban_runs WHERE card_id=?1) AS count
 FROM kanban_runs WHERE card_id=?1 ORDER BY seq DESC LIMIT 1`,
		)
		.get(cardId) as LatestRun | null;
	return row;
}
