import { answerSession, createAnswerStream } from "./generation-stream";
import { generationTiming } from "./generation-timing";
import { operationResultMessage } from "./context-format-current";
import { currentRequestMessage } from "./request-context";
import {
	resolveAttachmentContext,
	validAttachmentContext,
} from "./attachment-context";
import { z } from "zod";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import type { Receipt } from "../../inference";
import type { SettleResult } from "../../memory";
import type { HandlerDefinition } from "../../queue";
import { settleConversationOperation } from "./generation-operation";
import type { ConversationOperation } from "./conversation-tools";
import {
	agentOutcome,
	failedAnswer,
	prepareDecision,
	prepareInitialDecision,
	recordRejected,
	traceFailure,
	traceOutcome,
	traceSelection,
	type SelectionDraft,
} from "./selection-trace";
import { generateSelection } from "./generate-selection";
import { discoveryTool } from "./initial-decision";
import { announceSelection } from "./operation-announcement";
import { generateConversation } from "./conversation-generation";
import { researchCitations } from "./research-citations";
import type { Run } from "../contracts";
import { byId, transition } from "../repository";
import { endRun, type RunEndState } from "./run-end";
import {
	GENERATE_KIND,
	type DialogueDeps,
	type GenerateInput,
	type GeneratePayload,
} from "./context";
import { createPrepare } from "./generation-prepare";
import { flushDeferred } from "./specialist-core";
import { goalsLayerStale } from "./goals-layer";
import { adoptMemoryWindow, clearShownNotices } from "./memory-window";
import type { Progress } from "./progress";
const log = getLogger("dialogue");

function speaksChunks(deps: DialogueDeps, run: Run | null) {
	return (
		!!run?.utteranceId &&
		deps.store.read(
			(db) => deps.larm.snapshotFor?.(db, run.id)?.voice.autoSpeak ?? true,
		)
	);
}

function answerCollection(run: Run | null, chunkSpeech: boolean) {
	return run
		? {
				...(chunkSpeech ? { deliveryScope: "chunk" as const } : {}),
				collection: {
					conversationId: run.conversationId,
					turnId: run.id,
					granularity: "answer" as const,
					chunkOrder: null,
				},
			}
		: undefined;
}

function verifiedAnswerLinks(text: string, input: GenerateInput) {
	if (input.mediaResult)
		return researchCitations(text, null, { preserveLinkLabels: false });
	if (input.agent?.projection || input.agent?.failureCode)
		return researchCitations(text, input.agent.projection, {
			requireSources: true,
		});
	return text;
}

function shouldHoldBody(input: GenerateInput, chunkSpeech = false) {
	return !!(
		(!chunkSpeech && ((input.memory && !input.memory.quiet) || input.goals)) ||
		input.agent?.projection ||
		input.agent?.failureCode ||
		(!chunkSpeech && input.agent?.actionPayload) ||
		input.mediaResult
	);
}

/**
 * Refresh time/state before an operation's result is phrased, without repeating the operation.
 * A later change still rejects the generated answer at adoption.
 */
async function refreshActionResult(
	deps: DialogueDeps,
	agents: NonNullable<DialogueDeps["agents"]>,
	input: GenerateInput,
) {
	const refreshed = await deps.store.write((tx) => {
		const ticket = agents.prepareAnswerInTransaction(tx, input.runId);
		if (
			ticket.revision !== input.agent!.revision ||
			ticket.dataEpoch !== input.agent!.dataEpoch ||
			!ticket.actionPayload ||
			!agents.validAnswerInTransaction(tx, ticket)
		)
			throw new Error("report_invalidated");
		return { ticket, operation: JSON.parse(ticket.actionPayload) };
	});
	input.agent = refreshed.ticket;
	if (input.actionResultIndex === undefined)
		throw new Error("invalid_action_result");
	input.messages[input.actionResultIndex] = operationResultMessage(
		"operation.action",
		refreshed.operation,
	);
}

/** The queue handler of one generation: prepare, execute, settle (adopt) and cancel. */
export function createGenerationHandler(
	deps: DialogueDeps,
	{ partials, publish }: Pick<Progress, "partials" | "publish">,
) {
	const { store, conversation, larm, clock, id, memory, agents } = deps;

	const handler: HandlerDefinition<
		GeneratePayload,
		GenerateInput,
		{
			text: string;
			receipt?: Receipt;
			operation?: ConversationOperation;
			/** The decision this attempt made, recorded with its adoption. */
			selection?: SelectionDraft;
			recallPins?: Array<{ messageId: string; digest: string }>;
		}
	> = {
		kind: GENERATE_KIND,
		payloadVersions: [1],
		schema: z.object({
			runId: z.string(),
			commandNote: z.string().optional(),
			specialistHandoff: z.string().optional(),
		}),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction: createPrepare(deps),
		async execute(input, { signal: caller }) {
			let signal = caller;
			let closeStream = () => {};
			const run = store.read((db) => byId(db, input.runId));
			return withLogContext(
				{
					runId: input.runId,
					requestId: run?.requestId,
					utteranceId: run?.utteranceId ?? undefined,
				},
				async () => {
					log.info("dialogue.generation_started");
					const timing = generationTiming();
					resolveAttachmentContext(deps, input, run!.conversationId);
					if (input.agent?.actionPayload && agents) {
						await refreshActionResult(deps, agents, input);
						signal.throwIfAborted();
					}
					const chunkSpeech = speaksChunks(deps, run);
					let holdBody =
						!!input.briefReply || shouldHoldBody(input, chunkSpeech);
					const initial = !!input.routing && !input.agent;
					let decision = initial
						? await prepareInitialDecision(deps, input, signal)
						: await prepareDecision(deps, input, signal);
					const { recallPins } = decision;
					const body = createAnswerStream(
						deps,
						input,
						signal,
						partials,
						publish,
						timing,
						() => holdBody,
						recallPins,
					);
					closeStream = body.close;
					signal = body.signal;
					const delta = body.delta;
					const preparation = answerCollection(run, chunkSpeech);
					// What this turn's prompt stands on: forgetting any of it revokes the call while it runs.
					holdBody ||=
						(!chunkSpeech && recallPins.length > 0) ||
						initial ||
						!!decision.tools?.length;
					timing.policy(holdBody);
					let generated: Awaited<ReturnType<typeof generateConversation>>;
					try {
						generated = await generateConversation({
							inference: larm,
							requestId: input.requestId,
							messages: decision.selectionMessages ?? decision.messages,
							requestMessage: currentRequestMessage(input),
							signal,
							delta: decision.selectionMessages ? () => {} : delta,
							preparation: decision.selectionMessages ? undefined : preparation,
							briefReply: input.briefReply,
							tools: initial ? [discoveryTool] : decision.tools,
							discovery: initial,
							cards: decision.cards,
							openQuestions: decision.openQuestions,
							sessions: decision.sessions,
							// The selection call is one-shot; a direct call is the answer generation itself.
							sessionRole: decision.selectionMessages ? "auxiliary" : "main",
							session: answerSession(input, recallPins),
							repair: () => {
								partials.delete(input.runId);
								body.reset();
								publish(input.runId);
							},
						});
					} catch (error) {
						if (
							error instanceof Error &&
							error.message === "invalid_conversation_operation"
						)
							await recordRejected(deps, input.runId, decision.draft);
						throw error;
					}
					if (generated.needsToolchain) {
						({ decision, generated } = await generateSelection(
							deps,
							input,
							signal,
							body.reset,
							preparation,
						));
						recallPins.splice(0, recallPins.length, ...decision.recallPins);
					}
					if (generated.operation) {
						return announceSelection(deps, input, {
							generated,
							decision,
							signal,
							publish: () => publish(input.runId),
						});
					}
					if (decision.selectionMessages && decision.answerMessages) {
						holdBody =
							!!input.briefReply ||
							shouldHoldBody(input, chunkSpeech) ||
							(!chunkSpeech && recallPins.length > 0);
						// Selection prose has no authority as an answer; answer with the full exchange.
						generated = await generateConversation({
							inference: larm,
							requestId: input.requestId,
							messages: decision.answerMessages,
							requestMessage: currentRequestMessage(input),
							signal,
							delta,
							preparation,
							briefReply: input.briefReply,
							sessionRole: "main",
							session: answerSession(input, recallPins),
							repair: () => {
								partials.delete(input.runId);
								body.reset();
								publish(input.runId);
							},
						});
					}
					const { text, receipt } = generated;
					const answered = decision.draft("answer", {
						repaired: generated.repaired,
					});
					const prefix = partials.get(input.runId) ?? "";
					if (!text.startsWith(prefix)) throw new Error("chat_stream_diverged");
					if (holdBody) {
						// Held text was already counted while streaming; check the final length directly.
						if (text.length > 65536) throw new Error("chat_output_too_large");
					} else if (text.length > prefix.length)
						delta(text.slice(prefix.length));
					log.info("dialogue.generation_completed");
					return {
						text: verifiedAnswerLinks(text, input),
						receipt,
						selection: answered,
						recallPins,
					};
				},
			).finally(() => closeStream());
		},
		settleInTransaction(tx, claim, input, outcome) {
			const run = byId(tx, claim.payload.runId);
			if (!run) return "stale";
			if (outcome.type === "success") {
				const answerText = outcome.result.text;
				if (
					!input ||
					run.status !== "running" ||
					run.revision !== input.revision
				) {
					return "stale";
				}
				if (!validAttachmentContext(deps, tx, input, run.conversationId)) {
					endRun(deps, tx, run, "failed", "attachment_source_unavailable");
					return failedAnswer(
						deps,
						tx,
						run.id,
						"attachment_source_unavailable",
					);
				}
				traceSelection(deps, tx, run.id, outcome.result.selection);
				if (outcome.result.operation)
					return settleConversationOperation(
						deps,
						partials,
						tx,
						claim,
						run,
						input,
						{ ...outcome.result, operation: outcome.result.operation },
					);
				if (
					input.agent &&
					agents &&
					!agents.validAnswerInTransaction(tx, input.agent)
				) {
					endRun(deps, tx, run, "failed", "report_invalidated");
					agents.failAnswerInTransaction(tx, run.id, "report_invalidated");
					return failedAnswer(deps, tx, run.id, "report_invalidated");
				}
				// The goals layer stands apart from the memory window: a quiet window still has to see its goals change.
				const goalsStale = goalsLayerStale(deps.goals, tx, input.goals);
				if (goalsStale || (input.memory && memory)) {
					const adopted: SettleResult = goalsStale
						? { ok: false, reason: "memory_stale" }
						: adoptMemoryWindow(
								memory!,
								tx,
								run,
								input.memory!,
								outcome.result.recallPins,
							);
					if (!adopted.ok) {
						if (run.agentTaskId)
							agents?.failAnswerInTransaction(tx, run.id, adopted.reason);
						endRun(deps, tx, run, "failed", adopted.reason);
						return failedAnswer(deps, tx, run.id, adopted.reason);
					}
				}
				if (
					outcome.result.receipt &&
					!larm.acceptInTransaction?.(tx, outcome.result.receipt)
				) {
					memory?.discardUsageInTransaction(tx, run.id);
					if (run.agentTaskId)
						agents?.failAnswerInTransaction(tx, run.id, "permission_revoked");
					endRun(deps, tx, run, "failed", "permission_revoked");
					return failedAnswer(deps, tx, run.id, "permission_revoked");
				}
				if (input.agent && agents)
					agents.completeAnswerInTransaction(tx, input.agent);
				const messageId = id();
				conversation.appendInTransaction(tx, {
					id: messageId,
					conversationId: run.conversationId,
					role: "assistant",
					text: answerText,
					createdAt: clock(),
					runId: run.id,
				});
				// The notices this answer carried are shown once: only an adopted answer clears them.
				if (input.memory && memory)
					clearShownNotices(memory, tx, run, input.memory);
				if (outcome.result.receipt?.delivery?.version === 2)
					conversation.recordAnswerDeliveryInTransaction(
						tx,
						run.id,
						run.conversationId,
						outcome.result.receipt.delivery,
					);
				const done = endRun(deps, tx, run, "completed", null, messageId);
				if (done) traceOutcome(deps, tx, run.id, agentOutcome(input.agent));
				return done ? "applied" : "stale";
			}
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
			if (run.agentTaskId)
				agents?.failAnswerInTransaction(tx, run.id, next[1] ?? "answer_failed");
			if (next[0] !== "queued")
				traceFailure(deps, tx, run.id, outcome.type, next[1]);
			const moved =
				next[0] === "queued"
					? transition(tx, run.id, run.revision, "queued", clock(), next[1])
					: endRun(deps, tx, run, next[0], next[1]);
			return moved ? "applied" : "stale";
		},
		// A session switched or ended while this settled: abort what that withdrew.
		afterCommit: () => flushDeferred(deps),
		cancelInTransaction(tx, job) {
			const run = byId(tx, job.payload.runId);
			if (run && (run.status === "queued" || run.status === "running")) {
				endRun(deps, tx, run, "cancelled", "cancel_requested");
				traceFailure(deps, tx, run.id, "cancelled", "cancel_requested");
			}
		},
	};
	return handler;
}
