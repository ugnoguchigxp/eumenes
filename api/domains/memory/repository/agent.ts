import type { Database } from "bun:sqlite";

// ---- provenance: who asked for a State item ----

export type Provenance = "request" | "agent" | "manual";
export function putProvenance(
	db: Database,
	itemId: string,
	runId: string | null,
	mode: Provenance,
	now: string,
) {
	db.query(
		"INSERT OR REPLACE INTO memory_item_provenance (item_id, run_id, mode, created_at) VALUES (?,?,?,?)",
	).run(itemId, runId, mode, now);
}
/** An item with no row was registered through the API. */
export function provenanceOf(db: Database, itemId: string): Provenance {
	const row = db
		.query("SELECT mode FROM memory_item_provenance WHERE item_id = ?")
		.get(itemId) as { mode: Provenance } | null;
	return row?.mode ?? "manual";
}

// ---- tendencies: observations the agent derived from several items ----

export interface TendencyEvidence {
	namespace: "state" | "continuity";
	id: string;
}
export interface TendencyFull {
	id: string;
	text: string;
	evidence: TendencyEvidence[];
	status: "active" | "retired";
	revision: number;
	createdAt: string;
	updatedAt: string;
}
const tendencyColumns =
	"id, text, evidence, status, revision, created_at AS createdAt, updated_at AS updatedAt";
function mapTendency(row: Record<string, unknown>): TendencyFull {
	return {
		id: row.id as string,
		text: row.text as string,
		evidence: JSON.parse(row.evidence as string) as TendencyEvidence[],
		status: row.status as TendencyFull["status"],
		revision: row.revision as number,
		createdAt: row.createdAt as string,
		updatedAt: row.updatedAt as string,
	};
}
export function getTendency(db: Database, id: string): TendencyFull | null {
	const row = db
		.query(`SELECT ${tendencyColumns} FROM memory_tendency WHERE id = ?`)
		.get(id) as Record<string, unknown> | null;
	return row ? mapTendency(row) : null;
}
export function countActiveTendencies(db: Database): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM memory_tendency WHERE status = 'active'",
			)
			.get() as { n: number }
	).n;
}
/** Active tendencies, newest first (the order the agent sees them in). */
export function listActiveTendencies(db: Database): TendencyFull[] {
	return (
		db
			.query(
				`SELECT ${tendencyColumns} FROM memory_tendency WHERE status = 'active' ORDER BY updated_at DESC, id`,
			)
			.all() as Record<string, unknown>[]
	).map(mapTendency);
}
export function bumpTendencyRevision(db: Database) {
	db.query(
		"UPDATE memory_tendency_revision SET revision = revision + 1 WHERE id = 1",
	).run();
}
export function insertTendency(db: Database, row: TendencyFull) {
	db.query(
		"INSERT INTO memory_tendency (id, text, evidence, status, revision, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
	).run(
		row.id,
		row.text,
		JSON.stringify(row.evidence),
		row.status,
		row.revision,
		row.createdAt,
		row.updatedAt,
	);
	bumpTendencyRevision(db);
}
/** Rewrites an active tendency at its expected revision; false when it moved on. */
export function updateTendency(
	db: Database,
	id: string,
	expectedRevision: number,
	change: { text: string; evidence: TendencyEvidence[] },
	now: string,
): boolean {
	const result = db
		.query(
			"UPDATE memory_tendency SET text=?, evidence=?, revision=revision+1, updated_at=? WHERE id=? AND revision=? AND status='active'",
		)
		.run(
			change.text,
			JSON.stringify(change.evidence),
			now,
			id,
			expectedRevision,
		);
	if (result.changes !== 1) return false;
	bumpTendencyRevision(db);
	return true;
}
export function retireTendency(
	db: Database,
	id: string,
	expectedRevision: number,
	now: string,
): boolean {
	const result = db
		.query(
			"UPDATE memory_tendency SET status='retired', revision=revision+1, updated_at=? WHERE id=? AND revision=? AND status='active'",
		)
		.run(now, id, expectedRevision);
	if (result.changes !== 1) return false;
	bumpTendencyRevision(db);
	return true;
}
/** Physical delete (the user removing it from the settings screen). */
export function deleteTendency(db: Database, id: string): boolean {
	const result = db.query("DELETE FROM memory_tendency WHERE id = ?").run(id);
	if (result.changes !== 1) return false;
	bumpTendencyRevision(db);
	return true;
}
/** Ids bound per statement: far below SQLite's variable limit. */
const EVIDENCE_CHUNK = 500;
/**
 * Physical delete of every tendency (active or retired) that names one of the State items as evidence: a
 * forgotten item must not live on in a summary derived from it. Bumps the revision once when any row went.
 */
export function deleteTendenciesByStateEvidence(
	db: Database,
	itemIds: readonly string[],
): number {
	const unique = [...new Set(itemIds)];
	let deleted = 0;
	for (let start = 0; start < unique.length; start += EVIDENCE_CHUNK) {
		const chunk = unique.slice(start, start + EVIDENCE_CHUNK);
		const marks = chunk.map(() => "?").join(",");
		deleted += db
			.query(
				`DELETE FROM memory_tendency WHERE EXISTS (
					SELECT 1 FROM json_each(memory_tendency.evidence) AS e
					WHERE json_extract(e.value, '$.namespace') = 'state' AND json_extract(e.value, '$.id') IN (${marks})
				)`,
			)
			.run(...chunk).changes;
	}
	if (deleted > 0) bumpTendencyRevision(db);
	return deleted;
}

// ---- cursor: the last message the agent has read per conversation ----

export interface CursorRow {
	lastOrdinal: number;
	/** Consecutive runs that read these messages and failed. */
	failures: number;
}
export function readCursorRow(
	db: Database,
	conversationId: string,
): CursorRow | null {
	return db
		.query(
			"SELECT last_ordinal AS lastOrdinal, failures FROM memory_agent_cursor WHERE conversation_id = ?",
		)
		.get(conversationId) as CursorRow | null;
}
export function listCursors(
	db: Database,
): Array<{ conversationId: string; lastOrdinal: number }> {
	return db
		.query(
			"SELECT conversation_id AS conversationId, last_ordinal AS lastOrdinal FROM memory_agent_cursor",
		)
		.all() as Array<{ conversationId: string; lastOrdinal: number }>;
}
/** The first cursor of a conversation; an existing one is left alone. */
export function initCursor(
	db: Database,
	conversationId: string,
	ordinal: number,
) {
	db.query(
		"INSERT OR IGNORE INTO memory_agent_cursor (conversation_id, last_ordinal, failures) VALUES (?,?,0)",
	).run(conversationId, ordinal);
}
/** Never moves backwards; a read that worked clears the failure count. */
export function advanceCursor(
	db: Database,
	conversationId: string,
	ordinal: number,
) {
	db.query(
		`INSERT INTO memory_agent_cursor (conversation_id, last_ordinal, failures) VALUES (?,?,0)
		 ON CONFLICT(conversation_id) DO UPDATE SET last_ordinal = MAX(last_ordinal, excluded.last_ordinal), failures = 0`,
	).run(conversationId, ordinal);
}
/** One more failed run over the same messages; returns the count. */
export function countCursorFailure(
	db: Database,
	conversationId: string,
): number {
	db.query(
		"UPDATE memory_agent_cursor SET failures = failures + 1 WHERE conversation_id = ?",
	).run(conversationId);
	return readCursorRow(db, conversationId)?.failures ?? 0;
}

// ---- messages the agent must never learn from (scheduled prompts) ----

export function excludeMessage(db: Database, messageId: string) {
	db.query(
		"INSERT OR IGNORE INTO memory_agent_excluded_message (message_id) VALUES (?)",
	).run(messageId);
}
export function isExcluded(db: Database, messageId: string): boolean {
	return (
		db
			.query("SELECT 1 FROM memory_agent_excluded_message WHERE message_id = ?")
			.get(messageId) != null
	);
}

// ---- the control request of a job in flight (survives a restart) ----

export function putRequest(db: Database, jobId: string, requestId: string) {
	db.query(
		"INSERT OR REPLACE INTO memory_agent_request (job_id, request_id) VALUES (?,?)",
	).run(jobId, requestId);
}
/** Reads and removes the job's request; null when there is none. */
export function takeRequest(db: Database, jobId: string): string | null {
	const row = db
		.query(
			"SELECT request_id AS requestId FROM memory_agent_request WHERE job_id = ?",
		)
		.get(jobId) as { requestId: string } | null;
	if (!row) return null;
	db.query("DELETE FROM memory_agent_request WHERE job_id = ?").run(jobId);
	return row.requestId;
}
