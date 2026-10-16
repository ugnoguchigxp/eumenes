import type { Database } from "bun:sqlite";
import type { SpecialistEndReason, SpecialistState } from "../contracts";

/**
 * Specialist sessions (spec toolchain-specialist-dialogue §4.3): one non-ended session per conversation,
 * its command receipts, and the run columns that tie a turn to its session.
 */
export const specialistMigration = `
CREATE TABLE dialogue_specialist_sessions (
 id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
 toolchain_id TEXT NOT NULL, toolchain_revision_id TEXT NOT NULL, title TEXT NOT NULL,
 binding_revision_id TEXT NOT NULL, package_revision_id TEXT NOT NULL, artifact_revision_id TEXT NOT NULL,
 adapter_ref TEXT NOT NULL, work_ref TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('active','suspended','closing','ended')),
 end_reason TEXT CHECK(end_reason IS NULL OR end_reason IN ('closed','discarded','returned','expired','restarted','revoked')),
 closing_reason TEXT,
 close_failures INTEGER NOT NULL DEFAULT 0,
 revision INTEGER NOT NULL, epoch INTEGER NOT NULL, active_run_id TEXT,
 pending_switch_json TEXT,
 label TEXT NOT NULL DEFAULT '',
 reported INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX dialogue_specialist_live ON dialogue_specialist_sessions(conversation_id) WHERE state <> 'ended';
CREATE INDEX dialogue_specialist_sweep ON dialogue_specialist_sessions(state, expires_at);
CREATE TABLE dialogue_specialist_receipts (
 request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, kind TEXT NOT NULL,
 expected_revision INTEGER NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
ALTER TABLE dialogue_runs ADD COLUMN specialist_session_id TEXT;
ALTER TABLE dialogue_runs ADD COLUMN viewing_json TEXT;
CREATE INDEX dialogue_runs_specialist ON dialogue_runs(specialist_session_id, seq) WHERE specialist_session_id IS NOT NULL;
`;

/** A session row as dialogue stores it (the public `SpecialistSession` adds the domain's work state). */
export type SessionRecord = {
	id: string;
	conversationId: string;
	toolchainId: string;
	toolchainRevisionId: string;
	title: string;
	bindingRevisionId: string;
	packageRevisionId: string;
	artifactRevisionId: string;
	adapterRef: string;
	workRef: string;
	state: SpecialistState;
	endReason: SpecialistEndReason | null;
	/** The reason the session ends with once its work was ended (set while `closing`). */
	closingReason: SpecialistEndReason | null;
	closeFailures: number;
	revision: number;
	epoch: number;
	activeRunId: string | null;
	pendingSwitch: {
		toolchainId: string;
		targetRef: string | null;
		workRevision: number;
	} | null;
	/** The work's label as of the last time dialogue saw it (kept for the record after the session ends). */
	label: string;
	reported: boolean;
	expiresAt: string;
	createdAt: string;
	updatedAt: string;
};

function map(row: Record<string, unknown>): SessionRecord {
	return {
		id: row.id as string,
		conversationId: row.conversation_id as string,
		toolchainId: row.toolchain_id as string,
		toolchainRevisionId: row.toolchain_revision_id as string,
		title: row.title as string,
		bindingRevisionId: row.binding_revision_id as string,
		packageRevisionId: row.package_revision_id as string,
		artifactRevisionId: row.artifact_revision_id as string,
		adapterRef: row.adapter_ref as string,
		workRef: row.work_ref as string,
		state: row.state as SpecialistState,
		endReason: row.end_reason as SpecialistEndReason | null,
		closingReason: row.closing_reason as SpecialistEndReason | null,
		closeFailures: row.close_failures as number,
		revision: row.revision as number,
		epoch: row.epoch as number,
		activeRunId: row.active_run_id as string | null,
		pendingSwitch: row.pending_switch_json
			? JSON.parse(row.pending_switch_json as string)
			: null,
		label: row.label as string,
		reported: (row.reported as number) === 1,
		expiresAt: row.expires_at as string,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

export function insertSession(db: Database, s: SessionRecord) {
	db.query(
		`INSERT INTO dialogue_specialist_sessions (id,conversation_id,toolchain_id,toolchain_revision_id,title,binding_revision_id,package_revision_id,artifact_revision_id,adapter_ref,work_ref,state,end_reason,closing_reason,close_failures,revision,epoch,active_run_id,pending_switch_json,label,reported,expires_at,created_at,updated_at)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		s.id,
		s.conversationId,
		s.toolchainId,
		s.toolchainRevisionId,
		s.title,
		s.bindingRevisionId,
		s.packageRevisionId,
		s.artifactRevisionId,
		s.adapterRef,
		s.workRef,
		s.state,
		s.endReason,
		s.closingReason,
		s.closeFailures,
		s.revision,
		s.epoch,
		s.activeRunId,
		s.pendingSwitch ? JSON.stringify(s.pendingSwitch) : null,
		s.label,
		s.reported ? 1 : 0,
		s.expiresAt,
		s.createdAt,
		s.updatedAt,
	);
}
export function sessionById(db: Database, id: string): SessionRecord | null {
	const row = db
		.query("SELECT * FROM dialogue_specialist_sessions WHERE id = ?")
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
}
/** The conversation's one session that has not ended (any of active, suspended, closing). */
export function liveSession(
	db: Database,
	conversationId: string,
): SessionRecord | null {
	const row = db
		.query(
			"SELECT * FROM dialogue_specialist_sessions WHERE conversation_id = ? AND state <> 'ended'",
		)
		.get(conversationId);
	return row ? map(row as Record<string, unknown>) : null;
}
/** Sessions the sweep looks at: past their expiry or closing; the caller adds the clean-suspended ones. */
export function sweepCandidates(db: Database, now: string): SessionRecord[] {
	return (
		db
			.query(
				"SELECT * FROM dialogue_specialist_sessions WHERE state = 'closing' OR (state IN ('active','suspended') AND expires_at <= ?) ORDER BY created_at",
			)
			.all(now) as Record<string, unknown>[]
	).map(map);
}
export function suspendedSessions(db: Database): SessionRecord[] {
	return (
		db
			.query(
				"SELECT * FROM dialogue_specialist_sessions WHERE state = 'suspended' ORDER BY created_at",
			)
			.all() as Record<string, unknown>[]
	).map(map);
}
export function unfinishedSessions(db: Database): SessionRecord[] {
	return (
		db
			.query(
				"SELECT * FROM dialogue_specialist_sessions WHERE state <> 'ended' ORDER BY created_at",
			)
			.all() as Record<string, unknown>[]
	).map(map);
}
type Patch = Partial<
	Pick<
		SessionRecord,
		| "state"
		| "endReason"
		| "closingReason"
		| "closeFailures"
		| "epoch"
		| "activeRunId"
		| "pendingSwitch"
		| "label"
		| "expiresAt"
	>
> & {
	/** Advance the revision (a state change the screen must see); the default leaves it. */
	bump?: boolean;
};
const COLUMN = {
	state: "state",
	endReason: "end_reason",
	closingReason: "closing_reason",
	closeFailures: "close_failures",
	epoch: "epoch",
	activeRunId: "active_run_id",
	pendingSwitch: "pending_switch_json",
	label: "label",
	expiresAt: "expires_at",
} as const;
/** Update the named fields of one session; `bump` also advances the revision. */
export function patchSession(
	db: Database,
	id: string,
	patch: Patch,
	now: string,
) {
	const sets: string[] = ["updated_at = ?"];
	const values: Array<string | number | null> = [now];
	for (const key of Object.keys(COLUMN) as Array<keyof typeof COLUMN>) {
		if (!(key in patch)) continue;
		const value = patch[key];
		sets.push(`${COLUMN[key]} = ?`);
		values.push(
			key === "pendingSwitch"
				? value
					? JSON.stringify(value)
					: null
				: ((value ?? null) as string | number | null),
		);
	}
	if (patch.bump) sets.push("revision = revision + 1");
	db.query(
		`UPDATE dialogue_specialist_sessions SET ${sets.join(", ")} WHERE id = ?`,
	).run(...values, id);
}
/** The most recent session that ended and was never reported to the conversation (once). */
export function unreportedEnded(
	db: Database,
	conversationId: string,
): SessionRecord | null {
	const row = db
		.query(
			"SELECT * FROM dialogue_specialist_sessions WHERE conversation_id = ? AND state = 'ended' AND reported = 0 ORDER BY updated_at DESC LIMIT 1",
		)
		.get(conversationId);
	return row ? map(row as Record<string, unknown>) : null;
}
/** Every earlier ended session is reported with the latest one: the record is a single line. */
export function markReported(db: Database, conversationId: string) {
	db.query(
		"UPDATE dialogue_specialist_sessions SET reported = 1 WHERE conversation_id = ? AND state = 'ended' AND reported = 0",
	).run(conversationId);
}

export function receiptById(
	db: Database,
	requestId: string,
): {
	sessionId: string;
	kind: string;
	expectedRevision: number;
	resultJson: string;
} | null {
	const row = db
		.query(
			"SELECT session_id, kind, expected_revision, result_json FROM dialogue_specialist_receipts WHERE request_id = ?",
		)
		.get(requestId) as {
		session_id: string;
		kind: string;
		expected_revision: number;
		result_json: string;
	} | null;
	return row
		? {
				sessionId: row.session_id,
				kind: row.kind,
				expectedRevision: row.expected_revision,
				resultJson: row.result_json,
			}
		: null;
}
export function insertReceipt(
	db: Database,
	receipt: {
		requestId: string;
		sessionId: string;
		kind: string;
		expectedRevision: number;
		resultJson: string;
	},
	now: string,
) {
	db.query(
		"INSERT INTO dialogue_specialist_receipts (request_id, session_id, kind, expected_revision, result_json, created_at) VALUES (?,?,?,?,?,?)",
	).run(
		receipt.requestId,
		receipt.sessionId,
		receipt.kind,
		receipt.expectedRevision,
		receipt.resultJson,
		now,
	);
}

/** Tie a run to a session (its turn), or release it (a forwarded request is an ordinary run again). */
export function setRunSession(
	db: Database,
	runId: string,
	sessionId: string | null,
) {
	db.query(
		"UPDATE dialogue_runs SET specialist_session_id = ? WHERE id = ?",
	).run(sessionId, runId);
}
export function setRunViewing(db: Database, runId: string, viewing: unknown) {
	db.query("UPDATE dialogue_runs SET viewing_json = ? WHERE id = ?").run(
		JSON.stringify(viewing),
		runId,
	);
}
export function runViewing(db: Database, runId: string): unknown {
	const row = db
		.query("SELECT viewing_json FROM dialogue_runs WHERE id = ?")
		.get(runId) as { viewing_json: string | null } | null;
	return row?.viewing_json ? JSON.parse(row.viewing_json) : null;
}
/** The newest `limit` runs of a session accepted before `run` (oldest first): the specialist's own history. */
export function sessionRunsBefore(
	db: Database,
	sessionId: string,
	runId: string,
	limit: number,
): Array<{
	id: string;
	status: string;
	inputMessageId: string;
	answerMessageId: string | null;
}> {
	return (
		db
			.query(
				`SELECT id, status, input_message_id, answer_message_id FROM dialogue_runs
				 WHERE specialist_session_id = ? AND seq < (SELECT seq FROM dialogue_runs WHERE id = ?)
				 ORDER BY seq DESC LIMIT ?`,
			)
			.all(sessionId, runId, limit) as Array<{
			id: string;
			status: string;
			input_message_id: string;
			answer_message_id: string | null;
		}>
	)
		.map((row) => ({
			id: row.id,
			status: row.status,
			inputMessageId: row.input_message_id,
			answerMessageId: row.answer_message_id,
		}))
		.reverse();
}

/** The session's runs that have not ended (queued or running), oldest first: the chain of turns it holds. */
export function unfinishedSessionRuns(
	db: Database,
	sessionId: string,
): Array<{ id: string; status: string; jobId: string | null }> {
	return (
		db
			.query(
				"SELECT id, status, job_id FROM dialogue_runs WHERE specialist_session_id = ? AND status IN ('queued','running') ORDER BY seq",
			)
			.all(sessionId) as Array<{
			id: string;
			status: string;
			job_id: string | null;
		}>
	).map((row) => ({ id: row.id, status: row.status, jobId: row.job_id }));
}
