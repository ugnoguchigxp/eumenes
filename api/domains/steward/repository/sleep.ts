import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";

/**
 * `steward/0007-sleep-layer`: the steward starts the sleep layer (the memory redesign, section 6) instead of
 * reflecting every exchange and upkeeping per conversation.
 *   - the per-exchange reflection and the upkeep leave: `steward_state` (the upkeep control), `steward_route`
 *     (what curate-memory judged of each message), `steward_goal_todo` and `steward_event_failure` are dropped, and
 *     so are the units and decisions of `consolidate-memory` and `consolidate-goals`;
 *   - `steward_unit` takes the `sleep` and `forget` kinds (the `maintenance` slot now holds the profile-wide units); the `events` kind is gone (a unit made for
 *     events ends as `requests`), and a unit still open in the reflecting slot ends: it was made for the earlier
 *     design (its requests wait in the inbox and the startup kick makes the unit again);
 *   - `steward_inbox` takes the `excluded` state (a forget whose targets were excluded at once and waits for the
 *     closure delete) and the `exclusion` column that names those targets;
 *   - `steward_sleep_state` keeps the shallow consolidation's watermark and the day of the last deep consolidation;
 *     `steward_sleep_position` keeps, per conversation, the last event seq a deep consolidation covered.
 */
export const sleepLayerMigration: Migration = {
	id: "steward/0007-sleep-layer",
	after: ["steward/0006-activity-indexes"],
	sql: `
DROP TABLE steward_state;
DROP TABLE steward_route;
DROP TABLE steward_goal_todo;
DROP TABLE steward_event_failure;
DELETE FROM steward_decision_ref WHERE decision_id IN
 (SELECT id FROM steward_decision WHERE step IN ('consolidate-memory','consolidate-goals'));
DELETE FROM steward_decision WHERE step IN ('consolidate-memory','consolidate-goals');

CREATE TABLE steward_unit_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('requests','world_events','sleep','forget')),
 step TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('reflect','world','maintenance')),
 targets TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, forget_seq INTEGER,
 state TEXT NOT NULL CHECK(state IN ('open','applied','stale','failed')),
 job_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
INSERT INTO steward_unit_next (id, conversation_id, kind, step, slot, targets, attempt, forget_seq, state, job_id,
 created_at, closed_at)
 SELECT id, conversation_id, CASE kind WHEN 'events' THEN 'requests' ELSE kind END, step, slot, targets, attempt,
 forget_seq, CASE WHEN state = 'open' AND slot = 'reflect' THEN 'stale' ELSE state END, job_id, created_at,
 CASE WHEN state = 'open' AND slot = 'reflect' THEN created_at ELSE closed_at END
 FROM steward_unit WHERE slot IN ('reflect','world') AND step IN ('curate-memory','curate-goals','curate-world');
DROP TABLE steward_unit;
ALTER TABLE steward_unit_next RENAME TO steward_unit;
CREATE UNIQUE INDEX steward_unit_open ON steward_unit(conversation_id, slot) WHERE state = 'open';
CREATE INDEX steward_unit_conversation ON steward_unit(conversation_id, state);
CREATE INDEX steward_unit_last_closed ON steward_unit(conversation_id, slot, closed_at)
 WHERE state <> 'open' AND closed_at IS NOT NULL;

CREATE TABLE steward_inbox_next (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, source_ref TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('forget','remember','correct','goal','withdraw')), what TEXT NOT NULL, detail TEXT,
 state TEXT NOT NULL CHECK(state IN ('pending','excluded','done','none')),
 result_code TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT,
 exclusion TEXT
);
INSERT INTO steward_inbox_next (id, conversation_id, source_ref, kind, what, detail, state, result_code, failures,
 created_at, resolved_at)
 SELECT id, conversation_id, source_ref, kind, what, detail, state, result_code, failures, created_at, resolved_at
 FROM steward_inbox;
DROP TABLE steward_inbox;
ALTER TABLE steward_inbox_next RENAME TO steward_inbox;
CREATE INDEX steward_inbox_conversation ON steward_inbox(conversation_id, state, created_at);
CREATE INDEX steward_inbox_source ON steward_inbox(source_ref);

CREATE TABLE steward_sleep_state (
 id INTEGER PRIMARY KEY CHECK(id = 1),
 shallow_watermark INTEGER NOT NULL DEFAULT 0,
 deep_day TEXT
);
INSERT INTO steward_sleep_state (id) VALUES (1);
CREATE TABLE steward_sleep_position (
 conversation_id TEXT PRIMARY KEY, seq INTEGER NOT NULL DEFAULT 0
);
`,
};

// ---- the sleep layer's own state ----

export interface SleepState {
	/** The shallow consolidation's watermark: the newest candidate `updatedSeq` it read. */
	shallowWatermark: number;
	/** The Asia/Tokyo day (`YYYY-MM-DD`) the last deep consolidation of the time window ran on; null when none. */
	deepDay: string | null;
}
export function readSleepState(db: Database): SleepState {
	const row = db
		.query(
			"SELECT shallow_watermark AS shallowWatermark, deep_day AS deepDay FROM steward_sleep_state WHERE id = 1",
		)
		.get() as SleepState | null;
	return row ?? { shallowWatermark: 0, deepDay: null };
}
export function setShallowWatermark(db: Database, watermark: number) {
	db.query(
		"UPDATE steward_sleep_state SET shallow_watermark = ? WHERE id = 1 AND shallow_watermark < ?",
	).run(watermark, watermark);
}
export function setDeepDay(db: Database, day: string) {
	db.query("UPDATE steward_sleep_state SET deep_day = ? WHERE id = 1").run(day);
}

/** The conversation is known to the deep consolidation's event count (a new one starts at seq 0). */
export function touchPosition(db: Database, conversationId: string) {
	db.query(
		"INSERT OR IGNORE INTO steward_sleep_position (conversation_id, seq) VALUES (?, 0)",
	).run(conversationId);
}
export function readPositions(db: Database): Record<string, number> {
	return Object.fromEntries(
		(
			db
				.query("SELECT conversation_id AS id, seq FROM steward_sleep_position")
				.all() as Array<{ id: string; seq: number }>
		).map((row) => [row.id, row.seq]),
	);
}
/** A deep consolidation covered the events up to these seqs. */
export function writePositions(
	db: Database,
	positions: Readonly<Record<string, number>>,
) {
	const write = db.query(
		`INSERT INTO steward_sleep_position (conversation_id, seq) VALUES (?, ?)
		 ON CONFLICT(conversation_id) DO UPDATE SET seq = MAX(seq, excluded.seq)`,
	);
	for (const [id, seq] of Object.entries(positions)) write.run(id, seq);
}

/**
 * The sleep units of a step that failed one after another since its last adopted unit, and when the last one
 * closed. A failure that only gave the connection to the conversation (`skipCodes`) does not count.
 */
export function failedSleepUnits(
	db: Database,
	conversationId: string,
	step: string,
	skipCodes: readonly string[],
): { count: number; lastClosedAt: string | null } {
	const skip = skipCodes.length
		? `AND NOT EXISTS (SELECT 1 FROM steward_decision d WHERE d.conversation_id = x.conversation_id
			AND d.job_id = x.job_id AND d.error_code IN (${skipCodes.map(() => "?").join(",")}))`
		: "";
	const row = db
		.query(
			`SELECT COUNT(*) AS n, MAX(x.closed_at) AS last FROM steward_unit x
			 WHERE x.conversation_id = ? AND x.step = ? AND x.state = 'failed' ${skip}
			 AND x.closed_at > COALESCE((SELECT MAX(a.closed_at) FROM steward_unit a
				WHERE a.conversation_id = x.conversation_id AND a.step = x.step AND a.state = 'applied'), '')`,
		)
		.get(conversationId, step, ...skipCodes) as {
		n: number;
		last: string | null;
	};
	return { count: row.n, lastClosedAt: row.last };
}
