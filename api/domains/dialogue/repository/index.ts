import { intentAnswerRouteMigration, intentJudgmentsMigration } from "./intent";
import type { Database } from "bun:sqlite";
import {
	workMigration,
	workNoticesMigration,
	workOriginsMigration,
	workRefsMigration,
} from "./work";
import {
	confirmationRefsMigration,
	resourcesMigration,
	runViewingResourceMigration,
	workLinksMigration,
} from "./resources";
import type { Migration } from "../../../infrastructure/sqlite";
import {
	continuationConditionsMigration,
	continuationStepsMigration,
	continuationsMigration,
	retainedToolchainsMigration,
	retireContinuationsMigration,
} from "./retired";
import type { Run } from "../contracts";
import { specialistEventsMigration, specialistMigration } from "./specialist";
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
export const pinnedToolchainMigration = `ALTER TABLE dialogue_runs ADD COLUMN pinned_toolchain_id TEXT;`;
export const announcementMigration = `ALTER TABLE dialogue_runs ADD COLUMN announcement TEXT;`;
type Announcement = { key: string; text: string };
function announcements(value: unknown): Announcement[] {
	return typeof value === "string" ? (JSON.parse(value) as Announcement[]) : [];
}
export function saveAnnouncement(
	db: Database,
	runId: string,
	revision: number,
	key: string,
	text: string,
) {
	const row = db
		.query(
			"SELECT announcement FROM dialogue_runs WHERE id=? AND revision=? AND status='running'",
		)
		.get(runId, revision) as { announcement: string | null } | null;
	if (!row) throw new Error("run_changed");
	const notices = announcements(row.announcement);
	if (notices.some((notice) => notice.key === key)) return;
	notices.push({ key, text });
	if (notices.map((notice) => notice.text).join("\n").length > 65536)
		throw new Error("chat_output_too_large");
	if (
		db
			.query(
				"UPDATE dialogue_runs SET announcement=? WHERE id=? AND revision=? AND status='running'",
			)
			.run(JSON.stringify(notices), runId, revision).changes !== 1
	)
		throw new Error("run_changed");
}
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
		announcement:
			announcements(row.announcement)
				.map((notice) => notice.text)
				.join("\n") || null,
		error: row.error as string | null,
		jobId: row.job_id as string | null,
		deadlineAt: row.deadline_at as string | null,
		deadlineFixed:
			row.deadline_fixed === undefined ? true : !!row.deadline_fixed,
		sourceKind: row.source_kind as Run["sourceKind"],
		pinnedToolchainId:
			(row.pinned_toolchain_id as string | null | undefined) ?? null,
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
/** The conversation of the newest run: the one the user talked in last. */
export function latestConversationId(db: Database): string | null {
	const row = db
		.query(
			"SELECT conversation_id AS id FROM dialogue_runs ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get() as { id: string } | null;
	return row?.id ?? null;
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
/** The newest run made for an input message (an edited message has one per send). */
export function latestRunOfMessage(
	db: Database,
	messageId: string,
): Run | null {
	const row = db
		.query(
			`SELECT ${columns} FROM dialogue_runs WHERE input_message_id = ? ORDER BY seq DESC LIMIT 1`,
		)
		.get(messageId);
	return row ? map(row as Record<string, unknown>) : null;
}
/** True when the user said something after the run: a later typed or spoken input of the conversation. */
export function userInputAfter(db: Database, run: Run): boolean {
	return !!db
		.query(
			"SELECT 1 FROM dialogue_runs WHERE conversation_id = ? AND seq > (SELECT seq FROM dialogue_runs WHERE id = ?) AND input_message_id <> ? AND source_kind IN ('manual','voice') LIMIT 1",
		)
		.get(run.conversationId, run.id, run.inputMessageId);
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
	{
		id: "dialogue/0009-announcement",
		sql: announcementMigration,
		after: ["dialogue/0008-specialist-sessions"],
	},
	{
		id: "dialogue/0010-specialist-events",
		sql: specialistEventsMigration,
		after: ["dialogue/0009-announcement"],
	},
	{
		id: "dialogue/0011-retained-toolchains",
		sql: retainedToolchainsMigration,
		after: ["dialogue/0010-specialist-events"],
	},
	{
		id: "dialogue/0012-deadline-policy",
		after: ["dialogue/0011-retained-toolchains"],
		sql: "ALTER TABLE dialogue_runs ADD COLUMN deadline_fixed INTEGER NOT NULL DEFAULT 1;",
	},
	{
		id: "dialogue/0013-continuations",
		after: ["dialogue/0012-deadline-policy"],
		sql: continuationsMigration,
	},
	{
		id: "dialogue/0014-continuation-conditions",
		after: ["dialogue/0013-continuations"],
		sql: continuationConditionsMigration,
	},
	{
		id: "dialogue/0015-continuation-steps",
		after: ["dialogue/0014-continuation-conditions"],
		sql: continuationStepsMigration,
	},
	{
		id: "dialogue/0016-pinned-toolchain",
		after: ["dialogue/0015-continuation-steps"],
		sql: pinnedToolchainMigration,
	},
	{
		id: "dialogue/0017-work",
		after: ["dialogue/0016-pinned-toolchain"],
		sql: workMigration,
	},
	{
		id: "dialogue/0018-prefix-digest",
		after: ["dialogue/0017-work"],
		sql: "ALTER TABLE dialogue_runs ADD COLUMN prefix_digest TEXT;",
	},
	{
		id: "dialogue/0019-retire-continuations",
		after: ["dialogue/0018-prefix-digest"],
		sql: retireContinuationsMigration,
	},
	{
		id: "dialogue/0020-work-origins",
		after: ["dialogue/0019-retire-continuations"],
		sql: workOriginsMigration,
	},
	{
		id: "dialogue/0021-work-refs",
		after: ["dialogue/0020-work-origins"],
		sql: workRefsMigration,
	},
	{
		id: "dialogue/0022-resources",
		after: ["dialogue/0021-work-refs"],
		sql: resourcesMigration,
	},
	{
		id: "dialogue/0023-work-links",
		after: ["dialogue/0022-resources"],
		sql: workLinksMigration,
	},
	{
		id: "dialogue/0024-confirmation-refs",
		after: ["dialogue/0023-work-links"],
		sql: confirmationRefsMigration,
	},
	{
		id: "dialogue/0025-viewing-resource",
		after: ["dialogue/0024-confirmation-refs"],
		sql: runViewingResourceMigration,
	},
	{
		id: "dialogue/0026-work-notices",
		after: ["dialogue/0025-viewing-resource"],
		sql: workNoticesMigration,
	},
	{
		id: "dialogue/0027-intent-judgments",
		after: ["dialogue/0026-work-notices"],
		sql: intentJudgmentsMigration,
	},
	{
		id: "dialogue/0028-intent-answer-route",
		after: ["dialogue/0027-intent-judgments"],
		sql: intentAnswerRouteMigration,
	},
];

/** A screen's form submit names its toolchain; only such a run writes the column. */
export function savePinnedToolchain(
	db: Database,
	id: string,
	toolchainId: string,
) {
	db.query("UPDATE dialogue_runs SET pinned_toolchain_id=? WHERE id=?").run(
		toolchainId,
		id,
	);
}

/** Explicit caller deadlines stay fixed; old installations without the column keep their current policy. */
export function saveDeadlinePolicy(db: Database, id: string, fixed: boolean) {
	if (
		(
			db.query("PRAGMA table_info(dialogue_runs)").all() as { name: string }[]
		).some((c) => c.name === "deadline_fixed")
	)
		db.query("UPDATE dialogue_runs SET deadline_fixed=? WHERE id=?").run(
			fixed ? 1 : 0,
			id,
		);
}
