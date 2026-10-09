import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * World hardening state (review round 1). Append-only migration at the TAIL of
 * the host migrations, never edited.
 *
 * - `world_host_state.initial_sync_complete`: the explicit host statement that
 *   the first full pass over Memory's change feed and the source outboxes is
 *   done. World cannot be switched ON before it. Databases that already had
 *   World ON keep working (the flag is seeded from `enabled`).
 * - `world_host_dependent.release_pending`: the Memory dependent could not be
 *   unregistered (Memory refused or was unavailable) when its Slice was
 *   released or its usage receipt was forgotten. The host row stays so a retry
 *   sweep can finish the job; a pending row counts as "World content gone"
 *   when a Memory forget's confirmations are checked.
 * - `world_host_forget_abandoned`: a part of a forget (or single roots in it)
 *   that World permanently refuses as invalid input. It is an explicit,
 *   durable terminal (never a silent skip): the forget keeps reporting it and
 *   is never reported as complete.
 */
export const guardMigration = `
ALTER TABLE world_host_state ADD COLUMN initial_sync_complete INTEGER NOT NULL DEFAULT 0 CHECK (initial_sync_complete IN (0, 1));
UPDATE world_host_state SET initial_sync_complete = enabled;
ALTER TABLE world_host_dependent ADD COLUMN release_pending INTEGER NOT NULL DEFAULT 0 CHECK (release_pending IN (0, 1));
CREATE TABLE world_host_forget_abandoned (
	forget_id TEXT NOT NULL CHECK (length(forget_id) BETWEEN 1 AND 200),
	part INTEGER NOT NULL CHECK (part >= 0),
	skipped_roots INTEGER NOT NULL CHECK (skipped_roots >= 0),
	whole_part INTEGER NOT NULL CHECK (whole_part IN (0, 1)),
	reason TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (forget_id, part)
) WITHOUT ROWID;
`;

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

export type AbandonedPart = {
	forgetId: string;
	part: number;
	skippedRoots: number;
	/** true: World never saw this part at all (nothing in it could be forgotten). */
	wholePart: boolean;
	reason: string;
};

/** Idempotent per (forgetId, part); a later whole-part record widens an earlier partial one. */
export function recordAbandoned(
	db: Database,
	row: AbandonedPart,
	now: number,
): void {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_forget_abandoned (forget_id, part, skipped_roots, whole_part, reason, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT (forget_id, part) DO UPDATE SET
			skipped_roots = MAX(skipped_roots, excluded.skipped_roots),
			reason = CASE WHEN excluded.whole_part = 1 THEN excluded.reason ELSE reason END,
			whole_part = MAX(whole_part, excluded.whole_part)`,
	).run(
		row.forgetId,
		row.part,
		row.skippedRoots,
		row.wholePart ? 1 : 0,
		row.reason,
		now,
	);
}

export function listAbandoned(db: Database, forgetId: string): AbandonedPart[] {
	return (
		db
			.query(
				"SELECT forget_id, part, skipped_roots, whole_part, reason FROM world_host_forget_abandoned WHERE forget_id = ? ORDER BY part",
			)
			.all(forgetId) as {
			forget_id: string;
			part: number;
			skipped_roots: number;
			whole_part: number;
			reason: string;
		}[]
	).map((row) => ({
		forgetId: row.forget_id,
		part: row.part,
		skippedRoots: row.skipped_roots,
		wholePart: row.whole_part === 1,
		reason: row.reason,
	}));
}

/** Forgets with any abandoned part or root, in id order. */
export function listAbandonedForgetIds(db: Database): string[] {
	return (
		db
			.query(
				"SELECT DISTINCT forget_id FROM world_host_forget_abandoned ORDER BY forget_id",
			)
			.all() as { forget_id: string }[]
	).map((row) => row.forget_id);
}
