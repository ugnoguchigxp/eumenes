import type { Database } from "bun:sqlite";
import type {
	BlockerReason,
	NoticeKind,
	QueueState,
	RunKind,
	RunState,
} from "./contracts";

/* Runs, the single execution queue and notices (migration kanban/0002-runs). */

export type RunRow = {
	seq: number;
	id: string;
	cardId: string;
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

export const OPEN_RUN_STATES: readonly RunState[] = ["waiting_turn", "handed"];

export function insertRun(db: Database, run: Omit<RunRow, "seq">) {
	db.query(
		`INSERT INTO kanban_runs(id,card_id,kind,state,reason,card_revision,title,prompt,body,
 claude_session_id,project_id,origin,conversation_id,stop_requested,created_at,handed_at,finished_at)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
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

export const oldestWaiting = (db: Database): RunRow | null => {
	const row = db
		.query(
			"SELECT * FROM kanban_runs WHERE state='waiting_turn' ORDER BY seq LIMIT 1",
		)
		.get() as RawRun | null;
	return row ? toRun(row) : null;
};

export const handedRuns = (db: Database): RunRow[] =>
	(
		db
			.query("SELECT * FROM kanban_runs WHERE state='handed' ORDER BY seq")
			.all() as RawRun[]
	).map(toRun);

export const waitingCount = (db: Database): number =>
	(
		db
			.query("SELECT COUNT(*) AS n FROM kanban_runs WHERE state='waiting_turn'")
			.get() as { n: number }
	).n;

/** Open runs and every card's current run: what the board shows. */
export const boardRuns = (db: Database): RunRow[] =>
	(
		db
			.query(
				`SELECT * FROM kanban_runs WHERE state IN ('waiting_turn','handed')
 OR id IN (SELECT current_run_id FROM kanban_cards WHERE current_run_id IS NOT NULL)
 ORDER BY seq`,
			)
			.all() as RawRun[]
	).map(toRun);

/** Another card's run was handed over after this run (the working directory is shared). */
export const handedByOthersAfter = (db: Database, run: RunRow): boolean =>
	db
		.query(
			"SELECT 1 FROM kanban_runs WHERE card_id<>? AND handed_at IS NOT NULL AND seq>? LIMIT 1",
		)
		.get(run.cardId, run.seq) !== null;

export const setStopRequested = (db: Database, id: string, value: boolean) =>
	db
		.query(
			"UPDATE kanban_runs SET stop_requested=? WHERE id=? AND state='handed'",
		)
		.run(value ? 1 : 0, id);

export const stopRequestedIds = (db: Database): string[] =>
	(
		db
			.query(
				"SELECT id FROM kanban_runs WHERE state='handed' AND stop_requested=1 ORDER BY seq",
			)
			.all() as Array<{ id: string }>
	).map((row) => row.id);

export function getQueue(db: Database): QueueState {
	const row = db
		.query("SELECT queue_state,queue_reason FROM kanban_board WHERE id=1")
		.get() as {
		queue_state: "running" | "paused";
		queue_reason: string | null;
	};
	return row.queue_state === "paused"
		? {
				state: "paused",
				reason: row.queue_reason as Extract<
					QueueState,
					{ state: "paused" }
				>["reason"],
			}
		: { state: "running" };
}

export const setQueue = (db: Database, queue: QueueState) =>
	db
		.query("UPDATE kanban_board SET queue_state=?,queue_reason=? WHERE id=1")
		.run(queue.state, queue.state === "paused" ? queue.reason : null);

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
