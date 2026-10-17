import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import {
	byId,
	linkAnswer,
	unfinishedSessionRuns,
	patchSession,
	sessionById,
	setRunSession,
	transition,
	type SessionRecord,
} from "../repository";
import type { Run } from "../contracts";
import {
	GENERATE_KIND,
	type DialogueDeps,
	type SpecialistTurnPayload,
} from "./context";
import { endRun, type RunEndState } from "./run-end";
import { traceFailure, traceOutcome } from "./selection-trace";
import {
	blockSpecialistMessages,
	endOrMarkClosing,
	turnRefusal,
} from "./specialist-core";
import { releaseSpecialistTurn } from "./specialist-turn-end";
import type { TurnInput, TurnOutput } from "./specialist-turn";

const HANDOFF_LABEL_CHARS = 60;

function failTurn(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	code: string,
): { status: "failed"; errorCode: string } {
	endRun(deps, tx, run, "failed", code);
	traceFailure(deps, tx, run.id, "failed", code);
	return { status: "failed", errorCode: code };
}

/** The specialist's words as the session's assistant message (blocked like the rest of the session). */
function appendSpecialistAnswer(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	text: string,
): string {
	const messageId = deps.id();
	deps.conversation.appendInTransaction(tx, {
		id: messageId,
		conversationId: run.conversationId,
		role: "assistant",
		text,
		createdAt: deps.clock(),
		runId: run.id,
	});
	blockSpecialistMessages(deps, tx, run.conversationId, [messageId]);
	return messageId;
}

/** Hand the run to the main agent: its user message is the conversation's again, once. */
function forwardToMain(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	record: SessionRecord,
	state: "suspended" | "ended" | "closing",
	label: string,
) {
	deps.memory?.unblockSpecialistMessagesInTransaction(tx, [run.inputMessageId]);
	setRunSession(tx, run.id, null);
	const handoff = JSON.stringify({
		specialist: record.title,
		work: state,
		label: label.slice(0, HANDOFF_LABEL_CHARS),
	});
	const { job } = deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: GENERATE_KIND,
		dedupeKey: `specialist-forward:${run.id}:${record.id}:${record.epoch}`,
		payload: { runId: run.id, specialistHandoff: handoff },
		subjectRef: run.id,
		lane: "interactive",
		resourceKey: "inference.llm",
		maxAttempts: 1,
		concurrencyKey: `conversation:${run.conversationId}`,
		deadlineAtMs: Date.parse(run.deadlineAt!),
	});
	linkAnswer(tx, run.id, job.id);
	transition(tx, run.id, run.revision, "queued", deps.clock());
}

type Handler = HandlerDefinition<SpecialistTurnPayload, TurnInput, TurnOutput>;

/**
 * Apply a finished specialist turn: a reply is adopted as the session's answer; a return suspends (unsaved
 * work) or ends the session and, for a request out of the specialist's scope, hands the same run to the main
 * agent; a discard ends the session and drops the draft.
 */
export function settleSpecialistTurn(
	deps: DialogueDeps,
	tx: Database,
	claim: Parameters<Handler["settleInTransaction"]>[1],
	input: TurnInput | null,
	outcome: Parameters<Handler["settleInTransaction"]>[3],
): ReturnType<Handler["settleInTransaction"]> {
	const run = byId(tx, claim.payload.runId);
	if (!run) return "stale";
	if (outcome.type !== "success") {
		// A run that is already terminal (e.g. cancelled) keeps its state.
		if (run.status !== "queued" && run.status !== "running") return "applied";
		const next: [RunEndState | "queued", string | null] =
			outcome.type === "retry"
				? ["queued", outcome.errorCode]
				: outcome.type === "failed"
					? ["failed", outcome.errorCode]
					: outcome.type === "expired"
						? ["failed", "deadline_exceeded"]
						: ["interrupted", outcome.errorCode];
		if (next[0] !== "queued")
			traceFailure(deps, tx, run.id, outcome.type, next[1]);
		const moved =
			next[0] === "queued"
				? transition(tx, run.id, run.revision, "queued", deps.clock(), next[1])
				: endRun(deps, tx, run, next[0], next[1]);
		return moved ? "applied" : "stale";
	}
	if (!input || run.status !== "running" || run.revision !== input.revision)
		return "stale";
	const session = run.specialistSessionId
		? sessionById(tx, run.specialistSessionId)
		: null;
	const refusal = turnRefusal(
		session,
		run.id,
		claim.payload.epoch,
		deps.clock(),
	);
	if (refusal || !session) return failTurn(deps, tx, run, refusal ?? "x");
	for (const receipt of outcome.result.receipts)
		if (!deps.larm.acceptInTransaction?.(tx, receipt))
			return failTurn(deps, tx, run, "permission_revoked");
	const { action } = outcome.result;
	if (action.kind === "reply") {
		const messageId = appendSpecialistAnswer(deps, tx, run, action.text);
		const done = endRun(deps, tx, run, "completed", null, messageId);
		if (done) traceOutcome(deps, tx, run.id, { outcome: "completed" });
		return done ? "applied" : "stale";
	}
	return settleHandback(deps, tx, run, session, action);
}

/** return / discard: the turn gives the work back; the session is suspended or ended. */
function settleHandback(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	session: SessionRecord,
	action: Extract<TurnOutput["action"], { kind: "return" | "discard" }>,
): ReturnType<Handler["settleInTransaction"]> {
	const port = deps.specialist!;
	const record = sessionById(tx, session.id) as SessionRecord;
	const work = port.workStateInTransaction(
		tx,
		record.adapterRef,
		record.workRef,
	);
	const label = work?.label ?? record.label;
	// Utterances already queued behind this turn were meant for the specialist, who is leaving: they go to
	// the main agent instead of being lost.
	const leaving =
		action.kind === "return" && work?.dirty ? "suspended" : "ended";
	for (const queued of unfinishedSessionRuns(tx, record.id)) {
		const sibling = queued.id === run.id ? null : byId(tx, queued.id);
		if (sibling) forwardToMain(deps, tx, sibling, record, leaving, label);
	}
	// The turn gives the work back: an end or a suspension must not find it busy.
	releaseSpecialistTurn(deps, tx, run);
	let state: "suspended" | "ended" | "closing";
	if (action.kind === "return" && work?.dirty) {
		patchSession(
			tx,
			record.id,
			{ state: "suspended", label, bump: true },
			deps.clock(),
		);
		state = "suspended";
	} else {
		const ended = endOrMarkClosing(
			deps,
			tx,
			record,
			action.kind === "discard" ? "discarded" : "returned",
			run.id,
		);
		state = ended.state;
	}
	if (action.kind === "return" && action.forward) {
		forwardToMain(deps, tx, run, record, state, label);
		return "applied";
	}
	const messageId = action.text
		? appendSpecialistAnswer(deps, tx, run, action.text)
		: null;
	const done = endRun(deps, tx, run, "completed", null, messageId);
	if (done) traceOutcome(deps, tx, run.id, { outcome: "completed" });
	return done ? "applied" : "stale";
}
