import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { ExecutionSource } from "../../tool-runtime";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";

/** A completed originating conversation turn may own a still active parent. Notices never authorize it. */
export function executionSourceInTransaction(
	deps: DialogueDeps,
	db: Database,
	runId: string,
): ExecutionSource | null {
	const run = byId(db, runId);
	if (!run || !["manual", "voice"].includes(run.sourceKind)) return null;
	const found = deps.conversation.messageInTransaction(db, run.inputMessageId);
	if (
		!found ||
		found.message.role !== "user" ||
		found.message.conversationId !== run.conversationId ||
		deps.memory
			?.blockedMessageIdsOfConversationInTransaction(db, run.conversationId)
			.includes(run.inputMessageId)
	)
		return null;
	return {
		conversationId: run.conversationId,
		messageId: run.inputMessageId,
		runId,
		request: found.message.text,
		digest: hash(found.message.text),
	};
}
