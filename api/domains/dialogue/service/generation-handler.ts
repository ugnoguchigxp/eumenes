import { generationTiming } from "./generation-timing";
import { observeAnswer } from "./post-answer";
import {
	resolveAttachmentContext,
	validAttachmentContext,
} from "./attachment-context";
import { z } from "zod";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import type { Receipt } from "../../inference";
import type { HandlerDefinition } from "../../queue";
import { settleConversationOperation } from "./generation-operation";
import type { ConversationOperation } from "./conversation-tools";
import {
	agentOutcome,
	chosen,
	failedAnswer,
	prepareDecision,
	recordRejected,
	traceFailure,
	traceOutcome,
	traceSelection,
	type SelectionDraft,
} from "./selection-trace";
import { generateConversation } from "./conversation-generation";
import { researchCitations } from "./research-citations";
import {
	isSystemPrompt,
	type Run,
	type WorldContextSettleInput,
} from "../contracts";
import { byId, transition } from "../repository";
import {
	GENERATE_KIND,
	WorldContextRetry,
	type DialogueDeps,
	type GenerateInput,
	type GeneratePayload,
} from "./context";
import { createPrepare } from "./generation-prepare";
import { adoptMemoryWindow, clearShownNotices } from "./memory-window";
import type { Progress } from "./progress";
const log = getLogger("dialogue");

function answerCollection(run: Run | null, input: GenerateInput) {
	// An unadopted World-backed body must not be collected as an attitude sample.
	// Speech collects the adopted answer later, from the voice side.
	return run && !(input.world || input.worldUsed)
		? {
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
		return researchCitations(text, input.agent.projection);
	return text;
}

function shouldHoldBody(input: GenerateInput) {
	return !!(
		(input.memory && !input.memory.quiet) ||
		input.world ||
		input.worldUsed ||
		input.agent?.projection ||
		input.agent?.failureCode ||
		input.agent?.actionPayload ||
		input.mediaResult
	);
}

/** The queue handler of one generation: prepare, execute, settle (adopt) and cancel. */
export function createGenerationHandler(
	deps: DialogueDeps,
	{ partials, publish }: Pick<Progress, "partials" | "publish">,
) {
	const {
		store,
		conversation,
		larm,
		queue,
		clock,
		id,
		memory,
		agents,
		postAnswer,
		worldContext,
	} = deps;

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
			commandNote: z.string().max(500).optional(),
		}),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction: createPrepare(deps, { partials }),
		async execute(input, { signal, jobId, attempt, generation }) {
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
						// Refresh time/state before phrasing, without repeating the operation.
						// A later change still rejects this generated answer at adoption.
						const refreshed = await store.write((tx) => {
							const ticket = agents.prepareAnswerInTransaction(tx, input.runId);
							if (
								ticket.revision !== input.agent!.revision ||
								ticket.dataEpoch !== input.agent!.dataEpoch ||
								!ticket.actionPayload ||
								!agents.validAnswerInTransaction(tx, ticket)
							)
								throw new Error("report_invalidated");
							return {
								ticket,
								operation: JSON.parse(ticket.actionPayload),
							};
						});
						input.agent = refreshed.ticket;
						if (input.actionResultIndex === undefined)
							throw new Error("invalid_action_result");
						input.messages[input.actionResultIndex] = {
							role: "user",
							content: JSON.stringify({ actionResult: refreshed.operation }),
						};
						signal.throwIfAborted();
					}
					let holdBody = shouldHoldBody(input);
					if (input.world && worldContext) {
						// The last gate before the model. A source, policy or forget change makes
						// the context stale; a stopped run or a replaced attempt must not send either.
						// All of it is checked last, right before the send. Anything sent after this
						// cannot be recalled: later changes can only stop the adoption.
						const verdict = await worldContext.checkBeforeSend(
							input.world.context,
						);
						if (!verdict.ok)
							throw verdict.retryable
								? new WorldContextRetry(verdict.reason)
								: new Error(verdict.reason);
						signal.throwIfAborted();
						const now = store.read((db) => byId(db, input.runId));
						if (now?.status !== "running" || now.revision !== input.revision)
							throw new Error("cancelled");
						const job = queue.get(jobId);
						if (
							job?.state !== "running" ||
							job.attempt !== attempt ||
							job.generation !== generation
						)
							throw new Error("attempt_changed");
					}
					let held = 0;
					const delta = (text: string) => {
						signal.throwIfAborted();
						const current = store.read((db) => byId(db, input.runId));
						if (
							current?.status !== "running" ||
							current.revision !== input.revision
						)
							throw new Error("cancelled");
						timing.firstDelta(text, holdBody);
						if (holdBody) {
							// Memory/World-backed text is not shown or spoken before the adoption check passes.
							held += text.length;
							if (held > 65536) throw new Error("chat_output_too_large");
							return;
						}
						const next = (partials.get(input.runId) ?? "") + text;
						if (next.length > 65536) throw new Error("chat_output_too_large");
						partials.set(input.runId, next);
						publish(input.runId);
					};
					const preparation = answerCollection(run, input);
					const decision = await prepareDecision(deps, input, signal);
					const { recallPins } = decision;
					holdBody ||= recallPins.length > 0 || !!decision.tools?.length;
					timing.policy(holdBody);
					let generated: Awaited<ReturnType<typeof generateConversation>>;
					try {
						generated = await generateConversation({
							inference: larm,
							requestId: input.requestId,
							messages: decision.selectionMessages ?? decision.messages,
							signal,
							delta: decision.selectionMessages ? () => {} : delta,
							preparation: decision.selectionMessages ? undefined : preparation,
							tools: decision.tools,
							cards: decision.cards,
							openQuestions: decision.openQuestions,
							repair: () => {
								partials.delete(input.runId);
								held = 0;
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
					if (generated.operation) {
						if (!deps.toolchains || input.agent)
							throw new Error("invalid_conversation_operation");
						partials.delete(input.runId);
						return {
							...generated,
							selection: chosen(decision, generated),
							recallPins,
						};
					}
					if (decision.selectionMessages && decision.answerMessages) {
						// Selection prose has no authority as an answer; answer with the full exchange.
						generated = await generateConversation({
							inference: larm,
							requestId: input.requestId,
							messages: decision.answerMessages,
							signal,
							delta,
							preparation,
							repair: () => {
								partials.delete(input.runId);
								held = 0;
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
			);
		},
		classify: (error) =>
			error instanceof WorldContextRetry ? "retry" : "fail",
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
					// The result is not adopted: nothing it stood on stays registered.
					if (input?.world && run.status !== "completed")
						worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
					return "stale";
				}
				if (!validAttachmentContext(deps, tx, input, run.conversationId)) {
					if (input.world)
						worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
					transition(
						tx,
						run.id,
						run.revision,
						"failed",
						clock(),
						"attachment_source_unavailable",
					);
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
					transition(
						tx,
						run.id,
						run.revision,
						"failed",
						clock(),
						"report_invalidated",
					);
					agents.failAnswerInTransaction(tx, run.id, "report_invalidated");
					// Not adopted: the World context's input dependencies go.
					if (input.world)
						worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
					return failedAnswer(deps, tx, run.id, "report_invalidated");
				}
				const worldSettle: WorldContextSettleInput | null =
					input.world && worldContext
						? {
								runId: run.id,
								conversationId: run.conversationId,
								jobId: claim.jobId,
								attempt: claim.attempt,
								generation: claim.generation,
								inference: outcome.result.receipt
									? {
											requestId: outcome.result.receipt.requestId,
											attemptId: outcome.result.receipt.attemptId,
										}
									: null,
								nowMs: Date.parse(clock()),
							}
						: null;
				if (input.world && worldContext && worldSettle) {
					// Read-only, before anything is written: a stale World context adopts
					// neither the answer nor a usage record.
					const verdict = worldContext.validateInTransaction(
						tx,
						worldSettle,
						input.world.context,
					);
					if (!verdict.ok) {
						worldContext.releaseInTransaction(tx, run.id, run.conversationId);
						if (run.agentTaskId)
							agents?.failAnswerInTransaction(tx, run.id, verdict.reason);
						transition(
							tx,
							run.id,
							run.revision,
							"failed",
							clock(),
							verdict.reason,
						);
						return failedAnswer(deps, tx, run.id, verdict.reason);
					}
				}
				if (input.memory && memory) {
					const adopted = adoptMemoryWindow(
						memory,
						tx,
						run,
						input.memory,
						outcome.result.recallPins,
					);
					if (!adopted.ok) {
						// Not adopted: the World context's input dependencies go.
						if (input.world)
							worldContext?.releaseInTransaction(
								tx,
								run.id,
								run.conversationId,
							);
						if (run.agentTaskId)
							agents?.failAnswerInTransaction(tx, run.id, adopted.reason);
						transition(
							tx,
							run.id,
							run.revision,
							"failed",
							clock(),
							adopted.reason,
						);
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
					transition(
						tx,
						run.id,
						run.revision,
						"failed",
						clock(),
						"permission_revoked",
					);
					if (input.world)
						worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
					return failedAnswer(deps, tx, run.id, "permission_revoked");
				}
				// The usage record and the answer are written together, after every check.
				if (input.world && worldContext && worldSettle)
					worldContext.recordUsageInTransaction(
						tx,
						worldSettle,
						input.world.context,
					);
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
				const done = transition(
					tx,
					run.id,
					run.revision,
					"completed",
					clock(),
					null,
					messageId,
				);
				// The answer joins the conversation the memory agent is reading (scheduled runs have no user words).
				if (done && !isSystemPrompt(run.sourceKind))
					memory?.scheduleAgentInTransaction(tx, run.conversationId);
				if (done) observeAnswer(postAnswer, tx, run.id, input.agent);
				if (done) traceOutcome(deps, tx, run.id, agentOutcome(input.agent));
				else if (input.world)
					worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
				return done ? "applied" : "stale";
			}
			// A run that is already terminal (e.g. cancelled) keeps its state.
			if (run.status !== "queued" && run.status !== "running") return "applied";
			// Not adopted (failed, retried, expired, interrupted): drop the input dependencies.
			worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
			const next: [Run["status"], string | null] =
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
			return transition(tx, run.id, run.revision, next[0], clock(), next[1])
				? "applied"
				: "stale";
		},
		cancelInTransaction(tx, job) {
			const run = byId(tx, job.payload.runId);
			if (run && (run.status === "queued" || run.status === "running")) {
				transition(
					tx,
					run.id,
					run.revision,
					"cancelled",
					clock(),
					"cancel_requested",
				);
				// A late result is rejected by the queue; what the run registered is released.
				worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
				traceFailure(deps, tx, run.id, "cancelled", "cancel_requested");
			}
		},
	};
	return handler;
}
