import type { Database } from "bun:sqlite";
import type {
	BlockerReason,
	NoticeKind,
	QueueState,
	RunKind,
	RunState,
} from "./contracts";

import {
	ACTIVE_RUN_STATES,
	DEFAULT_EXECUTOR_ID,
	OPEN_RUN_STATES,
} from "./shared-contracts";
export { OPEN_RUN_STATES };

export type RunRow = {
	seq: number;
	id: string;
	cardId: string;
	executorId: string;
	executorRevision: number;
	workspaceRef: string;
	sessionRef: string | null;
	executionStopped: boolean;
	attemptRef: string | null;
	kind: RunKind;
	state: RunState;
	reason: BlockerReason | null;
	cardRevision: number;
	title: string;
	prompt: string;
	/** The text sent to Claude Code, composed and fixed when the run was created. */
	body: string;
	claudeSessionId: string;
	projectId: string;
	origin: "board" | "conversation";
	conversationId: string | null;
	stopRequested: boolean;
	createdAt: number;
	handedAt: number | null;
	finishedAt: number | null;
};

type RawRun = {
	seq: number;
	id: string;
	card_id: string;
	executor_id: string;
	executor_revision: number;
	workspace_ref: string;
	session_ref: string | null;
	execution_stopped: number;
	attempt_ref: string | null;
	kind: RunKind;
	state: RunState;
	reason: BlockerReason | null;
	card_revision: number;
	title: string;
	prompt: string;
	body: string;
	claude_session_id: string;
	project_id: string;
	origin: "board" | "conversation";
	conversation_id: string | null;
	stop_requested: number;
	created_at: number;
	handed_at: number | null;
	finished_at: number | null;
};

const toRun = (row: RawRun): RunRow => ({
	seq: row.seq,
	id: row.id,
	cardId: row.card_id,
	executorId: row.executor_id,
	executorRevision: row.executor_revision,
	workspaceRef: row.workspace_ref,
	sessionRef: row.session_ref,
	executionStopped: row.execution_stopped === 1,
	attemptRef: row.attempt_ref,
	kind: row.kind,
	state: row.state,
	reason: row.reason,
	cardRevision: row.card_revision,
	title: row.title,
	prompt: row.prompt,
	body: row.body,
	claudeSessionId: row.claude_session_id,
	projectId: row.project_id,
	origin: row.origin,
	conversationId: row.conversation_id,
	stopRequested: row.stop_requested === 1,
	createdAt: row.created_at,
	handedAt: row.handed_at,
	finishedAt: row.finished_at,
});

export function insertRun(db: Database, run: Omit<RunRow, "seq">) {
	db.query(
		`INSERT INTO kanban_runs(id,card_id,kind,state,reason,card_revision,title,prompt,body,
 claude_session_id,project_id,origin,conversation_id,stop_requested,created_at,handed_at,finished_at,executor_id,executor_revision,workspace_ref,session_ref,execution_stopped,attempt_ref)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		run.id,
		run.cardId,
		run.kind,
		run.state,
		run.reason,
		run.cardRevision,
		run.title,
		run.prompt,
		run.body,
		run.claudeSessionId,
		run.projectId,
		run.origin,
		run.conversationId,
		run.stopRequested ? 1 : 0,
		run.createdAt,
		run.handedAt,
		run.finishedAt,
		run.executorId,
		run.executorRevision,
		run.workspaceRef,
		run.sessionRef,
		run.executionStopped ? 1 : 0,
		run.attemptRef,
	);
}

export function getRun(db: Database, id: string): RunRow | null {
	const row = db
		.query("SELECT * FROM kanban_runs WHERE id=?")
		.get(id) as RawRun | null;
	return row ? toRun(row) : null;
}

/** Moves a run to a new state, only from one of `from`; false when it was elsewhere. */
export function transitionRun(
	db: Database,
	id: string,
	from: readonly RunState[],
	change: {
		state: RunState;
		reason?: BlockerReason | null;
		handedAt?: number;
		finishedAt?: number;
	},
): boolean {
	const marks = from.map(() => "?").join(",");
	const result = db
		.query(
			`UPDATE kanban_runs SET state=?,reason=?,stop_requested=0,
 handed_at=COALESCE(?,handed_at),finished_at=COALESCE(?,finished_at)
 WHERE id=? AND state IN (${marks})`,
		)
		.run(
			change.state,
			change.reason ?? null,
			change.handedAt ?? null,
			change.finishedAt ?? null,
			id,
			...from,
		);
	return result.changes > 0;
}

export const oldestWaiting = (
	db: Database,
	executorId = DEFAULT_EXECUTOR_ID,
): RunRow | null => {
	const row = db
		.query(
			"SELECT * FROM kanban_runs WHERE state='queued' AND executor_id=? ORDER BY seq LIMIT 1",
		)
		.get(executorId) as RawRun | null;
	return row ? toRun(row) : null;
};

export const handedRuns = (db: Database, executorId?: string): RunRow[] => {
	const marks = ACTIVE_RUN_STATES.map(() => "?").join(",");
	return (
		db
			.query(
				`SELECT * FROM kanban_runs WHERE state IN (${marks}) ${executorId ? "AND executor_id=?" : ""} ORDER BY seq`,
			)
			.all(
				...ACTIVE_RUN_STATES,
				...(executorId ? [executorId] : []),
			) as RawRun[]
	).map(toRun);
};
export const waitingCount = (
	db: Database,
	executorId = DEFAULT_EXECUTOR_ID,
): number =>
	(
		db
			.query(
				"SELECT COUNT(*) AS n FROM kanban_runs WHERE state='queued' AND executor_id=?",
			)
			.get(executorId) as { n: number }
	).n;

/** Open runs and every card's current run: what the board shows. */
export const boardRuns = (db: Database): RunRow[] =>
	(
		db
			.query(
				`SELECT * FROM kanban_runs WHERE state IN ('queued','dispatched','running','waiting','settling','stopping')
 OR id IN (SELECT current_run_id FROM kanban_cards WHERE current_run_id IS NOT NULL)
 ORDER BY seq`,
			)
			.all() as RawRun[]
	).map(toRun);

/**
 * The two most recently handed-over runs of different cards (newest first): enough to tell for
 * any run whether another card's run was handed over after it (the working directory is shared).
 */
export const latestHandedRuns = (
	db: Database,
): Array<{ cardId: string; seq: number }> =>
	(
		db
			.query(
				`SELECT card_id, MAX(seq) AS seq FROM kanban_runs WHERE handed_at IS NOT NULL
 GROUP BY card_id ORDER BY seq DESC LIMIT 2`,
			)
			.all() as Array<{ card_id: string; seq: number }>
	).map((row) => ({ cardId: row.card_id, seq: row.seq }));

/** Deletes final runs finished before `before` that no card points to; returns how many. */
export const deleteOldRuns = (db: Database, before: number): number =>
	db
		.query(
			`DELETE FROM kanban_runs WHERE state IN ('completed','blocked','cancelled','unknown')
 AND finished_at IS NOT NULL AND finished_at<?
 AND id NOT IN (SELECT current_run_id FROM kanban_cards WHERE current_run_id IS NOT NULL)`,
		)
		.run(before).changes;

export const setStopRequested = (db: Database, id: string, value: boolean) =>
	db
		.query(
			"UPDATE kanban_runs SET stop_requested=? WHERE id=? AND state IN ('dispatched','running','waiting','settling','stopping')",
		)
		.run(value ? 1 : 0, id);

export const stopRequestedIds = (
	db: Database,
	executorId = DEFAULT_EXECUTOR_ID,
): string[] =>
	(
		db
			.query(
				"SELECT id FROM kanban_runs WHERE state IN ('dispatched','running','waiting','settling','stopping') AND stop_requested=1 AND executor_id=? ORDER BY seq",
			)
			.all(executorId) as Array<{ id: string }>
	).map((row) => row.id);

export function getQueue(
	db: Database,
	executorId = DEFAULT_EXECUTOR_ID,
): QueueState {
	const row = db
		.query("SELECT state,reason FROM kanban_queues WHERE executor_id=?")
		.get(executorId) as {
		state: "running" | "paused";
		reason: string | null;
	} | null;
	return row?.state === "paused"
		? {
				state: "paused",
				reason: row.reason as Extract<
					QueueState,
					{ state: "paused" }
				>["reason"],
			}
		: { state: "running" };
}
export const setQueue = (
	db: Database,
	queue: QueueState,
	executorId = DEFAULT_EXECUTOR_ID,
) =>
	db
		.query(
			"INSERT INTO kanban_queues(executor_id,state,reason) VALUES(?,?,?) ON CONFLICT(executor_id) DO UPDATE SET state=excluded.state,reason=excluded.reason,revision=revision+1",
		)
		.run(
			executorId,
			queue.state,
			queue.state === "paused" ? queue.reason : null,
		);

export type NoticeRow = {
	id: string;
	kind: NoticeKind;
	cardId: string | null;
	runId: string | null;
	text: string;
	read: boolean;
	createdAt: number;
};

/** Notices kept (newest first); older ones are dropped when a new one is saved. */
const KEEP_NOTICES = 200;

/** Saves a notice; false when this run already has one of that kind. */
export function insertNotice(db: Database, notice: NoticeRow): boolean {
	const result = db
		.query(
			`INSERT OR IGNORE INTO kanban_notices(id,kind,card_id,run_id,text,is_read,created_at)
 VALUES(?,?,?,?,?,0,?)`,
		)
		.run(
			notice.id,
			notice.kind,
			notice.cardId,
			notice.runId,
			notice.text,
			notice.createdAt,
		);
	if (result.changes === 0) return false;
	db.query(
		`DELETE FROM kanban_notices WHERE seq NOT IN
 (SELECT seq FROM kanban_notices ORDER BY seq DESC LIMIT ?)`,
	).run(KEEP_NOTICES);
	return true;
}

export const listNotices = (db: Database, limit: number): NoticeRow[] =>
	(
		db
			.query("SELECT * FROM kanban_notices ORDER BY seq DESC LIMIT ?")
			.all(limit) as Array<{
			id: string;
			kind: NoticeKind;
			card_id: string | null;
			run_id: string | null;
			text: string;
			is_read: number;
			created_at: number;
		}>
	).map((row) => ({
		id: row.id,
		kind: row.kind,
		cardId: row.card_id,
		runId: row.run_id,
		text: row.text,
		read: row.is_read === 1,
		createdAt: row.created_at,
	}));

export const unreadNotices = (db: Database): number =>
	(
		db
			.query("SELECT COUNT(*) AS n FROM kanban_notices WHERE is_read=0")
			.get() as { n: number }
	).n;

/** Marks a notice read; false when there is no such notice. */
export function markNoticeRead(db: Database, id: string): boolean {
	const found = db.query("SELECT 1 FROM kanban_notices WHERE id=?").get(id);
	if (!found) return false;
	db.query("UPDATE kanban_notices SET is_read=1 WHERE id=?").run(id);
	return true;
}
