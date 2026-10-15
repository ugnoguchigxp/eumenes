import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * Host-owned UsageReceipt table of the retired World slice (P3-07). Append-only migration, never edited.
 * Nothing writes it any more (the conversation no longer receives a World slice); rows from earlier versions
 * remain until a forget in their Scope purges them and unregisters their Memory dependents
 * (`forgetUsageInScope`), so a receipt and its Memory dependents still live and die together.
 */
export const usageMigration = `
CREATE TABLE world_host_usage (
	run_id TEXT PRIMARY KEY CHECK (length(run_id) BETWEEN 1 AND 200),
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	conversation_id TEXT NOT NULL CHECK (length(conversation_id) BETWEEN 1 AND 200),
	job_id TEXT NOT NULL CHECK (length(job_id) BETWEEN 1 AND 200),
	attempt INTEGER NOT NULL CHECK (attempt >= 0),
	generation INTEGER NOT NULL CHECK (generation >= 0),
	slice_digest TEXT NOT NULL CHECK (length(slice_digest) BETWEEN 1 AND 200),
	slice_status TEXT NOT NULL CHECK (slice_status IN ('ready', 'partial')),
	world_scope_epoch INTEGER NOT NULL CHECK (world_scope_epoch >= 0),
	policy_revision TEXT NOT NULL,
	forget_epoch TEXT NOT NULL,
	restore_epoch TEXT NOT NULL,
	interpretation_version TEXT NOT NULL,
	assertion_versions_json TEXT NOT NULL,
	source_versions_json TEXT NOT NULL,
	goal_id TEXT,
	goal_revision INTEGER,
	goal_epoch INTEGER NOT NULL CHECK (goal_epoch >= 0),
	contract_version INTEGER NOT NULL,
	package_version TEXT NOT NULL,
	inference_request_id TEXT,
	inference_attempt_id TEXT,
	dependent_ids_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	CHECK ((goal_id IS NULL) = (goal_revision IS NULL))
) WITHOUT ROWID;
CREATE INDEX world_host_usage_scope ON world_host_usage (principal, scope_key, created_at, run_id);
`;

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

/** Every receipt of one Scope, removed (a forget in the Scope invalidates what they stood on). */
export function purgeScopeUsage(
	db: Database,
	principal: string,
	scopeKey: string,
): string[] {
	requireTransaction(db);
	const runs = (
		db
			.query(
				"SELECT run_id FROM world_host_usage WHERE principal = ? AND scope_key = ?",
			)
			.all(principal, scopeKey) as { run_id: string }[]
	).map((row) => row.run_id);
	db.query(
		"DELETE FROM world_host_usage WHERE principal = ? AND scope_key = ?",
	).run(principal, scopeKey);
	return runs;
}

/** Registered Memory dependents whose externalId starts with `prefix` (a hex-and-dash token). */
export function listDependentIdsByPrefix(
	db: Database,
	principal: string,
	scopeKey: string,
	prefix: string,
): string[] {
	return (
		db
			.query(
				`SELECT external_id FROM world_host_dependent
				WHERE principal = ? AND scope_key = ? AND external_id >= ? AND external_id < ?
				ORDER BY external_id`,
			)
			.all(principal, scopeKey, prefix, `${prefix}\u{10ffff}`) as {
			external_id: string;
		}[]
	).map((row) => row.external_id);
}

export function deleteDependents(
	db: Database,
	principal: string,
	scopeKey: string,
	externalIds: readonly string[],
): void {
	requireTransaction(db);
	const remove = db.query(
		"DELETE FROM world_host_dependent WHERE principal = ? AND scope_key = ? AND external_id = ?",
	);
	for (const externalId of externalIds)
		remove.run(principal, scopeKey, externalId);
}

/** Keeps the host rows but marks them for the retry sweep (Memory could not unregister them now). */
export function markReleasePending(
	db: Database,
	principal: string,
	scopeKey: string,
	externalIds: readonly string[],
): void {
	requireTransaction(db);
	const mark = db.query(
		"UPDATE world_host_dependent SET release_pending = 1 WHERE principal = ? AND scope_key = ? AND external_id = ?",
	);
	for (const externalId of externalIds)
		mark.run(principal, scopeKey, externalId);
}

export type PendingRelease = {
	principal: string;
	scopeKey: string;
	externalId: string;
};

/** Dependents waiting for a Memory unregistration, oldest id first. */
export function listReleasePending(
	db: Database,
	limit: number,
): PendingRelease[] {
	return (
		db
			.query(
				`SELECT principal, scope_key, external_id FROM world_host_dependent
				WHERE release_pending = 1 ORDER BY principal, scope_key, external_id LIMIT ?`,
			)
			.all(limit) as {
			principal: string;
			scope_key: string;
			external_id: string;
		}[]
	).map((row) => ({
		principal: row.principal,
		scopeKey: row.scope_key,
		externalId: row.external_id,
	}));
}
