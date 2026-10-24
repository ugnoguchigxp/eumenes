import type { Database } from "bun:sqlite";
import { byId } from "../repository";

/** Only a live, saved human input can authorize a local action; a host-written prompt authorizes nothing. */
export function readActionOriginInTransaction(db: Database, runId: string) {
	const run = byId(db, runId);
	if (!run || !["queued", "running"].includes(run.status)) return null;
	if (run.sourceKind !== "manual" && run.sourceKind !== "voice") return null;
	return {
		conversationId: run.conversationId,
		messageId: run.inputMessageId,
		runId: run.id,
		taskId: run.agentTaskId,
	};
}
