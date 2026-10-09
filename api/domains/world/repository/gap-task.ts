import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * Host-owned record of which Gap already has an investigation Task (P5-01).
 * Append-only migration at the TAIL of the host migrations, never edited.
 *
 * One row per (principal, scope, dedupe key): the key is a hash of the Gap key,
 * so the row holds no claim text and no entity id. A Gap that already has a row
 * never asks the Task port again (same Gap -> one Task). Rows are written only
 * after the port answered `created`; a denial leaves nothing behind.
 */
export const gapTaskMigration = `
CREATE TABLE world_host_gap_task (
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	dedupe_key TEXT NOT NULL CHECK (length(dedupe_key) BETWEEN 1 AND 128),
	task_ref TEXT NOT NULL CHECK (length(task_ref) BETWEEN 1 AND 200),
	linked_at_ms INTEGER NOT NULL,
	PRIMARY KEY (principal, scope_key, dedupe_key)
) WITHOUT ROWID;
`;

export function getGapTask(
	db: Database,
	principal: string,
	scopeKey: string,
	dedupeKey: string,
): { taskRef: string } | null {
	const row = db
		.query(
			`SELECT task_ref FROM world_host_gap_task
			WHERE principal = ?1 AND scope_key = ?2 AND dedupe_key = ?3`,
		)
		.get(principal, scopeKey, dedupeKey) as { task_ref: string } | null;
	return row ? { taskRef: row.task_ref } : null;
}

/** Records the first Task of a Gap. A second insert of the same key is ignored. */
export function putGapTask(
	db: Database,
	principal: string,
	scopeKey: string,
	dedupeKey: string,
	taskRef: string,
	nowMs: number,
): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
	db.query(
		`INSERT OR IGNORE INTO world_host_gap_task
			(principal, scope_key, dedupe_key, task_ref, linked_at_ms)
		VALUES (?1, ?2, ?3, ?4, ?5)`,
	).run(principal, scopeKey, dedupeKey, taskRef, nowMs);
}
