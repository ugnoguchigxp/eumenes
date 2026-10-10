import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	MAX_ADOPTED_GOALS,
	MAX_PROPOSED_GOALS,
	adoptGoalSchema,
	adoptProposalSchema,
	goalAccessSchema,
	goalTransitionSchema,
	proposeGoalSchema,
	updateGoalSchema,
} from "../contracts";
import type {
	AdoptGoal,
	AdoptProposal,
	Goal,
	GoalAccess,
	GoalRef,
	GoalRevision,
	GoalSnapshot,
	GoalSource,
	GoalStatus,
	GoalTransition,
	ProposeGoal,
	UpdateGoal,
} from "../contracts";
import {
	bumpScopeEpoch,
	countGoals,
	getGoal,
	getGoalByOperation,
	insertGoal,
	listAdoptedGoals,
	listProposedGoals,
	replaceGoal,
	scopeEpoch,
} from "../repository";

function parse<T>(
	schema: { safeParse(v: unknown): { success: boolean; data?: T } },
	value: unknown,
	code: string,
): T {
	const result = schema.safeParse(value);
	if (!result.success) throw new Error(code);
	return result.data as T;
}

function parseAccess(access: GoalAccess): {
	principal: string;
	scopeKeys: string[];
} {
	const parsed = parse<GoalAccess>(
		goalAccessSchema,
		{ principal: access.principal, scopeKeys: [...access.scopeKeys] },
		"invalid_goal_access",
	);
	return {
		principal: parsed.principal,
		scopeKeys: [...new Set(parsed.scopeKeys)].sort(),
	};
}

function ref(goal: Goal): GoalRef {
	return {
		goalId: goal.id,
		scopeKey: goal.scopeKey,
		desiredState: goal.desiredState,
		priority: goal.priority,
		revision: goal.revision,
		source: goal.source,
	};
}

/**
 * One consistent read of the adopted goals of the access principal/scopes.
 * Pass the writer's `db` or a `readSnapshot` db: every query then sees the same
 * committed state. Never fabricates a goal; no adopted goal gives `absent`.
 */
export function goalSnapshot(db: Database, access: GoalAccess): GoalSnapshot {
	const { principal, scopeKeys } = parseAccess(access);
	const goals = listAdoptedGoals(db, principal, scopeKeys).map(ref);
	const scopeEpochs = scopeKeys.map((scopeKey) => ({
		scopeKey,
		epoch: scopeEpoch(db, principal, scopeKey),
	}));
	const digest = createHash("sha256")
		.update(
			JSON.stringify([
				"goal-snapshot/1",
				principal,
				scopeEpochs.map((e) => [e.scopeKey, e.epoch]),
				goals.map((g) => [
					g.goalId,
					g.revision,
					g.scopeKey,
					g.priority,
					g.desiredState,
				]),
			]),
		)
		.digest("hex");
	return {
		principal,
		scopeKeys,
		state: goals.length > 0 ? "present" : "absent",
		goals,
		scopeEpochs,
		revision: scopeEpochs.reduce((sum, e) => sum + e.epoch, 0),
		digest: `sha256:${digest}`,
	};
}

function revisionOf(db: Database, goal: Goal): GoalRevision {
	return {
		goalId: goal.id,
		principal: goal.principal,
		scopeKey: goal.scopeKey,
		status: goal.status,
		revision: goal.revision,
		scopeEpoch: scopeEpoch(db, goal.principal, goal.scopeKey),
	};
}

/**
 * Current revision, status and scope epoch of one goal. A goal outside the
 * access principal/scopes is reported as unknown (null), exactly like a missing
 * one. `access` is required: this is the World-facing export.
 * World compares this with the revision a usage receipt recorded.
 */
export function goalRevisionOf(
	db: Database,
	goalId: string,
	access: GoalAccess,
): GoalRevision | null {
	const goal = getGoal(db, goalId);
	if (!goal) return null;
	const { principal, scopeKeys } = parseAccess(access);
	if (goal.principal !== principal || !scopeKeys.includes(goal.scopeKey))
		return null;
	return revisionOf(db, goal);
}

/**
 * Host-only variant without an access check (for example maintenance or tests).
 * Deliberately not re-exported from the domain index: World must never get a
 * way to probe goals of other principals.
 */
export function goalRevisionOfUnscoped(
	db: Database,
	goalId: string,
): GoalRevision | null {
	const goal = getGoal(db, goalId);
	return goal ? revisionOf(db, goal) : null;
}

/** Current goal epoch of one scope (0 when the scope never had an adopted goal). */
export function goalEpochOf(
	db: Database,
	principal: string,
	scopeKey: string,
): number {
	return scopeEpoch(db, principal, scopeKey);
}

export function createGoalsService(
	store: SqliteStore,
	clock: () => string = () => new Date().toISOString(),
	id: () => string = () => crypto.randomUUID(),
) {
	function assertScope(access: GoalAccess, scopeKey: string) {
		if (!access.scopeKeys.includes(scopeKey))
			throw new Error("goal_scope_forbidden");
	}
	/** Goals of other principals/scopes are indistinguishable from missing ones. */
	function ownGoal(db: Database, access: GoalAccess, goalId: string): Goal {
		const goal = getGoal(db, goalId);
		if (
			!goal ||
			goal.principal !== access.principal ||
			!access.scopeKeys.includes(goal.scopeKey)
		)
			throw new Error("invalid_goal");
		return goal;
	}
	function assertCapacity(db: Database, goal: Goal, status: GoalStatus) {
		const limit = status === "adopted" ? MAX_ADOPTED_GOALS : MAX_PROPOSED_GOALS;
		if (countGoals(db, goal.principal, goal.scopeKey, status) >= limit)
			throw new Error("goal_limit");
	}
	const operationDigest = (
		status: string,
		value: {
			scopeKey: string;
			desiredState: string;
			priority: number;
			source: GoalSource;
		},
	) =>
		createHash("sha256")
			.update(
				JSON.stringify([
					"goal-operation/1",
					status,
					value.scopeKey,
					value.desiredState,
					value.priority,
					[
						value.source.namespace,
						value.source.kind,
						value.source.id,
						value.source.revision ?? null,
						value.source.digest ?? null,
						value.source.representation ?? null,
					],
				]),
			)
			.digest("hex");
	function create(
		db: Database,
		rawAccess: GoalAccess,
		input: unknown,
		status: "adopted" | "proposed",
	): Goal {
		const access = parseAccess(rawAccess);
		const value = parse(
			status === "adopted" ? adoptGoalSchema : proposeGoalSchema,
			input,
			"invalid_goal_input",
		);
		assertScope(access, value.scopeKey);
		const operation = value.operationKey
			? {
					key: value.operationKey,
					digest: operationDigest(status, value),
				}
			: undefined;
		if (operation) {
			// Replay of the same operation returns the same goal; nothing is written.
			const done = getGoalByOperation(
				db,
				access.principal,
				value.scopeKey,
				operation.key,
			);
			if (done) {
				if (done.digest !== operation.digest)
					throw new Error("operation_conflict");
				return done.goal;
			}
		}
		const now = clock();
		const goal: Goal = {
			id: id(),
			principal: access.principal,
			scopeKey: value.scopeKey,
			desiredState: value.desiredState,
			priority: value.priority,
			status,
			source: value.source,
			proposedFrom: null,
			revision: 1,
			createdAt: now,
			updatedAt: now,
		};
		assertCapacity(db, goal, status);
		insertGoal(db, goal, operation);
		if (status === "adopted") bumpScopeEpoch(db, goal.principal, goal.scopeKey);
		return goal;
	}
	/** Revision first, then state, then compare-and-swap; epoch moves with visibility. */
	function transition(
		db: Database,
		rawAccess: GoalAccess,
		goalId: string,
		expectedRevision: number,
		from: readonly GoalStatus[],
		build: (current: Goal, now: string) => Goal,
	): Goal {
		const access = parseAccess(rawAccess);
		const current = ownGoal(db, access, goalId);
		if (current.revision !== expectedRevision)
			throw new Error("revision_conflict");
		if (!from.includes(current.status)) throw new Error("goal_state_conflict");
		const next = build(current, clock());
		if (next.status === "adopted" && current.status !== "adopted")
			assertCapacity(db, current, "adopted");
		const saved = replaceGoal(db, next, expectedRevision, current.status);
		if (!saved) throw new Error("revision_conflict");
		if (current.status === "adopted" || next.status === "adopted")
			bumpScopeEpoch(db, saved.principal, saved.scopeKey);
		return saved;
	}

	const inTransaction = {
		/** Explicit adoption of a new goal. Only the host calls this. */
		adoptInTransaction(
			db: Database,
			access: GoalAccess,
			input: AdoptGoal,
		): Goal {
			return create(db, access, input, "adopted");
		},
		/** Stores an inferred goal as a proposal. Never visible in snapshots. */
		proposeInTransaction(
			db: Database,
			access: GoalAccess,
			input: ProposeGoal,
		): Goal {
			return create(db, access, input, "proposed");
		},
		/** Explicit adoption of an existing proposal. */
		adoptProposalInTransaction(
			db: Database,
			access: GoalAccess,
			goalId: string,
			input: AdoptProposal,
		): Goal {
			const value = parse(adoptProposalSchema, input, "invalid_goal_input");
			return transition(
				db,
				access,
				goalId,
				value.expectedRevision,
				["proposed"],
				(c, now) => ({
					...c,
					status: "adopted",
					source: value.source,
					proposedFrom: c.source,
					revision: c.revision + 1,
					updatedAt: now,
				}),
			);
		},
		updateInTransaction(
			db: Database,
			access: GoalAccess,
			goalId: string,
			input: UpdateGoal,
		): Goal {
			const value = parse(updateGoalSchema, input, "invalid_goal_input");
			return transition(
				db,
				access,
				goalId,
				value.expectedRevision,
				["adopted"],
				(c, now) => ({
					...c,
					desiredState: value.desiredState ?? c.desiredState,
					priority: value.priority ?? c.priority,
					source: value.source,
					revision: c.revision + 1,
					updatedAt: now,
				}),
			);
		},
		/** Withdraws an adopted goal, or rejects a proposal. */
		withdrawInTransaction(
			db: Database,
			access: GoalAccess,
			goalId: string,
			input: GoalTransition,
		): Goal {
			const value = parse(goalTransitionSchema, input, "invalid_goal_input");
			return transition(
				db,
				access,
				goalId,
				value.expectedRevision,
				["adopted", "proposed"],
				(c, now) => ({
					...c,
					status: "withdrawn",
					source: value.source,
					revision: c.revision + 1,
					updatedAt: now,
				}),
			);
		},
		completeInTransaction(
			db: Database,
			access: GoalAccess,
			goalId: string,
			input: GoalTransition,
		): Goal {
			const value = parse(goalTransitionSchema, input, "invalid_goal_input");
			return transition(
				db,
				access,
				goalId,
				value.expectedRevision,
				["adopted"],
				(c, now) => ({
					...c,
					status: "completed",
					source: value.source,
					revision: c.revision + 1,
					updatedAt: now,
				}),
			);
		},
		/** Open proposals of the access principal/scopes (host review list). */
		proposalsInTransaction(db: Database, access: GoalAccess): Goal[] {
			const own = parseAccess(access);
			return listProposedGoals(db, own.principal, own.scopeKeys);
		},
		snapshotInTransaction: goalSnapshot,
		/** Access is required: a goal outside it is reported as unknown. */
		revisionOfInTransaction: goalRevisionOf,
	};

	return {
		...inTransaction,
		adopt: (access: GoalAccess, input: AdoptGoal) =>
			store.write((db) => inTransaction.adoptInTransaction(db, access, input)),
		propose: (access: GoalAccess, input: ProposeGoal) =>
			store.write((db) =>
				inTransaction.proposeInTransaction(db, access, input),
			),
		adoptProposal: (access: GoalAccess, goalId: string, input: AdoptProposal) =>
			store.write((db) =>
				inTransaction.adoptProposalInTransaction(db, access, goalId, input),
			),
		update: (access: GoalAccess, goalId: string, input: UpdateGoal) =>
			store.write((db) =>
				inTransaction.updateInTransaction(db, access, goalId, input),
			),
		withdraw: (access: GoalAccess, goalId: string, input: GoalTransition) =>
			store.write((db) =>
				inTransaction.withdrawInTransaction(db, access, goalId, input),
			),
		complete: (access: GoalAccess, goalId: string, input: GoalTransition) =>
			store.write((db) =>
				inTransaction.completeInTransaction(db, access, goalId, input),
			),
		/** Single committed snapshot on the readonly reader. */
		snapshot: (access: GoalAccess): GoalSnapshot =>
			store.readSnapshot((db) => goalSnapshot(db, access)),
		proposals: (access: GoalAccess): Goal[] =>
			store.readSnapshot((db) =>
				inTransaction.proposalsInTransaction(db, access),
			),
	};
}
export type GoalsService = ReturnType<typeof createGoalsService>;
