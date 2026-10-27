import type { Database } from "bun:sqlite";
import { HISTORY_LIST_LIMIT, type StoredVariable } from "../contracts";
import type { HistoryAction, HistoryStep } from "../contracts/history";

export type HistoryRow = {
	id: string;
	owner: string;
	title: string;
	request: string;
	place: string;
	variables_json: string;
	steps_json: string;
	actions_json: string;
	source_task_id: string | null;
	revision: number;
	run_count: number;
	failure_count: number;
	last_outcome: "completed" | "failed";
	has_commit: number;
	last_used_at: number;
	created_at: number;
	updated_at: number;
};

export type HistoryContent = {
	title: string;
	request: string;
	place: string;
	variables: StoredVariable[];
	steps: HistoryStep[];
	actions: HistoryAction[];
	sourceTaskId: string;
	hasCommit: boolean;
};

export const historyRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_histories WHERE id=?")
		.get(id) as HistoryRow | null;

/** A history of this owner, or `browser_history_not_found` (another owner's is not told apart from a missing one). */
export function ownedHistory(db: Database, id: string, owner: string) {
	const r = historyRow(db, id);
	if (!r || r.owner !== owner) throw new Error("browser_history_not_found");
	return r;
}

export const listHistoryRows = (
	db: Database,
	owner: string,
	limit = HISTORY_LIST_LIMIT,
) =>
	db
		.query(
			"SELECT * FROM browser_histories WHERE owner=? ORDER BY last_used_at DESC, rowid DESC LIMIT ?",
		)
		.all(owner, limit) as HistoryRow[];

export const historyVariables = (r: HistoryRow) =>
	JSON.parse(r.variables_json) as StoredVariable[];
export const historySteps = (r: HistoryRow) =>
	JSON.parse(r.steps_json) as HistoryStep[];
export const historyActions = (r: HistoryRow) =>
	JSON.parse(r.actions_json) as HistoryAction[];

export function insertHistory(
	db: Database,
	id: string,
	owner: string,
	c: HistoryContent,
	now: number,
) {
	db.query(
		`INSERT INTO browser_histories(id,owner,title,request,place,variables_json,steps_json,actions_json,source_task_id,
		 revision,run_count,failure_count,last_outcome,has_commit,last_used_at,created_at,updated_at)
		 VALUES(?,?,?,?,?,?,?,?,?,1,1,0,'completed',?,?,?,?)`,
	).run(
		id,
		owner,
		c.title,
		c.request,
		c.place,
		JSON.stringify(c.variables),
		JSON.stringify(c.steps),
		JSON.stringify(c.actions),
		c.sourceTaskId,
		c.hasCommit ? 1 : 0,
		now,
		now,
		now,
	);
}

/** A completed run replaces the content; the revision and the run count move on. */
export function replaceHistory(
	db: Database,
	id: string,
	c: HistoryContent,
	now: number,
) {
	db.query(
		`UPDATE browser_histories SET title=?,request=?,place=?,variables_json=?,steps_json=?,actions_json=?,source_task_id=?,
		 revision=revision+1,run_count=run_count+1,last_outcome='completed',has_commit=?,last_used_at=?,updated_at=? WHERE id=?`,
	).run(
		c.title,
		c.request,
		c.place,
		JSON.stringify(c.variables),
		JSON.stringify(c.steps),
		JSON.stringify(c.actions),
		c.sourceTaskId,
		c.hasCommit ? 1 : 0,
		now,
		now,
		id,
	);
}

/** A failed run counts but changes no content (and so not the revision). */
export const markHistoryFailed = (db: Database, id: string, now: number) =>
	db
		.query(
			"UPDATE browser_histories SET failure_count=failure_count+1,last_outcome='failed',last_used_at=?,updated_at=? WHERE id=?",
		)
		.run(now, now, id);

export const deleteHistory = (db: Database, id: string) =>
	db.query("DELETE FROM browser_histories WHERE id=?").run(id);
