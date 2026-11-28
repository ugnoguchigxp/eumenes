import type { GoalProgress } from "eumenes-agency/agenda/runtime";
import { goalDigest } from "./goal-progress-context";

/**
 * The message id a goal question was once written to the conversation under (before goal questions became the
 * agent's assignments' questions): such a message is still retracted when the goal's inputs are forgotten.
 */
export function goalQuestionMessageId(row: GoalProgress, ref: string) {
	return `agency-goal-question:${goalDigest([row.principal, row.goalId, row.goalRevision, ref])}`;
}
