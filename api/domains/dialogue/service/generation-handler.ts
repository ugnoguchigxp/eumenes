import {
	beforeCurrentRequest,
	judgeCompletion,
	progressLine,
	unmetMessage,
	unverifiedMessage,
	type CompletionDecision,
} from "./completion-check";
import {
	createGenerationSettlement,
	type GenerationHandler,
} from "./generation-settle";
import { answerSession, createAnswerStream } from "./generation-stream";
import { generationTiming } from "./generation-timing";
import { operationResultMessage } from "./context-format-current";
import { currentRequestMessage } from "./request-context";
import { resolveAttachmentContext } from "./attachment-context";
import { z } from "zod";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import {
	decisionDraft,
	prepareAnswer,
	recordRejected,
	traceFailure,
	type Decision,
} from "./selection-trace";
import { analyzeInitialRequest } from "./initial-request";
import { announceAndSelect } from "./operation-announcement";
import { answerInstant } from "./instant-answer";
import { generateConversation } from "./conversation-generation";
import { researchCitations } from "./research-citations";
import type { Run } from "../contracts";
import { byId } from "../repository";
import { endRun } from "./run-end";
import {
	GENERATE_KIND,
	type DialogueDeps,
	type GenerateInput,
} from "./context";
import { createPrepare } from "./generation-prepare";
import { flushDeferred } from "./specialist-core";
import type { Progress } from "./progress";
import {
	RESEARCH_FAILURE_REPLY,
	researchFailed,
} from "./research-failure-reply";
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
	if (input.agent?.projection)
		return researchCitations(text, input.agent.projection, {
			requireSources: true,
		});
	return text;
}

function shouldHoldBody(input: GenerateInput, chunkSpeech = false) {
	return !!(
		(!chunkSpeech && ((input.memory && !input.memory.quiet) || input.goals)) ||
		input.agent?.projection ||
		(!chunkSpeech && input.agent?.actionPayload) ||
		input.mediaResult ||
		input.executionNotice
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
	const { store, larm, agents } = deps;

	const handler: GenerationHandler = {
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
			let rethrow = (error: unknown): never => {
				throw error;
			};
			const run = store.read((db) => byId(db, input.runId));
			return withLogContext(
				{
					runId: input.runId,
					requestId: run?.requestId,
					utteranceId: run?.utteranceId ?? undefined,
				},
				async () => {
					log.info("dialogue.generation_started");
					// A failed research is answered by the host: no model call, and the code stays with the run.
					if (researchFailed(input.agent)) {
						signal.throwIfAborted();
						return { text: RESEARCH_FAILURE_REPLY };
					}
					if (input.executionNoticeReply) {
						signal.throwIfAborted();
						return {
							text: input.executionNoticeReply,
							hostAnswer: true as const,
						};
					}
					const timing = generationTiming();
					resolveAttachmentContext(deps, input, run!.conversationId);
					if (input.agent?.actionPayload && agents) {
						await refreshActionResult(deps, agents, input);
						signal.throwIfAborted();
					}
					const chunkSpeech = speaksChunks(deps, run);
					let holdBody =
						!!input.briefReply || shouldHoldBody(input, chunkSpeech);
					// What this turn's prompt stands on: forgetting any of it revokes the call while it runs.
					const recallPins: Array<{ messageId: string; digest: string }> = [];
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
					rethrow = body.rethrow;
					signal = body.signal;
					const delta = body.delta;
					const preparation = answerCollection(run, chunkSpeech);
					const repair = () => {
						partials.delete(input.runId);
						body.reset();
						publish(input.runId);
					};
					// A new decision finds the candidate toolchains, then analyzes the request: one call that gives it to a
					// toolchain, answers it, or reports that nothing fits. That round's body is neither shown nor adopted.
					const { found, first } = await analyzeInitialRequest(
						deps,
						input,
						signal,
						repair,
					);
					const analysis = first?.analysis;
					if (
						first &&
						found &&
						(analysis?.next === "execute_task" ||
							analysis?.next === "task_control")
					)
						return {
							text: analysis.announcement,
							receipt: first.receipt,
							taskDecision: analysis,
							...(analysis.next === "execute_task"
								? {
										selection: decisionDraft(input, found.started, {
											analysis,
											route: {
												...found.route,
												cards: [...found.route.cards, analysis.card],
											},
											query: found.query,
										})("toolchain", {
											toolchainId: analysis.card.id,
											toolchainRevisionId: analysis.card.revisionId,
											functionName: analysis.card.functionName,
											request: analysis.request,
										}),
									}
								: {}),
						};
					// A task pipeline: the notice is the answer; the host runs its steps once the answer is adopted.
					if (first && found && analysis?.next === "pipeline")
						return {
							text: analysis.announcement,
							receipt: first.receipt,
							pipelineDecision: analysis,
							selection: decisionDraft(input, found.started, {
								analysis,
								route: found.route,
								query: found.query,
							})("toolchain", {
								toolchainId: analysis.card.id,
								toolchainRevisionId: analysis.card.revisionId,
								functionName: analysis.card.functionName,
								request: JSON.stringify(analysis.inputs),
								repaired: first.repaired,
							}),
						};
					let decision: Decision;
					let generated: Awaited<ReturnType<typeof generateConversation>>;
					let completion: CompletionDecision | undefined;
					if (found && first && analysis?.next === "instant")
						return answerInstant(deps, input, {
							found,
							analysis,
							first,
							signal,
						});
					if (found && first && analysis?.next === "toolchain") {
						// The notice is delivered first; the request for the specialist is written while it is read.
						return announceAndSelect(deps, input, {
							found,
							analysis,
							first,
							signal,
							repair,
							publish: () => publish(input.runId),
						});
					}
					if (found && first && analysis?.next === "report_unavailable") {
						// No offered toolchain fits: the explanation it reported is the answer.
						decision = {
							draft: decisionDraft(input, found.started, {
								analysis,
								route: found.route,
								query: found.query,
							}),
							recallPins: [],
						};
						generated = {
							text: analysis.reply,
							receipt: first.receipt,
							repaired: first.repaired,
						};
						timing.policy(holdBody);
					} else {
						const prepared = prepareAnswer(deps, input, found, analysis);
						decision = prepared;
						// A delegated step's result: check it against the request before answering. A step that does not
						// achieve the request names what is missing; its answer is the host's fixed progress line (the
						// next step announces itself), so no model reply can break the spoken contract mid-request.
						completion = input.completionCheck
							? await judgeCompletion(
									deps,
									{
										requestId: input.requestId,
										completionCheck: input.completionCheck,
									},
									prepared.messages,
									signal,
								)
							: undefined;
						// Streamed text is checked against the exchanges this prompt stands on.
						recallPins.splice(0, recallPins.length, ...prepared.recallPins);
						holdBody ||= !chunkSpeech && recallPins.length > 0;
						timing.policy(holdBody);
						if (completion?.status === "continue")
							generated = {
								text: progressLine(),
								receipt: completion.receipt,
								repaired: false,
							};
						else
							try {
								generated = await generateConversation({
									inference: larm,
									requestId: input.requestId,
									messages:
										completion?.status === "unmet"
											? beforeCurrentRequest(prepared.messages, [
													unmetMessage(completion.unmet),
												])
											: completion?.status === "unverified"
												? beforeCurrentRequest(prepared.messages, [
														unverifiedMessage(),
													])
												: prepared.messages,
									requestMessage: currentRequestMessage(input),
									signal,
									delta,
									preparation,
									briefReply: input.briefReply,
									sessionRole: "main",
									session: answerSession(input, prepared.recallPins),
									repair,
								});
							} catch (error) {
								if (
									error instanceof Error &&
									error.message === "invalid_conversation_operation"
								)
									await recordRejected(deps, input.runId, prepared.draft);
								throw error;
							}
					}
					const { text, receipt } = generated;
					const answered = decision.draft("answer", {
						repaired: generated.repaired || !!first?.repaired,
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
						...(completion?.status === "continue"
							? {
									continuation: {
										achieved: completion.achieved,
										need: completion.need,
										conditions: completion.conditions,
									},
								}
							: {}),
					};
				},
			)
				.catch((error) => rethrow(error))
				.finally(() => closeStream());
		},
		settleInTransaction: createGenerationSettlement(deps, partials),
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
