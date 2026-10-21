import { systemContext } from "../../../infrastructure/system-context";
import {
	retainedOffer,
	usageMessage,
	type UsageReference,
} from "./retained-toolchains";
import { measureStage } from "../../../infrastructure/performance";
import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import { MEMORY_HISTORY_MAX_TOKENS } from "../../inference";
import { RECALL_MIN_SCORE, type TurnRecall } from "../../memory";
import type { AnswerTicket } from "../../agent-runtime";
import type { SelectionOutcome } from "../../toolchain-history";
import type {
	QueryVector,
	ToolchainRoute,
	ToolchainRoutingPort,
} from "../contracts/toolchains";
import type { DialogueDeps, GenerateInput } from "./context";
import { currentRequestMessage, markCurrentRequest } from "./request-context";
import { sessionFunctionNames, sessionOffers } from "./specialist-context";
import {
	analysisRecord,
	analysisTrace,
	type FirstRound,
} from "./initial-decision";
import {
	appendConversationPolicy,
	toolchainTools,
	type ConversationOperation,
	type SessionOffers,
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

type DraftParts = {
	analysis?: FirstRound;
	route?: ToolchainRoute;
	query?: QueryVector;
};
/**
 * The trace of one conversation decision, filled in once the decision is known. A decision made without
 * routing (a sub-agent's result, a scheduled prompt) leaves no trace.
 */
export function decisionDraft(
	input: GenerateInput,
	started: number,
	{ analysis, route, query }: DraftParts,
) {
	const routing = input.routing;
	return (
		decision: SelectionDraft["decision"],
		extra: Partial<SelectionDraft> = {},
	): SelectionDraft | undefined =>
		routing
			? {
					conversationId: routing.conversationId,
					utteranceId: routing.utteranceId,
					requestId: routing.requestId,
					retrieval: route?.retrieval ?? "none",
					candidates:
						route?.cards.map((c) => ({
							toolchainId: c.id,
							revisionId: c.revisionId,
							functionName: c.functionName,
							...c.score,
						})) ?? [],
					historyRefs: route?.past.map((p) => p.selectionId) ?? [],
					decision,
					...(analysis ? { analysis: analysisTrace(analysis) } : {}),
					query,
					durationMs: Date.now() - started,
					...extra,
				}
			: undefined;
}
/** What a decision hands on: the trace to record with its adoption and the recalled exchanges it stands on. */
export type Decision = {
	draft: ReturnType<typeof decisionDraft>;
	recallPins: TurnRecall["pins"];
};

/** The candidate toolchains of a request, found before the first round (no model call). */
export type Candidates = {
	started: number;
	allowDiscovery?: boolean;
	notes?: UsageReference[];
	discovery?: "completed" | "embedding_unavailable";
	route: ToolchainRoute;
	/** The embedding of the current request (the recall of the exchanges that left the window reads it too). */
	query: QueryVector | undefined;
	queryText?: string;
	recall?: { query: QueryVector | undefined };
	/** The function names of the session toolchains among the cards (their saved items are listed only for the chosen one). */
	sessionFunctions: ReadonlySet<string>;
};

/** First offer: retained callable functions only, with no embedding or search. */
export function retainedCandidates(
	deps: DialogueDeps,
	input: GenerateInput,
): Candidates {
	const offer = deps.store.read((db) => retainedOffer(deps, db, input));
	return {
		started: Date.now(),
		route: { cards: offer.cards, past: [], retrieval: "none" },
		query: undefined,
		allowDiscovery: true,
		notes: offer.notes,
		sessionFunctions: sessionFunctionNames(deps, offer.cards),
	};
}
/** One LLM-requested search, excluding already offered revisions before ranking and the four-card limit. */
export async function findCandidates(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	searchText = currentRequestMessage(input).content,
	excluded: ReadonlySet<string> = new Set(),
): Promise<Candidates> {
	const started = Date.now();
	const routing = input.routing!;
	const query = await measureStage("dialogue", "query_embedding", () =>
		deps.toolchains!.embedQuery(searchText, signal),
	);
	signal.throwIfAborted();
	const route = deps.store.read((db) =>
		deps.toolchains!.routeInTransaction(db, {
			runId: input.runId,
			text: searchText,
			query,
			available: new Set(routing.available),
			excludeRevisionIds: excluded,
			strict: true,
		}),
	);
	log.info("dialogue.candidates_selected", {
		candidateCount: route.cards.length,
		retrieval: route.retrieval,
		durationMs: Date.now() - started,
	});
	return {
		started,
		route,
		query,
		queryText: searchText,
		allowDiscovery: false,
		discovery: query ? "completed" : "embedding_unavailable",
		sessionFunctions: sessionFunctionNames(deps, route.cards),
	};
}

/** Keep existing conversation recall independent of capability discovery; never searches the tool catalog. */
export async function prepareRecallQuery(
	deps: DialogueDeps,
	input: GenerateInput,
	found: Candidates,
	signal: AbortSignal,
) {
	if (!deps.memory || !input.memory?.window || !deps.toolchains) return;
	const text = currentRequestMessage(input).content;
	found.recall = {
		query:
			found.queryText === text
				? found.query
				: await measureStage("dialogue", "memory_recall_embedding", () =>
						deps.toolchains!.embedQuery(text, signal),
					),
	};
	signal.throwIfAborted();
}

/**
 * The context of a direct answer: the conversation's own, the exchanges recalled for this turn and, after the
 * first round, its kind next to the current request. A turn without routing recalls nothing. The recall reads
 * the embedding of the current utterance itself.
 */
export function prepareAnswer(
	deps: DialogueDeps,
	input: GenerateInput,
	found?: Candidates,
	analysis?: FirstRound,
) {
	const started = found?.started ?? Date.now();
	const current = currentRequestMessage(input);
	const recalled = recallFor(
		deps,
		input,
		found?.recall ? found.recall.query : found?.query,
	);
	const messages = [...input.messages];
	messages.splice(
		messages.indexOf(current),
		0,
		...(recalled ? [{ role: "system" as const, content: recalled.text }] : []),
		...(analysis ? [analysisRecord(analysis)] : []),
	);
	return {
		messages: markCurrentRequest(
			messages,
			current,
			input.currentRequest.messageId,
		),
		draft: decisionDraft(input, started, {
			analysis,
			route: found?.route,
			query: found?.query,
		}),
		recallPins: recalled?.pins ?? [],
	};
}

/**
 * The second round of a request the first round gave to a toolchain: offer that one function only (with the
 * questions still open for it and, for a session toolchain, the saved items), the fixed policy, the past
 * selections, the recalled exchanges and the recent requests; and keep what is needed to trace the decision.
 */
export function prepareSelection(
	deps: DialogueDeps,
	input: GenerateInput,
	found: Candidates,
	analysis: FirstRound & { next: "toolchain" },
) {
	const current = currentRequestMessage(input);
	const routing = input.routing!;
	const { route, query } = found;
	const { card } = analysis;
	// Earlier exchanges that left the verbatim window, found by this turn's own vector (no model round trip).
	const recalled = recallFor(
		deps,
		input,
		found.recall ? found.recall.query : query,
	);
	// A question is answerable only through the function that is offered now.
	const openQuestions = routing.openQuestions.filter(
		(q) => q.functionName === card.functionName,
	);
	// The saved items are listed for the chosen toolchain only.
	const sessions: SessionOffers = sessionOffers(deps, [card], input.runId);
	// Keep the same scope; appended host results cannot become a request.
	const requests = [
		...input.messages
			.slice(0, input.messages.indexOf(current))
			.filter((m) => m.role === "user")
			.slice(-2),
		current,
	];
	let messages = requests.map((m, index) =>
		index === requests.length - 1
			? m
			: {
					...m,
					content:
						systemContext("dialogue.contexts.selection-trace.content", {}) +
						JSON.stringify(m.content),
				},
	);
	const note = found.notes?.filter(
		(note) => note.revisionId === card.revisionId,
	);
	if (note?.length) messages.unshift(usageMessage(note));
	if (recalled) messages.unshift({ role: "system", content: recalled.text });
	appendConversationPolicy(
		messages,
		current,
		route.past.map(({ request, functionName, outcome }) => ({
			request,
			functionName,
			outcome,
		})),
		openQuestions,
	);
	messages = markCurrentRequest(
		messages,
		current,
		input.currentRequest.messageId,
	);
	return {
		messages,
		tools: toolchainTools([card], openQuestions, sessions),
		cards: [card],
		openQuestions,
		sessions,
		draft: decisionDraft(input, found.started, { analysis, route, query }),
		recallPins: recalled?.pins ?? [],
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
				minScore: RECALL_MIN_SCORE,
				// What is left of the memory and history budget (the prefetch is already in the prompt).
				maxTokens:
					input.memoryRoomTokens ??
					MEMORY_HISTORY_MAX_TOKENS - window.prefetchTokens,
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
	return selection
		? deps.toolchains?.recordSelectionInTransaction(tx, { runId, ...selection })
		: undefined;
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
