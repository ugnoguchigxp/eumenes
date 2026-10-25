import type { Database } from "bun:sqlite";
import type { HandlerDefinition } from "../../queue";
import type { Receipt } from "../../inference";
import { hostDelivery, type DeliveryEmotion } from "../../delivery";
import { jstSeconds } from "../../../infrastructure/jst-time";
import type { Run } from "../contracts";
import type { ToolchainRoutingPort } from "../contracts/toolchains";
import { byId, linkAnswer, transition } from "../repository";
import {
	GENERATE_KIND,
	type DialogueDeps,
	type GenerateInput,
	type GeneratePayload,
} from "./context";
import type { Handover } from "./executor-context";
import { eventFields, SIDE_EFFECTS, type Heard } from "./event-fields";
import { generationStale } from "./generation-stream";
import { adoptMemoryWindow } from "./memory-window";
import { consumeAnswer } from "./result-intake";
import { endRun, type RunEndState } from "./run-end";

export type GenerationResult = {
	/** The speech the generation ends with ("" for silence or a handover). */
	text: string;
	receipt?: Receipt;
	/** The feeling the agent chose for its reply: the reply's voice tone and motion (never judged again). */
	emotion?: DeliveryEmotion;
	/** A delegation ended the generation: the announcement was delivered and the work handed over. */
	handover?: Handover;
	/** The generation issued a confirmation: its speech is the confirmation statement (section 6.7). */
	confirmation?: true;
	/** The trace of an utterance generation that answered without handing work over. */
	selection?: Omit<
		Parameters<ToolchainRoutingPort["recordSelectionInTransaction"]>[1],
		"runId"
	>;
};
export type GenerationHandler = HandlerDefinition<
	GeneratePayload,
	GenerateInput,
	GenerationResult
>;

/** The actions that commit a side effect (section 8.2); reads and searches are not among them. */
/**
 * A generation that committed an action and then was not adopted (section 13): its speech is dropped and a new
 * generation of the run starts on the trigger "not adopted", once. False when it committed nothing, or already
 * was such a retry.
 */
function retryNotAdopted(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	input: GenerateInput | null | undefined,
	payload: GeneratePayload,
): boolean {
	if (!input || payload.notAdopted) return false;
	const committed = deps.continuity.events
		.logInTransaction(tx, run.conversationId)
		.some(
			(event) =>
				event.seq > input.lastSeq &&
				event.type === "acted" &&
				event.by === "agent" &&
				SIDE_EFFECTS.has(String(eventFields(event).action)),
		);
	if (!committed) return false;
	const { job } = deps.queue.enqueueInTransaction(tx, {
		scope: "dialogue",
		kind: GENERATE_KIND,
		dedupeKey: `not-adopted:${run.id}:${run.revision}`,
		payload: { runId: run.id, notAdopted: true },
		subjectRef: run.id,
		lane: "interactive",
		resourceKey: "inference.llm",
		maxAttempts: 1,
		concurrencyKey: `conversation:${run.conversationId}`,
		deadlineAtMs: Date.parse(run.deadlineAt!),
	});
	linkAnswer(tx, run.id, job.id);
	return transition(tx, run.id, run.revision, "queued", deps.clock());
}

/** A failed adoption ends the run and the decision it carried. */
/**
 * A failed generation's utterances join the log unanswered: the user saw the failure and says it again if it still
 * matters. Left pending, every later generation would answer them all again, and a pile of them made the model
 * answer each in turn without end (2026-10-24). A cancelled run keeps them pending (the user stopped it).
 */
function handleFailedUtterances(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	input: GenerateInput | null | undefined,
) {
	if (input?.final.kind === "utterances")
		deps.continuity.events.handleInTransaction(
			tx,
			run.conversationId,
			input.final.seqs,
		);
}

function fail(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	code: string,
	input: GenerateInput,
) {
	if (run.agentTaskId) deps.agents?.failAnswerInTransaction(tx, run.id, code);
	if (endRun(deps, tx, run, "failed", code))
		handleFailedUtterances(deps, tx, run, input);
	deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
		outcome: "failed",
		code,
	});
	return { status: "failed" as const, errorCode: code };
}

/**
 * The adoption of a generation in the queue writer transaction (the ContextWindow specification, sections 8 and
 * 11.3): the speech becomes the assistant message and the agent's `said` event, the handled utterances join the
 * log, a told TODO's archive is confirmed by the delivery, and the run ends.
 */
export function createGenerationSettlement(
	deps: DialogueDeps,
): GenerationHandler["settleInTransaction"] {
	const { larm, memory, clock, id, conversation, continuity } = deps;
	const events = continuity.events;
	return (tx, claim, input, outcome) => {
		const run = byId(tx, claim.payload.runId);
		if (!run) return "stale";
		if (outcome.type === "success") {
			const result = outcome.result;
			if (!input) return "stale";
			// A handed-over run is queued behind its work already; nothing more is adopted here.
			if (result.handover?.handed) return "applied";
			if (run.status !== "running" || run.revision !== input.revision)
				return "stale";
			const stale = generationStale(deps, tx, input);
			if (stale)
				return retryNotAdopted(deps, tx, run, input, claim.payload)
					? "applied"
					: fail(deps, tx, run, stale, input);
			// The answer spoke of a report whose evidence changed since (H4/R8): it is not adopted, nor is the report.
			if (
				input.agent &&
				!result.handover &&
				!consumeAnswer(deps, tx, run, input.agent)
			)
				return fail(deps, tx, run, "report_invalidated", input);
			// A handover was this generation's adoption: its receipt and memory were taken there.
			if (input.memory && memory && !result.handover) {
				const adopted = adoptMemoryWindow(memory, tx, run, input.memory);
				if (!adopted.ok)
					return retryNotAdopted(deps, tx, run, input, claim.payload)
						? "applied"
						: fail(deps, tx, run, adopted.reason, input);
			}
			if (
				result.receipt &&
				!result.handover &&
				!larm.acceptInTransaction?.(tx, result.receipt)
			) {
				memory?.discardUsageInTransaction(tx, run.id);
				return retryNotAdopted(deps, tx, run, input, claim.payload)
					? "applied"
					: fail(deps, tx, run, "permission_revoked", input);
			}
			if (input.final.kind === "utterances")
				events.handleInTransaction(tx, run.conversationId, input.final.seqs);
			// A task or a pipeline runs on its own: its announcement is the answer of this run.
			const text = result.handover?.announcement ?? result.text;
			let messageId: string | null = null;
			if (text.trim()) {
				messageId = id();
				conversation.appendInTransaction(tx, {
					id: messageId,
					conversationId: run.conversationId,
					role: "assistant",
					text,
					createdAt: clock(),
					runId: run.id,
				});
				if (!result.handover) said(deps, tx, run, messageId, text, result);
				const delivery = result.emotion
					? hostDelivery(result.emotion)
					: result.receipt?.delivery?.version === 2
						? result.receipt.delivery
						: null;
				if (delivery)
					conversation.recordAnswerDeliveryInTransaction(
						tx,
						run.id,
						run.conversationId,
						delivery,
					);
			}
			// The notices this answer carried are shown once: only an adopted answer clears them.
			if (input.memory && memory && !result.handover)
				memory.clearNoticesInTransaction(
					tx,
					run.conversationId,
					input.memory.window.noticeIds,
				);
			if (result.selection)
				deps.toolchains?.recordSelectionInTransaction(tx, {
					runId: run.id,
					utteranceId: run.utteranceId ?? null,
					requestId: run.requestId ?? null,
					...result.selection,
				});
			const done = endRun(deps, tx, run, "completed", null, messageId);
			if (done && result.selection)
				deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
					outcome: "completed",
				});
			return done ? "applied" : "stale";
		}
		// A run that is already terminal (e.g. cancelled), or handed over to another job, keeps its state.
		if (run.status !== "queued" && run.status !== "running") return "applied";
		if (run.jobId !== claim.jobId) return "applied";
		// A failure after an action committed starts the "not adopted" generation instead of ending the run.
		if (
			outcome.type !== "retry" &&
			retryNotAdopted(deps, tx, run, input, claim.payload)
		)
			return "applied";
		const next: [RunEndState | "queued", string | null] =
			outcome.type === "retry"
				? ["queued", outcome.errorCode]
				: outcome.type === "failed"
					? ["failed", outcome.errorCode]
					: outcome.type === "expired"
						? ["failed", "deadline_exceeded"]
						: ["interrupted", outcome.errorCode];
		if (run.agentTaskId)
			deps.agents?.failAnswerInTransaction(
				tx,
				run.id,
				next[1] ?? "answer_failed",
			);
		if (next[0] !== "queued")
			deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
				outcome: outcome.type === "expired" ? "expired" : "failed",
				code: next[1],
			});
		const moved =
			next[0] === "queued"
				? transition(tx, run.id, run.revision, "queued", clock(), next[1])
				: endRun(deps, tx, run, next[0], next[1]);
		if (moved && next[0] === "failed")
			handleFailedUtterances(deps, tx, run, input);
		return moved ? "applied" : "stale";
	};
}

/**
 * The agent's utterance as an event (section 8.1). A text-only reply is delivered in full when it is stored; a spoken one waits for its playback's `delivered`.
 */
function said(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	messageId: string,
	text: string,
	result: GenerationResult,
) {
	const events = deps.continuity.events;
	const at = jstSeconds(Date.parse(deps.clock()));
	const { event } = events.appendInTransaction(tx, {
		conversationId: run.conversationId,
		at,
		type: "said",
		by: "agent",
		fields: {
			text,
			...(result.confirmation ? { origin: "confirmation" } : {}),
		},
		messageIds: [messageId],
		deliveryKey: `run:${run.id}`,
	});
	const spoken =
		!!run.utteranceId &&
		(deps.larm.snapshotFor?.(tx, run.id)?.voice.autoSpeak ?? true);
	if (spoken) return;
	events.appendInTransaction(tx, {
		conversationId: run.conversationId,
		at,
		type: "delivered",
		by: "host",
		fields: { ref: event.id, heard: "full" },
	});
	confirmArchives(deps, tx, run, "full");
}

/**
 * The TODOs this run's reply reported (as the conversation agent's background update found) are archived once
 * the reply was heard in full (section 9.4); the others stay done, with the reason logged.
 */
export function confirmArchives(
	deps: DialogueDeps,
	tx: Database,
	run: Run,
	heard: Heard,
) {
	const ledger = deps.work;
	if (!ledger) return;
	const at = jstSeconds(Date.parse(deps.clock()));
	for (const row of ledger.waitingArchivesInTransaction(
		tx,
		run.conversationId,
	)) {
		if (row.archiveRequested !== `run:${run.id}`) continue;
		const archived =
			heard === "full" && ledger.archiveInTransaction(tx, row.id);
		deps.continuity.events.appendInTransaction(tx, {
			conversationId: run.conversationId,
			at,
			type: "acted",
			by: "host",
			fields: archived
				? { action: "work.archived", todo: row.id }
				: {
						action: "work.archive_unconfirmed",
						todo: row.id,
						reason: `heard_${heard}`,
					},
		});
	}
}
