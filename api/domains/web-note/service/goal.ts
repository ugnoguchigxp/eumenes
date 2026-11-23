import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type {
	GoalExecutionIdentity,
	GoalExecutionSource,
} from "../../tool-runtime";
import { active, rowOf, stateOf } from "../repository";
import type { Context } from "./context";
import { end, forget, goalReceipt } from "./lifecycle";

export function createGoalWebNotePort(
	ctx: Context,
	start: (db: Database, origin: GoalExecutionSource) => string,
) {
	function goalRow(db: Database, origin: GoalExecutionSource) {
		const row = rowOf(db, origin.runId);
		if (!row?.data_json) return null;
		if (row.owner_kind !== "goal" || hash(origin) !== hash(stateOf(row).source))
			throw new Error("web_note_goal_conflict");
		return row;
	}

	function goalByIdentity(
		db: Database,
		origin: GoalExecutionIdentity,
		id: string,
	) {
		const row = rowOf(db, id);
		if (!row?.data_json) return null;
		const { source } = stateOf(row);
		if (
			row.owner_kind !== "goal" ||
			source.origin !== "goal" ||
			origin.principal !== source.principal ||
			origin.scopeKey !== source.scopeKey ||
			origin.goalId !== source.goalId ||
			origin.goalRevision !== source.goalRevision ||
			origin.attemptId !== source.attemptId ||
			origin.permitId !== source.permitId ||
			origin.permitRevision !== source.permitRevision
		)
			throw new Error("web_note_goal_conflict");
		return row;
	}

	return {
		startInTransaction(db: Database, origin: GoalExecutionSource) {
			const id = start(db, origin);
			const row = rowOf(db, id)!;
			return goalReceipt(row, stateOf(row));
		},
		lookupInTransaction(db: Database, origin: GoalExecutionSource) {
			const row = goalRow(db, origin);
			return row ? goalReceipt(row, stateOf(row)) : null;
		},
		lookupByIdentityInTransaction(
			db: Database,
			origin: GoalExecutionIdentity,
			id: string,
		) {
			const row = goalByIdentity(db, origin, id);
			return row ? goalReceipt(row, stateOf(row)) : null;
		},
		cancelInTransaction(
			db: Database,
			origin: GoalExecutionIdentity,
			id: string,
			erase = false,
		) {
			const row = goalByIdentity(db, origin, id);
			if (!row) return true;
			if (erase) forget(ctx, db, id);
			else if (active(row))
				end(ctx, db, row, "cancelled", "web_note_goal_cancelled");
			return true;
		},
	};
}
