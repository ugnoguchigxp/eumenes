import type { Database } from "bun:sqlite";

/** The newest immediate-change rows kept; older ones can no longer matter to a run in flight. */
const IMMEDIATE_KEEP = 1000;

export interface WindowRow {
	version: number;
	buildId: string;
	snapshot: string;
}
/** Only the key of the stored window: enough to validate the in-process copy. */
export function readWindowKey(
	db: Database,
	conversationId: string,
): { version: number; buildId: string } | null {
	const row = db
		.query(
			"SELECT version, build_id AS buildId FROM memory_context_window WHERE conversation_id = ?",
		)
		.get(conversationId) as { version: number; buildId: string } | null;
	return row;
}
export function readWindowRow(
	db: Database,
	conversationId: string,
): WindowRow | null {
	return db
		.query(
			"SELECT version, build_id AS buildId, snapshot FROM memory_context_window WHERE conversation_id = ?",
		)
		.get(conversationId) as WindowRow | null;
}
export function writeWindowRow(
	db: Database,
	conversationId: string,
	row: WindowRow,
	now: string,
) {
	db.query(
		`INSERT INTO memory_context_window (conversation_id, version, build_id, snapshot, updated_at) VALUES (?,?,?,?,?)
		 ON CONFLICT(conversation_id) DO UPDATE SET version=excluded.version, build_id=excluded.build_id, snapshot=excluded.snapshot, updated_at=excluded.updated_at`,
	).run(conversationId, row.version, row.buildId, row.snapshot, now);
}

/** Every conversation's stored window: they hold rendered memory text. */
export function purgeWindows(db: Database) {
	db.query("DELETE FROM memory_context_window").run();
}

export function maxImmediateSeq(db: Database): number {
	return (
		db
			.query("SELECT COALESCE(MAX(seq), 0) AS seq FROM memory_immediate_change")
			.get() as { seq: number }
	).seq;
}
export function insertImmediate(
	db: Database,
	kind: string,
	sourceRunId: string | null,
	now: string,
) {
	db.query(
		"INSERT INTO memory_immediate_change (kind, source_run_id, created_at) VALUES (?,?,?)",
	).run(kind, sourceRunId, now);
	db.query("DELETE FROM memory_immediate_change WHERE seq <= ?").run(
		maxImmediateSeq(db) - IMMEDIATE_KEEP,
	);
}
/** True when something other than `runId` itself changed immediately after `seq`. */
export function foreignImmediateSince(
	db: Database,
	seq: number,
	runId: string,
): boolean {
	return (
		db
			.query(
				"SELECT 1 FROM memory_immediate_change WHERE seq > ? AND (source_run_id IS NULL OR source_run_id != ?) LIMIT 1",
			)
			.get(seq, runId) != null
	);
}

export function tendencyRevision(db: Database): number {
	return (
		db
			.query("SELECT revision FROM memory_tendency_revision WHERE id = 1")
			.get() as { revision: number }
	).revision;
}
export interface TendencyRow {
	id: string;
	text: string;
	revision: number;
	updatedAt: string;
}
export function activeTendencies(db: Database): TendencyRow[] {
	return db
		.query(
			"SELECT id, text, revision, updated_at AS updatedAt FROM memory_tendency WHERE status = 'active' ORDER BY updated_at DESC, id",
		)
		.all() as TendencyRow[];
}
