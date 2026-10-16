import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { isSystemPrompt, type Run } from "../contracts";
import { endTransition } from "../repository";
import type { DialogueDeps } from "./context";
import { releaseSpecialistTurn } from "./specialist-turn-end";

const log = getLogger("dialogue");

export type RunEndState = "completed" | "failed" | "interrupted" | "cancelled";

/**
 * What the rest of the system learns when a run ends (section 2.5), in the transaction that ends it:
 * - completed: the exchange with its adopted answer (`answered`);
 * - failed or interrupted (the system's failure): the user's message alone (`failed`);
 * - cancelled (the user withdrew it) and the system's own prompts: no exchange;
 * then the steward is told, whatever the way it ended.
 * A specialist session's turn is neither: its work is released from the turn and nothing is learned from it.
 */
export function runEndedInTransaction(
	deps: Pick<DialogueDeps, "memory" | "steward" | "specialist" | "clock">,
	tx: Database,
	run: Run,
	state: RunEndState,
	answerMessageId: string | null,
): void {
	if (run.specialistSessionId) {
		releaseSpecialistTurn(deps, tx, run);
		return;
	}
	if (state !== "cancelled" && !isSystemPrompt(run.sourceKind)) {
		try {
			deps.memory?.recordExchangeInTransaction(tx, {
				conversationId: run.conversationId,
				runId: run.id,
				inputMessageId: run.inputMessageId,
				answerMessageId: state === "completed" ? answerMessageId : null,
				outcome: state === "completed" ? "answered" : "failed",
			});
		} catch (error) {
			// Messages that are no longer there leave nothing to register; the run still ends.
			if (!(error instanceof Error) || error.message !== "invalid_exchange")
				throw error;
			log.warn("dialogue.exchange_not_recorded", {
				runId: run.id,
				reason: "invalid_exchange",
			});
		}
	}
	deps.steward?.runEndedInTransaction(tx, {
		runId: run.id,
		conversationId: run.conversationId,
		state,
	});
}

/**
 * The one place a run reaches a terminal state: the transition, the exchange of memory's ledger, and the
 * steward's notice happen together. `run` is the run as it was read (its revision guards the transition).
 * false: the run had already moved on, nothing was recorded.
 */
export function endRun(
	deps: Pick<DialogueDeps, "memory" | "steward" | "specialist" | "clock">,
	tx: Database,
	run: Run,
	state: RunEndState,
	error: string | null = null,
	answerMessageId: string | null = null,
): boolean {
	if (
		!endTransition(
			tx,
			run.id,
			run.revision,
			state,
			deps.clock(),
			error,
			answerMessageId,
		)
	)
		return false;
	runEndedInTransaction(deps, tx, run, state, answerMessageId);
	return true;
}
