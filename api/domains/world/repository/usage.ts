import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * Host-owned UsageReceipt of an adopted World-backed answer (P3-07).
 * Append-only migration, never edited. One row per run, written in the SAME
 * transaction as the answer message; there is no "reserved" or "pending" row,
 * so an answer that was not adopted leaves nothing here.
 *
 * Ids, versions, digests and epochs only: no claim text, no source text.
 * - `slice_digest`, `*_versions_json`, epochs: what the answer stood on.
 * - `goal_*`: the Goal revision and the Goal scope epoch seen at prepare.
 * - `job_id`/`attempt`/`generation`: the queue attempt that produced it.
 * - `inference_*`: the inference request/attempt ids (the provider reference
 *   the host owns); NULL when the inference port gave no receipt.
 * - `dependent_ids_json`: the Memory external dependents registered for the
 *   slice's inputs (the same ids `world_host_dependent` keeps).
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

export type UsageRow = {
	runId: string;
	principal: string;
	scopeKey: string;
	conversationId: string;
	jobId: string;
	attempt: number;
	generation: number;
	sliceDigest: string;
	sliceStatus: "ready" | "partial";
	worldScopeEpoch: number;
	policyRevision: string;
	forgetEpoch: string;
	restoreEpoch: string;
	interpretationVersion: string;
	assertionVersions: unknown[];
	sourceVersions: unknown[];
	goal: { id: string; revision: number } | null;
	goalEpoch: number;
	contractVersion: number;
	packageVersion: string;
	inferenceRequestId: string | null;
	inferenceAttemptId: string | null;
	dependentIds: string[];
	createdAt: number;
};

type Raw = {
	run_id: string;
	principal: string;
	scope_key: string;
	conversation_id: string;
	job_id: string;
	attempt: number;
	generation: number;
	slice_digest: string;
	slice_status: "ready" | "partial";
	world_scope_epoch: number;
	policy_revision: string;
	forget_epoch: string;
	restore_epoch: string;
	interpretation_version: string;
	assertion_versions_json: string;
	source_versions_json: string;
	goal_id: string | null;
	goal_revision: number | null;
	goal_epoch: number;
	contract_version: number;
	package_version: string;
	inference_request_id: string | null;
	inference_attempt_id: string | null;
	dependent_ids_json: string;
	created_at: number;
};

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

export function insertUsage(db: Database, row: UsageRow): void {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_usage (
			run_id, principal, scope_key, conversation_id, job_id, attempt, generation,
			slice_digest, slice_status, world_scope_epoch, policy_revision, forget_epoch,
			restore_epoch, interpretation_version, assertion_versions_json, source_versions_json,
			goal_id, goal_revision, goal_epoch, contract_version, package_version,
			inference_request_id, inference_attempt_id, dependent_ids_json, created_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		row.runId,
		row.principal,
		row.scopeKey,
		row.conversationId,
		row.jobId,
		row.attempt,
		row.generation,
		row.sliceDigest,
		row.sliceStatus,
		row.worldScopeEpoch,
		row.policyRevision,
		row.forgetEpoch,
		row.restoreEpoch,
		row.interpretationVersion,
		JSON.stringify(row.assertionVersions),
		JSON.stringify(row.sourceVersions),
		row.goal?.id ?? null,
		row.goal?.revision ?? null,
		row.goalEpoch,
		row.contractVersion,
		row.packageVersion,
		row.inferenceRequestId,
		row.inferenceAttemptId,
		JSON.stringify(row.dependentIds),
		row.createdAt,
	);
}

export function getUsage(db: Database, runId: string): UsageRow | null {
	const row = db
		.query("SELECT * FROM world_host_usage WHERE run_id = ?")
		.get(runId) as Raw | null;
	if (!row) return null;
	return {
		runId: row.run_id,
		principal: row.principal,
		scopeKey: row.scope_key,
		conversationId: row.conversation_id,
		jobId: row.job_id,
		attempt: row.attempt,
		generation: row.generation,
		sliceDigest: row.slice_digest,
		sliceStatus: row.slice_status,
		worldScopeEpoch: row.world_scope_epoch,
		policyRevision: row.policy_revision,
		forgetEpoch: row.forget_epoch,
		restoreEpoch: row.restore_epoch,
		interpretationVersion: row.interpretation_version,
		assertionVersions: JSON.parse(row.assertion_versions_json) as unknown[],
		sourceVersions: JSON.parse(row.source_versions_json) as unknown[],
		goal:
			row.goal_id === null || row.goal_revision === null
				? null
				: { id: row.goal_id, revision: row.goal_revision },
		goalEpoch: row.goal_epoch,
		contractVersion: row.contract_version,
		packageVersion: row.package_version,
		inferenceRequestId: row.inference_request_id,
		inferenceAttemptId: row.inference_attempt_id,
		dependentIds: JSON.parse(row.dependent_ids_json) as string[],
		createdAt: row.created_at,
	};
}

export function deleteUsage(db: Database, runId: string): void {
	requireTransaction(db);
	db.query("DELETE FROM world_host_usage WHERE run_id = ?").run(runId);
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

/** Runs beyond the newest `keep` receipts of a Scope. */
export function listSurplusUsage(
	db: Database,
	principal: string,
	scopeKey: string,
	keep: number,
): string[] {
	return (
		db
			.query(
				`SELECT run_id FROM world_host_usage WHERE principal = ? AND scope_key = ?
				ORDER BY created_at DESC, run_id DESC LIMIT -1 OFFSET ?`,
			)
			.all(principal, scopeKey, keep) as { run_id: string }[]
	).map((row) => row.run_id);
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
