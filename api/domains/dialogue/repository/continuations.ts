import type { Database } from "bun:sqlite";

/**
 * A continuation run carries the user's request on after a delegated step did not achieve it: the human run it
 * started from (the request's original text and its authority), its position in the chain, and the step's record.
 */
export const continuationsMigration = `
CREATE TABLE dialogue_continuations (
 run_id TEXT PRIMARY KEY,
 root_run_id TEXT NOT NULL,
 hop INTEGER NOT NULL,
 original_request TEXT NOT NULL,
 achieved TEXT NOT NULL,
 need TEXT NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX dialogue_continuations_root ON dialogue_continuations(root_run_id, hop);`;
/** The request's conditions as the chain's first check listed them; later checks decide only their steps. */
export const continuationConditionsMigration =
	"ALTER TABLE dialogue_continuations ADD COLUMN conditions_json TEXT NOT NULL DEFAULT '[]';";

/** The steps' results, as the conversation received them: the host's copy, never a summary the model wrote. */
export const continuationStepsMigration =
	"ALTER TABLE dialogue_continuations ADD COLUMN steps_json TEXT NOT NULL DEFAULT '[]';";

/** One delegated step of the chain and the result blocks of its answer phase (`source` and the data). */
export type PriorStep = {
	step: number;
	results: Array<{ source: string; value: unknown }>;
};

export type Continuation = {
	runId: string;
	rootRunId: string;
	hop: number;
	originalRequest: string;
	/** What the earlier steps achieved, as the completion check wrote it. */
	achieved: string;
	/** The purpose of the next step: the search text of this run's discovery. */
	need: string;
	conditions: string[];
	/** Every earlier step of the chain, the first one included. */
	steps: PriorStep[];
	createdAt: string;
};
type Row = {
	run_id: string;
	root_run_id: string;
	hop: number;
	original_request: string;
	achieved: string;
	need: string;
	conditions_json: string;
	steps_json: string;
	created_at: string;
};
const fromRow = (r: Row): Continuation => ({
	runId: r.run_id,
	rootRunId: r.root_run_id,
	hop: r.hop,
	originalRequest: r.original_request,
	achieved: r.achieved,
	need: r.need,
	conditions: JSON.parse(r.conditions_json) as string[],
	steps: JSON.parse(r.steps_json) as PriorStep[],
	createdAt: r.created_at,
});

export function insertContinuation(db: Database, c: Continuation) {
	db.query(
		"INSERT INTO dialogue_continuations (run_id,root_run_id,hop,original_request,achieved,need,conditions_json,steps_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
	).run(
		c.runId,
		c.rootRunId,
		c.hop,
		c.originalRequest,
		c.achieved,
		c.need,
		JSON.stringify(c.conditions),
		JSON.stringify(c.steps),
		c.createdAt,
	);
}

export function continuationOf(
	db: Database,
	runId: string,
): Continuation | null {
	const row = db
		.query("SELECT * FROM dialogue_continuations WHERE run_id=?")
		.get(runId) as Row | null;
	return row ? fromRow(row) : null;
}

/** A retracted request leaves no copy of its text or its steps' results in its chain. */
export function deleteContinuationsOfInput(db: Database, messageId: string) {
	db.query(
		"DELETE FROM dialogue_continuations WHERE root_run_id IN (SELECT id FROM dialogue_runs WHERE input_message_id=?)",
	).run(messageId);
}

/** The condition each continuation step of a chain was taken for, up to `hop`: step `hop + 1` served `need`. */
export function chainAttempts(db: Database, rootRunId: string, hop: number) {
	return (
		db
			.query(
				"SELECT hop, need FROM dialogue_continuations WHERE root_run_id=? AND hop<=? ORDER BY hop",
			)
			.all(rootRunId, hop) as Array<{ hop: number; need: string }>
	).map((r) => ({ step: r.hop + 1, condition: r.need }));
}
