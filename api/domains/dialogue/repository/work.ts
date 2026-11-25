import type { Database } from "bun:sqlite";

/**
 * The conversation's TODOs and confirmations (the ContextWindow specification, sections 6.7 and 10.1). The ledger
 * is retired (spec toolchain-assignment-stage2-implementation-2026-11-25.md): nothing writes these tables any more,
 * and the rows it left stay for the forgetting that still reaches them and for the agency's work that began as one.
 */
export const workMigration = `
CREATE TABLE dialogue_work (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL,
 toolchain_id TEXT NOT NULL, toolchain_revision_id TEXT NOT NULL, execution TEXT NOT NULL,
 request TEXT NOT NULL, title TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('todo','waiting','done')),
 outcome TEXT, revision INTEGER NOT NULL, question_id TEXT, question TEXT, result_json TEXT,
 source_ref TEXT, dedupe_key TEXT NOT NULL,
 archive_requested TEXT, archived_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dialogue_work_dedupe ON dialogue_work(conversation_id, dedupe_key);
CREATE INDEX dialogue_work_open ON dialogue_work(conversation_id, archived_at, created_at);
CREATE INDEX dialogue_work_run ON dialogue_work(run_id);
CREATE INDEX dialogue_work_source ON dialogue_work(source_ref);
CREATE TABLE dialogue_confirmations (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, toolchain_id TEXT NOT NULL,
 toolchain_revision_id TEXT NOT NULL, request TEXT NOT NULL, inputs_json TEXT,
 impact TEXT NOT NULL, statement_delivery_key TEXT NOT NULL, issued_at TEXT NOT NULL,
 expires_at TEXT NOT NULL, used_at TEXT, superseded_at TEXT
);
CREATE INDEX dialogue_confirmations_open ON dialogue_confirmations(conversation_id, used_at, superseded_at);
`;

/** The user's messages each TODO and confirmation comes from, so forgetting one reaches them (section 13). */
export const workOriginsMigration = `
ALTER TABLE dialogue_work ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE dialogue_confirmations ADD COLUMN message_ids_json TEXT NOT NULL DEFAULT '[]';`;

/**
 * The short number the model reads a TODO (`t<ref>`) and a confirmation (`c<ref>`) by: per conversation, in
 * creation order, never changed (the ContextWindow layout specification, section 6).
 */
export const workRefsMigration = `
ALTER TABLE dialogue_work ADD COLUMN ref INTEGER;
UPDATE dialogue_work SET ref = (SELECT COUNT(*) FROM dialogue_work w WHERE w.conversation_id = dialogue_work.conversation_id
 AND (w.created_at < dialogue_work.created_at OR (w.created_at = dialogue_work.created_at AND w.rowid <= dialogue_work.rowid)));
CREATE UNIQUE INDEX dialogue_work_ref ON dialogue_work(conversation_id, ref);
ALTER TABLE dialogue_confirmations ADD COLUMN ref INTEGER;
UPDATE dialogue_confirmations SET ref = (SELECT COUNT(*) FROM dialogue_confirmations c
 WHERE c.conversation_id = dialogue_confirmations.conversation_id
 AND (c.issued_at < dialogue_confirmations.issued_at OR (c.issued_at = dialogue_confirmations.issued_at AND c.rowid <= dialogue_confirmations.rowid)));
CREATE UNIQUE INDEX dialogue_confirmations_ref ON dialogue_confirmations(conversation_id, ref);`;

/** The saved item a confirmed request changes, and how its unsaved edits are resolved: the approval hands them over. */
export const confirmationTargetMigration = `
ALTER TABLE dialogue_confirmations ADD COLUMN target TEXT;
ALTER TABLE dialogue_confirmations ADD COLUMN resolve_unsaved TEXT;`;

/** The name the confirmed item was shown by: the open confirmations name it, so two on one request stay apart. */
export const confirmationTargetLabelMigration = `
ALTER TABLE dialogue_confirmations ADD COLUMN target_label TEXT;`;

/** The user's own words a confirmed request was made from (the quote of its statement and the TODO's title). */
export const confirmationWordsMigration = `
ALTER TABLE dialogue_confirmations ADD COLUMN words TEXT;`;

/**
 * A TODO is archived as it finishes and the user is told by a notice on screen, unread until `notice_read_at` (the
 * TODO completion notice design, 2026-10-29). TODOs archived before are read; finished ones that still waited for
 * their spoken report are archived now and told once.
 */
export const workNoticesMigration = `
ALTER TABLE dialogue_work ADD COLUMN notice_read_at TEXT;
UPDATE dialogue_work SET notice_read_at = archived_at WHERE archived_at IS NOT NULL;
UPDATE dialogue_work SET archived_at = updated_at WHERE status = 'done' AND archived_at IS NULL;
ALTER TABLE dialogue_work DROP COLUMN archive_requested;
CREATE INDEX dialogue_work_archived ON dialogue_work(archived_at);`;

const fromMessages = (table: string, count: number) =>
	`EXISTS (SELECT 1 FROM json_each(${table}.message_ids_json) m WHERE m.value IN (${Array.from({ length: count }, () => "?").join(",")}))`;

/**
 * Forgetting reaches the TODOs that came from a forgotten message: their request, question and result are cleared
 * and they are archived (never read again). Open confirmations from it are withdrawn. Returns the TODOs cleared.
 */
export function forgetWork(
	db: Database,
	messageIds: readonly string[],
	at: string,
): Array<{ id: string; conversationId: string }> {
	if (messageIds.length === 0) return [];
	const rows = db
		.query(
			`SELECT id, conversation_id AS conversationId FROM dialogue_work WHERE ${fromMessages("dialogue_work", messageIds.length)}`,
		)
		.all(...messageIds) as Array<{ id: string; conversationId: string }>;
	for (const row of rows)
		db.query(
			"UPDATE dialogue_work SET request = '', title = '', question_id = NULL, question = NULL, result_json = NULL, archived_at = COALESCE(archived_at, ?), revision = revision + 1, updated_at = ? WHERE id = ?",
		).run(at, at, row.id);
	// The row stays without its words, so its number (`c<ref>`) is never given to another confirmation.
	db.query(
		`UPDATE dialogue_confirmations SET request = '', revision_sources_json=NULL, words = NULL, inputs_json = NULL, target = NULL, target_label = NULL, resolve_unsaved = NULL, superseded_at = COALESCE(superseded_at, ?) WHERE ${fromMessages("dialogue_confirmations", messageIds.length)}`,
	).run(at, ...messageIds);
	return rows;
}

/**
 * Pursuit run ids named by research TODOs from these messages.
 * Forgetting clears the TODO text and leaves `source_ref`. Blank ids and other toolchains,
 * including `web.note`, are not pursuit runs.
 */
export function researchSourceIds(
	db: Database,
	messageIds: readonly string[],
): string[] {
	if (messageIds.length === 0) return [];
	return (
		db
			.query(
				`SELECT DISTINCT source_ref AS id FROM dialogue_work
				WHERE toolchain_id = 'web.research' AND source_ref IS NOT NULL AND source_ref <> ''
				AND ${fromMessages("dialogue_work", messageIds.length)}
				ORDER BY source_ref`,
			)
			.all(...messageIds) as Array<{ id: string }>
	).map((row) => row.id);
}

/** A run's results deleted at their owner (a report deleted or expired): the TODOs it fed keep no copy. */
export function dropRunResults(
	db: Database,
	runId: string,
	at: string,
): Array<{ id: string; conversationId: string }> {
	const rows = db
		.query(
			"SELECT id, conversation_id AS conversationId FROM dialogue_work WHERE run_id = ? AND result_json IS NOT NULL",
		)
		.all(runId) as Array<{ id: string; conversationId: string }>;
	for (const row of rows)
		db.query(
			"UPDATE dialogue_work SET result_json = NULL, revision = revision + 1, updated_at = ? WHERE id = ?",
		).run(at, row.id);
	return rows;
}
export type WorkStatus = "todo" | "waiting" | "done";
type WorkOutcome =
	"succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
export type WorkRow = {
	id: string;
	/** The conversation's number of the TODO (`t<ref>`). */
	ref: number;
	conversationId: string;
	runId: string;
	toolchainId: string;
	toolchainRevisionId: string;
	execution: string;
	request: string;
	title: string;
	status: WorkStatus;
	outcome: WorkOutcome | null;
	revision: number;
	questionId: string | null;
	question: string | null;
	result: unknown;
	sourceRef: string | null;
	archivedAt: string | null;
	/** When the user read the TODO's completion notice; null while unread (or when it has none). */
	noticeReadAt: string | null;
	createdAt: string;
	updatedAt: string;
	/** The user's messages the request comes from. */
	messageIds: string[];
};

const columns =
	"id, ref, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title, status, outcome, revision, question_id, question, result_json, source_ref, archived_at, notice_read_at, created_at, updated_at, message_ids_json";
function map(row: Record<string, unknown>): WorkRow {
	return {
		id: row.id as string,
		ref: row.ref as number,
		conversationId: row.conversation_id as string,
		runId: row.run_id as string,
		toolchainId: row.toolchain_id as string,
		toolchainRevisionId: row.toolchain_revision_id as string,
		execution: row.execution as string,
		request: row.request as string,
		title: row.title as string,
		status: row.status as WorkStatus,
		outcome: (row.outcome as WorkOutcome | null) ?? null,
		revision: row.revision as number,
		questionId: (row.question_id as string | null) ?? null,
		question: (row.question as string | null) ?? null,
		result:
			row.result_json === null ? null : JSON.parse(row.result_json as string),
		sourceRef: (row.source_ref as string | null) ?? null,
		archivedAt: (row.archived_at as string | null) ?? null,
		noticeReadAt: (row.notice_read_at as string | null) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
		messageIds: JSON.parse(row.message_ids_json as string) as string[],
	};
}

function workById(db: Database, id: string): WorkRow | null {
	const row = db
		.query(`SELECT ${columns} FROM dialogue_work WHERE id = ?`)
		.get(id) as Record<string, unknown> | null;
	return row ? map(row) : null;
}

export function workBySource(db: Database, sourceRef: string): WorkRow | null {
	const row = db
		.query(
			`SELECT ${columns} FROM dialogue_work WHERE source_ref = ? ORDER BY created_at DESC LIMIT 1`,
		)
		.get(sourceRef) as Record<string, unknown> | null;
	return row ? map(row) : null;
}

/** A state change at the expected revision: the revision moves on; false when it moved meanwhile. */
export function updateWork(
	db: Database,
	id: string,
	expectedRevision: number,
	patch: {
		status?: WorkStatus;
		outcome?: WorkOutcome | null;
		questionId?: string | null;
		question?: string | null;
		result?: unknown;
		request?: string;
		sourceRef?: string | null;
		/** The run that now waits for the work (an answer resumes it in the answering run). */
		runId?: string;
	},
	at: string,
): boolean {
	const current = workById(db, id);
	if (!current || current.revision !== expectedRevision) return false;
	const next = { ...current, ...patch };
	return (
		db
			.query(
				"UPDATE dialogue_work SET status = ?, outcome = ?, question_id = ?, question = ?, result_json = ?, request = ?, source_ref = ?, run_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?",
			)
			.run(
				next.status,
				next.outcome,
				next.questionId,
				next.question,
				next.result === null || next.result === undefined
					? null
					: JSON.stringify(next.result),
				next.request,
				next.sourceRef,
				next.runId,
				at,
				id,
				expectedRevision,
			).changes === 1
	);
}

export function archiveWork(db: Database, id: string, at: string): boolean {
	return (
		db
			.query(
				"UPDATE dialogue_work SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL AND status = 'done'",
			)
			.run(at, at, id).changes === 1
	);
}

/** Remove copied bodies of one autonomous work while preserving its identity and replay key. */
export function eraseWorkBySource(db: Database, sourceRef: string, at: string) {
	const row = workBySource(db, sourceRef);
	if (!row) return [];
	db.query(
		"UPDATE dialogue_work SET request='',title='',question=NULL,question_id=NULL,result_json=NULL,status='done',outcome='cancelled',archived_at=COALESCE(archived_at,?),revision=revision+1,updated_at=? WHERE id=?",
	).run(at, at, row.id);
	return [row];
}
