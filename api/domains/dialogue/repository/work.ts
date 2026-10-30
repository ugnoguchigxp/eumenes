import type { Database } from "bun:sqlite";

/**
 * The conversation's TODOs (the ContextWindow specification, section 10.1): every piece of work the conversation
 * agent handed to a toolchain, its state as the work's owner reports it, its result, and whether it is archived (a
 * finished TODO is archived as it finishes). The confirmations issued before executing a change (section 6.7) live beside.
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
		`UPDATE dialogue_confirmations SET request = '', inputs_json = NULL, target = NULL, target_label = NULL, resolve_unsaved = NULL, superseded_at = COALESCE(superseded_at, ?) WHERE ${fromMessages("dialogue_confirmations", messageIds.length)}`,
	).run(at, ...messageIds);
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
		| "archivedAt"
		| "noticeReadAt"
		| "updatedAt"
		| "ref"
		| "messageIds"
	> & {
		dedupeKey: string;
		/** The user's messages the request comes from: forgetting any of them clears the TODO. */
		messageIds: readonly string[];
	},
): WorkRow {
	db.query(
		"INSERT INTO dialogue_work (id, ref, conversation_id, run_id, toolchain_id, toolchain_revision_id, execution, request, title, status, revision, source_ref, dedupe_key, created_at, updated_at, message_ids_json) VALUES (?,(SELECT COALESCE(MAX(ref), 0) + 1 FROM dialogue_work WHERE conversation_id = ?),?,?,?,?,?,?,?,'todo',1,?,?,?,?,?)",
	).run(
		row.id,
		row.conversationId,
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

/** The TODO the model names `t<ref>` in a conversation. */
export function workByRef(
	db: Database,
	conversationId: string,
	ref: number,
): WorkRow | null {
	const row = db
		.query(
			`SELECT ${columns} FROM dialogue_work WHERE conversation_id = ? AND ref = ?`,
		)
		.get(conversationId, ref) as Record<string, unknown> | null;
	return row ? map(row) : null;
}

/** Every TODO's number in a conversation (id to `ref`), archived ones included: the log names them all. */
export function workRefs(
	db: Database,
	conversationId: string,
): Map<string, number> {
	const rows = db
		.query("SELECT id, ref FROM dialogue_work WHERE conversation_id = ?")
		.all(conversationId) as Array<{ id: string; ref: number }>;
	return new Map(rows.map((row) => [row.id, row.ref]));
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

/** The TODOs archived since `since` (an ISO time), newest last, at most `limit`; a forgotten one (no title) is never read. */
export function recentlyArchivedWork(
	db: Database,
	conversationId: string,
	since: string,
	limit: number,
): WorkRow[] {
	return (
		db
			.query(
				`SELECT ${columns} FROM dialogue_work WHERE conversation_id = ? AND archived_at IS NOT NULL AND archived_at >= ? AND title != '' ORDER BY archived_at DESC, id DESC LIMIT ?`,
			)
			.all(conversationId, since, limit) as Record<string, unknown>[]
	)
		.map(map)
		.reverse();
}

/** Which TODOs a page lists: the unarchived (open) ones, or the archived. */
export type WorkPageState = "active" | "archived";

/** One page of a conversation's TODOs for display, newest first, with the count of each state. */
export function workPage(
	db: Database,
	conversationId: string,
	query: { state: WorkPageState; pageIndex: number; pageSize: number },
): {
	rows: WorkRow[];
	total: number;
	pageIndex: number;
	counts: { todo: number; archived: number };
} {
	const totals = db
		.query(
			`SELECT COUNT(CASE WHEN archived_at IS NULL THEN 1 END) active, COUNT(archived_at) archived
			 FROM dialogue_work WHERE conversation_id = ?`,
		)
		.get(conversationId) as { active: number; archived: number };
	const total = totals[query.state];
	const pageIndex = Math.min(
		query.pageIndex,
		Math.max(0, Math.ceil(total / query.pageSize) - 1),
	);
	const condition = {
		active: "archived_at IS NULL",
		archived: "archived_at IS NOT NULL",
	}[query.state];
	// Current work keeps the order it was asked in (newest first); the archive follows when each was archived.
	const order = { active: "created_at", archived: "archived_at" }[query.state];
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
		counts: { todo: totals.active, archived: totals.archived },
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

export function archiveWork(db: Database, id: string, at: string): boolean {
	return (
		db
			.query(
				"UPDATE dialogue_work SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL AND status = 'done'",
			)
			.run(at, at, id).changes === 1
	);
}

/**
 * A finished TODO's notice: one that ended with a result to tell (not cancelled) and was not forgotten (a forgotten
 * TODO loses its title).
 */
const NOTICE =
	"archived_at IS NOT NULL AND status = 'done' AND outcome IN ('succeeded','partial','failed','interrupted') AND title != ''";

/** The completion notices of every conversation, newest first, at most `limit`, and how many are unread in all. */
export function workNotices(
	db: Database,
	limit: number,
): { rows: WorkRow[]; unread: number } {
	const rows = (
		db
			.query(
				`SELECT ${columns} FROM dialogue_work WHERE ${NOTICE} AND notice_archived_at IS NULL ORDER BY archived_at DESC, id DESC LIMIT ?`,
			)
			.all(limit) as Record<string, unknown>[]
	).map(map);
	const { unread } = db
		.query(
			`SELECT COUNT(*) unread FROM dialogue_work WHERE ${NOTICE} AND notice_archived_at IS NULL AND notice_read_at IS NULL`,
		)
		.get() as { unread: number };
	return { rows, unread };
}

/** Archives completion notices without changing the work, result, or read state. */
export function archiveWorkNotices(db: Database, at: string) {
	return db
		.query(`UPDATE dialogue_work SET notice_archived_at=?
		WHERE ${NOTICE} AND notice_archived_at IS NULL`)
		.run(at).changes;
}

/** Marks a TODO's notice read; false when the TODO has no notice. Reading it again changes nothing. */
export function readWorkNotice(db: Database, id: string, at: string): boolean {
	if (
		!db.query(`SELECT 1 FROM dialogue_work WHERE id = ? AND ${NOTICE}`).get(id)
	)
		return false;
	db.query(
		"UPDATE dialogue_work SET notice_read_at = ? WHERE id = ? AND notice_read_at IS NULL",
	).run(at, id);
	return true;
}

export type ConfirmationRow = {
	id: string;
	/** The conversation's number of the confirmation (`c<ref>`). */
	ref: number;
	conversationId: string;
	toolchainId: string;
	toolchainRevisionId: string;
	request: string;
	inputs: Record<string, unknown> | null;
	/** The saved item the request changes (a specialist's target), handed over as it was confirmed. */
	target: string | null;
	/** The target's name as the confirmation showed it. */
	targetLabel: string | null;
	resolveUnsaved: "discard" | null;
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
		ref: row.ref as number,
		conversationId: row.conversation_id as string,
		toolchainId: row.toolchain_id as string,
		toolchainRevisionId: row.toolchain_revision_id as string,
		request: row.request as string,
		inputs:
			row.inputs_json === null
				? null
				: (JSON.parse(row.inputs_json as string) as Record<string, unknown>),
		target: (row.target as string | null) ?? null,
		targetLabel: (row.target_label as string | null) ?? null,
		resolveUnsaved: (row.resolve_unsaved as "discard" | null) ?? null,
		impact: row.impact as string,
		statementDeliveryKey: row.statement_delivery_key as string,
		issuedAt: row.issued_at as string,
		expiresAt: row.expires_at as string,
		usedAt: (row.used_at as string | null) ?? null,
		supersededAt: (row.superseded_at as string | null) ?? null,
	};
}

/** Issues a confirmation; an open one for the same toolchain, request and target is superseded. */
export function insertConfirmation(
	db: Database,
	row: Omit<ConfirmationRow, "ref" | "usedAt" | "supersededAt">,
	/** The user's messages the confirmed request comes from: forgetting any of them withdraws it. */
	messageIds: readonly string[],
) {
	db.query(
		"UPDATE dialogue_confirmations SET superseded_at = ? WHERE conversation_id = ? AND toolchain_id = ? AND request = ? AND target IS ? AND used_at IS NULL AND superseded_at IS NULL",
	).run(
		row.issuedAt,
		row.conversationId,
		row.toolchainId,
		row.request,
		row.target,
	);
	db.query(
		"INSERT INTO dialogue_confirmations (id, ref, conversation_id, toolchain_id, toolchain_revision_id, request, inputs_json, target, target_label, resolve_unsaved, impact, statement_delivery_key, issued_at, expires_at, message_ids_json) VALUES (?,(SELECT COALESCE(MAX(ref), 0) + 1 FROM dialogue_confirmations WHERE conversation_id = ?),?,?,?,?,?,?,?,?,?,?,?,?,?)",
	).run(
		row.id,
		row.conversationId,
		row.conversationId,
		row.toolchainId,
		row.toolchainRevisionId,
		row.request,
		row.inputs === null ? null : JSON.stringify(row.inputs),
		row.target,
		row.targetLabel,
		row.resolveUnsaved,
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

/** The confirmation the model names `c<ref>` in a conversation. */
export function confirmationByRef(
	db: Database,
	conversationId: string,
	ref: number,
): ConfirmationRow | null {
	const row = db
		.query(
			"SELECT * FROM dialogue_confirmations WHERE conversation_id = ? AND ref = ?",
		)
		.get(conversationId, ref) as Record<string, unknown> | null;
	return row ? mapConfirmation(row) : null;
}

/** Every confirmation's number in a conversation (id to `ref`). */
export function confirmationRefs(
	db: Database,
	conversationId: string,
): Map<string, number> {
	const rows = db
		.query(
			"SELECT id, ref FROM dialogue_confirmations WHERE conversation_id = ?",
		)
		.all(conversationId) as Array<{ id: string; ref: number }>;
	return new Map(rows.map((row) => [row.id, row.ref]));
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

/** A confirmation the user declined: closed, as a newer one for the same request would close it. */
export function withdrawConfirmation(
	db: Database,
	conversationId: string,
	ref: number,
	at: string,
): boolean {
	return (
		db
			.query(
				"UPDATE dialogue_confirmations SET superseded_at = ? WHERE conversation_id = ? AND ref = ? AND used_at IS NULL AND superseded_at IS NULL",
			)
			.run(at, conversationId, ref).changes === 1
	);
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
