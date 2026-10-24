import type { Database } from "bun:sqlite";

/**
 * `steward/0002-world-goals`: the World curation unit and the goal reflection.
 *   - `steward_unit` takes the `world_events` kind and the `world` slot, `steward_inbox` the `goal` request kind and
 *     `steward_decision_ref` the claim, entity and goal references (SQLite can not alter a CHECK: the tables are rebuilt);
 *   - `steward_route`: what curate-memory judged of a message (section 3.4 of the World plan), bound to the message's
 *     revision and digest so a corrected message is never routed by the old judgment;
 *   - `steward_goal_todo`: the exchanges whose goal reflection is still due (rebuilt per event by `steward/0003`);
 *   - `steward_world_event`: the failures and holds counted per World event (the third one gives the event up).
 */
export const worldGoalsMigration = `
CREATE TABLE steward_unit_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('exchange_step','requests','maintenance','world_events')),
 step TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('reflect','maintenance','recall','world')),
 targets TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, forget_seq INTEGER, summary_revision INTEGER,
 state TEXT NOT NULL CHECK(state IN ('open','applied','stale','failed')),
 job_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
INSERT INTO steward_unit_next SELECT id, conversation_id, kind, step, slot, targets, attempt, forget_seq, summary_revision,
 state, job_id, created_at, closed_at FROM steward_unit;
DROP TABLE steward_unit;
ALTER TABLE steward_unit_next RENAME TO steward_unit;
CREATE UNIQUE INDEX steward_unit_open ON steward_unit(conversation_id, slot) WHERE state = 'open';
CREATE INDEX steward_unit_conversation ON steward_unit(conversation_id, state);

CREATE TABLE steward_inbox_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, message_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('forget','remember','correct','goal')), what TEXT NOT NULL, detail TEXT,
 state TEXT NOT NULL CHECK(state IN ('staged','pending','done','none','discarded')),
 result_code TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT
);
INSERT INTO steward_inbox_next SELECT id, conversation_id, run_id, message_id, kind, what, detail, state, result_code,
 failures, created_at, resolved_at FROM steward_inbox;
DROP TABLE steward_inbox;
ALTER TABLE steward_inbox_next RENAME TO steward_inbox;
CREATE INDEX steward_inbox_conversation ON steward_inbox(conversation_id, state, created_at);
CREATE INDEX steward_inbox_run ON steward_inbox(run_id, state);
CREATE INDEX steward_inbox_message ON steward_inbox(message_id);

CREATE TABLE steward_decision_ref_next (
 decision_id INTEGER NOT NULL,
 ref_type TEXT NOT NULL CHECK(ref_type IN ('item','message','request','claim','entity','goal')),
 ref_id TEXT NOT NULL, PRIMARY KEY (decision_id, ref_type, ref_id)
);
INSERT INTO steward_decision_ref_next SELECT decision_id, ref_type, ref_id FROM steward_decision_ref;
DROP TABLE steward_decision_ref;
ALTER TABLE steward_decision_ref_next RENAME TO steward_decision_ref;
CREATE INDEX steward_decision_ref_target ON steward_decision_ref(ref_type, ref_id);

CREATE TABLE steward_route (
 message_id TEXT NOT NULL, revision TEXT NOT NULL, digest TEXT NOT NULL, conversation_id TEXT NOT NULL,
 world INTEGER NOT NULL CHECK(world IN (0,1)), goals INTEGER NOT NULL CHECK(goals IN (0,1)), created_at TEXT NOT NULL,
 PRIMARY KEY (message_id, revision, digest)
);
CREATE INDEX steward_route_conversation ON steward_route(conversation_id, created_at);
CREATE TABLE steward_goal_todo (
 input_message_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX steward_goal_todo_conversation ON steward_goal_todo(conversation_id);
CREATE TABLE steward_world_event (
 event_id TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, holds INTEGER NOT NULL DEFAULT 0
);
`;

const CHUNK = 200;
function chunks<T>(values: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += CHUNK)
		out.push(values.slice(i, i + CHUNK));
	return out;
}
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

// ---- routing (section 3.4) ----

export interface RouteRow {
	messageId: string;
	revision: string;
	digest: string;
	conversationId: string;
	world: boolean;
	goals: boolean;
}
/** Routes kept per conversation: a route is read once, when the message's World event is due. */
const ROUTES_PER_CONVERSATION = 500;

export function putRoute(db: Database, row: RouteRow, now: string) {
	db.query(
		`INSERT OR REPLACE INTO steward_route (message_id, revision, digest, conversation_id, world, goals, created_at)
		 VALUES (?,?,?,?,?,?,?)`,
	).run(
		row.messageId,
		row.revision,
		row.digest,
		row.conversationId,
		row.world ? 1 : 0,
		row.goals ? 1 : 0,
		now,
	);
	db.query(
		`DELETE FROM steward_route WHERE conversation_id = ? AND rowid NOT IN
		 (SELECT rowid FROM steward_route WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
	).run(row.conversationId, row.conversationId, ROUTES_PER_CONVERSATION);
}
/** The judgment of the message as it is now (its revision and digest); null when there is none for that version. */
export function readRoute(
	db: Database,
	messageId: string,
	revision: string,
	digest: string,
): { world: boolean; goals: boolean } | null {
	const row = db
		.query(
			"SELECT world, goals FROM steward_route WHERE message_id = ? AND revision = ? AND digest = ?",
		)
		.get(messageId, revision, digest) as {
		world: number;
		goals: number;
	} | null;
	return row ? { world: row.world === 1, goals: row.goals === 1 } : null;
}
export function deleteRoutesOfMessages(
	db: Database,
	messageIds: readonly string[],
) {
	for (const part of chunks(messageIds))
		db.query(
			`DELETE FROM steward_route WHERE message_id IN (${marks(part.length)})`,
		).run(...part);
}

// ---- World events ----

export function worldEventCounts(
	db: Database,
	eventIds: readonly string[],
): Map<string, { failures: number; holds: number }> {
	const out = new Map<string, { failures: number; holds: number }>();
	for (const part of chunks(eventIds))
		for (const row of db
			.query(
				`SELECT event_id AS id, failures, holds FROM steward_world_event WHERE event_id IN (${marks(part.length)})`,
			)
			.all(...part) as Array<{ id: string; failures: number; holds: number }>)
			out.set(row.id, { failures: row.failures, holds: row.holds });
	return out;
}
export function bumpWorldEvent(
	db: Database,
	eventId: string,
	column: "failures" | "holds",
): number {
	db.query(
		`INSERT INTO steward_world_event (event_id, ${column}) VALUES (?, 1)
		 ON CONFLICT(event_id) DO UPDATE SET ${column} = ${column} + 1`,
	).run(eventId);
	return (
		db
			.query(
				`SELECT ${column} AS n FROM steward_world_event WHERE event_id = ?`,
			)
			.get(eventId) as { n: number }
	).n;
}
export function deleteWorldEvents(db: Database, eventIds: readonly string[]) {
	for (const part of chunks(eventIds))
		db.query(
			`DELETE FROM steward_world_event WHERE event_id IN (${marks(part.length)})`,
		).run(...part);
}
