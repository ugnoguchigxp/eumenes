import { systemContext } from "../../../infrastructure/system-context";
import { measureStage } from "../../../infrastructure/performance";
import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	PREFETCH_BYTES,
	RECALL_LIMIT,
	RECALL_MIN_SCORE,
	type TurnRecall,
} from "../../memory";
import type { AnswerTicket } from "../../agent-runtime";
import type { SelectionOutcome } from "../../toolchain-history";
import type {
	QueryVector,
	ToolchainRoute,
	ToolchainRoutingPort,
} from "../contracts/toolchains";
import type { DialogueDeps, GenerateInput } from "./context";
import { currentRequestMessage, markCurrentRequest } from "./request-context";
import {
	appendConversationPolicy,
	toolchainTools,
	type ConversationOperation,
	type OpenQuestion,
} from "./conversation-tools";

const log = getLogger("dialogue");

/** One conversation decision as recorded with its adoption (the run id is added there). */
export type SelectionDraft = Omit<
	Parameters<ToolchainRoutingPort["recordSelectionInTransaction"]>[1],
	"runId"
>;

const reported = new Set<SelectionOutcome>([
	"answered",
	"partial",
	"not_found",
	"clarification_required",
	"failed",
]);
/** The outcome of an adopted answer: the sub-agent's report outcome, or completed. */
export function agentOutcome(agent: AnswerTicket | undefined): {
	outcome: SelectionOutcome;
	code?: string | null;
} {
	if (!agent) return { outcome: "completed" };
	if (agent.failureCode) return { outcome: "failed", code: agent.failureCode };
	if (agent.actionFailure) return { outcome: "failed", code: "action_failed" };
	try {
		const outcome = agent.projection
			? (JSON.parse(agent.projection) as { outcome?: SelectionOutcome }).outcome
			: undefined;
		return {
			outcome: outcome && reported.has(outcome) ? outcome : "completed",
		};
	} catch {
		return { outcome: "completed" };
	}
}

/**
 * A new decision: retrieve the toolchains for this request, offer them as functions with the
 * fixed policy and past selections, and keep what is needed to trace the decision.
 */
export async function prepareDecision(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
) {
	const routed = Date.now();
	const current = currentRequestMessage(input);
	let messages = [...input.messages];
	let tools = input.agent ? undefined : input.tools;
	let route: ToolchainRoute | undefined;
	let query: QueryVector | undefined;
	let recallPins: TurnRecall["pins"] = [];
	let openQuestions: OpenQuestion[] = [];
	let selectionMessages: typeof messages | undefined;
	let answerMessages: typeof messages | undefined;
	let selectionRecall: string | undefined;
	if (input.routing && deps.toolchains && !input.agent) {
		const routing = input.routing;
		query = await measureStage("dialogue", "query_embedding", () =>
			deps.toolchains!.embedQuery(routing.query, signal),
		);
		signal.throwIfAborted();
		route = deps.store.read((db) =>
			deps.toolchains!.routeInTransaction(db, {
				runId: input.runId,
				text: routing.query,
				query,
				available: new Set(routing.available),
			}),
		);
		messages = [...input.messages];
		// Earlier exchanges that left the verbatim window, found by this turn's own vector (no model round trip).
		const recalled = recallFor(deps, input, query);
		if (recalled) {
			messages.splice(messages.indexOf(current), 0, {
				role: "system",
				content: recalled.text,
			});
			selectionRecall = recalled.text;
			recallPins = recalled.pins;
		}
		// A question is answerable only through a function that is offered now.
		openQuestions = routing.openQuestions.filter((q) =>
			route!.cards.some((c) => c.functionName === q.functionName),
		);
		answerMessages = markCurrentRequest(
			messages,
			current,
			input.currentRequest.messageId,
		);
		if (route.cards.length && !input.operationResult) {
			// Keep the same scope; appended host results cannot become a request.
			const requests = [
				...messages
					.slice(0, messages.indexOf(current))
					.filter((m) => m.role === "user")
					.slice(-2),
				current,
			];
			selectionMessages = requests.map((m, index) =>
				index === requests.length - 1
					? m
					: {
							...m,
							content:
								systemContext("dialogue.contexts.selection-trace.content", {}) +
								JSON.stringify(m.content),
						},
			);
			if (selectionRecall)
				selectionMessages.unshift({ role: "system", content: selectionRecall });
			appendConversationPolicy(
				selectionMessages,
				true,
				current,
				[],
				openQuestions,
			);
			selectionMessages = markCurrentRequest(
				selectionMessages,
				current,
				input.currentRequest.messageId,
			);
		}
		appendConversationPolicy(
			messages,
			route.cards.length > 0,
			current,
			route.past.map(({ request, functionName, outcome }) => ({
				request,
				functionName,
				outcome,
			})),
			openQuestions,
		);
		tools = route.cards.length
			? toolchainTools(route.cards, openQuestions)
			: undefined;
		log.info("dialogue.candidates_selected", {
			candidateCount: route.cards.length,
			retrieval: route.retrieval,
			durationMs: Date.now() - routed,
		});
	}
	messages = markCurrentRequest(
		messages,
		current,
		input.currentRequest.messageId,
	);
	const decided = route;
	const draft = (
		decision: SelectionDraft["decision"],
		extra: Partial<SelectionDraft> = {},
	): SelectionDraft | undefined =>
		decided && input.routing
			? {
					conversationId: input.routing.conversationId,
					utteranceId: input.routing.utteranceId,
					requestId: input.routing.requestId,
					retrieval: decided.retrieval,
					candidates: decided.cards.map((c) => ({
						toolchainId: c.id,
						revisionId: c.revisionId,
						functionName: c.functionName,
						...c.score,
					})),
					historyRefs: decided.past.map((p) => p.selectionId),
					decision,
					query,
					durationMs: Date.now() - routed,
					...extra,
				}
			: undefined;
	return {
		messages,
		selectionMessages,
		answerMessages,
		tools,
		cards: route?.cards,
		openQuestions,
		draft,
		recallPins,
	};
}
/** The earlier exchanges (not shown in the prompt) that resemble the request; null when there are none or recall is unavailable. */
function recallFor(
	deps: DialogueDeps,
	input: GenerateInput,
	query: QueryVector | undefined,
): TurnRecall | null {
	const window = input.memory?.window;
	if (!deps.memory || !window || !query) return null;
	try {
		return deps.store.read((db) =>
			deps.memory!.recallTurnsInRead(db, {
				conversationId: window.conversationId,
				space: query.space,
				vector: query.vector,
				limit: RECALL_LIMIT,
				minScore: RECALL_MIN_SCORE,
				// What the prefetch already uses comes off the same budget.
				maxBytes: PREFETCH_BYTES - window.prefetchBytes,
				// Blocked messages are left out by the recall itself, at the time it reads them.
				excludeMessageIds: [
					...window.shownMessageIds,
					...window.pins.map((pin) => pin.messageId),
				],
			}),
		);
	} catch (error) {
		// Recall is an aid: the answer goes on without it.
		log.warn("dialogue.recall_failed", { reason: "recall_failed" }, error);
		return null;
	}
}
/** A decision whose output broke the contract twice is traced as rejected and failed. */
export async function recordRejected(
	deps: DialogueDeps,
	runId: string,
	draft: Decision["draft"],
) {
	const rejected = draft("rejected", { repaired: true });
	if (!rejected || !deps.toolchains) return;
	await deps.store
		.write((db) => {
			deps.toolchains!.recordSelectionInTransaction(db, {
				runId,
				...rejected,
			});
			deps.toolchains!.settleSelectionInTransaction(db, runId, {
				outcome: "failed",
				code: "invalid_conversation_operation",
			});
		})
		.catch(() => undefined);
}
/** An answer that is not adopted also ends the decision it carried. */
export function failedAnswer(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	errorCode: string,
) {
	deps.toolchains?.settleSelectionInTransaction(tx, runId, {
		outcome: "failed",
		code: errorCode,
	});
	return { status: "failed" as const, errorCode };
}
type Decision = Awaited<ReturnType<typeof prepareDecision>>;
/** The trace of a decision that handed the request to one toolchain. */
export function chosen(
	decision: Decision,
	generated: { operation?: ConversationOperation; repaired: boolean },
) {
	const op = generated.operation!;
	return decision.draft("toolchain", {
		toolchainId: op.toolchainId,
		toolchainRevisionId: op.revisionId,
		functionName: op.functionName,
		request: op.request,
		repaired: generated.repaired,
	});
}
/** Record the decision with the attempt that is being adopted. */
export function traceSelection(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	selection: SelectionDraft | undefined,
) {
	if (selection)
		deps.toolchains?.recordSelectionInTransaction(tx, { runId, ...selection });
}
export function traceOutcome(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	result: { outcome: SelectionOutcome; code?: string | null },
) {
	deps.toolchains?.settleSelectionInTransaction(tx, runId, result);
}
/** A run that ends without an adopted answer: failed, expired, interrupted or cancelled. */
export function traceFailure(
	deps: DialogueDeps,
	tx: Database,
	runId: string,
	type: string,
	code: string | null,
) {
	traceOutcome(deps, tx, runId, {
		outcome:
			type === "expired"
				? "expired"
				: type === "cancelled"
					? "cancelled"
					: "failed",
		code,
	});
}
