import type { Database } from "bun:sqlite";
import { byId } from "../repository";
import { eventsOf, openInteractionOfRun } from "../repository/interactions";

/** 非同期実行が、確認に使った元発言と回答の失効を後から照合するための参照。 */
export function commandInputMessageIdsInTransaction(
	db: Database,
	runId: string,
) {
	const run = byId(db, runId);
	if (!run) return [];
	const ids = new Set([run.inputMessageId]);
	const interaction = openInteractionOfRun(db, runId);
	if (interaction) {
		ids.add(interaction.originMessageId);
		for (const event of eventsOf(db, interaction.id)) {
			if (event.kind !== "answer" || !event.payloadJson) continue;
			const payload = JSON.parse(event.payloadJson) as { runId?: string };
			const answer = payload.runId ? byId(db, payload.runId) : null;
			if (answer?.conversationId === run.conversationId)
				ids.add(answer.inputMessageId);
		}
	}
	return [...ids];
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
