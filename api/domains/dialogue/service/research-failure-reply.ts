import type { AnswerTicket } from "../../agent-runtime";

/**
 * The answer to a failed research. The host adopts it as the answer without a model call: the failure code is
 * recorded with the run (the selection outcome), and the cause is read from there, not explained in speech.
 */
export const RESEARCH_FAILURE_REPLY = "失敗しました。";

/** A research that failed is answered by the host; a failed action keeps its result for the model to phrase. */
export function researchFailed(agent: AnswerTicket | undefined): boolean {
	return !!agent?.failureCode && !agent.actionFailure;
}
