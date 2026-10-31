import type { Database } from "bun:sqlite";
import { WorldHostStateError } from "./index";

/**
 * Host-owned trace of runtime observations (P4-04). Append-only migration at
 * the TAIL of the host migrations, never edited. World's own tables are never
 * read or written here (the package has no read API for outcomes); this is the
 * host's record of WHICH version of WHICH ledger result became (or did not
 * become) an Outcome, written in the same writer callback as the World
 * operation. Opaque ids, versions, digests and reason codes only: no measured
 * value and no text.
 *
 * - `state`: observed (an Outcome stands on this ledger version), incomparable
 *   (verified but its comparison conditions are missing or do not match: no
 *   Outcome exists), superseded (a later ledger revision replaced it),
 *   withdrawn (the ledger forgot / retracted / un-verified it: the Outcome was
 *   handed to the forget procedure).
 * - one row per (ledger result version, prediction): a repeated notice is the
 *   same key and so a no-op.
 */
export const runtimeMigration = `
CREATE TABLE world_host_runtime_observation (
	principal TEXT NOT NULL CHECK (length(principal) BETWEEN 1 AND 200),
	scope_key TEXT NOT NULL CHECK (length(scope_key) BETWEEN 1 AND 200),
	source_key TEXT NOT NULL CHECK (length(source_key) BETWEEN 1 AND 8192),
	ledger_revision TEXT NOT NULL CHECK (length(ledger_revision) BETWEEN 1 AND 256),
	ledger_digest TEXT NOT NULL CHECK (length(ledger_digest) BETWEEN 1 AND 256),
	prediction_id TEXT NOT NULL CHECK (length(prediction_id) BETWEEN 1 AND 256),
	prediction_revision INTEGER NOT NULL CHECK (prediction_revision >= 1),
	verification TEXT NOT NULL CHECK (verification = 'verified'),
	state TEXT NOT NULL CHECK (state IN ('observed', 'incomparable', 'superseded', 'withdrawn')),
	outcome_id TEXT CHECK (outcome_id IS NULL OR length(outcome_id) <= 256),
	outcome_revision INTEGER CHECK (outcome_revision IS NULL OR outcome_revision >= 1),
	reasons TEXT CHECK (reasons IS NULL OR length(reasons) <= 2048),
	observed_at_ms INTEGER NOT NULL,
	recorded_at_ms INTEGER NOT NULL,
	PRIMARY KEY (principal, scope_key, source_key, ledger_revision, ledger_digest, prediction_id, prediction_revision),
	CHECK ((state IN ('observed', 'superseded', 'withdrawn')) = (outcome_id IS NOT NULL AND outcome_revision IS NOT NULL) OR state = 'withdrawn')
) WITHOUT ROWID;
CREATE INDEX world_host_runtime_observation_prediction ON world_host_runtime_observation (principal, scope_key, prediction_id, prediction_revision, state);
CREATE INDEX world_host_runtime_observation_open ON world_host_runtime_observation (principal, scope_key, state) WHERE state = 'observed';
`;

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

/**
 * Outcome revisions that stand on these ledger sources. A forget of a source
 * names them as roots: World's own closure from a source reaches assertions
 * and manifests, not Outcomes, so the host adds them (like extraction events).
 */
export function runtimeOutcomeRootsOfSources(
	db: Database,
	principal: string,
	scopeKey: string,
	sourceKeys: readonly string[],
): { kind: "outcome"; id: string; revision: number }[] {
	const roots: { kind: "outcome"; id: string; revision: number }[] = [];
	const query = db.query(
		`SELECT DISTINCT outcome_id, outcome_revision FROM world_host_runtime_observation
		WHERE principal = ? AND scope_key = ? AND source_key = ?
		AND outcome_id IS NOT NULL AND state <> 'withdrawn'`,
	);
	for (const key of sourceKeys)
		for (const row of query.all(principal, scopeKey, key) as {
			outcome_id: string;
			outcome_revision: number;
		}[])
			roots.push({
				kind: "outcome",
				id: row.outcome_id,
				revision: row.outcome_revision,
			});
	return roots;
}

/** The host trace of forgotten ledger sources goes with the forget (any state). */
export function purgeRuntimeObservations(
	db: Database,
	principal: string,
	scopeKey: string,
	sourceKeys: readonly string[],
): number {
	requireTransaction(db);
	let count = 0;
	const remove = db.query(
		`DELETE FROM world_host_runtime_observation
		WHERE principal = ? AND scope_key = ? AND source_key = ?`,
	);
	for (const key of sourceKeys)
		count += (remove.run(principal, scopeKey, key) as { changes: number })
			.changes;
	return count;
}
