import type { Database } from "bun:sqlite";
import type { ScopeRef } from "eumenes-world-model";

/** An earlier outbox-only sync never covered legacy messages. Re-run it once on upgrade. */
export const initialSyncMigration = `
ALTER TABLE world_host_state ADD COLUMN initial_source_sync_started INTEGER NOT NULL DEFAULT 0 CHECK (initial_source_sync_started IN (0,1));
UPDATE world_host_state SET enabled = 0, initial_sync_complete = 0, revision = revision + 1 WHERE id = 1;
`;

export function initialSourceSyncStarted(db: Database): boolean {
	return (
		(
			db
				.query(
					"SELECT initial_source_sync_started AS started FROM world_host_state WHERE id=1",
				)
				.get() as { started: number }
		).started === 1
	);
}

/** First pass resets an OFF scan; subsequent attempts retain the committed cursor. */
export function prepareInitialSourceSync(db: Database, scope: ScopeRef) {
	if (!db.inTransaction) throw new Error("transaction_required");
	if (initialSourceSyncStarted(db)) return;
	db.query(
		"DELETE FROM world_host_feed_cursor WHERE feed='source' AND principal=? AND scope_key=?",
	).run(scope.principal, scope.scopeKey);
	// OFF scans were never delivered to World. Explicit first import may now stage them.
	// SOURCE_BLOCKED, rejected and real receipts are deliberately retained.
	db.query(
		"DELETE FROM world_host_extract_event WHERE principal=? AND scope_key=? AND state='skipped' AND reason='WORLD_OFF'",
	).run(scope.principal, scope.scopeKey);
	db.query(
		"UPDATE world_host_state SET initial_source_sync_started=1 WHERE id=1",
	).run();
}
