import type { Database } from "bun:sqlite";
import { hash } from "../../capabilities";
import type { ExecutionReference } from "../../tool-runtime";
import {
	byId,
	sessionById,
	sessionEvents,
	type SessionRecord,
} from "../repository";
import type { DialogueDeps } from "./context";
import { specialistReviewConditions } from "./collaboration-state";
import { withAttachmentNotes } from "./attachment-context";

/** Preserve the actual messages and confirmed conditions behind the switch, as reference data. */
export function specialistHandoffContext(
	deps: DialogueDeps,
	db: Database,
	session: SessionRecord,
	enabled: boolean,
	currentRunId: string,
) {
	const handoffs = sessionEvents(db, session.id).filter(
		(event) => event.kind === "handover",
	);
	const initial =
		handoffs.findLast((event) => !!event.previousSessionId) ?? handoffs[0];
	const run = initial && byId(db, initial.runId);
	if (!run || (!enabled && !initial.previousSessionId)) return null;
	const previous = initial.previousSessionId
		? sessionById(db, initial.previousSessionId)
		: null;
	const recent = priorMessages(
		deps,
		db,
		session.conversationId,
		run.inputMessageId,
	);
	let remaining = 16_000;
	const messages = [];
	for (const { id, role, text, attachments } of [...recent].reverse()) {
		const line = {
			id,
			role,
			text: withAttachmentNotes(text, attachments).slice(0, 2500),
		};
		remaining -= Buffer.byteLength(JSON.stringify(line));
		if (remaining < 0) break;
		messages.unshift(line);
	}
	return {
		...(run.id === currentRunId ? { arrivedThisTurn: true } : {}),
		activeSpecialist: { id: session.toolchainId, title: session.title },
		recent: messages,
		conditions:
			previous?.conversationId === session.conversationId
				? specialistReviewConditions(deps, db, previous.id)
				: { state: "none" as const },
	};
}

function priorMessages(
	deps: DialogueDeps,
	db: Database,
	conversationId: string,
	messageId: string,
) {
	return deps.conversation
		.turnsBeforeInTransaction(db, conversationId, messageId, 16)
		.filter(
			(message) => !deps.memory?.isSourceRevokedInTransaction(db, message.id),
		);
}

export function specialistHandoffReferences(db: Database, sessionId: string) {
	return sessionEvents(db, sessionId)
		.flatMap((event) =>
			event.kind === "handover" ? (event.references ?? []) : [],
		)
		.slice(-32);
}

/** Issue message references alongside the handoff transcript, using the same source checks as execution. */
export function specialistHandoffMaterials(
	deps: DialogueDeps,
	db: Database,
	sessionId: string,
): ExecutionReference[] {
	const issued = specialistHandoffReferences(db, sessionId);
	const session = sessionById(db, sessionId);
	const initial = sessionEvents(db, sessionId).find(
		(event) => event.kind === "handover",
	);
	const run = initial && byId(db, initial.runId);
	if (!session || !run) return issued;
	return [
		...issued,
		...priorMessages(deps, db, session.conversationId, run.inputMessageId)
			.filter((message) => message.role === "user" && !!message.text)
			.map((message) => ({
				ref: `message:${message.id}`,
				owner: "conversation",
				id: message.id,
				revision: "",
				digest: hash(message.text),
				label: message.text.slice(0, 160),
				kind: "message" as const,
				preview: message.text.slice(0, 2000),
			})),
	].slice(0, 32);
}
