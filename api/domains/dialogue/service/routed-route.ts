import {
	CONVERSATION_ID,
	DISCARD_ID,
	MEMORY_ID,
	predictionSet,
	type Ranked,
} from "eumenes_router";
import type { ToolchainCard } from "../../capabilities";
import type { InferencePort } from "../../inference";
import type { RouterTrace, RouterTraceRecord } from "../../toolchain-history";
import { systemContext } from "../../../infrastructure/system-context";
import type { RoutedInput } from "./context";
import { lineText } from "./input-text";
import type { ChoiceCandidate } from "./routed-choice";

/**
 * The host's side of the router (spec router-package-integration 2026-11-04): the candidates only the host can make
 * (its work, its open confirmations and questions, a redirect of the work just handed over), the candidates it carries
 * out, and the trace of a turn. The eumenes_router package searches the toolchains, scores every candidate and decides
 * by the decision table; every word of a candidate's description here is a SystemContext of the dialogue domain.
 */
export type RouterSettings = ReturnType<
	NonNullable<InferencePort["snapshotInTransaction"]>
>["router"];

export { CONVERSATION_ID, DISCARD_ID, MEMORY_ID };

/** The router sees the words of earlier turns this long only (a correction follows within 5 minutes). */
export const TRACE_WINDOW_MS = 5 * 60 * 1000;

/** What a description may carry of a record's text, in characters. */
const TITLE_CHARS = 40;
const SAID_CHARS = 60;
const QUESTION_CHARS = 80;
/** A confirmation's description carries three of them (the toolchain, its request, the item it changes). */
const CONFIRM_TOOLCHAIN_CHARS = 30;
const CONFIRM_REQUEST_CHARS = 40;
const CONFIRM_TARGET_CHARS = 30;
/** The work the router may name: the newest of them (the records of a long conversation are not all offered). */
const WORK_LISTED = 6;
/** The redirect candidates one correction offers, at most. */
const REDIRECTS = 2;

type Described = { id: string; passage: string };
type Tool = { card: ToolchainCard; choice: ChoiceCandidate };
type Confirmation = { confirmation: string; toolchain: string };
/** The candidates the host makes for a turn and offers the package beside its search. */
export type DynamicCandidate = Described &
	(
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
/** One thing the turn may be sent to, as the host carries it out. */
export type RouteCandidate =
	| (Described &
			(
				| { kind: "conversation" }
				| ({ kind: "toolchain" } & Tool)
				| ({ kind: "read" } & Tool)
				| { kind: "memory" }
			))
	| DynamicCandidate;

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

/**
 * The candidates of the host's records, in the order they are offered: the work (the newest six), a redirect of the
 * work just handed over, the open confirmations and questions, the unsaved work a hand-over waits on. The package
 * leaves out a name or a description it would refuse, and makes room by these when its offer is full.
 */
export function dynamicCandidates(input: {
	routed: RoutedInput;
	redirect: Redirect | null;
	/** The toolchain a hand-over waits for the user's word on, because unsaved work stands in its way. */
	switching: { id: string; title: string } | null;
	/** The titles of toolchains by id (those that are active). */
	titles: (ids: readonly string[]) => ReadonlyMap<string, string>;
}): DynamicCandidate[] {
	const { routed } = input;
	const listed = new Set(
		[...routed.todos]
			.sort((a, b) => b.ref - a.ref)
			.slice(0, WORK_LISTED)
			.map((todo) => todo.ref),
	);
	const work = routed.todos
		.filter((todo) => listed.has(todo.ref))
		.flatMap((todo) =>
			(todo.open
				? (["check", "amend", "cancel"] as const)
				: (["check"] as const)
			).map((operation): DynamicCandidate => ({
				id: `t${todo.ref}.${operation}`,
				kind: "work",
				todo: `t${todo.ref}`,
				operation,
				title: todo.title,
				passage: context(WORK[operation], {
					title: short(todo.title, TITLE_CHARS),
				}),
			})),
		);
	const pending: DynamicCandidate[] = [
		...routed.pending.confirmations.flatMap((c) =>
			(["approve", "decline"] as const).map((operation): DynamicCandidate => ({
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
		...routed.pending.questions.map((q): DynamicCandidate => ({
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
					} satisfies DynamicCandidate,
				]
			: []),
	];
	return [
		...work,
		...redirects(input.redirect, routed, input.titles),
		...pending,
	];
}

/**
 * Where the toolchain the user was last sent to is doubted: the open work it started, and for each other toolchain
 * the router had in its prediction set, one candidate that does it again there. A question about such a candidate
 * asked before (`decided` is its id) keeps the same candidates on offer.
 */
function redirects(
	redirect: Redirect | null,
	routed: RoutedInput,
	titlesOf: (ids: readonly string[]) => ReadonlyMap<string, string>,
): DynamicCandidate[] {
	if (!redirect) return [];
	const { trace, todo } = redirect;
	const open = routed.todos.find((t) => `t${t.ref}` === todo && t.open);
	// Only a turn the router decided started the work that is doubted.
	if (!open || !trace.decided || trace.mode !== "on") return [];
	const asked = /^t\d+\.redirect:(.+)$/.exec(trace.decided);
	// The toolchain the work went to: the decision, or (for a question about doing it elsewhere) the set's first.
	const fromId = asked ? trace.set[0] : trace.decided;
	if (!fromId) return [];
	const others = trace.set.filter((id) => id !== fromId);
	const ordered = asked
		? [asked[1]!, ...others.filter((id) => id !== asked[1])]
		: others;
	const titles = titlesOf([fromId, ...ordered]);
	const from = titles.get(fromId);
	if (!from) return [];
	return ordered
		.filter((id) => titles.has(id))
		.slice(0, REDIRECTS)
		.map((id): DynamicCandidate => ({
			id: `${todo}.redirect:${id}`,
			kind: "redirect",
			todo,
			title: open.title,
			toolchainId: id,
			target: titles.get(id)!,
			passage: systemContext("dialogue.contexts.local.router-redirect", {
				request: short(trace.text, SAID_CHARS),
				from: short(from, TITLE_CHARS),
				to: short(titles.get(id)!, TITLE_CHARS),
			}),
		}));
}

/** What the turn does (the decision table's row the case belongs to), with the candidates the host carries out. */
export type Announce = "fixed" | "try" | "partial" | "none";
export type RouteDecision =
	| { row: 1 | 7 | 8; to: "conversation" }
	| { row: 8; to: "clarify"; question: string; unhandled: readonly string[] }
	| { row: 8; to: "ask"; options: [RouteCandidate, RouteCandidate] }
	| {
			row: 2 | 3 | 4 | 5 | 6 | 9;
			to: "run";
			candidate: RouteCandidate;
			announce: Announce;
	  }
	/** Not sure enough to do it (a yes, a cancellation): the host asks once more instead. */
	| { row: 5 | 6; to: "again"; candidate: RouteCandidate };

/** The id a decision lands on, as the trace keeps it. */
export function decidedId(decision: RouteDecision): string | null {
	switch (decision.to) {
		case "conversation":
			return CONVERSATION_ID;
		case "ask":
		case "clarify":
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

/** The trace of one routed turn: what was offered, the probabilities, what was decided, and how the package routed. */
export function routerTrace(input: {
	/** The package's ranking of the text the decision came from (the whole utterance, or its request part). */
	ranked: readonly Ranked[];
	decision: RouteDecision | null;
	answer: { headRevision: string | null; model: string } | null;
	durationMs: number;
	error: string | null;
	entry: NonNullable<RouterTrace["entry"]>;
	/** best-v2's top-two gap and whether it was too small to be sure. */
	gate: number | null;
	defer: boolean | null;
	/** The structure model's requests and the parts routed (`routeStructured`); null when it gave no structure. */
	structure: RouterTrace["structure"];
	/** The id the trace keeps as decided, when it is not the decision's own (a redirect that was carried out). */
	decided?: string | null;
	/** The prediction set the trace keeps, when it is an earlier turn's (the question about a redirect carries it on). */
	set?: string[];
}): RouterTrace {
	return {
		mode: "on",
		entry: input.entry,
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
		gate: input.gate,
		defer: input.defer,
		structure: input.structure,
		durationMs: input.durationMs,
		error: input.error,
	};
}
