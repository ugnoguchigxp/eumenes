import type { Database } from "bun:sqlite";
import { byId } from "../repository";

/** 非同期実行が、依頼に使った元発言の失効を後から照合するための参照。 */
export function commandInputMessageIdsInTransaction(
	db: Database,
	runId: string,
) {
	const run = byId(db, runId);
	return run ? [run.inputMessageId] : [];
}

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
