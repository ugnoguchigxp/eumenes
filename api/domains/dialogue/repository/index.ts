import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Run } from "../contracts";
import { specialistMigration } from "./specialist";
import {
	commandInteractionsMigration,
	questionChoicesMigration,
} from "./interactions";
export const migration = `
CREATE TABLE dialogue_runs (
 id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id),
 utterance_id TEXT, status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','interrupted')),
 revision INTEGER NOT NULL, input_message_id TEXT NOT NULL REFERENCES messages(id), answer_message_id TEXT REFERENCES messages(id),
 error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dialogue_utterance_once ON dialogue_runs(utterance_id) WHERE utterance_id IS NOT NULL;
CREATE INDEX dialogue_runs_conversation ON dialogue_runs(conversation_id, created_at);
`;
/** Appended after the voice migration; links runs to queue jobs and schedules. */
export const queueLinkMigration = `
ALTER TABLE dialogue_runs ADD COLUMN job_id TEXT;
ALTER TABLE dialogue_runs ADD COLUMN deadline_at TEXT;
ALTER TABLE dialogue_runs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE dialogue_runs ADD COLUMN schedule_id TEXT;
ALTER TABLE dialogue_runs ADD COLUMN occurrence_id TEXT;
ALTER TABLE dialogue_runs ADD COLUMN seq INTEGER NOT NULL DEFAULT 0;
UPDATE dialogue_runs SET seq = rowid;
CREATE UNIQUE INDEX dialogue_runs_seq ON dialogue_runs(seq);
CREATE INDEX dialogue_runs_conversation_seq ON dialogue_runs(conversation_id, seq);
`;
export const agentLinkMigration = `ALTER TABLE dialogue_runs ADD COLUMN agent_task_id TEXT;`;
/** P3-08: whether World was read for the run ('used') or refused it ('blocked'). Frozen once deployed; dropped by `worldStateDropMigration`. */
export const worldStateMigration = `ALTER TABLE dialogue_runs ADD COLUMN world_state TEXT CHECK (world_state IN ('used','blocked'));`;
/** Nothing writes `world_state` any more (the conversation gets no World slice), so the column goes. */
const worldStateDropMigration = `ALTER TABLE dialogue_runs DROP COLUMN world_state;`;
export * from "./specialist";
export function linkAgent(
	db: Database,
	runId: string,
	taskId: string,
	jobId: string,
) {
	if (
		db
			.query(
				"UPDATE dialogue_runs SET agent_task_id=?,job_id=? WHERE id=? AND status IN ('queued','running')",
			)
			.run(taskId, jobId, runId).changes !== 1
	)
		throw new Error("run_changed");
}
export function linkAnswer(db: Database, runId: string, jobId: string) {
	if (
		db
			.query(
				"UPDATE dialogue_runs SET job_id=? WHERE id=? AND status IN ('queued','running')",
			)
			.run(jobId, runId).changes !== 1
	)
		throw new Error("run_changed");
}
const columns = "*";
function map(row: Record<string, unknown>): Run {
	return {
		id: row.id as string,
		agentTaskId: (row.agent_task_id as string | null | undefined) ?? null,
		requestId: row.request_id as string,
		conversationId: row.conversation_id as string,
		utteranceId: row.utterance_id as string | null,
		status: row.status as Run["status"],
		revision: row.revision as number,
		inputMessageId: row.input_message_id as string,
		answerMessageId: row.answer_message_id as string | null,
		error: row.error as string | null,
		jobId: row.job_id as string | null,
		deadlineAt: row.deadline_at as string | null,
		sourceKind: row.source_kind as Run["sourceKind"],
		scheduleId: row.schedule_id as string | null,
		occurrenceId: row.occurrence_id as string | null,
		specialistSessionId:
			(row.specialist_session_id as string | null | undefined) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}
export function byId(db: Database, id: string): Run | null {
	const row = db
		.query(`SELECT ${columns} FROM dialogue_runs WHERE id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
}
export function byRequest(db: Database, id: string): Run | null {
	const row = db
		.query(`SELECT ${columns} FROM dialogue_runs WHERE request_id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
}
export function byUtterance(db: Database, id: string): Run | null {
	const row = db
		.query(`SELECT ${columns} FROM dialogue_runs WHERE utterance_id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
}
export function listRuns(db: Database, conversationId: string): Run[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_runs WHERE conversation_id = ? ORDER BY seq`,
			)
			.all(conversationId) as Record<string, unknown>[]
	).map(map);
}
export function insert(db: Database, run: Run) {
	db.query(
		"INSERT INTO dialogue_runs (id,request_id,conversation_id,utterance_id,status,revision,input_message_id,answer_message_id,error,job_id,deadline_at,source_kind,schedule_id,occurrence_id,seq,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,(SELECT COALESCE(MAX(seq),0)+1 FROM dialogue_runs),?,?)",
	).run(
		run.id,
		run.requestId,
		run.conversationId,
		run.utteranceId,
		run.status,
		run.revision,
		run.inputMessageId,
		run.answerMessageId,
		run.error,
		run.jobId,
		run.deadlineAt,
		run.sourceKind,
		run.scheduleId,
		run.occurrenceId,
		run.createdAt,
		run.updatedAt,
	);
}
const UPDATE_RUN =
	"UPDATE dialogue_runs SET status=?,revision=revision+1,updated_at=?,error=?,answer_message_id=COALESCE(?,answer_message_id) WHERE id=? AND revision=? AND status IN ('queued','running')";
/** A run that goes on (claimed, or queued again for another attempt). */
export function transition(
	db: Database,
	id: string,
	revision: number,
	status: "queued" | "running",
	now: string,
	error: string | null = null,
): boolean {
	return (
		db.query(UPDATE_RUN).run(status, now, error, null, id, revision).changes ===
		1
	);
}
/** A run that ends. Only `endRun` calls this: the exchange and the steward must hear of the end in the same transaction. */
export function endTransition(
	db: Database,
	id: string,
	revision: number,
	status: "completed" | "failed" | "cancelled" | "interrupted",
	now: string,
	error: string | null,
	answerMessageId: string | null,
): boolean {
	return (
		db.query(UPDATE_RUN).run(status, now, error, answerMessageId, id, revision)
			.changes === 1
	);
}
/** Runs without a queue job predate the queue: they are interrupted, and returned (as they were) so the end can be recorded. */
export function interruptUnfinished(db: Database, now: string): Run[] {
	const runs = (
		db
			.query(
				"SELECT * FROM dialogue_runs WHERE status IN ('queued','running') AND job_id IS NULL",
			)
			.all() as Record<string, unknown>[]
	).map(map);
	db.query(
		"UPDATE dialogue_runs SET status='interrupted',revision=revision+1,updated_at=?,error='backend_restarted' WHERE status IN ('queued','running') AND job_id IS NULL",
	).run(now);
	return runs;
}
/**
 * The newest `limit` runs accepted before `run`, oldest first (the verbatim part of the model-visible history).
 * `withoutSpecialist` leaves the specialist sessions' runs out before the limit applies (they are not the
 * conversation's history); it needs the specialist migration, so only a host that wires sessions sets it.
 */
export function recentPriorRuns(
	db: Database,
	run: Run,
	limit: number,
	withoutSpecialist = false,
): Run[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_runs WHERE conversation_id = ? AND seq < (SELECT seq FROM dialogue_runs WHERE id = ?)${withoutSpecialist ? " AND specialist_session_id IS NULL" : ""} ORDER BY seq DESC LIMIT ?`,
			)
			.all(run.conversationId, run.id, limit) as Record<string, unknown>[]
	)
		.map(map)
		.reverse();
}

export function unfinishedAgentRuns(db: Database): Run[] {
	return (
		db
			.query(
				"SELECT * FROM dialogue_runs WHERE agent_task_id IS NOT NULL AND status IN ('queued','running')",
			)
			.all() as Record<string, unknown>[]
	).map(map);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "dialogue/0001-init", sql: migration },
	{ id: "dialogue/0002-queue-link", sql: queueLinkMigration },
	{ id: "dialogue/0003-agent-link", sql: agentLinkMigration },
	{ id: "dialogue/0004-world-state", sql: worldStateMigration },
	{
		id: "dialogue/0005-command-interactions",
		sql: commandInteractionsMigration,
		after: ["dialogue/0004-world-state"],
	},
	{
		id: "dialogue/0006-interaction-choices",
		sql: questionChoicesMigration,
		after: ["dialogue/0005-command-interactions"],
	},
	{
		id: "dialogue/0007-drop-world-state",
		sql: worldStateDropMigration,
		after: ["dialogue/0006-interaction-choices"],
	},
	{
		id: "dialogue/0008-specialist-sessions",
		sql: specialistMigration,
		after: ["dialogue/0007-drop-world-state"],
	},
];
