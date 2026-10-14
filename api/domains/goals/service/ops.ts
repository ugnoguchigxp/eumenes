import type { Database } from "bun:sqlite";
import { MAX_GOAL_OPS, goalRejectReasons } from "../contracts";
import type {
	AdoptProposal,
	Goal,
	GoalAccess,
	GoalOp,
	GoalOpResult,
	GoalRejectReason,
	GoalTransition,
	UpdateGoal,
} from "../contracts";

/** The single-goal operations a batch is built from. */
interface GoalActions {
	create(
		access: GoalAccess,
		input: unknown,
		status: "adopted" | "proposed",
	): { goal: Goal; replayed: boolean };
	adoptProposal(
		db: Database,
		access: GoalAccess,
		goalId: string,
		input: AdoptProposal,
	): Goal;
	update(
		db: Database,
		access: GoalAccess,
		goalId: string,
		input: UpdateGoal,
	): Goal;
	withdraw(
		db: Database,
		access: GoalAccess,
		goalId: string,
		input: GoalTransition,
	): Goal;
	complete(
		db: Database,
		access: GoalAccess,
		goalId: string,
		input: GoalTransition,
	): Goal;
}

const known = new Set<string>(goalRejectReasons);

function dispatch(
	db: Database,
	access: GoalAccess,
	op: GoalOp,
	actions: GoalActions,
): { goal: Goal; replayed: boolean } {
	if (typeof op !== "object" || op === null)
		throw new Error("invalid_goal_input");
	const { op: kind, ...rest } = op as GoalOp & Record<string, unknown>;
	const sources = rest.sourceMessageIds;
	// Without a message the goal could not be forgotten with its conversation (F10).
	if (!Array.isArray(sources) || sources.length === 0)
		throw new Error("source_required");
	const goalId = rest.goalId;
	delete rest.goalId;
	const withGoal = (run: (id: string) => Goal) => {
		if (typeof goalId !== "string" || goalId === "")
			throw new Error("invalid_goal_input");
		return { goal: run(goalId), replayed: false };
	};
	switch (kind) {
		case "propose":
			return actions.create(access, rest, "proposed");
		case "adopt":
			return goalId === undefined
				? actions.create(access, rest, "adopted")
				: withGoal((id) =>
						actions.adoptProposal(db, access, id, rest as AdoptProposal),
					);
		case "revise":
			return withGoal((id) =>
				actions.update(db, access, id, rest as UpdateGoal),
			);
		case "complete":
			return withGoal((id) =>
				actions.complete(db, access, id, rest as GoalTransition),
			);
		case "withdraw":
			return withGoal((id) =>
				actions.withdraw(db, access, id, rest as GoalTransition),
			);
		default:
			throw new Error("invalid_goal_input");
	}
}

/**
 * Runs the operations in order, each inside its own savepoint. A refusal with
 * a known reason code rolls back only that operation; any other error is a
 * bug or a database failure and propagates so the caller's transaction aborts.
 */
export function applyGoalOps(
	db: Database,
	access: GoalAccess,
	ops: readonly GoalOp[],
	actions: GoalActions,
): GoalOpResult[] {
	if (ops.length > MAX_GOAL_OPS) throw new Error("goal_ops_limit");
	return ops.map((op, index): GoalOpResult => {
		db.exec("SAVEPOINT goals_op");
		try {
			const done = dispatch(db, access, op, actions);
			db.exec("RELEASE goals_op");
			return { index, status: "applied", ...done };
		} catch (error) {
			db.exec("ROLLBACK TO goals_op");
			db.exec("RELEASE goals_op");
			const reason = error instanceof Error ? error.message : "";
			if (!known.has(reason)) throw error;
			return { index, status: "rejected", reason: reason as GoalRejectReason };
		}
	});
}
