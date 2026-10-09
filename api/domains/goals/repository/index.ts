import type { Database } from "bun:sqlite";
import type { Goal, GoalSource, GoalStatus } from "../contracts";

export const migration = `
CREATE TABLE goals_ledger (
 id TEXT PRIMARY KEY, principal TEXT NOT NULL, scope_key TEXT NOT NULL,
 desired_state TEXT NOT NULL, priority INTEGER NOT NULL CHECK(priority BETWEEN 0 AND 100),
 status TEXT NOT NULL CHECK(status IN ('proposed','adopted','withdrawn','completed')),
 source_json TEXT NOT NULL, proposed_from_json TEXT,
 revision INTEGER NOT NULL CHECK(revision >= 1), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX goals_ledger_scope ON goals_ledger(principal, scope_key, status, priority DESC);
CREATE TABLE goals_history (
 goal_id TEXT NOT NULL, revision INTEGER NOT NULL, status TEXT NOT NULL,
 desired_state TEXT NOT NULL, priority INTEGER NOT NULL, source_json TEXT NOT NULL, at TEXT NOT NULL,
 PRIMARY KEY (goal_id, revision)
);
CREATE TABLE goals_scope_epochs (
 principal TEXT NOT NULL, scope_key TEXT NOT NULL, epoch INTEGER NOT NULL CHECK(epoch >= 1),
 PRIMARY KEY (principal, scope_key)
);
`;

/**
 * Idempotency key of adopt/propose (append-only; the base migration may already
 * be applied). operation_digest fingerprints the payload for conflict detection.
 */
export const operationMigration = `
ALTER TABLE goals_ledger ADD COLUMN operation_key TEXT;
ALTER TABLE goals_ledger ADD COLUMN operation_digest TEXT;
CREATE UNIQUE INDEX goals_ledger_operation ON goals_ledger(principal, scope_key, operation_key) WHERE operation_key IS NOT NULL;
`;

const columns =
	"id, principal, scope_key, desired_state, priority, status, source_json, proposed_from_json, revision, created_at, updated_at";

function map(row: Record<string, unknown>): Goal {
	return {
		id: row.id as string,
		principal: row.principal as string,
		scopeKey: row.scope_key as string,
		desiredState: row.desired_state as string,
		priority: row.priority as number,
		status: row.status as GoalStatus,
		source: JSON.parse(row.source_json as string) as GoalSource,
		proposedFrom: row.proposed_from_json
			? (JSON.parse(row.proposed_from_json as string) as GoalSource)
			: null,
		revision: row.revision as number,
		createdAt: row.created_at as string,
		updatedAt: row.updated_at as string,
	};
}

function recordHistory(db: Database, goal: Goal) {
	db.query(
		"INSERT INTO goals_history (goal_id, revision, status, desired_state, priority, source_json, at) VALUES (?,?,?,?,?,?,?)",
	).run(
		goal.id,
		goal.revision,
		goal.status,
		goal.desiredState,
		goal.priority,
		JSON.stringify(goal.source),
		goal.updatedAt,
	);
}

export function insertGoal(
	db: Database,
	goal: Goal,
	operation?: { key: string; digest: string },
) {
	db.query(
		`INSERT INTO goals_ledger (${columns}, operation_key, operation_digest) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		goal.id,
		goal.principal,
		goal.scopeKey,
		goal.desiredState,
		goal.priority,
		goal.status,
		JSON.stringify(goal.source),
		goal.proposedFrom ? JSON.stringify(goal.proposedFrom) : null,
		goal.revision,
		goal.createdAt,
		goal.updatedAt,
		operation?.key ?? null,
		operation?.digest ?? null,
	);
	recordHistory(db, goal);
}

/** The goal an operation key already created for this (principal, scope), if any. */
export function getGoalByOperation(
	db: Database,
	principal: string,
	scopeKey: string,
	operationKey: string,
): { goal: Goal; digest: string } | null {
	const row = db
		.query(
			`SELECT ${columns}, operation_digest FROM goals_ledger WHERE principal=? AND scope_key=? AND operation_key=?`,
		)
		.get(principal, scopeKey, operationKey) as Record<string, unknown> | null;
	return row
		? { goal: map(row), digest: row.operation_digest as string }
		: null;
}

export function getGoal(db: Database, id: string): Goal | null {
	const row = db
		.query(`SELECT ${columns} FROM goals_ledger WHERE id = ?`)
		.get(id);
	return row ? map(row as Record<string, unknown>) : null;
}

/**
 * Compare-and-swap on (id, revision, from-status). Returns the new row, or
 * null when the revision or status no longer matches.
 */
export function replaceGoal(
	db: Database,
	next: Goal,
	expectedRevision: number,
	from: GoalStatus,
): Goal | null {
	const result = db
		.query(
			"UPDATE goals_ledger SET desired_state=?, priority=?, status=?, source_json=?, revision=?, updated_at=? WHERE id=? AND revision=? AND status=?",
		)
		.run(
			next.desiredState,
			next.priority,
			next.status,
			JSON.stringify(next.source),
			next.revision,
			next.updatedAt,
			next.id,
			expectedRevision,
			from,
		);
	if (result.changes !== 1) return null;
	recordHistory(db, next);
	return next;
}

export function countGoals(
	db: Database,
	principal: string,
	scopeKey: string,
	status: GoalStatus,
): number {
	return (
		db
			.query(
				"SELECT COUNT(*) AS n FROM goals_ledger WHERE principal=? AND scope_key=? AND status=?",
			)
			.get(principal, scopeKey, status) as { n: number }
	).n;
}

export function listAdoptedGoals(
	db: Database,
	principal: string,
	scopeKeys: readonly string[],
): Goal[] {
	if (scopeKeys.length === 0) return [];
	const marks = scopeKeys.map(() => "?").join(",");
	return (
		db
			.query(
				`SELECT ${columns} FROM goals_ledger WHERE principal=? AND status='adopted' AND scope_key IN (${marks}) ORDER BY priority DESC, rowid`,
			)
			.all(principal, ...scopeKeys) as Record<string, unknown>[]
	).map(map);
}

export function listProposedGoals(
	db: Database,
	principal: string,
	scopeKeys: readonly string[],
): Goal[] {
	if (scopeKeys.length === 0) return [];
	const marks = scopeKeys.map(() => "?").join(",");
	return (
		db
			.query(
				`SELECT ${columns} FROM goals_ledger WHERE principal=? AND status='proposed' AND scope_key IN (${marks}) ORDER BY rowid`,
			)
			.all(principal, ...scopeKeys) as Record<string, unknown>[]
	).map(map);
}

export function bumpScopeEpoch(
	db: Database,
	principal: string,
	scopeKey: string,
) {
	db.query(
		"INSERT INTO goals_scope_epochs (principal, scope_key, epoch) VALUES (?,?,1) ON CONFLICT(principal, scope_key) DO UPDATE SET epoch = epoch + 1",
	).run(principal, scopeKey);
}

export function scopeEpoch(
	db: Database,
	principal: string,
	scopeKey: string,
): number {
	return (
		(
			db
				.query(
					"SELECT epoch FROM goals_scope_epochs WHERE principal=? AND scope_key=?",
				)
				.get(principal, scopeKey) as { epoch: number } | null
		)?.epoch ?? 0
	);
}

export function goalHistory(
	db: Database,
	goalId: string,
): { revision: number; status: GoalStatus; source: GoalSource }[] {
	return (
		db
			.query(
				"SELECT revision, status, source_json FROM goals_history WHERE goal_id=? ORDER BY revision",
			)
			.all(goalId) as Record<string, unknown>[]
	).map((row) => ({
		revision: row.revision as number,
		status: row.status as GoalStatus,
		source: JSON.parse(row.source_json as string) as GoalSource,
	}));
}
