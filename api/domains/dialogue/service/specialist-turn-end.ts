import type { Database } from "bun:sqlite";
import type { Run } from "../contracts";
import {
	patchSession,
	sessionById,
	unfinishedSessionRuns,
} from "../repository";
import type { DialogueDeps } from "./context";

/**
 * A run of a specialist session ended (any way): the domain's work is released from the turn. When another
 * utterance of the session is already queued behind it, that turn takes the work at once (so the work is
 * never free between two turns); otherwise the session has no active run. No-op for a run that does not hold
 * the work, so late or repeated calls are harmless.
 */
export function releaseSpecialistTurn(
	deps: Pick<DialogueDeps, "specialist" | "clock">,
	tx: Database,
	run: Run,
) {
	if (!run.specialistSessionId || !deps.specialist) return;
	const session = sessionById(tx, run.specialistSessionId);
	if (!session) return;
	deps.specialist.endTurnInTransaction(
		tx,
		session.adapterRef,
		session.workRef,
		run.id,
	);
	if (session.activeRunId !== run.id) return;
	const next =
		session.state === "active"
			? unfinishedSessionRuns(tx, session.id).find(
					(entry) => entry.id !== run.id && entry.status === "queued",
				)
			: undefined;
	if (next) {
		try {
			deps.specialist.beginTurnInTransaction(
				tx,
				session.adapterRef,
				session.workRef,
				next.id,
			);
			patchSession(tx, session.id, { activeRunId: next.id }, deps.clock());
			return;
		} catch {
			// The work cannot be taken: the queued turn finds no holder and ends with a clear code.
		}
	}
	patchSession(tx, session.id, { activeRunId: null }, deps.clock());
}
