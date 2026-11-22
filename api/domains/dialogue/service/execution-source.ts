import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import {
	isStandardExecutionSource,
	type ExecutionSource,
} from "../../tool-runtime";
import { confirmationById } from "../repository/work";
import { byId } from "../repository";
import type { DialogueDeps } from "./context";

/** A completed originating conversation turn may own a still active parent. Notices never authorize it. */
export function executionSourceInTransaction(
	deps: DialogueDeps,
	db: Database,
	runId: string,
): (ExecutionSource & { messageId: string }) | null {
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

/** Recover the frozen request explicitly approved by this turn and still present in the conversation. */
export function confirmedExecutionRequest(
	deps: DialogueDeps,
	db: Database,
	source: ExecutionSource,
	confirmationId: string,
	requestedText: string,
) {
	const current = executionSourceInTransaction(deps, db, source.runId);
	if (
		!isStandardExecutionSource(source) ||
		source.origin ||
		!current ||
		source.messageId !== current.messageId ||
		source.conversationId !== current.conversationId ||
		source.digest !== current.digest ||
		source.request !== current.request
	)
		return null;
	const row = confirmationById(db, confirmationId);
	if (
		!row ||
		row.usedByRun !== source.runId ||
		!row.usedAt ||
		row.supersededAt ||
		row.toolchainId !== "development-supervision.request" ||
		row.conversationId !== source.conversationId ||
		row.request !== requestedText ||
		!deps.work?.confirmationStatementInTransaction(db, row)
	)
		return null;
	const blocked =
		deps.memory?.blockedMessageIdsOfConversationInTransaction(
			db,
			source.conversationId,
		) ?? [];
	if (row.messageIds?.some((id) => blocked.includes(id))) return null;
	return { request: row.request, digest: hash(row.request) };
}
