import type { Database } from "bun:sqlite";

/**
 * The conversation's TODOs (the ContextWindow specification, section 10.1): every piece of work the conversation
 * agent handed to a toolchain, its state as the work's owner reports it, its result held for the conversation, and
 * whether the agent archived it. The confirmations issued before executing a change (section 6.7) live beside.
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
	db.query(
		`DELETE FROM dialogue_confirmations WHERE ${fromMessages("dialogue_confirmations", messageIds.length)}`,
	).run(...messageIds);
	return rows;
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
export type WorkOutcome =
	| "succeeded"
	| "partial"
	| "failed"
	| "cancelled"
	| "interrupted";
export type WorkRow = {
	id: string;
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
	archiveRequested: string | null;
	archivedAt: string | null;
	createdAt: string;
	updatedAt: string;
};

const columns =
	"id, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title, status, outcome, revision, question_id, question, result_json, source_ref, archive_requested, archived_at, created_at, updated_at";
function map(row: Record<string, unknown>): WorkRow {
	return {
		id: row.id as string,
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
		archiveRequested: (row.archive_requested as string | null) ?? null,
		archivedAt: (row.archived_at as string | null) ?? null,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

export function insertWork(
	db: Database,
	row: Omit<
		WorkRow,
		| "status"
		| "outcome"
		| "revision"
		| "questionId"
		| "question"
		| "result"
		| "archiveRequested"
		| "archivedAt"
		| "updatedAt"
	> & {
		dedupeKey: string;
		/** The user's messages the request comes from: forgetting any of them clears the TODO. */
		messageIds: readonly string[];
	},
): WorkRow {
	db.query(
		"INSERT INTO dialogue_work (id, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title, status, revision, source_ref, dedupe_key, created_at, updated_at, message_ids_json) VALUES (?,?,?,?,?,?,?,?,'todo',1,?,?,?,?,?)",
	).run(
		row.id,
		row.conversationId,
		row.runId,
		row.toolchainId,
		row.toolchainRevisionId,
		row.execution,
		row.request,
		row.title,
		row.sourceRef,
		row.dedupeKey,
		row.createdAt,
		row.createdAt,
		JSON.stringify(row.messageIds),
	);
	return workById(db, row.id)!;
}

export function workById(db: Database, id: string): WorkRow | null {
	const row = db
		.query(`SELECT ${columns} FROM dialogue_work WHERE id = ?`)
		.get(id) as Record<string, unknown> | null;
	return row ? map(row) : null;
}

export function workByDedupe(
	db: Database,
	conversationId: string,
	dedupeKey: string,
): WorkRow | null {
	const row = db
		.query(
			`SELECT ${columns} FROM dialogue_work WHERE conversation_id = ? AND dedupe_key = ?`,
		)
		.get(conversationId, dedupeKey) as Record<string, unknown> | null;
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

export function workOfRun(db: Database, runId: string): WorkRow[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_work WHERE run_id = ? ORDER BY created_at`,
			)
			.all(runId) as Record<string, unknown>[]
	).map(map);
}

/** The TODOs not archived, oldest first. */
export function openWork(db: Database, conversationId: string): WorkRow[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_work WHERE conversation_id = ? AND archived_at IS NULL ORDER BY created_at, id`,
			)
			.all(conversationId) as Record<string, unknown>[]
	).map(map);
}

/** Which TODOs a page lists: the unarchived ones, the open ones, the finished unarchived ones, or the archived. */
export type WorkPageState = "active" | "todo" | "done" | "archived";

/** One page of a conversation's TODOs for display, newest first, with the count of each state. */
export function workPage(
	db: Database,
	conversationId: string,
	query: { state: WorkPageState; pageIndex: number; pageSize: number },
): {
	rows: WorkRow[];
	total: number;
	pageIndex: number;
	counts: { todo: number; done: number; archived: number };
} {
	const totals = db
		.query(
			`SELECT
			 COUNT(CASE WHEN archived_at IS NULL AND status != 'done' THEN 1 END) todo,
			 COUNT(CASE WHEN archived_at IS NULL AND status = 'done' THEN 1 END) done,
			 COUNT(archived_at) archived,
			 COUNT(CASE WHEN archived_at IS NULL THEN 1 END) active
			 FROM dialogue_work WHERE conversation_id = ?`,
		)
		.get(conversationId) as {
		todo: number;
		done: number;
		archived: number;
		active: number;
	};
	const total = totals[query.state];
	const pageIndex = Math.min(
		query.pageIndex,
		Math.max(0, Math.ceil(total / query.pageSize) - 1),
	);
	const condition = {
		active: "archived_at IS NULL",
		todo: "archived_at IS NULL AND status != 'done'",
		done: "archived_at IS NULL AND status = 'done'",
		archived: "archived_at IS NOT NULL",
	}[query.state];
	const order = query.state === "archived" ? "archived_at" : "updated_at";
	const rows = (
		db
			.query(
				`SELECT ${columns} FROM dialogue_work WHERE conversation_id = ? AND ${condition} ORDER BY ${order} DESC, id DESC LIMIT ? OFFSET ?`,
			)
			.all(
				conversationId,
				query.pageSize,
				pageIndex * query.pageSize,
			) as Record<string, unknown>[]
	).map(map);
	return {
		rows,
		total,
		pageIndex,
		counts: { todo: totals.todo, done: totals.done, archived: totals.archived },
	};
}

/** The toolchains used most recently in the conversation, newest first, one row each. */
export function recentToolchains(
	db: Database,
	conversationId: string,
	limit: number,
): Array<{
	toolchainId: string;
	toolchainRevisionId: string;
	request: string;
}> {
	return (
		db
			.query(
				`SELECT toolchain_id AS toolchainId, toolchain_revision_id AS toolchainRevisionId, request, MAX(created_at) AS at
				 FROM dialogue_work WHERE conversation_id = ? AND execution != 'instant' GROUP BY toolchain_id ORDER BY at DESC LIMIT ?`,
			)
			.all(conversationId, limit) as Array<{
			toolchainId: string;
			toolchainRevisionId: string;
			request: string;
		}>
	).map(({ toolchainId, toolchainRevisionId, request }) => ({
		toolchainId,
		toolchainRevisionId,
		request,
	}));
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

export function requestArchive(db: Database, id: string, told: string) {
	db.query(
		"UPDATE dialogue_work SET archive_requested = ? WHERE id = ? AND archived_at IS NULL",
	).run(told, id);
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

/** The archive requests waiting for the delivery of the utterance they stand on. */
export function waitingArchives(
	db: Database,
	conversationId: string,
): WorkRow[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_work WHERE conversation_id = ? AND archive_requested IS NOT NULL AND archived_at IS NULL`,
			)
			.all(conversationId) as Record<string, unknown>[]
	).map(map);
}

export type ConfirmationRow = {
	id: string;
	conversationId: string;
	toolchainId: string;
	toolchainRevisionId: string;
	request: string;
	inputs: Record<string, unknown> | null;
	impact: string;
	statementDeliveryKey: string;
	issuedAt: string;
	expiresAt: string;
	usedAt: string | null;
	supersededAt: string | null;
};
function mapConfirmation(row: Record<string, unknown>): ConfirmationRow {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		toolchainId: row.toolchain_id as string,
		toolchainRevisionId: row.toolchain_revision_id as string,
		request: row.request as string,
		inputs:
			row.inputs_json === null
				? null
				: (JSON.parse(row.inputs_json as string) as Record<string, unknown>),
		impact: row.impact as string,
		statementDeliveryKey: row.statement_delivery_key as string,
		issuedAt: row.issued_at as string,
		expiresAt: row.expires_at as string,
		usedAt: (row.used_at as string | null) ?? null,
		supersededAt: (row.superseded_at as string | null) ?? null,
	};
}

/** Issues a confirmation; an open one for the same toolchain and request is superseded. */
export function insertConfirmation(
	db: Database,
	row: Omit<ConfirmationRow, "usedAt" | "supersededAt">,
	/** The user's messages the confirmed request comes from: forgetting any of them withdraws it. */
	messageIds: readonly string[],
) {
	db.query(
		"UPDATE dialogue_confirmations SET superseded_at = ? WHERE conversation_id = ? AND toolchain_id = ? AND request = ? AND used_at IS NULL AND superseded_at IS NULL",
	).run(row.issuedAt, row.conversationId, row.toolchainId, row.request);
	db.query(
		"INSERT INTO dialogue_confirmations (id, conversation_id, toolchain_id, toolchain_revision_id, request, inputs_json, impact, statement_delivery_key, issued_at, expires_at, message_ids_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		row.id,
		row.conversationId,
		row.toolchainId,
		row.toolchainRevisionId,
		row.request,
		row.inputs === null ? null : JSON.stringify(row.inputs),
		row.impact,
		row.statementDeliveryKey,
		row.issuedAt,
		row.expiresAt,
		JSON.stringify(messageIds),
	);
}

export function confirmationById(
	db: Database,
	id: string,
): ConfirmationRow | null {
	const row = db
		.query("SELECT * FROM dialogue_confirmations WHERE id = ?")
		.get(id) as Record<string, unknown> | null;
	return row ? mapConfirmation(row) : null;
}

export function openConfirmations(
	db: Database,
	conversationId: string,
	now: string,
): ConfirmationRow[] {
	return (
		db
			.query(
				"SELECT * FROM dialogue_confirmations WHERE conversation_id = ? AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ? ORDER BY issued_at",
			)
			.all(conversationId, now) as Record<string, unknown>[]
	).map(mapConfirmation);
}

export function useConfirmation(db: Database, id: string, at: string): boolean {
	return (
		db
			.query(
				"UPDATE dialogue_confirmations SET used_at = ? WHERE id = ? AND used_at IS NULL AND superseded_at IS NULL AND expires_at > ?",
			)
			.run(at, id, at).changes === 1
	);
}
