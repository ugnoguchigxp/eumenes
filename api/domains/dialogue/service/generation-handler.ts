import { z } from "zod";
import type { AnswerTicket } from "../../agent-runtime";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import type { Receipt } from "../../inference";
import type { HandlerDefinition, Tx } from "../../queue";
import { operationRejection } from "./operation-authority";
import type { ConversationOperation } from "./conversation-tools";
import { delegateConversation } from "./delegate-conversation";
import { generateConversation } from "./conversation-generation";
import { researchCitations } from "./research-citations";
import { type Run, type WorldContextSettleInput } from "../contracts";
import { byId, transition } from "../repository";
import {
	GENERATE_KIND,
	WorldContextRetry,
	type DialogueDeps,
	type GenerateInput,
} from "./context";
import { createPrepare } from "./generation-prepare";
import type { Progress } from "./progress";
const log = getLogger("dialogue");

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
	/** Optional learning runs in its own SAVEPOINT: any failure rolls back only that part. */
	function observeAnswer(tx: Tx, runId: string, ticket?: AnswerTicket) {
		if (!postAnswer || !ticket || ticket.reportEpoch === null) return;
		const name = "dialogue_post_answer";
		tx.exec(`SAVEPOINT ${name}`);
		try {
			const result = postAnswer.recordInTransaction(tx, {
				runId,
				ticketId: ticket.eventId,
				reportEpoch: ticket.reportEpoch,
			});
			if (result.status !== "recorded") {
				tx.exec(`ROLLBACK TO ${name}`);
				log.info("dialogue.post_answer_skipped", { reason: result.code });
			}
		} catch {
			tx.exec(`ROLLBACK TO ${name}`);
			log.warn("dialogue.post_answer_skipped", { reason: "observer_error" });
		}
		tx.exec(`RELEASE ${name}`);
	}

	const handler: HandlerDefinition<
		{ runId: string },
		GenerateInput,
		{ text: string; receipt?: Receipt; operation?: ConversationOperation }
	> = {
		kind: GENERATE_KIND,
		payloadVersions: [1],
		schema: z.object({ runId: z.string() }),
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
					const holdBody = !!(
						input.memory ||
						input.world ||
						input.worldUsed ||
						input.agent?.projection ||
						input.agent?.failureCode ||
						input.agent?.actionPayload
					);
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
					// An unadopted World-backed body must not be collected as an attitude
					// sample (its text would persist before adoption): no collection identity.
					// Speech collects the adopted answer later, from the voice side.
					const preparation =
						run && !(input.world || input.worldUsed)
							? {
									collection: {
										conversationId: run.conversationId,
										turnId: run.id,
										granularity: "answer" as const,
										chunkOrder: null,
									},
								}
							: undefined;
					const generated = await generateConversation({
						inference: larm,
						requestId: input.requestId,
						messages: input.messages,
						signal,
						delta,
						preparation,
						tools: input.agent ? undefined : input.tools,
						repair: () => {
							partials.delete(input.runId);
							held = 0;
							publish(input.runId);
						},
					});
					let { text } = generated;
					const { receipt } = generated;
					if (generated.operation) {
						if (!agents || input.agent)
							throw new Error("invalid_conversation_operation");
						partials.delete(input.runId);
						return generated;
					}
					const prefix = partials.get(input.runId) ?? "";
					if (!text.startsWith(prefix)) throw new Error("chat_stream_diverged");
					if (holdBody) {
						// Held text was already counted while streaming; check the final length directly.
						if (text.length > 65536) throw new Error("chat_output_too_large");
					} else if (text.length > prefix.length)
						delta(text.slice(prefix.length));
					log.info("dialogue.generation_completed");
					if (input.agent?.projection || input.agent?.failureCode)
						text = researchCitations(text, input.agent.projection);
					return { text, receipt };
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
				if (outcome.result.operation && agents) {
					const rejected = operationRejection(tx, {
						inference: larm,
						receipt: outcome.result.receipt,
						memory,
						memoryView: input.memory,
						world: worldContext,
						worldView: input.world,
						settle: {
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
						},
					});
					if (rejected) {
						if (input.world)
							worldContext?.releaseInTransaction(
								tx,
								run.id,
								run.conversationId,
							);
						transition(tx, run.id, run.revision, "failed", clock(), rejected);
						return { status: "failed", errorCode: rejected };
					}
					// The initial receipt stays pending; the final answer is a later attempt
					// on the same policy request. No control text is adopted or collected.
					if (input.world)
						worldContext?.releaseInTransaction(tx, run.id, run.conversationId);
					delegateConversation(
						tx,
						agents,
						conversation,
						run,
						outcome.result.operation,
						{
							parentJobId: claim.jobId,
							authorizedUrls: input.authorizedUrls,
							actionSnapshot: input.actionSnapshot,
							timerCapability: input.timerCapability,
							requirementCatalog: input.requirementCatalog,
						},
					);
					transition(tx, run.id, run.revision, "queued", clock());
					partials.delete(run.id);
					return "applied";
				}
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
					return { status: "failed", errorCode: "report_invalidated" };
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
						return { status: "failed", errorCode: verdict.reason };
					}
				}
				if (input.memory && memory) {
					const adopted = memory.settleInTransaction(
						tx,
						run.id,
						run.conversationId,
						input.memory.view,
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
						return { status: "failed", errorCode: adopted.reason };
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
					return { status: "failed", errorCode: "permission_revoked" };
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
				if (done) observeAnswer(tx, run.id, input.agent);
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
			}
		},
	};
	return handler;
}
