import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type {
	DecisionDto,
	InboxState,
	RequestKind,
	StepId,
	UnitKind,
	UnitSlot,
	UnitState,
} from "../contracts";
import { dropEpisodeMigration } from "./drop-episode";
import { activityIndexesMigration } from "./activity-indexes";
import { dropRecallMigration } from "./drop-recall";
import { continuityEventsMigration } from "./events";
import { worldGoalsMigration } from "./world-goals";

export * from "./activity";
export * from "./events";
export * from "./world-goals";

/**
 * The steward's tables (`steward/0001-init`): execution units, the inference requests they hold, the upkeep
 * control per conversation, the request inbox and the decision records with their reference index.
 */
const migration = `
CREATE TABLE steward_unit (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('exchange_step','requests','maintenance')),
 step TEXT NOT NULL, slot TEXT NOT NULL CHECK(slot IN ('reflect','maintenance','recall')),
 targets TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, forget_seq INTEGER, summary_revision INTEGER,
 state TEXT NOT NULL CHECK(state IN ('open','applied','stale','failed')),
 job_id TEXT, created_at TEXT NOT NULL, closed_at TEXT
);
CREATE UNIQUE INDEX steward_unit_open ON steward_unit(conversation_id, slot) WHERE state = 'open';
CREATE INDEX steward_unit_conversation ON steward_unit(conversation_id, state);
CREATE TABLE steward_request (
 job_id TEXT NOT NULL, step TEXT NOT NULL, request_id TEXT NOT NULL, PRIMARY KEY (job_id, step)
);
CREATE TABLE steward_state (
 conversation_id TEXT PRIMARY KEY, maintenance_revision INTEGER NOT NULL DEFAULT 0,
 maintained_revision INTEGER NOT NULL DEFAULT 0, quiet_steps TEXT NOT NULL DEFAULT '{}',
 next_maintenance_at INTEGER, defer_count INTEGER NOT NULL DEFAULT 0, recall_pending TEXT
);
CREATE TABLE steward_inbox (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, run_id TEXT NOT NULL, message_id TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('forget','remember','correct')), what TEXT NOT NULL, detail TEXT,
 state TEXT NOT NULL CHECK(state IN ('staged','pending','done','none','discarded')),
 result_code TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, resolved_at TEXT
);
CREATE INDEX steward_inbox_conversation ON steward_inbox(conversation_id, state, created_at);
CREATE INDEX steward_inbox_run ON steward_inbox(run_id, state);
CREATE INDEX steward_inbox_message ON steward_inbox(message_id);
CREATE TABLE steward_decision (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id TEXT NOT NULL, job_id TEXT NOT NULL, step TEXT NOT NULL,
 created_at TEXT NOT NULL, output TEXT, results TEXT, window_version_before INTEGER, window_version_after INTEGER,
 duration_ms INTEGER, output_tokens INTEGER, error_code TEXT
);
CREATE INDEX steward_decision_conversation ON steward_decision(conversation_id, id);
CREATE TABLE steward_decision_ref (
 decision_id INTEGER NOT NULL, ref_type TEXT NOT NULL CHECK(ref_type IN ('item','message','request')),
 ref_id TEXT NOT NULL, PRIMARY KEY (decision_id, ref_type, ref_id)
);
CREATE INDEX steward_decision_ref_target ON steward_decision_ref(ref_type, ref_id);
`;

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{
		id: "steward/0001-init",
		sql: migration,
		after: ["conversation/0001-init"],
	},
	{
		id: "steward/0002-world-goals",
		sql: worldGoalsMigration,
		after: ["steward/0001-init"],
	},
	{
		id: "steward/0003-continuity-events",
		sql: continuityEventsMigration,
		after: ["steward/0002-world-goals"],
	},
	{
		id: "steward/0004-drop-recall",
		sql: dropRecallMigration,
		after: ["steward/0003-continuity-events"],
	},
	{
		id: "steward/0005-drop-episode",
		sql: dropEpisodeMigration,
		after: ["steward/0004-drop-recall"],
	},
	activityIndexesMigration,
];

const CHUNK = 200;
function chunks<T>(values: readonly T[]): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < values.length; i += CHUNK)
		out.push(values.slice(i, i + CHUNK));
	return out;
}
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");

// ---- units ----

export type UnitTargets = {
	/** The `seq` of the continuity events the step reads (the ones it settles). */
	seqs?: number[];
	/** Inbox ids of the requests a curate step settles. */
	requests?: string[];
	/** The maintenance revision an upkeep unit was made for. */
	revision?: number;
	/** An upkeep unit made for the pending limit: it does not wait for the foreground. */
	urgent?: boolean;
	/** The World events a `world_events` unit curates (the events of one run's messages, at most two). */
	events?: string[];
};
export interface UnitRow {
	id: string;
	conversationId: string;
	kind: UnitKind;
	step: StepId;
	slot: UnitSlot;
	targets: UnitTargets;
	attempt: number;
	forgetSeq: number | null;
	state: UnitState;
	jobId: string | null;
	createdAt: string;
	closedAt: string | null;
}
const unitColumns = `id, conversation_id AS conversationId, kind, step, slot, targets, attempt, forget_seq AS forgetSeq,
 state, job_id AS jobId, created_at AS createdAt, closed_at AS closedAt`;
function mapUnit(row: Record<string, unknown>): UnitRow {
	return {
		...(row as unknown as Omit<UnitRow, "targets">),
		targets: JSON.parse(row.targets as string) as UnitTargets,
	};
}
export function insertUnit(
	db: Database,
	row: Pick<
		UnitRow,
		| "id"
		| "conversationId"
		| "kind"
		| "step"
		| "slot"
		| "targets"
		| "attempt"
		| "createdAt"
	>,
) {
	db.query(
		`INSERT INTO steward_unit (id, conversation_id, kind, step, slot, targets, attempt, state, created_at)
		 VALUES (?,?,?,?,?,?,?, 'open', ?)`,
	).run(
		row.id,
		row.conversationId,
		row.kind,
		row.step,
		row.slot,
		JSON.stringify(row.targets),
		row.attempt,
		row.createdAt,
	);
}
export function readUnit(db: Database, id: string): UnitRow | null {
	const row = db
		.query(`SELECT ${unitColumns} FROM steward_unit WHERE id = ?`)
		.get(id) as Record<string, unknown> | null;
	return row ? mapUnit(row) : null;
}
export function openUnitOf(
	db: Database,
	conversationId: string,
	slot: UnitSlot,
): UnitRow | null {
	const row = db
		.query(
			`SELECT ${unitColumns} FROM steward_unit WHERE conversation_id = ? AND slot = ? AND state = 'open'`,
		)
		.get(conversationId, slot) as Record<string, unknown> | null;
	return row ? mapUnit(row) : null;
}
export function setUnitJob(db: Database, id: string, jobId: string) {
	db.query("UPDATE steward_unit SET job_id = ? WHERE id = ?").run(jobId, id);
}
/** What prepare fixes of the unit: the fences it must re-check at settle, and the targets that really fit. */
export function setUnitPrepared(
	db: Database,
	id: string,
	input: {
		forgetSeq: number;
		targets: UnitTargets;
	},
) {
	db.query(
		"UPDATE steward_unit SET forget_seq = ?, targets = ? WHERE id = ? AND state = 'open'",
	).run(input.forgetSeq, JSON.stringify(input.targets), id);
}
/** Closes an open unit; false when it was not open (settled already). */
export function closeUnit(
	db: Database,
	id: string,
	state: Exclude<UnitState, "open">,
	now: string,
): boolean {
	return (
		db
			.query(
				"UPDATE steward_unit SET state = ?, closed_at = ? WHERE id = ? AND state = 'open'",
			)
			.run(state, now, id).changes === 1
	);
}
/** Keeps the newest `keep` closed units of a conversation (the open ones always stay). */
export function pruneUnits(db: Database, conversationId: string, keep: number) {
	db.query(
		`DELETE FROM steward_unit WHERE conversation_id = ? AND state <> 'open' AND rowid NOT IN
		 (SELECT rowid FROM steward_unit WHERE conversation_id = ? AND state <> 'open' ORDER BY rowid DESC LIMIT ?)`,
	).run(conversationId, conversationId, keep);
}
/** Units of an upkeep step over one revision that ended in failure (the step is given up at the limit). */
export function failedMaintenanceUnits(
	db: Database,
	conversationId: string,
	step: StepId,
	revision: number,
): number {
	return (
		db
			.query(
				`SELECT COUNT(*) AS n FROM steward_unit WHERE conversation_id = ? AND step = ? AND state = 'failed'
				 AND json_extract(targets, '$.revision') = ?`,
			)
			.get(conversationId, step, revision) as { n: number }
	).n;
}
/** Every conversation the steward has ever worked for (the startup kick starts from them). */
export function conversationsWithWork(db: Database): string[] {
	return (
		db
			.query(
				`SELECT conversation_id AS id FROM steward_unit UNION SELECT conversation_id FROM steward_state
				 UNION SELECT conversation_id FROM steward_inbox`,
			)
			.all() as Array<{ id: string }>
	).map((row) => row.id);
}

// ---- inference requests held by a job ----

export function putRequest(
	db: Database,
	jobId: string,
	step: StepId,
	requestId: string,
) {
	db.query(
		"INSERT OR REPLACE INTO steward_request (job_id, step, request_id) VALUES (?,?,?)",
	).run(jobId, step, requestId);
}
/** Removes and returns the requests a job holds (they are released together). */
export function takeRequests(db: Database, jobId: string): string[] {
	const rows = db
		.query("SELECT request_id AS id FROM steward_request WHERE job_id = ?")
		.all(jobId) as Array<{ id: string }>;
	db.query("DELETE FROM steward_request WHERE job_id = ?").run(jobId);
	return rows.map((row) => row.id);
}

// ---- upkeep control ----

type QuietSteps = {
	/** Upkeep steps that found nothing to change: step -> the revision they were quiet at. */
	quiet?: Record<string, number>;
	/** The round being run: its revision and the steps already started in it. */
	round?: { revision: number; count: number };
	/** The number of pending additions a pending-limit consolidation was last made for. */
	pending?: number;
};
export interface StateRow {
	conversationId: string;
	maintenanceRevision: number;
	maintainedRevision: number;
	quiet: QuietSteps;
	nextMaintenanceAt: number | null;
	deferCount: number;
}
export function readState(db: Database, conversationId: string): StateRow {
	const row = db
		.query(
			`SELECT maintenance_revision AS maintenanceRevision, maintained_revision AS maintainedRevision,
			 quiet_steps AS quiet, next_maintenance_at AS nextMaintenanceAt, defer_count AS deferCount
			 FROM steward_state WHERE conversation_id = ?`,
		)
		.get(conversationId) as
		| (Omit<StateRow, "conversationId" | "quiet"> & { quiet: string })
		| null;
	return row
		? {
				conversationId,
				...row,
				quiet: JSON.parse(row.quiet) as QuietSteps,
			}
		: {
				conversationId,
				maintenanceRevision: 0,
				maintainedRevision: 0,
				quiet: {},
				nextMaintenanceAt: null,
				deferCount: 0,
			};
}
export function writeState(db: Database, state: StateRow) {
	db.query(
		`INSERT INTO steward_state (conversation_id, maintenance_revision, maintained_revision, quiet_steps,
		 next_maintenance_at, defer_count) VALUES (?,?,?,?,?,?)
		 ON CONFLICT(conversation_id) DO UPDATE SET maintenance_revision = excluded.maintenance_revision,
		 maintained_revision = excluded.maintained_revision, quiet_steps = excluded.quiet_steps,
		 next_maintenance_at = excluded.next_maintenance_at, defer_count = excluded.defer_count`,
	).run(
		state.conversationId,
		state.maintenanceRevision,
		state.maintainedRevision,
		JSON.stringify(state.quiet),
		state.nextMaintenanceAt,
		state.deferCount,
	);
}

// ---- inbox ----

export interface InboxRow {
	id: string;
	conversationId: string;
	/** The user's message the request was made in (the conversation message, not an event). */
	sourceRef: string;
	kind: RequestKind;
	what: string;
	detail: string | null;
	state: InboxState;
	resultCode: string | null;
	failures: number;
	createdAt: string;
	resolvedAt: string | null;
}
const inboxColumns = `id, conversation_id AS conversationId, source_ref AS sourceRef, kind, what, detail,
 state, result_code AS resultCode, failures, created_at AS createdAt, resolved_at AS resolvedAt`;
/** A request waits as `pending` at once. False when the id was already queued (the first stands). */
export function insertInbox(
	db: Database,
	row: Pick<
		InboxRow,
		| "id"
		| "conversationId"
		| "sourceRef"
		| "kind"
		| "what"
		| "detail"
		| "createdAt"
	>,
): boolean {
	return (
		db
			.query(
				`INSERT OR IGNORE INTO steward_inbox (id, conversation_id, source_ref, kind, what, detail, state, created_at)
				 VALUES (?,?,?,?,?,?, 'pending', ?)`,
			)
			.run(
				row.id,
				row.conversationId,
				row.sourceRef,
				row.kind,
				row.what,
				row.detail,
				row.createdAt,
			).changes === 1
	);
}
export function readInbox(db: Database, id: string): InboxRow | null {
	return (
		(db
			.query(`SELECT ${inboxColumns} FROM steward_inbox WHERE id = ?`)
			.get(id) as InboxRow | null) ?? null
	);
}
export function countOpenInbox(db: Database, conversationId: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM steward_inbox WHERE conversation_id = ? AND state = 'pending'",
			)
			.get(conversationId) as { n: number }
	).n;
}
/** Pending requests, oldest first. `goal` requests belong to the goal reflection, the others to curate-memory. */
export function pendingInbox(
	db: Database,
	conversationId: string,
	limit: number,
	which: "goal" | "memory" = "memory",
): InboxRow[] {
	return db
		.query(
			`SELECT ${inboxColumns} FROM steward_inbox WHERE conversation_id = ? AND state = 'pending'
			 AND kind ${which === "goal" ? "=" : "<>"} 'goal' ORDER BY created_at, id LIMIT ?`,
		)
		.all(conversationId, limit) as InboxRow[];
}
/**
 * Ends a request (done or none): its words are no longer kept (section 6). `afterForget`: the request was
 * resolved in the same transaction as a forget whose purge already ended it as `forgotten` (its own message is among
 * the blocked ones); the resolution the curation reached replaces that ending.
 */
export function resolveInbox(
	db: Database,
	id: string,
	state: Extract<InboxState, "done" | "none">,
	code: string | null,
	now: string,
	afterForget = false,
): boolean {
	return (
		db
			.query(
				`UPDATE steward_inbox SET state = ?, result_code = ?, what = '', detail = NULL, resolved_at = ?
				 WHERE id = ? AND (state = 'pending' OR (? = 1 AND state = 'none' AND result_code = 'forgotten'))`,
			)
			.run(state, code, now, id, afterForget ? 1 : 0).changes === 1
	);
}
export function bumpInboxFailure(db: Database, id: string): number {
	db.query(
		"UPDATE steward_inbox SET failures = failures + 1 WHERE id = ? AND state = 'pending'",
	).run(id);
	return (
		(
			db.query("SELECT failures FROM steward_inbox WHERE id = ?").get(id) as {
				failures: number;
			} | null
		)?.failures ?? 0
	);
}
/** Open requests that stand on forgotten messages: they end as `none`, the words are cleared. */
export function endInboxOfMessages(
	db: Database,
	messageIds: readonly string[],
	code: string,
	now: string,
) {
	for (const part of chunks(messageIds))
		db.query(
			`UPDATE steward_inbox SET state = 'none', result_code = ?, what = '', detail = NULL, resolved_at = ?
			 WHERE state = 'pending' AND source_ref IN (${marks(part.length)})`,
		).run(code, now, ...part);
	for (const part of chunks(messageIds))
		db.query(
			`UPDATE steward_inbox SET what = '', detail = NULL WHERE source_ref IN (${marks(part.length)}) AND what <> ''`,
		).run(...part);
}

// ---- decisions ----

export interface DecisionInput {
	conversationId: string;
	jobId: string;
	step: StepId;
	createdAt: string;
	output: unknown;
	results: unknown;
	windowVersionBefore: number | null;
	windowVersionAfter: number | null;
	durationMs: number | null;
	outputTokens: number | null;
	errorCode: string | null;
}
export function insertDecision(db: Database, input: DecisionInput): number {
	const result = db
		.query(
			`INSERT INTO steward_decision (conversation_id, job_id, step, created_at, output, results, window_version_before,
			 window_version_after, duration_ms, output_tokens, error_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		)
		.run(
			input.conversationId,
			input.jobId,
			input.step,
			input.createdAt,
			input.output === null ? null : JSON.stringify(input.output),
			input.results === null ? null : JSON.stringify(input.results),
			input.windowVersionBefore,
			input.windowVersionAfter,
			input.durationMs,
			input.outputTokens,
			input.errorCode,
		);
	return Number(result.lastInsertRowid);
}
export type DecisionRefType =
	| "item"
	| "message"
	| "request"
	| "claim"
	| "entity"
	| "goal";
export function insertDecisionRefs(
	db: Database,
	decisionId: number,
	refs: ReadonlyArray<{ type: DecisionRefType; id: string }>,
) {
	const insert = db.query(
		"INSERT OR IGNORE INTO steward_decision_ref (decision_id, ref_type, ref_id) VALUES (?,?,?)",
	);
	for (const ref of refs) insert.run(decisionId, ref.type, ref.id);
}
/** Keeps the newest `keep` decisions of a conversation. */
export function pruneDecisions(
	db: Database,
	conversationId: string,
	keep: number,
) {
	const cutoff = db
		.query(
			"SELECT id FROM steward_decision WHERE conversation_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?",
		)
		.get(conversationId, keep - 1) as { id: number } | null;
	if (!cutoff) return;
	db.query(
		`DELETE FROM steward_decision_ref WHERE decision_id IN
		 (SELECT id FROM steward_decision WHERE conversation_id = ? AND id < ?)`,
	).run(conversationId, cutoff.id);
	db.query(
		"DELETE FROM steward_decision WHERE conversation_id = ? AND id < ?",
	).run(conversationId, cutoff.id);
}
/**
 * Deletes every decision that touched one of these items, messages, World claims or entities, or goals (and its
 * index rows).
 */
export function deleteDecisionsByRefs(
	db: Database,
	refs: {
		itemIds?: readonly string[];
		messageIds?: readonly string[];
		claimIds?: readonly string[];
		entityIds?: readonly string[];
		goalIds?: readonly string[];
	},
) {
	const ids = new Set<number>();
	const find = (type: string, values: readonly string[]) => {
		for (const part of chunks(values))
			for (const row of db
				.query(
					`SELECT DISTINCT decision_id AS id FROM steward_decision_ref WHERE ref_type = ? AND ref_id IN (${marks(part.length)})`,
				)
				.all(type, ...part) as Array<{ id: number }>)
				ids.add(row.id);
	};
	find("item", refs.itemIds ?? []);
	find("message", refs.messageIds ?? []);
	find("claim", refs.claimIds ?? []);
	find("entity", refs.entityIds ?? []);
	find("goal", refs.goalIds ?? []);
	for (const part of chunks([...ids])) {
		db.query(
			`DELETE FROM steward_decision_ref WHERE decision_id IN (${marks(part.length)})`,
		).run(...part);
		db.query(
			`DELETE FROM steward_decision WHERE id IN (${marks(part.length)})`,
		).run(...part);
	}
}
const decisionColumns = `id, conversation_id AS conversationId, job_id AS jobId, step, created_at AS createdAt, output, results,
 window_version_before AS windowVersionBefore, window_version_after AS windowVersionAfter, duration_ms AS durationMs,
 output_tokens AS outputTokens, error_code AS errorCode`;
function mapDecision(row: Record<string, unknown>): DecisionDto {
	const parse = (value: unknown) =>
		typeof value === "string" ? (JSON.parse(value) as unknown) : null;
	return {
		...(row as unknown as DecisionDto),
		output: parse(row.output),
		results: parse(row.results),
	};
}
/** Newest first. */
export function listDecisions(
	db: Database,
	conversationId: string,
	limit: number,
): DecisionDto[] {
	return (
		db
			.query(
				`SELECT ${decisionColumns} FROM steward_decision WHERE conversation_id = ? ORDER BY id DESC LIMIT ?`,
			)
			.all(conversationId, limit) as Record<string, unknown>[]
	).map(mapDecision);
}
