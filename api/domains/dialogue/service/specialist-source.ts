import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { ExecutionResponse, ExecutionSource } from "../../tool-runtime";
import { byId, sessionById } from "../repository";
import type { DialogueDeps } from "./context";
import { sessionExpired } from "./specialist-core";

/** Revalidate a response already accepted by the owner of an inherited execution. */
export function specialistExecutionResponse(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	messageId: string,
	sessionId: string,
): ExecutionResponse | null {
	const message = deps.conversation.messageInTransaction(
		db,
		messageId,
	)?.message;
	const run = message?.runId && byId(db, message.runId);
	if (
		message?.role !== "user" ||
		message.conversationId !== conversationId ||
		!run ||
		run.inputMessageId !== messageId ||
		run.specialistSessionId !== sessionId ||
		!["manual", "voice"].includes(run.sourceKind) ||
		deps.memory?.isSourceRevokedInTransaction(db, messageId)
	)
		return null;
	return {
		messageId,
		request: message.text,
		digest: hash(message.text),
		specialistSessionId: sessionId,
	};
}

/** A work recorded this message when it held the turn. Address changes do not erase that provenance. */
export function hasSpecialistContribution(
	deps: DialogueDeps,
	db: Database,
	input: {
		runId: string;
		conversationId: string;
		messageId: string;
		digest: string;
	},
) {
	const run = byId(db, input.runId);
	const message = deps.conversation.messageInTransaction(
		db,
		input.messageId,
	)?.message;
	return (
		run?.inputMessageId === input.messageId &&
		run.conversationId === input.conversationId &&
		["manual", "voice"].includes(run.sourceKind) &&
		message?.role === "user" &&
		message.conversationId === input.conversationId &&
		hash(message.text) === input.digest &&
		!deps.memory?.isSourceRevokedInTransaction(db, message.id)
	);
}

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
