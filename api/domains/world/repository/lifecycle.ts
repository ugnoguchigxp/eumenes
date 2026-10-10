import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * Host-owned lifecycle state (P3-05). Append-only migration, never edited.
 * World's own tables are never touched here.
 *
 * - `world_host_forget_intake`: one row per accepted forget. The state only
 *   moves forward: pending (accepted, durable) -> journaled (World journal
 *   entry fsynced) -> world_applied (World forget complete and verified, in
 *   the same transaction as this mark) -> memory_confirmed (every Memory
 *   external deletion confirmed) -> complete (World reopened the Scope).
 *   Ids only: roots are opaque ids, never content.
 * - `world_host_forget_confirmation`: one row per Memory external (providerRef
 *   is always eumenes-world) of a Memory forget. Only `confirmed` counts.
 * - `world_host_dependent`: what the host registered in Memory for each World
 *   version (externalId and its dependencies, with the World source key). A
 *   restore re-registers exactly these; ids only.
 * - `world_host_restore`: the restore that is running (or the last one).
 */
export const lifecycleMigration = `
CREATE TABLE world_host_forget_intake (
	forget_id TEXT PRIMARY KEY CHECK (length(forget_id) BETWEEN 1 AND 200),
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	memory_forget_id TEXT CHECK (memory_forget_id IS NULL OR length(memory_forget_id) BETWEEN 1 AND 200),
	memory_final INTEGER NOT NULL DEFAULT 1 CHECK (memory_final IN (0, 1)),
	reason_code TEXT NOT NULL CHECK (reason_code IN ('FORGET_REQUESTED', 'SOURCE_FORGOTTEN', 'CORRECTION_APPLIED', 'AUTHORIZATION_REVOKED')),
	origin TEXT NOT NULL CHECK (origin IN ('request', 'memory_feed', 'source_feed', 'restored')),
	roots_json TEXT NOT NULL,
	roots_digest TEXT NOT NULL CHECK (length(roots_digest) = 64),
	state TEXT NOT NULL CHECK (state IN ('pending', 'journaled', 'world_applied', 'memory_confirmed', 'complete')),
	journal_seq INTEGER,
	journal_hash TEXT,
	world_part INTEGER NOT NULL DEFAULT 0 CHECK (world_part >= 0),
	world_chunks INTEGER NOT NULL DEFAULT 0 CHECK (world_chunks >= 0),
	blocked_reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	CHECK ((journal_seq IS NULL) = (journal_hash IS NULL))
);
CREATE INDEX world_host_forget_intake_open ON world_host_forget_intake (state) WHERE state <> 'complete';
CREATE INDEX world_host_forget_intake_memory ON world_host_forget_intake (memory_forget_id) WHERE memory_forget_id IS NOT NULL;
CREATE TABLE world_host_forget_confirmation (
	memory_forget_id TEXT NOT NULL CHECK (length(memory_forget_id) BETWEEN 1 AND 200),
	external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
	state TEXT NOT NULL CHECK (state IN ('pending', 'confirmed', 'unverified', 'failed')),
	updated_at INTEGER NOT NULL,
	PRIMARY KEY (memory_forget_id, external_id)
) WITHOUT ROWID;
CREATE TABLE world_host_dependent (
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	external_id TEXT NOT NULL CHECK (length(external_id) BETWEEN 1 AND 256),
	depends_json TEXT NOT NULL,
	PRIMARY KEY (principal, scope_key, external_id)
) WITHOUT ROWID;
CREATE TABLE world_host_restore (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	restore_epoch TEXT NOT NULL CHECK (length(restore_epoch) BETWEEN 1 AND 200),
	state TEXT NOT NULL CHECK (state IN ('in_progress', 'complete')),
	reason TEXT,
	updated_at INTEGER NOT NULL
);
`;

export const FORGET_STATES = [
	"pending",
	"journaled",
	"world_applied",
	"memory_confirmed",
	"complete",
] as const;
export type ForgetState = (typeof FORGET_STATES)[number];
export const TOMBSTONE_REASONS = [
	"FORGET_REQUESTED",
	"SOURCE_FORGOTTEN",
	"CORRECTION_APPLIED",
	"AUTHORIZATION_REVOKED",
] as const;
export type TombstoneReasonCode = (typeof TOMBSTONE_REASONS)[number];
export type ForgetOrigin =
	| "request"
	| "memory_feed"
	| "source_feed"
	| "restored";
export const ROOT_KINDS = [
	"source",
	"state",
	"entity",
	"assertion",
	"manifest",
	"prediction",
	"outcome",
	"candidate",
	"projection",
	"slice",
] as const;
export type RootKind = (typeof ROOT_KINDS)[number];
export type ForgetRoot = {
	kind: RootKind;
	id: string;
	revision: number;
};

export type IntakeRow = {
	forgetId: string;
	principal: string;
	scopeKey: string;
	memoryForgetId: string | null;
	memoryFinal: boolean;
	reasonCode: TombstoneReasonCode;
	origin: ForgetOrigin;
	roots: ForgetRoot[];
	rootsDigest: string;
	state: ForgetState;
	journalSeq: number | null;
	journalHash: string | null;
	/** Roots go to World in parts of at most 500; the current part and the ops applied in it. */
	worldPart: number;
	worldChunks: number;
	blockedReason: string | null;
	createdAt: number;
	updatedAt: number;
};

type RawIntake = {
	forget_id: string;
	principal: string;
	scope_key: string;
	memory_forget_id: string | null;
	memory_final: number;
	reason_code: TombstoneReasonCode;
	origin: ForgetOrigin;
	roots_json: string;
	roots_digest: string;
	state: ForgetState;
	journal_seq: number | null;
	journal_hash: string | null;
	world_part: number;
	world_chunks: number;
	blocked_reason: string | null;
	created_at: number;
	updated_at: number;
};

const toIntake = (row: RawIntake): IntakeRow => ({
	forgetId: row.forget_id,
	principal: row.principal,
	scopeKey: row.scope_key,
	memoryForgetId: row.memory_forget_id,
	memoryFinal: row.memory_final === 1,
	reasonCode: row.reason_code,
	origin: row.origin,
	roots: JSON.parse(row.roots_json) as ForgetRoot[],
	rootsDigest: row.roots_digest,
	state: row.state,
	journalSeq: row.journal_seq,
	journalHash: row.journal_hash,
	worldPart: row.world_part,
	worldChunks: row.world_chunks,
	blockedReason: row.blocked_reason,
	createdAt: row.created_at,
	updatedAt: row.updated_at,
});

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

export type NewIntake = {
	forgetId: string;
	principal: string;
	scopeKey: string;
	memoryForgetId: string | null;
	memoryFinal: boolean;
	reasonCode: TombstoneReasonCode;
	origin: ForgetOrigin;
	roots: readonly ForgetRoot[];
	rootsDigest: string;
	state?: ForgetState;
	journalSeq?: number;
	journalHash?: string;
};

/** Insert only: an existing id is the caller's idempotency check. */
export function insertIntake(db: Database, input: NewIntake, now: number) {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_forget_intake
		(forget_id, principal, scope_key, memory_forget_id, memory_final, reason_code, origin, roots_json, roots_digest, state, journal_seq, journal_hash, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.forgetId,
		input.principal,
		input.scopeKey,
		input.memoryForgetId,
		input.memoryFinal ? 1 : 0,
		input.reasonCode,
		input.origin,
		JSON.stringify(input.roots),
		input.rootsDigest,
		input.state ?? "pending",
		input.journalSeq ?? null,
		input.journalHash ?? null,
		now,
		now,
	);
}

export function getIntake(db: Database, forgetId: string): IntakeRow | null {
	const row = db
		.query("SELECT * FROM world_host_forget_intake WHERE forget_id = ?")
		.get(forgetId) as RawIntake | null | undefined;
	return row ? toIntake(row) : null;
}

/** Every intake that is not complete, oldest first. */
export function listOpenIntakes(db: Database): IntakeRow[] {
	return (
		db
			.query(
				"SELECT * FROM world_host_forget_intake WHERE state <> 'complete' ORDER BY rowid",
			)
			.all() as RawIntake[]
	).map(toIntake);
}

/** Forgets of ONE Scope, newest first (any state): what the owner may be shown. */
export function listIntakesOfScope(
	db: Database,
	principal: string,
	scopeKey: string,
	limit: number,
): IntakeRow[] {
	return (
		db
			.query(
				"SELECT * FROM world_host_forget_intake WHERE principal = ? AND scope_key = ? ORDER BY rowid DESC LIMIT ?",
			)
			.all(principal, scopeKey, limit) as RawIntake[]
	).map(toIntake);
}

/** Intakes that name a Memory forget (any state), oldest first. */
export function listMemoryLinkedIntakes(db: Database): IntakeRow[] {
	return (
		db
			.query(
				"SELECT * FROM world_host_forget_intake WHERE memory_forget_id IS NOT NULL ORDER BY rowid",
			)
			.all() as RawIntake[]
	).map(toIntake);
}

export function listIntakesOfMemoryForget(
	db: Database,
	memoryForgetId: string,
): IntakeRow[] {
	return (
		db
			.query(
				"SELECT * FROM world_host_forget_intake WHERE memory_forget_id = ? ORDER BY rowid",
			)
			.all(memoryForgetId) as RawIntake[]
	).map(toIntake);
}

export function allIntakeIds(db: Database): Set<string> {
	return new Set(
		(
			db.query("SELECT forget_id FROM world_host_forget_intake").all() as {
				forget_id: string;
			}[]
		).map((row) => row.forget_id),
	);
}

export function intakesWithJournal(db: Database): IntakeRow[] {
	return (
		db
			.query(
				"SELECT * FROM world_host_forget_intake WHERE journal_seq IS NOT NULL ORDER BY journal_seq",
			)
			.all() as RawIntake[]
	).map(toIntake);
}

const ORDER: Record<ForgetState, number> = {
	pending: 0,
	journaled: 1,
	world_applied: 2,
	memory_confirmed: 3,
	complete: 4,
};
export const stateAtLeast = (state: ForgetState, floor: ForgetState) =>
	ORDER[state] >= ORDER[floor];

/** Forward-only transition. false: the row was not in `from` (someone else moved it). */
export function advanceIntake(
	db: Database,
	forgetId: string,
	from: ForgetState,
	to: ForgetState,
	now: number,
	extra: { journalSeq?: number; journalHash?: string } = {},
): boolean {
	requireTransaction(db);
	if (ORDER[to] <= ORDER[from]) throw new RangeError("intake_state_backwards");
	const result = db
		.query(
			`UPDATE world_host_forget_intake SET state = ?, blocked_reason = NULL, updated_at = ?,
			journal_seq = COALESCE(?, journal_seq), journal_hash = COALESCE(?, journal_hash)
			WHERE forget_id = ? AND state = ?`,
		)
		.run(
			to,
			now,
			extra.journalSeq ?? null,
			extra.journalHash ?? null,
			forgetId,
			from,
		);
	return result.changes === 1;
}

/**
 * complete -> world_applied again: Memory's receipt no longer backs the
 * completion (a restore brought back pending external deletions, or the check
 * could not be made). The only backwards move; World content stays deleted.
 */
export function reopenIntakeForMemory(
	db: Database,
	forgetId: string,
	reason: string,
	now: number,
): boolean {
	requireTransaction(db);
	return (
		db
			.query(
				`UPDATE world_host_forget_intake SET state = 'world_applied', blocked_reason = ?, updated_at = ?
				WHERE forget_id = ? AND state IN ('complete', 'memory_confirmed')`,
			)
			.run(reason, now, forgetId).changes === 1
	);
}

export function setWorldProgress(
	db: Database,
	forgetId: string,
	part: number,
	chunks: number,
	now: number,
): void {
	requireTransaction(db);
	db.query(
		"UPDATE world_host_forget_intake SET world_part = ?, world_chunks = ?, updated_at = ? WHERE forget_id = ?",
	).run(part, chunks, now, forgetId);
}

export function setBlockedReason(
	db: Database,
	forgetId: string,
	reason: string | null,
	now: number,
): void {
	requireTransaction(db);
	db.query(
		"UPDATE world_host_forget_intake SET blocked_reason = ?, updated_at = ? WHERE forget_id = ?",
	).run(reason, now, forgetId);
}

// --- confirmations ------------------------------------------------------------

export type ConfirmationState =
	| "pending"
	| "confirmed"
	| "unverified"
	| "failed";
export type ConfirmationRow = {
	memoryForgetId: string;
	externalId: string;
	state: ConfirmationState;
};

export function listConfirmations(
	db: Database,
	memoryForgetId: string,
): ConfirmationRow[] {
	return (
		db
			.query(
				"SELECT memory_forget_id, external_id, state FROM world_host_forget_confirmation WHERE memory_forget_id = ? ORDER BY external_id",
			)
			.all(memoryForgetId) as {
			memory_forget_id: string;
			external_id: string;
			state: ConfirmationState;
		}[]
	).map((row) => ({
		memoryForgetId: row.memory_forget_id,
		externalId: row.external_id,
		state: row.state,
	}));
}

/** Records Memory's own view; a row Memory no longer shows as confirmed goes back to pending. */
export function upsertConfirmation(
	db: Database,
	memoryForgetId: string,
	externalId: string,
	state: ConfirmationState,
	now: number,
): void {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_forget_confirmation (memory_forget_id, external_id, state, updated_at) VALUES (?, ?, ?, ?)
		ON CONFLICT (memory_forget_id, external_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
	).run(memoryForgetId, externalId, state, now);
}

export function countUnconfirmed(db: Database, memoryForgetId: string): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM world_host_forget_confirmation WHERE memory_forget_id = ? AND state <> 'confirmed'",
			)
			.get(memoryForgetId) as { n: number }
	).n;
}

// --- dependents ----------------------------------------------------------------

export type DependentDependency = {
	/** Memory dependency type and id. */
	type: "source" | "state_item";
	id: string;
	/** The World source key of the same input (what restore.register is keyed by). */
	key: string;
};
export type DependentRow = {
	externalId: string;
	dependsOn: DependentDependency[];
};

export function upsertDependent(
	db: Database,
	principal: string,
	scopeKey: string,
	externalId: string,
	dependsOn: readonly DependentDependency[],
): void {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_dependent (principal, scope_key, external_id, depends_json) VALUES (?, ?, ?, ?)
		ON CONFLICT (principal, scope_key, external_id) DO UPDATE SET depends_json = excluded.depends_json, release_pending = 0`,
	).run(principal, scopeKey, externalId, JSON.stringify(dependsOn));
}

export type DependentRecord = {
	dependsOn: DependentDependency[];
	releasePending: boolean;
};

/** The host's record of one registered dependent, or null when the row is gone. */
export function getDependent(
	db: Database,
	principal: string,
	scopeKey: string,
	externalId: string,
): DependentRecord | null {
	const row = db
		.query(
			`SELECT depends_json, release_pending FROM world_host_dependent
			WHERE principal = ? AND scope_key = ? AND external_id = ?`,
		)
		.get(principal, scopeKey, externalId) as {
		depends_json: string;
		release_pending: number;
	} | null;
	return row
		? {
				dependsOn: JSON.parse(row.depends_json) as DependentDependency[],
				releasePending: row.release_pending === 1,
			}
		: null;
}

export function listDependents(
	db: Database,
	principal: string,
	scopeKey: string,
	afterExternalId: string | null,
	limit: number,
): DependentRow[] {
	return (
		db
			.query(
				`SELECT external_id, depends_json FROM world_host_dependent
				WHERE principal = ? AND scope_key = ? AND external_id > ?
				ORDER BY external_id LIMIT ?`,
			)
			.all(principal, scopeKey, afterExternalId ?? "", limit) as {
			external_id: string;
			depends_json: string;
		}[]
	).map((row) => ({
		externalId: row.external_id,
		dependsOn: JSON.parse(row.depends_json) as DependentDependency[],
	}));
}

// --- restore -------------------------------------------------------------------

export type RestoreRow = {
	restoreEpoch: string;
	state: "in_progress" | "complete";
	reason: string | null;
};

export function readRestore(db: Database): RestoreRow | null {
	const row = db
		.query(
			"SELECT restore_epoch, state, reason FROM world_host_restore WHERE id = 1",
		)
		.get() as
		| {
				restore_epoch: string;
				state: "in_progress" | "complete";
				reason: string | null;
		  }
		| null
		| undefined;
	return row
		? {
				restoreEpoch: row.restore_epoch,
				state: row.state,
				reason: row.reason,
			}
		: null;
}

export function writeRestore(
	db: Database,
	restoreEpoch: string,
	state: "in_progress" | "complete",
	reason: string | null,
	now: number,
): void {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_restore (id, restore_epoch, state, reason, updated_at) VALUES (1, ?, ?, ?, ?)
		ON CONFLICT (id) DO UPDATE SET restore_epoch = excluded.restore_epoch, state = excluded.state,
		reason = excluded.reason, updated_at = excluded.updated_at`,
	).run(restoreEpoch, state, reason, now);
}

/** Every stored feed cursor goes: a restore (or Memory resync) invalidates all positions. */
export function dropFeedCursors(db: Database): void {
	requireTransaction(db);
	db.query("DELETE FROM world_host_feed_cursor").run();
}

/** Scopes the host knows World may hold data for. */
export function listKnownScopes(
	db: Database,
): { principal: string; scopeKey: string }[] {
	const rows = db
		.query(
			`SELECT principal, scope_key FROM world_host_dependent
			UNION SELECT principal, scope_key FROM world_host_forget_intake
			UNION SELECT principal, scope_key FROM world_host_feed_cursor
			UNION SELECT principal, scope_key FROM world_host_forget_epoch
			ORDER BY 1, 2`,
		)
		.all() as { principal: string; scope_key: string }[];
	return rows.map((row) => ({
		principal: row.principal,
		scopeKey: row.scope_key,
	}));
}
