import type { Database } from "bun:sqlite";
import { byId, continuationOf } from "../repository";

/**
 * Only a live, saved human input can authorize a local action. A continuation acts for the human input of the
 * run its request started from; any other host-written prompt authorizes nothing.
 */
export function readActionOriginInTransaction(db: Database, runId: string) {
	const run = byId(db, runId);
	if (!run || !["queued", "running"].includes(run.status)) return null;
	const root =
		run.sourceKind === "continuation"
			? byId(db, continuationOf(db, run.id)?.rootRunId ?? "")
			: run;
	if (
		!root ||
		root.conversationId !== run.conversationId ||
		(root.sourceKind !== "manual" && root.sourceKind !== "voice")
	)
		return null;
	return {
		conversationId: run.conversationId,
		messageId: root.inputMessageId,
		runId: run.id,
		taskId: run.agentTaskId,
	};
}
