import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { Goal, GoalSource, GoalStatus } from "../contracts";

const migration = `
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
const operationMigration = `
ALTER TABLE goals_ledger ADD COLUMN operation_key TEXT;
ALTER TABLE goals_ledger ADD COLUMN operation_digest TEXT;
CREATE UNIQUE INDEX goals_ledger_operation ON goals_ledger(principal, scope_key, operation_key) WHERE operation_key IS NOT NULL;
`;

/**
 * Provenance for forgetting (F8): the messages each revision is based on, and
 * the World entities a goal concerns (accumulated over its revisions). Message
 * and entity ids are opaque here; goals never resolves them.
 */
const sourceMigration = `
CREATE TABLE goals_source (
 goal_id TEXT NOT NULL, revision INTEGER NOT NULL, message_id TEXT NOT NULL,
 PRIMARY KEY (goal_id, revision, message_id)
);
CREATE INDEX goals_source_message ON goals_source(message_id);
CREATE TABLE goals_entity (
 goal_id TEXT NOT NULL, entity_id TEXT NOT NULL,
 PRIMARY KEY (goal_id, entity_id)
);
CREATE INDEX goals_entity_entity ON goals_entity(entity_id);
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

/** Writes the provenance of one goal revision. Entity links only accumulate. */
export function recordGoalLinks(
	db: Database,
	goalId: string,
	revision: number,
	links: { sourceMessageIds: readonly string[]; entityIds: readonly string[] },
) {
	for (const messageId of new Set(links.sourceMessageIds))
		db.query(
			"INSERT OR IGNORE INTO goals_source (goal_id, revision, message_id) VALUES (?,?,?)",
		).run(goalId, revision, messageId);
	for (const entityId of new Set(links.entityIds))
		db.query(
			"INSERT OR IGNORE INTO goals_entity (goal_id, entity_id) VALUES (?,?)",
		).run(goalId, entityId);
}

/** All goals of the access, optionally limited to some statuses; newest first within a status. */
export function listGoals(
	db: Database,
	principal: string,
	scopeKeys: readonly string[],
	statuses: readonly GoalStatus[],
): Goal[] {
	if (scopeKeys.length === 0 || statuses.length === 0) return [];
	const scopes = scopeKeys.map(() => "?").join(",");
	const marks = statuses.map(() => "?").join(",");
	return (
		db
			.query(
				`SELECT ${columns} FROM goals_ledger WHERE principal=? AND scope_key IN (${scopes}) AND status IN (${marks}) ORDER BY CASE status WHEN 'adopted' THEN 0 WHEN 'proposed' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END, priority DESC, updated_at DESC, rowid DESC`,
			)
			.all(principal, ...scopeKeys, ...statuses) as Record<string, unknown>[]
	).map(map);
}

/** Adopted goals by priority (high first), then the most recently revised. */
export function listAdoptedByPriority(
	db: Database,
	principal: string,
	scopeKeys: readonly string[],
): Goal[] {
	if (scopeKeys.length === 0) return [];
	const marks = scopeKeys.map(() => "?").join(",");
	return (
		db
			.query(
				`SELECT ${columns} FROM goals_ledger WHERE principal=? AND status='adopted' AND scope_key IN (${marks}) ORDER BY priority DESC, updated_at DESC, rowid DESC`,
			)
			.all(principal, ...scopeKeys) as Record<string, unknown>[]
	).map(map);
}

/**
 * Goals a forget reaches: the named ones plus those linked to the entities.
 * Only goals with a row in some goals table are returned, sorted.
 */
export function forgetClosure(
	db: Database,
	goalIds: readonly string[],
	entityIds: readonly string[],
): string[] {
	const rows = db
		.query(
			`WITH named(id) AS (SELECT value FROM json_each(?1)),
 linked(id) AS (SELECT DISTINCT goal_id FROM goals_entity WHERE entity_id IN (SELECT value FROM json_each(?2))),
 want(id) AS (SELECT id FROM named UNION SELECT id FROM linked)
 SELECT id FROM want WHERE id IN (
  SELECT id FROM goals_ledger UNION SELECT goal_id FROM goals_history
  UNION SELECT goal_id FROM goals_source UNION SELECT goal_id FROM goals_entity)
 ORDER BY id`,
		)
		.all(JSON.stringify(goalIds), JSON.stringify(entityIds)) as {
		id: string;
	}[];
	return rows.map((r) => r.id);
}

export function messageIdsOfGoals(
	db: Database,
	goalIds: readonly string[],
): string[] {
	return (
		db
			.query(
				"SELECT DISTINCT message_id FROM goals_source WHERE goal_id IN (SELECT value FROM json_each(?)) ORDER BY message_id",
			)
			.all(JSON.stringify(goalIds)) as { message_id: string }[]
	).map((r) => r.message_id);
}

/** Scopes of the goals about to be deleted, for the epoch bump. */
export function scopesOfGoals(
	db: Database,
	goalIds: readonly string[],
): { principal: string; scopeKey: string }[] {
	return (
		db
			.query(
				"SELECT DISTINCT principal, scope_key FROM goals_ledger WHERE id IN (SELECT value FROM json_each(?)) ORDER BY principal, scope_key",
			)
			.all(JSON.stringify(goalIds)) as {
			principal: string;
			scope_key: string;
		}[]
	).map((r) => ({ principal: r.principal, scopeKey: r.scope_key }));
}

/** Deletes the goals with every revision, history row and provenance row. */
export function deleteGoals(db: Database, goalIds: readonly string[]) {
	const ids = JSON.stringify(goalIds);
	for (const sql of [
		"DELETE FROM goals_source WHERE goal_id IN (SELECT value FROM json_each(?))",
		"DELETE FROM goals_entity WHERE goal_id IN (SELECT value FROM json_each(?))",
		"DELETE FROM goals_history WHERE goal_id IN (SELECT value FROM json_each(?))",
		"DELETE FROM goals_ledger WHERE id IN (SELECT value FROM json_each(?))",
	])
		db.query(sql).run(ids);
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const migrations: readonly Migration[] = [
	{ id: "goals/0001-init", sql: migration },
	{ id: "goals/0002-operation", sql: operationMigration },
	{
		id: "goals/0003-sources",
		sql: sourceMigration,
		after: ["goals/0002-operation"],
	},
];
