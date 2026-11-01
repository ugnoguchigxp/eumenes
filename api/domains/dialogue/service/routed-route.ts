import { routerPassage, type ToolchainCard } from "../../capabilities";
import type { InferencePort } from "../../inference";
import { ROUTE_LIMITS, routeCriterionName } from "../../inference/contracts";
import type {
	NearFeedback,
	RouterTrace,
	RouterTraceRecord,
} from "../../toolchain-history";
import { systemContext } from "../../../infrastructure/system-context";
import type { RoutedInput } from "./context";
import { lineText } from "./input-text";
import type { ChoiceCandidate } from "./routed-choice";
import type { Searched } from "./routed-search";

/**
 * The router's side of a request turn that needs no host operation (spec toolchain-router-redesign 2026-11-01): the
 * candidates it scores (§3.2), the correction of the probabilities by what the user corrected before (§5.4), and the
 * decision table (§3.3). Every word of a candidate's description is a SystemContext of the dialogue domain.
 */
export type RouterSettings = ReturnType<
	NonNullable<InferencePort["snapshotInTransaction"]>
>["router"];

/** The router sees the words of earlier turns this long only (spec §5.2: a correction follows within 5 minutes). */
export const TRACE_WINDOW_MS = 5 * 60 * 1000;

/** What a description may carry of a record's text, in characters (a criterion is 300 characters in all). */
const TITLE_CHARS = 40;
const SAID_CHARS = 60;
const QUESTION_CHARS = 80;
/** A confirmation's description carries three of them (the toolchain, its request, the item it changes). */
const CONFIRM_TOOLCHAIN_CHARS = 30;
const CONFIRM_REQUEST_CHARS = 40;
const CONFIRM_TARGET_CHARS = 30;
/** The work the router may name: the newest of them (the records of a long conversation are not all offered). */
const WORK_LISTED = 6;
/** The redirect candidates one correction offers, at most (spec §3.2). */
const REDIRECTS = 2;
/** The prediction set: the best candidates until this probable together, at most this many. */
const SET_MASS = 0.9;
const SET_SIZE = 3;
/** A probability of zero must still be a log. */
const FLOOR = 1e-9;

export const CONVERSATION_ID = "conversation.respond";
export const MEMORY_ID = "memory.request";
export const DISCARD_ID = "switch.discard";

type Described = { id: string; passage: string };
type Tool = { card: ToolchainCard; choice: ChoiceCandidate };
type Confirmation = { confirmation: string; toolchain: string };
/** One thing the router may send the turn to. */
export type RouteCandidate = Described &
	(
		| { kind: "conversation" }
		| ({ kind: "toolchain" } & Tool)
		| ({ kind: "read" } & Tool)
		| { kind: "memory" }
		| {
				kind: "work";
				todo: string;
				operation: "check" | "amend" | "cancel";
				title: string;
		  }
		| {
				kind: "redirect";
				todo: string;
				title: string;
				toolchainId: string;
				/** The title of the toolchain it would be done again by. */
				target: string;
		  }
		| ({ kind: "pending"; operation: "approve" } & Confirmation)
		| ({ kind: "pending"; operation: "decline" } & Confirmation)
		| { kind: "pending"; operation: "answer"; todo: string; title: string }
		| {
				kind: "pending";
				operation: "discard";
				toolchain: string;
				title: string;
		  }
	);

const short = (text: string, chars: number) => lineText(text).slice(0, chars);
const context = (
	key: Parameters<typeof systemContext>[0],
	variables: Record<string, string>,
) => systemContext(key, variables as never);
const WORK = {
	check: "dialogue.contexts.local.router-check",
	amend: "dialogue.contexts.local.router-amend",
	cancel: "dialogue.contexts.local.router-cancel",
} as const;
/** The confirmation's descriptions, without and with the saved item it changes. */
const CONFIRMATION = {
	approve: [
		"dialogue.contexts.local.router-approve",
		"dialogue.contexts.local.router-approve-target",
	],
	decline: [
		"dialogue.contexts.local.router-decline",
		"dialogue.contexts.local.router-decline-target",
	],
} as const;

/** The work whose toolchain the previous routed turn decided, and that turn's trace (a correction's ground). */
export type Redirect = { trace: RouterTraceRecord; todo: string };

/** Why a candidate was left out of the offer (logged with `dialogue.router_candidate_skipped`). */
export type Skipped = {
	id: string;
	reason: "invalid_name" | "description_too_long" | "criteria_limit";
};

/**
 * The candidates, in the order they are sent: those that change little between turns first, by id (what the router
 * can keep from one call to the next), then the ones this turn's records add. A candidate whose name or rendered
 * description the router would refuse is left out (and named in `skipped`) rather than failing the whole offer.
 */
export function routeCandidates(input: {
	routed: RoutedInput;
	/** The search's cards; null when the turn looks at the open confirmations and questions only. */
	searched: Searched | null;
	redirect: Redirect | null;
	/** The toolchain a hand-over waits for the user's word on, because unsaved work stands in its way. */
	switching: { id: string; title: string } | null;
	skipped?: Skipped[];
}): RouteCandidate[] {
	const { routed, searched } = input;
	const admit = (candidates: RouteCandidate[]) =>
		candidates.filter((c) => {
			const reason = !routeCriterionName.test(c.id)
				? "invalid_name"
				: c.passage.length > ROUTE_LIMITS.description
					? "description_too_long"
					: null;
			if (reason) input.skipped?.push({ id: c.id, reason });
			return !reason;
		});
	const stable: RouteCandidate[] = [
		{
			id: CONVERSATION_ID,
			kind: "conversation",
			passage: systemContext("dialogue.contexts.local.router-conversation", {}),
		},
	];
	const seen = new Set<string>();
	for (const card of searched?.cards ?? []) {
		const choice = searched?.candidates.find((c) => c.id === card.id);
		if (!choice || seen.has(card.id)) continue;
		seen.add(card.id);
		stable.push({
			id: card.id,
			kind: card.read ? "read" : "toolchain",
			passage: routerPassage(card),
			card,
			choice,
		} as RouteCandidate);
	}
	if (searched)
		stable.push({
			id: MEMORY_ID,
			kind: "memory",
			passage: systemContext("dialogue.contexts.local.memory-request", {}),
		});
	const offered = admit(stable).sort((a, b) =>
		a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
	);

	const listed = new Set(
		[...routed.todos]
			.sort((a, b) => b.ref - a.ref)
			.slice(0, WORK_LISTED)
			.map((todo) => todo.ref),
	);
	const work: RouteCandidate[] = searched
		? routed.todos
				.filter((todo) => listed.has(todo.ref))
				.flatMap((todo) =>
					(todo.open
						? (["check", "amend", "cancel"] as const)
						: (["check"] as const)
					).map((operation): RouteCandidate => ({
						id: `t${todo.ref}.${operation}`,
						kind: "work",
						todo: `t${todo.ref}`,
						operation,
						title: todo.title,
						passage: context(WORK[operation], {
							title: short(todo.title, TITLE_CHARS),
						}),
					})),
				)
		: [];
	const pending: RouteCandidate[] = [
		...routed.pending.confirmations.flatMap((c): RouteCandidate[] =>
			(["approve", "decline"] as const).map((operation): RouteCandidate => ({
				id: `c${c.ref}.${operation}`,
				kind: "pending",
				operation,
				confirmation: `c${c.ref}`,
				toolchain: c.toolchain,
				passage: context(CONFIRMATION[operation][c.target ? 1 : 0], {
					toolchain: short(c.toolchain, CONFIRM_TOOLCHAIN_CHARS),
					request: short(c.request, CONFIRM_REQUEST_CHARS),
					...(c.target
						? { target: short(c.target, CONFIRM_TARGET_CHARS) }
						: {}),
				}),
			})),
		),
		...routed.pending.questions.map((q): RouteCandidate => ({
			id: `t${q.ref}.answer`,
			kind: "pending",
			operation: "answer",
			todo: `t${q.ref}`,
			title: q.title,
			passage: systemContext("dialogue.contexts.local.router-answer", {
				question: short(q.question, QUESTION_CHARS),
			}),
		})),
		...(input.switching
			? [
					{
						id: DISCARD_ID,
						kind: "pending",
						operation: "discard",
						toolchain: input.switching.id,
						title: input.switching.title,
						passage: systemContext("dialogue.contexts.local.router-discard", {
							title: short(input.switching.title, TITLE_CHARS),
						}),
					} satisfies RouteCandidate,
				]
			: []),
	];
	const redirected = redirects(input.redirect, routed, offered);
	const dynamic = [...admit(work), ...admit(redirected), ...admit(pending)];
	// The open confirmations and questions come before everything else in importance: the work gives way first.
	const room = Math.max(0, ROUTE_LIMITS.criteria - offered.length);
	const kept = new Set(
		[...dynamic]
			.sort((a, b) => Number(isKept(b)) - Number(isKept(a)))
			.slice(0, room)
			.map((c) => c.id),
	);
	for (const c of dynamic)
		if (!kept.has(c.id))
			input.skipped?.push({ id: c.id, reason: "criteria_limit" });
	return [...offered, ...dynamic.filter((c) => kept.has(c.id))];
}

/** The dynamic candidates that give way last when the offer is full: the user's open confirmations and questions. */
const isKept = (c: RouteCandidate) => c.kind === "pending";

/**
 * Where the toolchain the user was last sent to is doubted (spec §3.2): the open work it started, and for each
 * other toolchain the router had in its prediction set (and this turn offers), one candidate that does it again there.
 * A question about such a candidate asked before (`decided` is its id) keeps the same candidates on offer.
 */
function redirects(
	redirect: Redirect | null,
	routed: RoutedInput,
	stable: readonly RouteCandidate[],
): RouteCandidate[] {
	if (!redirect) return [];
	const { trace, todo } = redirect;
	const open = routed.todos.find((t) => `t${t.ref}` === todo && t.open);
	// Only a turn the router decided (not one it only watched) started the work that is doubted.
	if (!open || !trace.decided || trace.mode !== "on") return [];
	const toolchains = stable.filter(
		(c): c is Extract<RouteCandidate, { kind: "toolchain" }> =>
			c.kind === "toolchain",
	);
	const asked = /^t\d+\.redirect:(.+)$/.exec(trace.decided);
	// The toolchain the work went to: the decision, or (for a question about doing it elsewhere) the set's first.
	const fromId = asked ? trace.set[0] : trace.decided;
	const from = toolchains.find((c) => c.id === fromId);
	if (!from) return [];
	const others = trace.set.filter((id) => id !== from.id);
	const ordered = asked
		? [asked[1]!, ...others.filter((id) => id !== asked[1])]
		: others;
	return ordered
		.flatMap((id) => toolchains.filter((c) => c.id === id))
		.slice(0, REDIRECTS)
		.map((to): RouteCandidate => ({
			id: `${todo}.redirect:${to.id}`,
			kind: "redirect",
			todo,
			title: open.title,
			toolchainId: to.id,
			target: to.card.title,
			passage: systemContext("dialogue.contexts.local.router-redirect", {
				request: short(trace.text, SAID_CHARS),
				from: short(from.card.title, TITLE_CHARS),
				to: short(to.card.title, TITLE_CHARS),
			}),
		}));
}

/** A candidate scored: LARM's probability, the correction added to its log, and the probability after it. */
export type Ranked = {
	candidate: RouteCandidate;
	raw: number;
	correction: number;
	p: number;
	/** LARM's independent score (0..1) when it gave one. */
	score: number | null;
};

/**
 * The correction of the probabilities by the corrections near this utterance (spec §5.4). Corrections that name
 * different right answers cancel each other: none applies. `weight` 0 turns the corrections off.
 */
export function correctProbabilities(
	candidates: ReadonlyArray<{ id: string; p: number }>,
	near: readonly NearFeedback[],
	options: { threshold: number; weight: number },
): { p: number[]; shift: number[]; conflict: boolean } {
	const none = {
		p: candidates.map((c) => c.p),
		shift: candidates.map(() => 0),
	};
	if (!near.length || options.weight <= 0) return { ...none, conflict: false };
	if (new Set(near.map((row) => row.rightId)).size > 1)
		return { ...none, conflict: true };
	const { threshold: theta, weight: beta } = options;
	const shifts = new Map<string, number>();
	for (const row of near) {
		const w =
			theta >= 1 ? 1 : Math.max(0, (row.similarity - theta) / (1 - theta));
		shifts.set(row.rightId, (shifts.get(row.rightId) ?? 0) + beta * w);
		if (row.wrongId)
			shifts.set(row.wrongId, (shifts.get(row.wrongId) ?? 0) - beta * w);
	}
	const shift = candidates.map((c) =>
		Math.max(-beta, Math.min(beta, shifts.get(c.id) ?? 0)),
	);
	const logs = candidates.map((c, i) => Math.log(c.p + FLOOR) + shift[i]!);
	const top = Math.max(...logs);
	const exp = logs.map((value) => Math.exp(value - top));
	const total = exp.reduce((sum, value) => sum + value, 0);
	return { p: exp.map((value) => value / total), shift, conflict: false };
}

/** What the turn does (spec §3.3). `row` is the decision table's row the case belongs to. */
export type Announce = "fixed" | "try" | "partial" | "none";
export type RouteDecision =
	| { row: 1 | 7 | 8; to: "conversation" }
	| { row: 8; to: "ask"; options: [RouteCandidate, RouteCandidate] }
	| {
			row: 2 | 3 | 4 | 5 | 6 | 9;
			to: "run";
			candidate: RouteCandidate;
			announce: Announce;
	  }
	/** Not sure enough to do it (a yes, a cancellation): the host asks once more instead. */
	| { row: 5 | 6; to: "again"; candidate: RouteCandidate };

const isTool = (c: RouteCandidate) =>
	c.kind === "toolchain" || c.kind === "read";
const cancelling = (c: RouteCandidate) =>
	c.kind === "redirect" || (c.kind === "work" && c.operation === "cancel");

/** The decision table (spec §3.3, rows 1 to 9; row 10, a router that failed, is the caller's). */
export function decide(
	ranked: readonly Ranked[],
	settings: Pick<
		RouterSettings,
		"accept" | "low" | "margin" | "approve" | "multi"
	>,
	/** The candidate the host asked about in the turn before (rows 5 and 6): the user was asked, so `low` is the line. */
	asked: string | null = null,
): RouteDecision {
	const [top, next] = ranked;
	if (!top) return { row: 8, to: "conversation" };
	const { accept, low, margin, approve, multi } = settings;
	const c = top.candidate;
	const p1 = top.p;
	const p2 = next?.p ?? 0;
	if (c.kind === "conversation") {
		if (p1 >= accept) return { row: 1, to: "conversation" };
		if (next && p2 >= low) return { row: 7, to: "conversation" };
		return { row: p1 < low ? 8 : 1, to: "conversation" };
	}
	if (p1 < low) {
		// Nothing is sure: the conversation among the best two answers, else the host asks between two toolchains.
		if (next && isTool(c) && isTool(next.candidate))
			return { row: 8, to: "ask", options: [c, next.candidate] };
		return { row: 8, to: "conversation" };
	}
	const sure = p1 >= accept && p1 - p2 >= margin;
	if (c.kind === "toolchain" && several(ranked, accept, multi))
		return { row: 9, to: "run", candidate: c, announce: "partial" };
	if (isTool(c)) {
		if (sure) return { row: 2, to: "run", candidate: c, announce: "fixed" };
		const changes =
			c.kind === "toolchain" &&
			(c.card.minImpact === "modify_existing" ||
				c.card.minImpact === "irreversible");
		return { row: changes ? 4 : 3, to: "run", candidate: c, announce: "try" };
	}
	if (c.kind === "work" && c.operation === "check")
		return { row: sure ? 2 : 3, to: "run", candidate: c, announce: "none" };
	if (cancelling(c))
		return p1 >= accept || c.id === asked
			? { row: 6, to: "run", candidate: c, announce: "none" }
			: { row: 6, to: "again", candidate: c };
	if (
		c.kind === "pending" &&
		(c.operation === "approve" || c.operation === "discard")
	)
		return p1 >= approve || c.id === asked
			? { row: 5, to: "run", candidate: c, announce: "none" }
			: { row: 5, to: "again", candidate: c };
	// A memory request, a correction, a decline, an answer: only when sure; else no promise is made.
	return sure
		? { row: 2, to: "run", candidate: c, announce: "none" }
		: { row: 7, to: "conversation" };
}

/**
 * A request of several jobs (row 9): two dedicated toolchains each score at least `multi` on their own (LARM's
 * independent score: the search's similarity is too compressed to stand in for it, so a router that gives none
 * never makes a request several), and no pipeline that scores `accept` would do them all.
 */
function several(ranked: readonly Ranked[], accept: number, multi: number) {
	const toolchains = ranked.filter(
		(
			r,
		): r is Ranked & {
			candidate: { kind: "toolchain"; card: ToolchainCard };
		} => r.candidate.kind === "toolchain",
	);
	const jobs = toolchains.filter(
		(r) =>
			!r.candidate.card.general &&
			r.candidate.card.execution !== "pipeline" &&
			(r.score ?? 0) >= multi,
	);
	return (
		jobs.length >= 2 &&
		!toolchains.some(
			(r) =>
				r.candidate.card.execution === "pipeline" && (r.score ?? 0) >= accept,
		)
	);
}

/** The best candidates until they are this probable together, at most three (what a correction may move to). */
export function predictionSet(ranked: readonly Ranked[]): string[] {
	const set: string[] = [];
	let mass = 0;
	for (const r of ranked) {
		set.push(r.candidate.id);
		mass += r.p;
		if (mass >= SET_MASS || set.length >= SET_SIZE) break;
	}
	return set;
}

/** The id a decision lands on, as the trace keeps it. */
export function decidedId(decision: RouteDecision): string | null {
	switch (decision.to) {
		case "conversation":
			return CONVERSATION_ID;
		case "ask":
			// The user decides between the two: nothing is decided yet.
			return null;
		default:
			return decision.candidate.id;
	}
}

/** What the log names of a decision: its kind, never the words. */
export function decidedKind(decision: RouteDecision): string {
	return decision.to === "run" || decision.to === "again"
		? decision.candidate.kind
		: decision.to;
}

/** The trace of one routed turn (spec §5.3): what was offered, the probabilities, what was or would be decided. */
export function routerTrace(input: {
	mode: RouterTrace["mode"];
	ranked: readonly Ranked[];
	decision: RouteDecision | null;
	answer: { headRevision: string | null; model: string } | null;
	durationMs: number;
	error: string | null;
	/** The id the trace keeps as decided, when it is not the decision's own (a redirect that was carried out). */
	decided?: string | null;
	/** The prediction set the trace keeps, when it is an earlier turn's (the question about a redirect carries it on). */
	set?: string[];
}): RouterTrace {
	return {
		mode: input.mode,
		revision: input.answer?.headRevision ?? null,
		model: input.answer?.model ?? null,
		candidates: input.ranked.map((r) => ({
			id: r.candidate.id,
			kind: r.candidate.kind,
			raw: r.raw,
			correction: r.correction,
			p: r.p,
			score: r.score,
		})),
		set: input.set
			? input.set
			: !input.decision
				? []
				: input.decision.to === "ask"
					? // The two the user is asked to choose between: the answer is one of them.
						input.decision.options.map((o) => o.id)
					: predictionSet(input.ranked),
		row: input.decision?.row ?? 0,
		decided:
			input.decided !== undefined
				? input.decided
				: input.decision
					? decidedId(input.decision)
					: null,
		durationMs: input.durationMs,
		error: input.error,
	};
}
