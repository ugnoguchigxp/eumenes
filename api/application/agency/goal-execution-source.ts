import type {
	GoalAttempt,
	GoalPermit,
	GoalProgress,
} from "eumenes-agency/agenda/runtime";
import { hash } from "../../domains/capabilities";
import type { GoalExecutionSource } from "../../domains/tool-runtime";

export function goalExecutionSource(
	row: GoalProgress,
	attempt: GoalAttempt,
	permit: GoalPermit,
): GoalExecutionSource {
	const { request, expectedObservation } = attempt.step;
	return {
		origin: "goal",
		runId: attempt.dispatchId,
		principal: row.principal,
		scopeKey: row.ledgerScope,
		goalId: row.goalId,
		goalRevision: row.goalRevision,
		attemptId: attempt.id,
		permitId: attempt.permitId,
		permitRevision: attempt.permitRevision,
		toolchainRevisionId: permit.toolchainRevisionId,
		bindingRevisionId: attempt.bindingRevisionId,
		request,
		expectedObservation,
		digest: hash([request, expectedObservation]),
	};
}
