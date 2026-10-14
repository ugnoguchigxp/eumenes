import type { GoalStatus, StewardGoal } from "../../goals";
import { clipChars } from "./budget";
import type { StepEnv } from "./types";

/** Goals shown to the model at once. Adopted ones first (30 at most exist), then proposals (50), then the rest. */
const GOALS_SHOWN = 40;
const GOAL_TEXT_CHARS = 200;

export type GoalRefEntry = {
	goalId: string;
	revision: number;
	status: GoalStatus;
};
export type GoalsView = {
	/** `g1`... -> the goal (ids and revisions never reach the model). */
	refs: Record<string, GoalRefEntry>;
	goals: Array<{
		ref: string;
		status: GoalStatus;
		priority: number;
		text: string;
		updated: string;
	}>;
};

const ORDER: Record<GoalStatus, number> = {
	adopted: 0,
	proposed: 1,
	completed: 2,
	withdrawn: 3,
};

/** The goals of the conversation's access in the given statuses, newest change first within a status. */
export function describeGoals(
	env: StepEnv,
	statuses: readonly GoalStatus[],
	limit = GOALS_SHOWN,
): GoalsView | null {
	const { db, deps } = env;
	const goals = deps.goals;
	if (!goals) return null;
	const listed: StewardGoal[] = goals.ops
		.listForStewardInTransaction(db, goals.access, statuses)
		.sort(
			(a, b) =>
				ORDER[a.status] - ORDER[b.status] ||
				b.updatedAt.localeCompare(a.updatedAt) ||
				a.goalId.localeCompare(b.goalId),
		)
		.slice(0, limit);
	const refs: GoalsView["refs"] = {};
	const shown: GoalsView["goals"] = listed.map((goal, i) => {
		const ref = `g${i + 1}`;
		refs[ref] = {
			goalId: goal.goalId,
			revision: goal.revision,
			status: goal.status,
		};
		return {
			ref,
			status: goal.status,
			priority: goal.priority,
			text: clipChars(goal.desiredState, GOAL_TEXT_CHARS),
			updated: goal.updatedAt.slice(0, 10),
		};
	});
	return { refs, goals: shown };
}
