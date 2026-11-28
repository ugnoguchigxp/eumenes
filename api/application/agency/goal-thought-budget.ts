import type { GoalStep, GoalStepContext } from "eumenes-agency/agenda";

/**
 * One autonomous run (from registration, an update or an answer of the owner, until done, a question or this
 * bound) thinks at most this many rounds, failed ones included; its session (the `goal-pursuit` plan) allows
 * as many. Then the goal asks the owner once and stops.
 */
export const THOUGHT_LIMIT = 4;

/** What a turn leaves of the autonomous run's budget, stored with the goal's cycle. */
export type ThoughtBudget = {
	/** Thought-plan runs that called the model in this autonomous run (see `THOUGHT_LIMIT`). */
	readonly thoughts: number;
	/** The questions the owner had answered when this autonomous run began; a new answer starts the next run. */
	readonly answers: readonly string[];
	/** Why the last turn that thought concluded what it did, in the model's words. */
	readonly reason: string | null;
};

/** A failed turn whose run reached the model counts against the budget; one that never sent a call does not. */
export function thoughtCounted(code: string) {
	return (
		code.startsWith("goal_cycle_") &&
		code !== "goal_cycle_stage_input_too_large" &&
		code !== "goal_cycle_llm_preempted" &&
		code !== "goal_cycle_cancelled"
	);
}

/**
 * The one message an autonomous run ends with when it may not think again (its bound of thinking, or its
 * session's rounds, are used up): what the goal is, how often it thought, and the model's last reason. Its
 * answer, whatever it says, begins the next run.
 */
export function ownerNotice(
	context: GoalStepContext,
	budget: ThoughtBudget,
): GoalStep {
	const goal = context.goal.desiredState.slice(0, 120);
	return {
		contextId: context.contextId,
		progressVersion: context.progressVersion,
		kind: "ask",
		criterionIds: context.criteria
			.filter(({ status }) => status === "open")
			.map(({ id }) => id),
		reason: "1回の自発行動で考えられる上限に達した。",
		review: null,
		missing: "続けてよいかと、やり方の指定",
		question: [
			`目標「${goal}」について、${budget.thoughts}回考えて進めましたが、達成を確かめられていません。`,
			...(budget.reason ? [`最後の判断: ${budget.reason}`] : []),
			"続けてよいか、やり方の指定があれば教えてください。",
		].join("\n"),
	};
}
