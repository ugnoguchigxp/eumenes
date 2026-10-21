import {
	REFERENCE_WINDOW_TOKENS,
	contextBudgets,
	estimateTextTokens,
	estimateMessageTokens,
	estimateJsonTokens,
	outputReserveTokens,
	type ContextBlock,
} from "../../inference";
import type { AnswerTicket } from "../../agent-runtime";
import type { HandlerDefinition } from "../../queue";
import { compileAssembly, windowIsEmpty } from "./context-compiler";
import {
	hostTextBlock,
	operationBlock,
	researchResultBlock,
} from "./context-blocks";
import { withVolatile } from "./context-volatile";
import { fitAssembly, memoryHistoryUsed } from "./context-fit";
import { systemMessageOf } from "./context-format-current";
import { renderContext } from "./context-render";
import { prepareRouting } from "./delegate-conversation";
import { prepareRetained } from "./retained-toolchains";
import { analysisTools } from "./initial-decision";
import { analysisMessages, previousExchange } from "./request-analysis";
import { renderGoalsLayer } from "./goals-layer";
import { topicTexts, worldNamesBlock } from "./topic-texts";
import { specialistWorkBlock, viewingBlock } from "./specialist-context";
import { byId, transition } from "../repository";
import { endRun } from "./run-end";
import { isSystemPrompt, type Run } from "../contracts";
import {
	DEFAULT_DEADLINE_MS,
	type DialogueDeps,
	type GenerateInput,
	type GeneratePayload,
} from "./context";

/** The claim-time half of a generation: fixes memory, goals, the World name hint and history inside the claim transaction. */
export function createPrepare(
	deps: DialogueDeps,
): HandlerDefinition<
	GeneratePayload,
	GenerateInput,
	unknown
>["prepareInTransaction"] {
	const { conversation, larm, clock, memory, agents, worldContext, goals } =
		deps;
	return (tx, claim) => {
		const run = byId(tx, claim.payload.runId);
		if (!run || run.status !== "queued" || run.jobId !== claim.jobId)
			return { status: "stale", reason: "run_not_queued" };
		let agent: AnswerTicket | undefined;
		if (run.agentTaskId && agents) {
			try {
				agent = agents.prepareAnswerInTransaction(tx, run.id);
			} catch {
				endRun(deps, tx, run, "failed", "report_invalidated");
				agents.failAnswerInTransaction(tx, run.id, "report_invalidated");
				return { status: "stale", reason: "report_invalidated" };
			}
		}
		if (!transition(tx, run.id, run.revision, "running", clock()))
			return { status: "stale", reason: "run_changed" };
		const current = byId(tx, run.id) as Run;
		let window: ReturnType<
			NonNullable<typeof memory>["windowForRunInTransaction"]
		> = null;
		try {
			window =
				memory?.windowForRunInTransaction(tx, run.conversationId) ?? null;
		} catch (error) {
			if (!(error instanceof Error) || error.message !== "memory_blocked")
				throw error;
			if (run.agentTaskId)
				agents?.failAnswerInTransaction(tx, run.id, "memory_blocked");
			// Never silently drop memory and continue; end the run with the reason.
			endRun(deps, tx, current, "failed", "memory_blocked");
			return { status: "stale", reason: "memory_blocked" };
		}
		// The adopted goals come right after L1.
		const goalsLayer = goals
			? renderGoalsLayer(goals.adoptedForContextInTransaction(tx))
			: null;
		if (larm.captureInTransaction && !larm.requestFor?.(tx, run.id, "llm")) {
			const snapshot = larm.snapshotInTransaction?.(tx);
			if (snapshot) {
				for (const p of ["llm", "asr", "tts"] as const) {
					snapshot.routes[p].mode = "larm-only";
					snapshot.routes[p].cloudAllowed = false;
				}
				larm.captureInTransaction(
					tx,
					run.id,
					"llm",
					claim.deadlineAtMs ?? Date.now() + DEFAULT_DEADLINE_MS,
					snapshot,
				);
			}
		}
		// The model window of this run, from its saved settings: a cloud route's resource. A LARM route's provider
		// window is known only when its lease is claimed, so the reference window (256k) stands in for it here and
		// the transport trims the oldest history if the real window is smaller.
		const llmRequestId = larm.requestFor?.(tx, run.id, "llm");
		const windowTokens =
			(llmRequestId &&
				larm.llmContextWindowInTransaction?.(tx, llmRequestId)) ||
			REFERENCE_WINDOW_TOKENS;
		const budgets = contextBudgets(windowTokens);
		const compiled = compileAssembly(
			tx,
			current,
			conversation,
			larm.snapshotInTransaction?.(tx).general,
			window,
			memory,
			goalsLayer?.block,
			!!deps.specialist,
			budgets.memoryHistory,
		);
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		const requestId = larm.requestFor?.(tx, run.id, "llm");
		if (requestId) larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
		const operations: ContextBlock[] = [];
		if (agent?.actionPayload)
			operations.push(
				operationBlock("operation.action", JSON.parse(agent.actionPayload)),
			);
		const delegated =
			!run.agentTaskId && !isSystemPrompt(run.sourceKind)
				? deps.delegation?.prepareInTransaction(tx, run)
				: undefined;
		const drawingResult = deps.excalidraw?.resultInTransaction(tx, run.id);
		const recognitionResult = deps.objectRecognition?.resultInTransaction(
			tx,
			run.id,
		);
		if (recognitionResult)
			operations.push(
				operationBlock("operation.recognition", recognitionResult),
			);
		const imageResult = deps.image?.resultInTransaction(tx, run.id);
		const musicResult = deps.music?.resultInTransaction(tx, run.id);
		if (delegated?.receipt)
			operations.push(
				operationBlock("operation.delegation", delegated.receipt),
			);
		if (drawingResult)
			operations.push(operationBlock("operation.drawing", drawingResult));
		if (imageResult)
			operations.push(operationBlock("operation.image", imageResult));
		if (musicResult)
			operations.push(operationBlock("operation.music", musicResult));
		const note = claim.payload.commandNote;
		if (note)
			operations.push(operationBlock("operation.command_question", note));
		// The report of the research sub-agent. A failed one has none: it is answered by the host, not the model.
		const nowMs = Date.parse(clock());
		const research: ContextBlock[] = agent?.projection
			? [researchResultBlock(JSON.parse(agent.projection), nowMs)]
			: [];
		// What holds for this call only, in the order it is shown (see `withVolatile`).
		const assembly = withVolatile(compiled.assembly, {
			memory: compiled.assembly.volatile,
			...(agent ? { answer: { actionPayload: agent.actionPayload } } : {}),
			// World is read only by the research sub-agent; the conversation gets the names of the known targets
			// this turn's wording mentions, as one line of L4 (nothing when none is named or World is unusable).
			worldNames: () =>
				worldContext
					? worldNamesBlock(
							worldContext.knownNamesInTransaction(tx, {
								conversationId: run.conversationId,
								texts: topicTexts(
									tx,
									current,
									conversation,
									new Set(
										memory?.blockedMessageIdsOfConversationInTransaction(
											tx,
											run.conversationId,
										) ?? [],
									),
									!!deps.specialist,
								),
							}),
						)
					: null,
			// Specialist work stays out of the conversation's context; the main agent gets a short host record of it.
			specialist: () =>
				deps.specialist && !isSystemPrompt(run.sourceKind)
					? [
							specialistWorkBlock(deps, tx, current),
							viewingBlock(deps, tx, current),
							claim.payload.specialistHandoff
								? hostTextBlock(
										"specialist.handoff",
										claim.payload.specialistHandoff,
									)
								: null,
						].filter((block): block is ContextBlock => !!block)
					: [],
			operations,
			research: research[0] ?? null,
		});
		// Inside the two budgets of the window: a block over its budget is clipped, never the cause of a failure.
		const fitted = fitAssembly(
			assembly,
			windowTokens,
			estimateTextTokens(systemMessageOf(assembly).content),
		);
		const rendered = renderContext(fitted, "current");
		const { messages } = rendered;
		// A new decision: the execute phase retrieves the toolchains for this request.
		// While an operation's result (or a sub-agent's question) is phrased, nothing new is offered.
		const routing = !operations.length
			? prepareRouting(
					tx,
					deps,
					run,
					messages,
					compiled.assembly.input,
					{ dots: !!delegated && delegated.available !== false },
					{
						persona: compiled.assembly.persona,
						previous: previousExchange(compiled.assembly.history.turns),
					},
				)
			: undefined;
		if (routing) {
			const base = {
				routing: routing.routing,
				messages,
				currentRequest: {
					messageId: run.inputMessageId,
					messageIndex: rendered.currentRequestIndex,
				},
			};
			const room =
				budgets.task -
				outputReserveTokens(windowTokens) -
				estimateMessageTokens(analysisMessages(base)) -
				estimateJsonTokens(analysisTools([], new Set(), true));
			Object.assign(routing.routing, {
				retained: prepareRetained(
					deps,
					tx,
					run,
					new Set(routing.routing.available),
					room,
				),
			});
		}
		// A prefetch left out of this turn is neither sent nor checked at adoption.
		const prepared =
			window && compiled.prefetchDropped
				? { ...window, prefetch: { text: "", pins: [], tokens: 0 } }
				: window;
		return {
			status: "ready",
			input: {
				briefReply:
					conversation.messageInTransaction(tx, run.inputMessageId)?.message
						.presentation !== "artifact",
				runId: run.id,
				revision: current.revision,
				messages,
				sessionContext: rendered.sessionContext,
				currentRequest: {
					messageId: run.inputMessageId,
					messageIndex: rendered.currentRequestIndex,
				},
				actionResultIndex: rendered.blockIndex["operation.action"],
				...(imageResult || musicResult ? { mediaResult: true as const } : {}),
				...(operations.length ? { operationResult: true as const } : {}),
				...routing,
				agent,
				...(goalsLayer
					? { goals: { goalIds: goalsLayer.shown.map((g) => g.goalId) } }
					: {}),
				// An empty window still travels: the exchanges recalled for this turn are checked against it.
				...(prepared
					? {
							memory: {
								window: memory!.preparedWindow(
									prepared,
									compiled.shownMessageIds,
								),
								...(windowIsEmpty(prepared) ? { quiet: true as const } : {}),
								blockedAtPrepare: [
									...memory!.blockedMessageIdsInTransaction(
										tx,
										compiled.shownMessageIds,
									),
								],
							},
						}
					: {}),
				requestId: larm.requestFor?.(tx, run.id, "llm") ?? undefined,
				memoryRoomTokens: Math.max(
					0,
					budgets.memoryHistory - memoryHistoryUsed(fitted),
				),
			},
		};
	};
}
