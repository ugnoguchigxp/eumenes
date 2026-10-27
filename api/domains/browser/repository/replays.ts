import type { Database } from "bun:sqlite";
import {
	REPLAY_LIST_LIMIT,
	errorLabel,
	type ReplayState,
	type ReplayView,
} from "../contracts";
import { markHistoryFailed, markHistoryReplayed } from "./histories";

export type ReplayRow = {
	id: string;
	owner: string;
	history_id: string;
	state: ReplayState;
	error_code: string | null;
	tab_ref: string | null;
	started_at: number;
	ended_at: number | null;
};

export const replayRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_replays WHERE id=?")
		.get(id) as ReplayRow | null;

/** A replay of this owner, or `browser_replay_not_found` (another owner's is not told apart from a missing one). */
export function ownedReplay(db: Database, id: string, owner: string) {
	const r = replayRow(db, id);
	if (!r || r.owner !== owner) throw new Error("browser_replay_not_found");
	return r;
}

export const insertReplay = (
	db: Database,
	id: string,
	owner: string,
	historyId: string,
	now: number,
) =>
	db
		.query(
			"INSERT INTO browser_replays(id,owner,history_id,state,started_at) VALUES(?,?,?, 'running', ?)",
		)
		.run(id, owner, historyId, now);

export const setReplayTab = (db: Database, id: string, tabRef: string) =>
	db.query("UPDATE browser_replays SET tab_ref=? WHERE id=?").run(tabRef, id);

export const activeReplayCount = (db: Database, owner: string) =>
	(
		db
			.query(
				"SELECT COUNT(*) AS n FROM browser_replays WHERE owner=? AND state='running'",
			)
			.get(owner) as { n: number }
	).n;

/** A replay drives the browser alone while it runs: tasks and captures of the owner start only after it. */
export function assertNoReplay(db: Database, owner: string) {
	if (activeReplayCount(db, owner) > 0) throw new Error("replay_busy");
}

/**
 * Ends a running replay once and counts it on its history: a completed one is a run, a failed one a failure,
 * a cancelled one nothing. Returns false when it had already ended.
 */
export function endReplay(
	db: Database,
	id: string,
	end: { state: "completed" | "cancelled" } | { state: "failed"; code: string },
	now: number,
) {
	const r = replayRow(db, id);
	if (!r || r.state !== "running") return false;
	db.query(
		"UPDATE browser_replays SET state=?,error_code=?,ended_at=? WHERE id=?",
	).run(end.state, end.state === "failed" ? end.code : null, now, id);
	if (end.state === "completed") markHistoryReplayed(db, r.history_id, now);
	else if (end.state === "failed") markHistoryFailed(db, r.history_id, now);
	return true;
}

/** Backend restart: nothing of the previous process is alive, so a replay that was running failed. */
export function interruptReplays(db: Database, now: number) {
	const running = db
		.query("SELECT id FROM browser_replays WHERE state='running'")
		.all() as { id: string }[];
	for (const r of running)
		endReplay(db, r.id, { state: "failed", code: "replay_interrupted" }, now);
}

export const listReplayRows = (
	db: Database,
	owner: string,
	limit = REPLAY_LIST_LIMIT,
) =>
	db
		.query(
			"SELECT * FROM browser_replays WHERE owner=? ORDER BY started_at DESC, rowid DESC LIMIT ?",
		)
		.all(owner, limit) as ReplayRow[];

export const replayView = (r: ReplayRow): ReplayView => ({
	replayId: r.id,
	historyId: r.history_id,
	state: r.state,
	errorCode: r.error_code,
	errorLabel: errorLabel(r.error_code),
	startedAt: r.started_at,
	endedAt: r.ended_at,
});

/** Moves on at every start and every end, so the screen's snapshot is read again. */
export const replaysRevision = (db: Database) => {
	const r = db
		.query(
			"SELECT COUNT(*) AS n, COALESCE(SUM(state!='running'),0) AS e, COALESCE(MAX(started_at),0) AS s, COALESCE(MAX(ended_at),0) AS t FROM browser_replays",
		)
		.get() as { n: number; e: number; s: number; t: number };
	return r.n + r.e + r.s + r.t;
};
