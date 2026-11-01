import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { InferencePort } from "../../inference";
import type { RouteAnswer } from "../../inference/contracts";
import type { RouterTraceRecord } from "../../toolchain-history";
import type { QueryVector } from "../contracts/toolchains";
import type { DialogueDeps } from "./context";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import {
	SAID,
	answerQuestion,
	approveConfirmation,
	askBack,
	checkWork,
	declineConfirmation,
	handWith,
	instantWith,
	needsConfirmation,
	operateWork,
	readWith,
	requestMemory,
	type Fields,
	type Step,
} from "./routed-actions";
import { fieldsOf } from "./routed-fields";
import {
	TRACE_WINDOW_MS,
	correctProbabilities,
	decide,
	decidedKind,
	routeCandidates,
	routerTrace,
	type Skipped,
	type Announce,
	type Ranked,
	type RouteCandidate,
	type RouteDecision,
	type RouterSettings,
} from "./routed-route";
import {
	retainedChoice,
	searchTurn,
	switchingOf,
	type Searched,
} from "./routed-search";
import type { Turn } from "./routed-turn";

const log = getLogger("dialogue");
/** The resources one hand-over may carry (the delegate call's bound). */
const RESOURCE_REFS = 8;

/** The saved router when it is on or in shadow, with the ports that ask it (spec toolchain-router-redesign §8). */
export type ActiveRouter = {
	settings: RouterSettings;
	route: NonNullable<InferencePort["route"]>;
	routeFields?: InferencePort["routeFields"];
};

/** The router the turn may ask: none until a profile is saved, none when it is off or the port cannot route. */
export function activeRouter(deps: DialogueDeps): ActiveRouter | null {
	const snapshot = deps.larm.snapshotInTransaction?.bind(deps.larm);
	const route = deps.larm.route?.bind(deps.larm);
	if (!snapshot || !route) return null;
	const settings = deps.store.read((tx) => snapshot(tx)).router;
	if (!settings || settings.mode === "off" || !settings.profile) return null;
	const fields = deps.larm.routeFields?.bind(deps.larm);
	return { settings, route, ...(fields ? { routeFields: fields } : {}) };
}

/** A failure as the log may name it: a code, never the words of a message. */
export function reasonOf(error: unknown, timeout?: AbortSignal): string {
	if (timeout?.aborted) return "timeout";
	return error instanceof Error && /^[a-z0-9_]{1,80}$/.test(error.message)
		? error.message
		: "router_failed";
}

/** What one asking of the router left the turn with. */
type Consulted = {
	candidates: RouteCandidate[];
	/** The words the turn acts on. */
	words: string;
	/** Null when the router failed or timed out (row 10). */
	decision: RouteDecision | null;
	/** The previous routed turn of the conversation, within the correction window. */
	latest: RouterTraceRecord | null;
	/** The model of the router's answer: what its second call is asked of. */
	model: string | null;
	/** Writes the turn's trace again with these parts changed (a redirect carried out, a question asked once more). */
	retrace(changes: Retrace): Promise<void>;
};
type Retrace = {
	decided?: string | null;
	set?: string[];
	text?: string;
	query?: QueryVector | null;
	messageIds?: readonly string[];
};

/** The previous routed turn's trace and the number of the work it started, when that work is still listed. */
function previousTrace(turn: Turn): {
	trace: RouterTraceRecord;
	todo: string | null;
} | null {
	const { deps, input } = turn;
	const port = deps.toolchains;
	if (!port?.latestRouterTraceInTransaction) return null;
	return deps.store.read((tx) => {
		const trace = port.latestRouterTraceInTransaction!(tx, {
			conversationId: input.conversationId,
			since: Date.parse(deps.clock()) - TRACE_WINDOW_MS,
		});
		if (!trace) return null;
		const todo = trace.workId
			? (deps.work
					?.refsInTransaction(tx, input.conversationId)
					.todo(trace.workId) ?? null)
			: null;
		return { trace, todo };
	});
}

/** The messages a turn's trace is made from: its own, and those of the question back it answers. */
function messagesOf(turn: Turn, asking: RouterTraceRecord | null): string[] {
	const { input } = turn;
	return [
		...new Set([
			...(input.final.kind === "utterances" ? input.final.messageIds : []),
			input.inputMessageId,
			...(turn.routed?.asked && asking ? asking.messageIds : []),
		]),
	];
}

/**
 * Asks the router about the turn: scores the candidates, corrects the scores by what the user corrected near these
 * words, decides by the table, and records the trace. A router that failed (or a read of its own that did) leaves no
 * decision.
 */
async function consult(
	turn: Turn,
	router: ActiveRouter,
	mode: "shadow" | "on",
	words: string,
	searched: Searched | null,
): Promise<Consulted> {
	const routed = turn.routed!;
	const { settings } = router;
	const started = performance.now();
	let previous: ReturnType<typeof previousTrace> = null;
	let candidates: RouteCandidate[] = [];
	let answer: RouteAnswer | null = null;
	let ranked: Ranked[] = [];
	let decision: RouteDecision | null = null;
	let error: string | null = null;
	let timeout: AbortSignal | undefined;
	try {
		previous = previousTrace(turn);
		const skipped: Skipped[] = [];
		candidates = routeCandidates({
			routed,
			searched,
			redirect: previous?.todo
				? { trace: previous.trace, todo: previous.todo }
				: null,
			switching: switchingOf(turn),
			skipped,
		});
		for (const reason of new Set(skipped.map((s) => s.reason)))
			log.warn("dialogue.router_candidate_skipped", {
				count: skipped.filter((s) => s.reason === reason).length,
				reason,
			});
	} catch (cause) {
		if (turn.signal.aborted) throw cause;
		error = reasonOf(cause);
	}
	if (!error) {
		timeout = AbortSignal.timeout(settings.timeoutMs);
		try {
			answer = await router.route(
				{
					// The router cuts the text to its bound itself (at a character, never inside one).
					text: words.trim(),
					previousAgent: routed.previousReply,
					previousUser: routed.earlier.at(-1) ?? null,
					instructions: systemContext(
						"dialogue.contexts.local.router-instructions",
						{},
					),
					criteria: candidates.map((c) => ({
						name: c.id,
						description: c.passage,
					})),
				},
				AbortSignal.any([turn.signal, timeout]),
			);
		} catch (cause) {
			// A cancelled run is the run's, not the router's.
			if (turn.signal.aborted) throw cause;
			error = reasonOf(cause, timeout);
		}
	}
	const durationMs = Math.round(performance.now() - started);
	const query = searched?.query;
	if (answer) {
		try {
			const scored = rank(turn, router, candidates, answer, query);
			ranked = scored.ranked;
			if (scored.conflicts.length) await markConflicts(turn, scored.conflicts);
			// A question asked in the turn before (rows 5 and 6) was put to the user: the answer needs `low` only.
			const asked =
				previous?.trace.mode === "on" &&
				(previous.trace.row === 5 || previous.trace.row === 6)
					? previous.trace.decided
					: null;
			decision = decide(ranked, settings, asked);
		} catch (cause) {
			if (turn.signal.aborted) throw cause;
			error = reasonOf(cause);
			ranked = [];
			decision = null;
		}
	}
	const traced = {
		mode,
		ranked,
		decision,
		answer: decision ? answer : null,
		durationMs,
		error,
	};
	const latest = previous?.trace ?? null;
	const trace = (changes: Retrace = {}) =>
		recordTrace(
			turn,
			{
				text: changes.text ?? words,
				query:
					changes.query === undefined ? query : (changes.query ?? undefined),
				messageIds: changes.messageIds ?? messagesOf(turn, latest),
			},
			{
				...traced,
				...(changes.decided !== undefined ? { decided: changes.decided } : {}),
				...(changes.set ? { set: changes.set } : {}),
			},
		);
	await trace();
	if (decision)
		log.info("dialogue.router_decided", {
			mode,
			row: decision.row,
			kind: decidedKind(decision),
			count: candidates.length,
			durationMs,
		});
	else log.warn("dialogue.router_failed", { reason: error ?? "router_failed" });
	return {
		candidates,
		words,
		decision,
		latest,
		model: answer?.model ?? null,
		retrace: trace,
	};
}

/** The candidates with the router's probabilities, corrected by the corrections near the query, best first. */
function rank(
	turn: Turn,
	router: ActiveRouter,
	candidates: readonly RouteCandidate[],
	answer: RouteAnswer,
	query: QueryVector | undefined,
): { ranked: Ranked[]; conflicts: string[] } {
	const { deps } = turn;
	const { settings } = router;
	const port = deps.toolchains;
	const near =
		query &&
		settings.feedbackWeight > 0 &&
		port?.nearRouterFeedbackInTransaction
			? deps.store.read((tx) =>
					port.nearRouterFeedbackInTransaction!(tx, {
						...query,
						threshold: settings.feedbackNear,
					}),
				)
			: [];
	const corrected = correctProbabilities(
		candidates.map((c) => ({ id: c.id, p: answer.probabilities[c.id] ?? 0 })),
		near,
		{ threshold: settings.feedbackNear, weight: settings.feedbackWeight },
	);
	if (corrected.conflict)
		log.warn("dialogue.router_feedback_conflict", { count: near.length });
	return {
		conflicts: corrected.conflict ? near.map((row) => row.id) : [],
		ranked: candidates
			.map((candidate, i): Ranked => ({
				candidate,
				raw: answer.probabilities[candidate.id] ?? 0,
				correction: corrected.shift[i]!,
				p: corrected.p[i]!,
				score: answer.scores?.[candidate.id] ?? null,
			}))
			.sort((a, b) => b.p - a.p),
	};
}

/** Corrections that name different right answers are taken out of use and left for the user's review. */
function markConflicts(turn: Turn, ids: readonly string[]): Promise<void> {
	const { deps } = turn;
	const port = deps.toolchains;
	if (!port?.setRouterFeedbackStateInTransaction) return Promise.resolve();
	return deps.store
		.write((tx) => {
			for (const id of ids)
				port.setRouterFeedbackStateInTransaction!(tx, id, "conflict");
		})
		.catch((error: unknown) => {
			log.warn("dialogue.router_trace_failed", { reason: reasonOf(error) });
		});
}

/** The trace of the turn; a trace that cannot be written never stops the conversation. */
function recordTrace(
	turn: Turn,
	utterance: {
		text: string;
		query: QueryVector | undefined;
		messageIds: readonly string[];
	},
	made: Parameters<typeof routerTrace>[0],
): Promise<void> {
	const { deps, input } = turn;
	const port = deps.toolchains;
	if (!port?.recordRouterTraceInTransaction) return Promise.resolve();
	return deps.store
		.write((tx) =>
			port.recordRouterTraceInTransaction!(tx, {
				runId: input.runId,
				conversationId: input.conversationId,
				messageId: input.inputMessageId,
				messageIds: utterance.messageIds,
				text: utterance.text,
				query: utterance.query ?? null,
				trace: routerTrace(made),
			}),
		)
		.catch((error: unknown) => {
			log.warn("dialogue.router_trace_failed", { reason: reasonOf(error) });
		});
}

/**
 * The shadow router (spec §8, R1): looks at the turn beside the choice call, records what it would decide, and
 * changes nothing. Whatever goes wrong only reaches the log.
 */
export async function shadowRoute(
	turn: Turn,
	router: ActiveRouter,
	words: string,
): Promise<void> {
	try {
		const searched = await searchTurn(turn, words, {
			slots: "router",
			record: false,
		});
		await consult(turn, router, "shadow", words, searched);
	} catch (error) {
		if (turn.signal.aborted) return;
		log.warn("dialogue.router_failed", { reason: reasonOf(error) });
	}
}

/**
 * The request turn and the pending turn, decided by the router (spec §3.1, §3.3): no choice call. `search: false`
 * when the judge found no request of work: only the open confirmations and questions are offered then.
 */
export async function routerTurn(
	turn: Turn,
	router: ActiveRouter,
	options: { search: boolean },
): Promise<Step> {
	const routed = turn.routed!;
	const words = routed.asked
		? `${routed.asked.request}\n${turn.utterance}`
		: turn.utterance;
	const searched = options.search
		? await searchTurn(turn, words, { slots: "router" })
		: null;
	const consulted = await consult(turn, router, "on", words, searched);
	// A router that failed leaves the turn to the talk turn (row 10); nothing is promised.
	if (!consulted.decision) return "talk";
	const step = await carryOut(turn, router, consulted, consulted.decision);
	if (typeof step === "string") return step;
	// The host could not carry it out: it says so, and the router's choice is not made again.
	turn.speak(SAID.failed);
	return "done";
}

/** The title of a candidate the host names to the user. */
const titleOf = (c: RouteCandidate) =>
	lineText(
		c.kind === "toolchain" || c.kind === "read" ? c.card.title : c.id,
	).slice(0, 30);

const ANNOUNCE = {
	fixed: "dialogue.contexts.local.router-announce",
	try: "dialogue.contexts.local.router-announce-try",
	partial: "dialogue.contexts.local.router-announce-partial",
} as const;
const announcement = (announce: Announce, title: string) =>
	announce === "none" ? "" : systemContext(ANNOUNCE[announce], { title });

/** What a decision does (spec §3.3). */
async function carryOut(
	turn: Turn,
	router: ActiveRouter,
	consulted: Consulted,
	decision: RouteDecision,
): Promise<Step> {
	switch (decision.to) {
		case "conversation":
			return "talk";
		case "ask":
			return askBack(
				turn,
				systemContext("dialogue.contexts.local.router-ask", {
					first: titleOf(decision.options[0]),
					second: titleOf(decision.options[1]),
				}),
			);
		case "again":
			return askAgain(turn, consulted, decision.candidate);
		case "run":
			return run(
				turn,
				router,
				consulted,
				decision.candidate,
				decision.announce,
			);
	}
}

/**
 * Not sure enough to do it: the host asks once more and does nothing. The trace keeps the candidate asked about as
 * decided, so the answer in the next turn is held to `low` only.
 */
async function askAgain(
	turn: Turn,
	consulted: Consulted,
	c: RouteCandidate,
): Promise<Step> {
	const { deps, input } = turn;
	const latest = consulted.latest;
	if (c.kind === "pending" && c.operation === "discard")
		turn.speak(
			systemContext("dialogue.contexts.local.router-switch-ask", {
				title: lineText(c.title).slice(0, 30),
			}),
		);
	else if (c.kind === "pending" && c.operation === "approve")
		turn.speak(
			systemContext("dialogue.contexts.local.router-reconfirm", {
				toolchain: lineText(c.toolchain).slice(0, 30),
			}),
		);
	else if (c.kind === "redirect") {
		turn.speak(
			systemContext("dialogue.contexts.local.router-redirect-ask", {
				title: lineText(c.title).slice(0, 40),
				to: lineText(c.target).slice(0, 30),
			}),
		);
		// The answer is a redirect of the same work to the same toolchain: its context goes on in this turn's trace.
		if (latest?.workId) {
			await consulted.retrace({
				text: latest.text,
				query: latest.query,
				set: latest.set,
				messageIds: [
					...new Set([...messagesOf(turn, latest), ...latest.messageIds]),
				],
			});
			const port = deps.toolchains;
			await deps.store
				.write((tx) =>
					port?.linkRouterWorkInTransaction?.(tx, input.runId, latest.workId!),
				)
				.catch((error: unknown) => {
					log.warn("dialogue.router_trace_failed", { reason: reasonOf(error) });
				});
		}
	} else
		turn.speak(
			systemContext("dialogue.contexts.local.router-cancel-ask", {
				title: lineText(c.kind === "work" ? c.title : "").slice(0, 40),
			}),
		);
	return "done";
}

/** One candidate the router decided to do. */
async function run(
	turn: Turn,
	router: ActiveRouter,
	consulted: Consulted,
	c: RouteCandidate,
	announce: Announce,
): Promise<Step> {
	const accepted = () =>
		systemContext("dialogue.contexts.local.router-accepted", {});
	switch (c.kind) {
		case "conversation":
			return "talk";
		case "toolchain":
		case "read":
			return toolchain(turn, router, consulted, c, announce);
		case "memory": {
			const filled = await fieldsOf(
				turn,
				router,
				consulted.words,
				"memory",
				consulted.model,
			);
			if ("step" in filled) return filled.step;
			return requestMemory(
				turn,
				{
					kind: filled.fields.kind,
					what: filled.fields.what,
					detail: filled.fields.detail,
				},
				accepted(),
			);
		}
		case "work":
			return c.operation === "check"
				? checkWork(turn, c.todo)
				: c.operation === "amend"
					? operateWork(turn, c.todo, "amend", turn.utterance, accepted())
					: operateWork(turn, c.todo, "cancel", undefined, accepted());
		case "redirect":
			return redirect(turn, router, consulted, c);
		case "pending":
			if (c.operation === "approve")
				return approveConfirmation(turn, c.confirmation);
			if (c.operation === "decline")
				return declineConfirmation(turn, c.confirmation);
			if (c.operation === "discard") return discard(turn, c);
			return answerQuestion(turn, c.todo, turn.utterance);
	}
}

/**
 * The words a hand-over carries as its request: the turn's, then the user's utterance before them when there is one
 * (a request that points back at it reaches the toolchain with what it points to).
 */
function requestWords(turn: Turn, words: string): string {
	const previous = turn.routed!.earlier.at(-1);
	return previous
		? `${words}\n${systemContext("dialogue.contexts.local.router-request", { previous })}`
		: words;
}

/** A toolchain's hand-over made ready: its fields found, and whether it will need the user's yes first. */
type Prepared = { step: Step } | { confirms: boolean; go: () => Promise<Step> };

/**
 * A toolchain or a read tool, up to the host operation: its fields (the router's second call, else the model's fill).
 * Nothing is changed yet. `redirected` is the earlier turn this hand-over corrects: its words are already in `words`.
 */
async function prepare(
	turn: Turn,
	router: ActiveRouter,
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "toolchain" | "read" }>,
	announce: Announce,
	redirected?: { trace: RouterTraceRecord; wrongId: string },
): Promise<Prepared> {
	const words = redirected
		? `${redirected.trace.text}\n${turn.utterance}`
		: consulted.words;
	const filled = await fieldsOf(turn, router, words, c, consulted.model);
	if ("step" in filled) return filled;
	const { choice } = c;
	if (choice.execution === "read")
		return {
			confirms: false,
			go: () => readWith(turn, choice, filled.fields.inputs),
		};
	if (choice.execution === "instant")
		return {
			confirms: false,
			go: () => instantWith(turn, choice, filled.fields.inputs),
		};
	// The resources `## State` presents go with the request unless a fill chose them: the agent picks what it uses.
	const resources = turn.routed!.resources.slice(0, RESOURCE_REFS);
	const fields: Fields = {
		...(resources.length ? { refs: resources } : {}),
		...filled.fields,
		request:
			typeof filled.fields.request === "string"
				? filled.fields.request
				: redirected
					? words
					: requestWords(turn, words),
		// The user's own words: the TODO is titled by them and a confirmation quotes them, not the context behind.
		words,
	};
	return {
		confirms: needsConfirmation(choice, fields.target),
		go: async () => {
			const step = await handWith(
				turn,
				choice,
				fields,
				announcement(announce, titleOf(c)),
				words,
			);
			if (step === "done") await afterHandOver(turn, consulted, c, redirected);
			return step;
		},
	};
}

/** A toolchain or a read tool: its fields, then the host operation it takes. */
async function toolchain(
	turn: Turn,
	router: ActiveRouter,
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "toolchain" | "read" }>,
	announce: Announce,
): Promise<Step> {
	const prepared = await prepare(turn, router, consulted, c, announce);
	return "step" in prepared ? prepared.step : prepared.go();
}

/** The last hand-over of the turn that started work or issued a confirmation. */
function handedOver(turn: Turn) {
	for (let i = turn.executed.length - 1; i >= 0; i--) {
		const { call, outcome } = turn.executed[i]!;
		if (
			call.name === TOOL_NAMES.delegate &&
			(outcome.end || outcome.confirmation)
		)
			return outcome;
	}
	return null;
}

/**
 * What the router learns once a hand-over is done (spec §5.2): the work it started is linked to the trace, so a
 * correction of it is found; the toolchain a question back was answered with is the right one for the words asked,
 * when it is one of the two asked about. A redirect that was carried out is what the trace then decided.
 */
async function afterHandOver(
	turn: Turn,
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "toolchain" | "read" }>,
	redirected: { wrongId: string; trace: RouterTraceRecord } | undefined,
): Promise<void> {
	const { deps, input } = turn;
	const port = deps.toolchains;
	const outcome = handedOver(turn);
	if (!outcome || !port) return;
	// A redirect waiting for the user's yes has changed nothing yet: the old work runs on, and nothing is learned.
	if (redirected && !outcome.end) return;
	const todo = (outcome.result as { todo?: unknown }).todo;
	const asked = turn.routed!.asked;
	const trace = redirected?.trace ?? consulted.latest;
	// The answer to a question back is the right one for the words the router asked about (its trace is row 8).
	const corrects =
		trace?.query &&
		(redirected ||
			(asked &&
				trace.mode === "on" &&
				trace.row === 8 &&
				trace.set.includes(c.id)));
	// So a later redirect of this work names the toolchain it went to (not the first it was given to).
	if (redirected)
		await consulted.retrace({
			decided: c.id,
			set: redirected.trace.set,
			text: redirected.trace.text,
			query: redirected.trace.query,
			messageIds: [
				...new Set([
					...messagesOf(turn, redirected.trace),
					...redirected.trace.messageIds,
				]),
			],
		});
	await deps.store
		.write((tx) => {
			if (outcome.end && typeof todo === "string")
				port.linkRouterWorkInTransaction?.(tx, input.runId, todo);
			if (corrects && trace?.query)
				port.recordRouterFeedbackInTransaction?.(tx, {
					conversationId: input.conversationId,
					messageId: trace.messageId,
					messageIds: trace.messageIds,
					runId: trace.runId,
					source: redirected ? "redirect" : "ask_answer",
					text: trace.text,
					query: trace.query,
					wrongId: redirected?.wrongId ?? null,
					rightId: c.id,
				});
		})
		.catch((error: unknown) => {
			log.warn("dialogue.router_trace_failed", { reason: reasonOf(error) });
		});
}

/**
 * The user doubts the toolchain the work was given to (spec §5.2). Everything that can fail or ask comes first, with
 * the old work untouched: the fields, a question back, a confirmation the new toolchain needs (the old work runs on
 * then). Only a hand-over that goes ahead cancels the old work, and one that then fails says so.
 */
async function redirect(
	turn: Turn,
	router: ActiveRouter,
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "redirect" }>,
): Promise<Step> {
	const trace = consulted.latest;
	const target = consulted.candidates.find(
		(other): other is Extract<RouteCandidate, { kind: "toolchain" }> =>
			other.kind === "toolchain" && other.id === c.toolchainId,
	);
	if (!trace?.decided || !target) return { retry: "redirect_unavailable" };
	const prepared = await prepare(turn, router, consulted, target, "fixed", {
		trace,
		wrongId: /^t\d+\.redirect:/.test(trace.decided)
			? (trace.set[0] ?? trace.decided)
			: trace.decided,
	});
	if ("step" in prepared) return prepared.step;
	if (prepared.confirms) {
		const step = await prepared.go();
		if (step === "done")
			turn.speak(
				systemContext("dialogue.contexts.local.router-redirect-kept", {}),
			);
		return step;
	}
	const cancelled = await turn.act(TOOL_NAMES.work, {
		todo: c.todo,
		operation: "cancel",
	});
	if ("refused" in cancelled)
		return { retry: turn.reasonOf(cancelled.refused) };
	if ((cancelled.outcome.result as { ok?: unknown }).ok === false)
		return { retry: "cancel_failed" };
	const step = await prepared.go();
	if (typeof step === "string") return step;
	turn.speak(
		systemContext("dialogue.contexts.local.router-redirect-failed", {
			title: titleOf(target),
		}),
	);
	return "done";
}

/**
 * The user agreed to let the unsaved work go (the router's `switch.discard`): the waiting hand-over is made again, to
 * the same item, with the word that lets it through. Its request is the words that asked for it, as the host holds
 * them: the user's utterance before this one.
 */
async function discard(
	turn: Turn,
	c: Extract<RouteCandidate, { operation: "discard" }>,
): Promise<Step> {
	const routed = turn.routed!;
	const switching = switchingOf(turn);
	if (!switching || switching.id !== c.toolchain)
		return { retry: "switch_unavailable" };
	const previous = routed.earlier.at(-1);
	return handWith(
		turn,
		retainedChoice(turn, switching.card),
		{
			request: previous ? `${previous}\n${turn.utterance}` : turn.utterance,
			words: previous ?? turn.utterance,
			resolveUnsaved: "discard",
			...(routed.switchTarget ? { target: routed.switchTarget } : {}),
		},
		announcement("fixed", lineText(switching.title).slice(0, 30)),
		turn.utterance,
	);
}
