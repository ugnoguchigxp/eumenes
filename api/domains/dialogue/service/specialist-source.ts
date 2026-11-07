import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { ExecutionSource } from "../../tool-runtime";
import { byId, sessionById } from "../repository";
import type { DialogueDeps } from "./context";
import { sessionExpired } from "./specialist-core";

/** A session's user input stays private from recall but may authorize that same session's work. */
export function specialistExecutionSource(
	deps: DialogueDeps,
	db: Database,
	runId: string,
	expectedSession?: string,
	expectedEpoch?: number,
): (ExecutionSource & { messageId: string }) | null {
	const run = byId(db, runId);
	if (
		!run?.specialistSessionId ||
		!["manual", "voice"].includes(run.sourceKind)
	)
		return null;
	const session = sessionById(db, run.specialistSessionId);
	if (
		!session ||
		!["active", "suspended"].includes(session.state) ||
		(expectedEpoch !== undefined && session.state !== "active") ||
		sessionExpired(session, deps.clock()) ||
		(expectedSession !== undefined && session.id !== expectedSession) ||
		(expectedEpoch !== undefined && session.epoch !== expectedEpoch)
	)
		return null;
	const found = deps.conversation.messageInTransaction(
		db,
		run.inputMessageId,
	)?.message;
	if (
		!found ||
		found.role !== "user" ||
		found.conversationId !== session.conversationId ||
		deps.memory?.isSourceRevokedInTransaction(db, found.id)
	)
		return null;
	return {
		conversationId: session.conversationId,
		messageId: found.id,
		runId,
		request: found.text,
		digest: hash(found.text),
		specialistSessionId: session.id,
		specialistEpoch: session.epoch,
	};
}
