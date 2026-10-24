import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import { endTransition } from "../repository";
import type { DialogueDeps } from "./context";
import { releaseSpecialistTurn } from "./specialist-turn-end";

export type RunEndState = "completed" | "failed" | "interrupted" | "cancelled";

/**
 * What the rest of the system learns when a run ends, in the transaction that ends it: the work it waited for
 * ends with it unless it completed, then the steward is told, whatever the way it ended.
 * A specialist session's turn is neither: its work is released from the turn and nothing is learned from it.
 */
export function runEndedInTransaction(
	deps: Pick<DialogueDeps, "steward" | "specialist" | "clock" | "work">,
	tx: Database,
	run: Run,
	state: RunEndState,
): void {
	if (run.specialistSessionId) {
		releaseSpecialistTurn(deps, tx, run);
		return;
	}
	// Work the run was waiting for ends with it: its TODO is done with the run's outcome (section 10.1).
	if (state !== "completed" && deps.work)
		for (const row of deps.work.waitingOfRunInTransaction(tx, run.id))
			deps.work.reportInTransaction(tx, row.id, {
				status: "done",
				outcome:
					state === "cancelled"
						? "cancelled"
						: state === "interrupted"
							? "interrupted"
							: "failed",
				result: null,
			});
	deps.steward?.runEndedInTransaction(tx, {
		runId: run.id,
		conversationId: run.conversationId,
		state,
	});
}

/**
 * The one place a run reaches a terminal state: the transition, the work it waited for, and the
 * steward's notice happen together. `run` is the run as it was read (its revision guards the transition).
 * false: the run had already moved on, nothing was recorded.
 */
export function endRun(
	deps: Pick<DialogueDeps, "steward" | "specialist" | "clock" | "work">,
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
	runEndedInTransaction(deps, tx, run, state);
	return true;
}
