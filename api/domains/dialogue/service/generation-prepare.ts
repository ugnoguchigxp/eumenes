import { systemContext } from "../../../infrastructure/system-context";
import type { AnswerTicket } from "../../agent-runtime";
import type { HandlerDefinition } from "../../queue";
import { compileContext, windowIsEmpty } from "./context-compiler";
import { prepareRouting } from "./delegate-conversation";
import { renderGoalsLayer } from "./goals-layer";
import { topicTexts, worldNamesHint } from "./topic-texts";
import { researchResultContext } from "./research-result-context";
import { specialistWorkMessage, viewingMessage } from "./specialist-context";
import { byId, transition } from "../repository";
import { endRun } from "./run-end";
import { isSystemPrompt, type Run } from "../contracts";
import {
	DEFAULT_DEADLINE_MS,
	type ChatMessage,
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
		// World is read only by the research sub-agent; the conversation gets the names of the known targets
		// this turn's wording mentions, as one line of L4 (nothing when none is named or World is unusable).
		const worldHint =
			worldContext && !agent?.failureCode && !agent?.actionPayload
				? worldNamesHint(
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
		const compiled = compileContext(
			tx,
			current,
			conversation,
			larm.snapshotInTransaction?.(tx).general,
			window,
			memory,
			goalsLayer?.message,
			!!deps.specialist,
		);
		let messages = compiled.messages;
		if (agent?.projection || agent?.failureCode)
			messages = researchResultContext(
				compiled.sections,
				agent.projection ?? undefined,
				agent.failureCode,
			);
		// Notices, prefetched exchanges and the World name hint come last, right before the current input; the
		// operation results and the policy added below then land between them and the input.
		messages.splice(
			messages.length - 1,
			0,
			...(!agent?.failureCode ? compiled.sections.tail : []),
			...(worldHint ? [worldHint] : []),
		);
		// Specialist work stays out of the conversation's context; the main agent gets a short host record of it.
		const specialistLines: ChatMessage[] =
			deps.specialist && !isSystemPrompt(run.sourceKind) && !agent
				? [
						specialistWorkMessage(deps, tx, current),
						viewingMessage(deps, tx, current),
						...(claim.payload.specialistHandoff
							? [
									{
										role: "system" as const,
										content: `${systemContext(
											"dialogue.contexts.generation-prepare.specialist-handoff",
											{},
										)}\nspecialistHandoff=${claim.payload.specialistHandoff}`,
									},
								]
							: []),
					].filter((line): line is ChatMessage => line !== null)
				: [];
		messages.splice(messages.length - 1, 0, ...specialistLines);
		// This run's context is fixed by the host: the server must neither trim nor reorder it.
		const requestId = larm.requestFor?.(tx, run.id, "llm");
		if (requestId) larm.setContextPolicyInTransaction?.(tx, requestId, "exact");
		let actionResultIndex: number | undefined;
		if (agent?.actionPayload) {
			const operation = JSON.parse(agent.actionPayload);
			actionResultIndex = messages.length - 1;
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare",
				{},
			);
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ actionResult: operation }),
			});
		}

		const delegated =
			!run.agentTaskId && !isSystemPrompt(run.sourceKind)
				? deps.delegation?.prepareInTransaction(tx, run)
				: undefined;
		const drawingResult = deps.excalidraw?.resultInTransaction(tx, run.id);
		const recognitionResult = deps.objectRecognition?.resultInTransaction(
			tx,
			run.id,
		);
		if (recognitionResult) {
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare-2",
				{},
			);
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ recognitionResult }),
			});
		}
		const imageResult = deps.image?.resultInTransaction(tx, run.id);
		const musicResult = deps.music?.resultInTransaction(tx, run.id);
		if (delegated?.receipt) {
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare-3",
				{},
			);
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ delegationResult: delegated.receipt }),
			});
		}
		if (drawingResult) {
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare-4",
				{},
			);
			messages.push({
				role: "user",
				content: JSON.stringify({ drawingResult }),
			});
		}
		if (imageResult) {
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare-5",
				{},
			);
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ imageResult }),
			});
		}
		if (musicResult) {
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare-6",
				{},
			);
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ musicResult }),
			});
		}
		const note = claim.payload.commandNote;
		if (note) {
			messages[0]!.content += systemContext(
				"dialogue.contexts.generation-prepare.create-prepare-7",
				{},
			);
			messages.splice(messages.length - 1, 0, {
				role: "user",
				content: JSON.stringify({ commandQuestion: note }),
			});
		}
		// A new decision: the execute phase retrieves the toolchains for this request.
		// While an operation's result (or a sub-agent's question) is phrased, nothing new is offered.
		const routing =
			!drawingResult &&
			!recognitionResult &&
			!imageResult &&
			!musicResult &&
			!delegated?.receipt &&
			!note
				? prepareRouting(tx, deps, run, messages, compiled.sections.input, {
						dots: !!delegated && delegated.available !== false,
					})
				: undefined;
		// The history a resumed session starts from is exactly the adopted exchanges this prompt shows (the
		// kept and the not yet processed ones); the layers around them and everything added later are this turn's input.
		const adopted = new Set([
			...compiled.sections.history,
			...compiled.sections.unprocessed,
		]);
		const sessionContext = {
			instructionCount:
				1 + compiled.sections.longTerm.length + compiled.sections.goals.length,
			historyCount: messages.filter((m) => adopted.has(m)).length,
		};
		// A prefetch left out of this turn is neither sent nor checked at adoption.
		const prepared =
			window && compiled.prefetchDropped
				? { ...window, prefetch: { text: "", pins: [], bytes: 0 } }
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
				sessionContext,
				currentRequest: {
					messageId: run.inputMessageId,
					messageIndex: messages.indexOf(compiled.sections.input),
				},
				actionResultIndex,
				...(imageResult || musicResult ? { mediaResult: true as const } : {}),
				...(actionResultIndex !== undefined ||
				delegated?.receipt ||
				drawingResult ||
				recognitionResult ||
				imageResult ||
				musicResult ||
				note
					? { operationResult: true as const }
					: {}),
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
			},
		};
	};
}
