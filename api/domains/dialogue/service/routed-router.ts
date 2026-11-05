import { head, type Ranked, type RouteTurn } from "eumenes_router";
import { getLogger } from "../../../infrastructure/logger";
import { systemContext } from "../../../infrastructure/system-context";
import type { RouterTraceRecord } from "../../toolchain-history";
import type { QueryVector } from "../contracts/toolchains";
import { availableToolchainsInTransaction } from "./delegate-conversation";
import { availableReadTools } from "./executor-read";
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
import { chooseWholeWork } from "./routed-work-choice";
import {
	decidedPart,
	hostDecision,
	offer,
	reasonOf,
	routeByEntry,
	type ActiveRouter,
	type Routed,
} from "./routed-package";
import {
	CONVERSATION_ID,
	MEMORY_ID,
	TRACE_WINDOW_MS,
	decidedKind,
	dynamicCandidates,
	routerTrace,
	type Announce,
	type DynamicCandidate,
	type RouteCandidate,
	type RouteDecision,
} from "./routed-route";
import { referencedKindInTransaction } from "./routing-export";
import { retainedChoice, switchingOf } from "./routed-search";
import type { Turn } from "./routed-turn";

const log = getLogger("dialogue");
/** The resources one hand-over may carry (the delegate call's bound). */
const RESOURCE_REFS = 8;
/** What one asking of the router left the turn with. */
type Consulted = {
	/** The candidates the host can carry out: those the package offered, the host's own, the conversation's two. */
	candidates: RouteCandidate[];
	/** The words the turn acts on. */
	words: string;
	/** Null when the router failed or timed out (row 10). */
	decision: RouteDecision | null;
	/** The previous routed turn of the conversation, within the correction window. */
	latest: RouterTraceRecord | null;
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
 * Asks the router about the turn (spec router-package-integration 2026-11-04 §1): the package routes it by the saved
 * entry with the host's candidates beside its search, the host offers the toolchains it ranked (its own operation
 * keeps the authority checks), marks the corrections that disagreed, and records the trace. A router that failed (or
 * a read of its own that did) leaves no decision.
 */
async function consult(
	turn: Turn,
	router: ActiveRouter,
	words: string,
): Promise<Consulted> {
	const { deps, input } = turn;
	const routed = turn.routed!;
	const { settings } = router;
	const port = deps.toolchains!;
	const started = performance.now();
	const embedded = new Map<string, QueryVector>();
	let previous: ReturnType<typeof previousTrace> = null;
	let dynamic: DynamicCandidate[] = [];
	let result: Routed | null = null;
	let error: string | null = null;
	try {
		previous = previousTrace(turn);
		dynamic = dynamicCandidates({
			routed,
			redirect: previous?.todo
				? { trace: previous.trace, todo: previous.todo }
				: null,
			switching: switchingOf(turn),
			titles: (ids) =>
				port.titlesInTransaction
					? deps.store.read((tx) => port.titlesInTransaction!(tx, ids))
					: new Map(),
		});
		// best-v2 needs the memory of the embedding's space: the utterance is embedded first, once.
		const text = words.trim();
		const first = head(text, 2000);
		const r = await port.embedRouter!([first], turn.signal);
		embedded.set(first, { space: r.space, vector: r.vectors[0]! });
		const model = deps.store.read((tx) =>
			port.routerModelInTransaction!(tx, r.space),
		);
		if (!model) throw new Error("router_memory_missing");
		const { available, resource } = deps.store.read((tx) => ({
			available: new Set<string>([
				...availableToolchainsInTransaction(deps, tx),
				...availableReadTools(deps, tx),
			]),
			resource: referencedKindInTransaction(tx, input.runId),
		}));
		// The candidate asked about in the turn before (rows 5 and 6) was put to the user: the answer needs `low` only.
		const asked =
			previous?.trace.mode === "on" &&
			(previous.trace.row === 5 || previous.trace.row === 6)
				? previous.trace.decided
				: null;
		const routeTurn: RouteTurn = {
			state: {
				text,
				previousAgent: routed.previousReply,
				previousUser: routed.earlier.at(-1) ?? null,
			},
			dynamic,
			retained: input.retained.map((entry) => entry.card.id),
			available: (id) =>
				id === CONVERSATION_ID || id === MEMORY_ID || available.has(id),
			instructions: systemContext(
				"dialogue.contexts.local.router-instructions",
				{},
			),
			resource,
			asked,
		};
		result = await routeByEntry(turn, router, routeTurn, model, embedded);
	} catch (cause) {
		// A cancelled run is the run's, not the router's.
		if (turn.signal.aborted) throw cause;
		error = reasonOf(cause);
	}
	const part = result ? decidedPart(result) : undefined;
	let candidates: RouteCandidate[] = [];
	let decision: RouteDecision | null = null;
	if (result) {
		try {
			const offered = await offer(turn, words, result, dynamic);
			candidates = offered.candidates;
			decision = hostDecision(
				result.decision,
				offered.hostOf,
				offered.candidates.find(
					(c) => c.kind === "toolchain" && c.card.execution === "pipeline",
				),
			);
			if (!decision) error = "router_candidate_unavailable";
			const conflicts = [
				...new Set(result.parts.flatMap((p) => p.result.explain.conflicts)),
			];
			if (conflicts.length) await markConflicts(turn, conflicts);
		} catch (cause) {
			if (turn.signal.aborted) throw cause;
			error = reasonOf(cause);
			decision = null;
		}
	}
	const durationMs = Math.round(performance.now() - started);
	const query =
		(part && embedded.get(head(part.text, 2000))) ??
		embedded.get(head(words.trim(), 2000)) ??
		null;
	const traced = {
		ranked: decision && part ? part.result.corrected : ([] as Ranked[]),
		decision,
		answer: decision && part ? part.result.answer : null,
		durationMs,
		error,
		entry: settings.entry,
		gate: part?.result.explain.gate ?? null,
		defer: part?.result.explain.defer ?? null,
		structure: result?.structure
			? {
					requests: result.structure.requests.length,
					parts: result.parts.length,
				}
			: null,
	};
	const latest = previous?.trace ?? null;
	const trace = (changes: Retrace = {}) =>
		recordTrace(
			turn,
			{
				text: changes.text ?? words,
				query: changes.query === undefined ? query : changes.query,
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
			mode: "on",
			source: settings.entry,
			row: decision.row,
			kind: decidedKind(decision),
			count: part?.result.explain.offered.length ?? 0,
			durationMs,
		});
	else log.warn("dialogue.router_failed", { reason: error ?? "router_failed" });
	return { candidates, words, decision, latest, retrace: trace };
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
		query: QueryVector | null;
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
				query: utterance.query,
				trace: routerTrace(made),
			}),
		)
		.catch((error: unknown) => {
			log.warn("dialogue.router_trace_failed", { reason: reasonOf(error) });
		});
}

/**
 * Every utterance turn when the router is on (spec router-package-integration 2026-11-04 §1 #12): the package decides
 * with no choice call, among the toolchains, the conversation, the work and the open confirmations and questions.
 */
export async function routerTurn(
	turn: Turn,
	router: ActiveRouter,
): Promise<Step> {
	const routed = turn.routed!;
	const words = routed.asked
		? `${routed.asked.request}\n${turn.utterance}`
		: turn.utterance;
	const consulted = await consult(turn, router, words);
	// A router that failed leaves the turn to the talk turn (row 10); nothing is promised.
	if (!consulted.decision) return "talk";
	const step = await carryOut(turn, consulted, consulted.decision);
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
	partial: "dialogue.contexts.local.router-announce",
} as const;
const announcement = (announce: Announce, title: string) =>
	announce === "none" ? "" : systemContext(ANNOUNCE[announce], { title });

/** What a decision does (spec §3.3). */
async function carryOut(
	turn: Turn,
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
			if (decision.row === 9 && decision.candidate.kind === "toolchain") {
				const selected = await chooseWholeWork(
					turn,
					consulted.words,
					decision.candidate,
					consulted.candidates,
				);
				if ("step" in selected) return selected.step;
				if (selected.candidate.id !== decision.candidate.id)
					await consulted.retrace({ decided: selected.candidate.id });
				return toolchain(
					turn,
					consulted,
					selected.candidate,
					decision.announce,
					selected.fields,
				);
			}
			return run(turn, consulted, decision.candidate, decision.announce);
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
			return toolchain(turn, consulted, c, announce);
		case "memory": {
			const filled = await fieldsOf(turn, consulted.words, "memory");
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
			return redirect(turn, consulted, c);
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
 * A toolchain or a read tool, up to the host operation: its fields (the model's one-candidate fill when it has any).
 * Nothing is changed yet. `redirected` is the earlier turn this hand-over corrects: its words are already in `words`.
 */
async function prepare(
	turn: Turn,
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "toolchain" | "read" }>,
	announce: Announce,
	redirected?: { trace: RouterTraceRecord; wrongId: string },
	prefilled?: Fields,
): Promise<Prepared> {
	const words = redirected
		? `${redirected.trace.text}\n${turn.utterance}`
		: consulted.words;
	const filled = prefilled
		? { fields: prefilled }
		: c.card.execution === "pipeline"
			? { fields: { request: words } }
			: await fieldsOf(turn, words, c);
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
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "toolchain" | "read" }>,
	announce: Announce,
	prefilled?: Fields,
): Promise<Step> {
	const prepared = await prepare(
		turn,
		consulted,
		c,
		announce,
		undefined,
		prefilled,
	);
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
	consulted: Consulted,
	c: Extract<RouteCandidate, { kind: "redirect" }>,
): Promise<Step> {
	const trace = consulted.latest;
	const target = consulted.candidates.find(
		(other): other is Extract<RouteCandidate, { kind: "toolchain" }> =>
			other.kind === "toolchain" && other.id === c.toolchainId,
	);
	if (!trace?.decided || !target) return { retry: "redirect_unavailable" };
	const prepared = await prepare(turn, consulted, target, "fixed", {
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
