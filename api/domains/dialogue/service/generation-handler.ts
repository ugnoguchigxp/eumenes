import { z } from "zod";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import type { Run } from "../contracts";
import { byId } from "../repository";
import { resolveAttachmentContext } from "./attachment-context";
import { GENERATE_KIND, type DialogueDeps } from "./context";
import { createGenerationExecutor } from "./generation-executor";
import { runGeneration, type GenerationOutcome } from "./generation-loop";
import { TOOL_NAMES } from "./generation-tools";
import { createPrepare } from "./generation-prepare";
import { runRoutedTurn } from "./routed-turn";
import {
	createGenerationSettlement,
	type GenerationHandler,
} from "./generation-settle";
import { answerSession, createAnswerStream } from "./generation-stream";
import { generationTiming } from "./generation-timing";
import { isPinnedDecision, pinnedGeneration } from "./pinned-operation";
import type { Progress } from "./progress";
import { refreshAgentAnswer, reportedLinks } from "./result-intake";
import { endRun } from "./run-end";
import { flushDeferred } from "./specialist-core";

const log = getLogger("dialogue");

/** The generation asked a toolchain and every such call was refused: nothing was handed over or answered by one. */
function delegationRefused(generated: GenerationOutcome): boolean {
	return (
		generated.exchange.some(
			(step) =>
				step.name === TOOL_NAMES.delegate &&
				(step.result as { refused?: unknown } | null)?.refused === true,
		) &&
		!generated.executed.some(({ call }) => call.name === TOOL_NAMES.delegate)
	);
}

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

/** The queue handler of one generation: prepare, run the generation with its tools, settle (adopt) and cancel. */
export function createGenerationHandler(
	deps: DialogueDeps,
	{ publish, openAnswerStream }: Pick<Progress, "publish" | "openAnswerStream">,
) {
	const { store } = deps;

	const handler: GenerationHandler = {
		kind: GENERATE_KIND,
		payloadVersions: [1],
		schema: z.object({
			runId: z.string(),
			notAdopted: z.boolean().optional(),
			commandNote: z.string().optional(),
			specialistHandoff: z.string().optional(),
		}),
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction: createPrepare(deps),
		async execute(input, { signal: caller }) {
			const run = store.read((db) => byId(db, input.runId));
			return withLogContext(
				{
					runId: input.runId,
					requestId: run?.requestId,
					utteranceId: run?.utteranceId ?? undefined,
				},
				async () => {
					log.info("dialogue.generation_started");
					// A screen's form submit names its toolchain: handed over as it is, with no model call.
					if (isPinnedDecision(run, input)) {
						caller.throwIfAborted();
						return pinnedGeneration(deps, input, run!);
					}
					resolveAttachmentContext(deps, input, run!.conversationId);
					await refreshAgentAnswer(deps, input);
					const body = createAnswerStream(
						deps,
						input,
						caller,
						generationTiming(),
						openAnswerStream,
					);
					try {
						const publishNow = () => publish(input.runId);
						const executor = createGenerationExecutor(deps, {
							input,
							jobId: input.jobId,
							publish: publishNow,
						});
						const turn = {
							signal: body.signal,
							delta: body.delta,
							preparation: answerCollection(run, speaksChunks(deps, run)),
							session: answerSession(input),
							execute: executor.execute,
							decline: executor.decline,
						};
						// The local harness routes the turn itself; the cloud harness's agent calls the tools.
						const generated =
							input.harness.turn === "routed"
								? await runRoutedTurn(deps, input, turn)
								: await runGeneration(deps, input, turn);
						const handover = executor.handover();
						if (handover) {
							log.info("dialogue.generation_handed_over", {
								kind: handover.handed ? "handed" : "started",
							});
							return {
								text: "",
								handover,
								exchange: generated.exchange,
								...(generated.receipt ? { receipt: generated.receipt } : {}),
							};
						}
						if (generated.text.length > 65536)
							throw new Error("chat_output_too_large");
						// Saying nothing completes the run (the system allows it); it is kept countable.
						if (!generated.text.trim())
							log.info("dialogue.no_answer", {
								kind: input.final.kind,
								// Calls run before saying nothing (a search with no hand-over, for one).
								count: generated.executed.length,
							});
						log.info("dialogue.generation_completed");
						return {
							text: reportedLinks(deps, input, generated.text),
							exchange: generated.exchange,
							...(generated.receipt ? { receipt: generated.receipt } : {}),
							...(generated.emotion ? { emotion: generated.emotion } : {}),
							...(generated.executed.some((entry) => entry.outcome.confirmation)
								? { confirmation: true as const }
								: {}),
							...(input.final.kind === "utterances"
								? {
										selection: executor.answered(delegationRefused(generated)),
									}
								: {}),
						};
					} catch (error) {
						return body.rethrow(error);
					} finally {
						body.close();
					}
				},
			);
		},
		settleInTransaction: createGenerationSettlement(deps),
		// A session switched or ended while this settled: abort what that withdrew.
		afterCommit: () => flushDeferred(deps),
		cancelInTransaction(tx, job) {
			const run = byId(tx, job.payload.runId);
			if (run && (run.status === "queued" || run.status === "running")) {
				endRun(deps, tx, run, "cancelled", "cancel_requested");
				deps.toolchains?.settleSelectionInTransaction(tx, run.id, {
					outcome: "cancelled",
					code: "cancel_requested",
				});
			}
		},
	};
	return handler;
}
