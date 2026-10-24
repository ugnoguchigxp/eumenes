import type { Database } from "bun:sqlite";

/**
 * `steward/0003-continuity-events`: the steward reads the handled events of the continuity flow instead of the
 * exchange ledger, and the memory requests wait as `pending` from the start.
 *   - `steward_unit`: the `exchange_step` kind is `events`, the `episode` slot is new (summaries and merges that
 *     the next re-construction applies) and `summary_revision` is the window version the unit was prepared on;
 *     the units of the removed steps are dropped, and units still open were made for the earlier design: they end;
 *   - `steward_inbox`: the `staged` and `discarded` states and the run the request was made in are gone, the
 *     `withdraw` kind is new, and `message_id` is the `source_ref` (the user's message the request was made in);
 *     a request still staged is pending now, a discarded one ended without being carried out;
 *   - `steward_goal_todo` is keyed by the event (`seq`) the goal reflection is due for, as the exchanges are gone;
 *   - `steward_event_failure`: the failed tries of the memory reflection over one event (the third one gives it up);
 *   - the decisions of the removed steps (and their references) are dropped, and the recall preparation starts afresh.
 */
export const continuityEventsMigration = `
CREATE TABLE steward_unit_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('events','requests','maintenance','world_events')),
 step TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('reflect','maintenance','recall','world','episode')),
 targets TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, forget_seq INTEGER, window_version INTEGER,
 state TEXT NOT NULL CHECK(state IN ('open','applied','stale','failed')),
 job_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
INSERT INTO steward_unit_next (id, conversation_id, kind, step, slot, targets, attempt, forget_seq, window_version, state,
 job_id, created_at, closed_at)
 SELECT id, conversation_id, CASE kind WHEN 'exchange_step' THEN 'events' ELSE kind END, step, slot, targets, attempt,
 forget_seq, NULL, CASE state WHEN 'open' THEN 'stale' ELSE state END, job_id, created_at,
 CASE state WHEN 'open' THEN created_at ELSE closed_at END
 FROM steward_unit WHERE step NOT IN ('dispose-exchanges','compact-history');
DROP TABLE steward_unit;
ALTER TABLE steward_unit_next RENAME TO steward_unit;
CREATE UNIQUE INDEX steward_unit_open ON steward_unit(conversation_id, slot) WHERE state = 'open';
CREATE INDEX steward_unit_conversation ON steward_unit(conversation_id, state);

CREATE TABLE steward_inbox_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_ref TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('forget','remember','correct','goal','withdraw')), what TEXT NOT NULL, detail TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','done','none')),
 result_code TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT
);
INSERT INTO steward_inbox_next (id, conversation_id, source_ref, kind, what, detail, state, result_code, failures,
 created_at, resolved_at)
 SELECT id, conversation_id, message_id, kind, what, detail,
 CASE state WHEN 'staged' THEN 'pending' WHEN 'discarded' THEN 'none' ELSE state END,
 result_code, failures, created_at, resolved_at FROM steward_inbox;
DROP TABLE steward_inbox;
ALTER TABLE steward_inbox_next RENAME TO steward_inbox;
CREATE INDEX steward_inbox_conversation ON steward_inbox(conversation_id, state, created_at);
CREATE INDEX steward_inbox_source ON steward_inbox(source_ref);

DROP TABLE steward_goal_todo;
CREATE TABLE steward_goal_todo (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (conversation_id, seq)
);
CREATE TABLE steward_event_failure (
 conversation_id TEXT NOT NULL, seq INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY (conversation_id, seq)
);

DELETE FROM steward_decision_ref WHERE decision_id IN
 (SELECT id FROM steward_decision WHERE step IN ('dispose-exchanges','compact-history'));
DELETE FROM steward_decision WHERE step IN ('dispose-exchanges','compact-history');
UPDATE steward_state SET recall_pending = NULL;
`;

// ---- goal reflection due, per event ----

export function addGoalTodo(db: Database, conversationId: string, seq: number) {
	db.query(
		"INSERT OR IGNORE INTO steward_goal_todo (conversation_id, seq) VALUES (?,?)",
	).run(conversationId, seq);
}
/** The events whose goal reflection is due, in the order they were curated. */
export function pendingGoalTodos(
	db: Database,
	conversationId: string,
	limit: number,
): Array<{ seq: number; failures: number }> {
	return db
		.query(
			`SELECT seq, failures FROM steward_goal_todo WHERE conversation_id = ? ORDER BY rowid LIMIT ?`,
		)
		.all(conversationId, limit) as Array<{ seq: number; failures: number }>;
}
export function deleteGoalTodos(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
) {
	const remove = db.query(
		"DELETE FROM steward_goal_todo WHERE conversation_id = ? AND seq = ?",
	);
	for (const seq of seqs) remove.run(conversationId, seq);
}
export function bumpGoalTodoFailure(
	db: Database,
	conversationId: string,
	seq: number,
): number {
	db.query(
		"UPDATE steward_goal_todo SET failures = failures + 1 WHERE conversation_id = ? AND seq = ?",
	).run(conversationId, seq);
	return (
		(
			db
				.query(
					"SELECT failures FROM steward_goal_todo WHERE conversation_id = ? AND seq = ?",
				)
				.get(conversationId, seq) as { failures: number } | null
		)?.failures ?? 0
	);
}

// ---- failed memory reflections, per event ----

export function eventFailures(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
): Map<number, number> {
	const found = new Map<number, number>();
	const read = db.query(
		"SELECT failures FROM steward_event_failure WHERE conversation_id = ? AND seq = ?",
	);
	for (const seq of seqs) {
		const row = read.get(conversationId, seq) as { failures: number } | null;
		if (row) found.set(seq, row.failures);
	}
	return found;
}
export function bumpEventFailure(
	db: Database,
	conversationId: string,
	seq: number,
): number {
	db.query(
		`INSERT INTO steward_event_failure (conversation_id, seq, failures) VALUES (?,?,1)
		 ON CONFLICT(conversation_id, seq) DO UPDATE SET failures = failures + 1`,
	).run(conversationId, seq);
	return eventFailures(db, conversationId, [seq]).get(seq) ?? 0;
}
export function deleteEventFailures(
	db: Database,
	conversationId: string,
	seqs: readonly number[],
) {
	const remove = db.query(
		"DELETE FROM steward_event_failure WHERE conversation_id = ? AND seq = ?",
	);
	for (const seq of seqs) remove.run(conversationId, seq);
}
