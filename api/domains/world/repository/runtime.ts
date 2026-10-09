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

export const RUNTIME_OBSERVATION_STATES = [
	"observed",
	"incomparable",
	"superseded",
	"withdrawn",
] as const;
export type RuntimeObservationState =
	(typeof RUNTIME_OBSERVATION_STATES)[number];

export type RuntimeObservationRow = {
	principal: string;
	scopeKey: string;
	sourceKey: string;
	ledgerRevision: string;
	ledgerDigest: string;
	predictionId: string;
	predictionRevision: number;
	state: RuntimeObservationState;
	outcomeId: string | null;
	outcomeRevision: number | null;
	reasons: string[];
	observedAtMs: number;
	recordedAtMs: number;
};

type Raw = {
	principal: string;
	scope_key: string;
	source_key: string;
	ledger_revision: string;
	ledger_digest: string;
	prediction_id: string;
	prediction_revision: number;
	state: RuntimeObservationState;
	outcome_id: string | null;
	outcome_revision: number | null;
	reasons: string | null;
	observed_at_ms: number;
	recorded_at_ms: number;
};
const COLUMNS =
	"principal, scope_key, source_key, ledger_revision, ledger_digest, prediction_id, prediction_revision, state, outcome_id, outcome_revision, reasons, observed_at_ms, recorded_at_ms";

const toRow = (raw: Raw): RuntimeObservationRow => ({
	principal: raw.principal,
	scopeKey: raw.scope_key,
	sourceKey: raw.source_key,
	ledgerRevision: raw.ledger_revision,
	ledgerDigest: raw.ledger_digest,
	predictionId: raw.prediction_id,
	predictionRevision: raw.prediction_revision,
	state: raw.state,
	outcomeId: raw.outcome_id,
	outcomeRevision: raw.outcome_revision,
	reasons: raw.reasons === null ? [] : (JSON.parse(raw.reasons) as string[]),
	observedAtMs: raw.observed_at_ms,
	recordedAtMs: raw.recorded_at_ms,
});

function requireTransaction(db: Database): void {
	if (!db.inTransaction) throw new WorldHostStateError("transaction_required");
}

export type NewRuntimeObservation = Omit<RuntimeObservationRow, "reasons"> & {
	reasons?: readonly string[];
};

export function insertRuntimeObservation(
	db: Database,
	row: NewRuntimeObservation,
): void {
	requireTransaction(db);
	db.query(
		`INSERT INTO world_host_runtime_observation (${COLUMNS}, verification)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified')`,
	).run(
		row.principal,
		row.scopeKey,
		row.sourceKey,
		row.ledgerRevision,
		row.ledgerDigest,
		row.predictionId,
		row.predictionRevision,
		row.state,
		row.outcomeId,
		row.outcomeRevision,
		row.reasons && row.reasons.length > 0
			? JSON.stringify([...row.reasons])
			: null,
		row.observedAtMs,
		row.recordedAtMs,
	);
}

export function getRuntimeObservation(
	db: Database,
	key: {
		principal: string;
		scopeKey: string;
		sourceKey: string;
		ledgerRevision: string;
		ledgerDigest: string;
		predictionId: string;
		predictionRevision: number;
	},
): RuntimeObservationRow | null {
	const raw = db
		.query(
			`SELECT ${COLUMNS} FROM world_host_runtime_observation
			WHERE principal = ? AND scope_key = ? AND source_key = ? AND ledger_revision = ?
			AND ledger_digest = ? AND prediction_id = ? AND prediction_revision = ?`,
		)
		.get(
			key.principal,
			key.scopeKey,
			key.sourceKey,
			key.ledgerRevision,
			key.ledgerDigest,
			key.predictionId,
			key.predictionRevision,
		) as Raw | null;
	return raw ? toRow(raw) : null;
}

export function setRuntimeObservationState(
	db: Database,
	key: Pick<
		RuntimeObservationRow,
		| "principal"
		| "scopeKey"
		| "sourceKey"
		| "ledgerRevision"
		| "ledgerDigest"
		| "predictionId"
		| "predictionRevision"
	>,
	state: RuntimeObservationState,
): void {
	requireTransaction(db);
	db.query(
		`UPDATE world_host_runtime_observation SET state = ?
		WHERE principal = ? AND scope_key = ? AND source_key = ? AND ledger_revision = ?
		AND ledger_digest = ? AND prediction_id = ? AND prediction_revision = ?`,
	).run(
		state,
		key.principal,
		key.scopeKey,
		key.sourceKey,
		key.ledgerRevision,
		key.ledgerDigest,
		key.predictionId,
		key.predictionRevision,
	);
}

/** Every row of one (source, prediction) pair, oldest outcome revision first. */
export function listRuntimeObservationsOfSource(
	db: Database,
	principal: string,
	scopeKey: string,
	sourceKey: string,
	predictionId: string,
	predictionRevision: number,
): RuntimeObservationRow[] {
	return (
		db
			.query(
				`SELECT ${COLUMNS} FROM world_host_runtime_observation
				WHERE principal = ? AND scope_key = ? AND source_key = ?
				AND prediction_id = ? AND prediction_revision = ?
				ORDER BY COALESCE(outcome_revision, 0), recorded_at_ms, ledger_revision`,
			)
			.all(
				principal,
				scopeKey,
				sourceKey,
				predictionId,
				predictionRevision,
			) as Raw[]
	).map(toRow);
}

/** Rows of a prediction in the given states (bounded). */
export function listRuntimeObservationsOfPrediction(
	db: Database,
	principal: string,
	scopeKey: string,
	predictionId: string,
	predictionRevision: number,
	states: readonly RuntimeObservationState[],
	limit: number,
): RuntimeObservationRow[] {
	const marks = states.map(() => "?").join(", ");
	return (
		db
			.query(
				`SELECT ${COLUMNS} FROM world_host_runtime_observation
				WHERE principal = ? AND scope_key = ? AND prediction_id = ? AND prediction_revision = ?
				AND state IN (${marks})
				ORDER BY source_key, recorded_at_ms, ledger_revision LIMIT ?`,
			)
			.all(
				principal,
				scopeKey,
				predictionId,
				predictionRevision,
				...states,
				limit,
			) as Raw[]
	).map(toRow);
}

/** Observed rows of the Scope (the reconcile sweep), bounded. */
export function listObservedRuntimeObservations(
	db: Database,
	principal: string,
	scopeKey: string,
	limit: number,
): RuntimeObservationRow[] {
	return (
		db
			.query(
				`SELECT ${COLUMNS} FROM world_host_runtime_observation
				WHERE principal = ? AND scope_key = ? AND state = 'observed'
				ORDER BY source_key, ledger_revision LIMIT ?`,
			)
			.all(principal, scopeKey, limit) as Raw[]
	).map(toRow);
}

/** Highest Outcome revision already used for this outcome id (0 when none). */
export function maxOutcomeRevision(
	db: Database,
	principal: string,
	scopeKey: string,
	outcomeId: string,
): number {
	const row = db
		.query(
			`SELECT COALESCE(MAX(outcome_revision), 0) AS n FROM world_host_runtime_observation
			WHERE principal = ? AND scope_key = ? AND outcome_id = ?`,
		)
		.get(principal, scopeKey, outcomeId) as { n: number };
	return row.n;
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
