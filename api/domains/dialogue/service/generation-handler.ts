import { z } from "zod";
import { getLogger, withLogContext } from "../../../infrastructure/logger";
import type { Run } from "../contracts";
import { byId } from "../repository";
import { resolveAttachmentContext } from "./attachment-context";
import { GENERATE_KIND, type DialogueDeps } from "./context";
import { createGenerationExecutor } from "./generation-executor";
import { runGeneration } from "./generation-loop";
import { createPrepare } from "./generation-prepare";
import {
	createGenerationSettlement,
	type GenerationHandler,
} from "./generation-settle";
import { answerSession, createAnswerStream } from "./generation-stream";
import { generationTiming } from "./generation-timing";
import { isPinnedDecision, pinnedGeneration } from "./pinned-operation";
import type { Progress } from "./progress";
import { refreshActionResults, reportedLinks } from "./result-intake";
import { endRun } from "./run-end";
import { flushDeferred } from "./specialist-core";

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

/** The queue handler of one generation: prepare, run the generation with its tools, settle (adopt) and cancel. */
export function createGenerationHandler(
	deps: DialogueDeps,
	{ publish }: Pick<Progress, "publish">,
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
					await refreshActionResults(deps, input);
					const body = createAnswerStream(
						deps,
						input,
						caller,
						generationTiming(),
					);
					try {
						const publishNow = () => publish(input.runId);
						const activeTodos = new Set(input.shown.todos);
						const executor = createGenerationExecutor(deps, {
							input,
							jobId: input.jobId,
							publish: publishNow,
							activeTodos,
						});
						const generated = await runGeneration(deps, input, {
							signal: body.signal,
							delta: body.delta,
							preparation: answerCollection(run, speaksChunks(deps, run)),
							session: answerSession(input),
							repair: () => {
								body.reset();
								publishNow();
							},
							execute: executor.execute,
							window: {
								activeTodos,
								eventIds: new Set(input.shown.events),
							},
						});
						const handover = executor.handover();
						if (handover) {
							log.info("dialogue.generation_handed_over", {
								kind: handover.handed ? "handed" : "started",
							});
							return {
								text: "",
								handover,
								...(generated.receipt ? { receipt: generated.receipt } : {}),
							};
						}
						if (generated.text.length > 65536)
							throw new Error("chat_output_too_large");
						log.info("dialogue.generation_completed");
						return {
							text: reportedLinks(
								deps,
								input,
								generated.text,
								generated.respond?.todoRefs ?? [],
							),
							...(generated.receipt ? { receipt: generated.receipt } : {}),
							...(generated.respond ? { respond: generated.respond } : {}),
							...(generated.executed.some(
								(entry) => entry.outcome.basis === "confirmation",
							)
								? { confirmation: true as const }
								: {}),
							...(input.final.kind === "utterances" && generated.respond
								? {
										selection: executor.answered(
											generated.respond,
											generated.repaired,
										),
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
