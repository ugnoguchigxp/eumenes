import type { Database } from "bun:sqlite";
import { byRequest } from "../repository";
import type { DialogueDeps } from "./context";
import { endRun } from "./run-end";

/** A forgotten source cannot leave an already queued result answer adoptable. */
export function revokeExecutionNotice(
	deps: DialogueDeps,
	db: Database,
	eventId: string,
) {
	const run = byRequest(db, eventId);
	if (!run || !["queued", "running"].includes(run.status)) return;
	endRun(deps, db, run, "cancelled", "execution_source_forgotten");
	if (run.jobId)
		deps.queue.cancelInTransaction(db, run.jobId, "execution_source_forgotten");
	deps.larm.revokeAgentAttemptsInTransaction?.(db, {
		messageIds: [run.inputMessageId],
		itemIds: [],
	});
}
