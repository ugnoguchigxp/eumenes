import { systemContext } from "../../../infrastructure/system-context";
import type { RoutedPipelineStep } from "../../tool-runtime";
import { IMPACT_ORDER } from "./executor-context";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import {
	NEW_TARGET,
	answerMessages,
	answerSchema,
	type ChoiceCandidate,
} from "./routed-choice";
import type { RouteDecision } from "./routed-route";
import type { Turn } from "./routed-turn";
import { ARGUMENT_CHARS, ASK_STEP } from "./tool-exchange";

/**
 * The host operations a routed turn carries out once something decided on them (the local harness rebuild plan,
 * sections 4.3 and 4.4): the choice call's decision and the router's (spec toolchain-router-redesign) both end here,
 * so one operation is one code path. Each returns how the step ended.
 */

/** How a step of the turn ended: it said what it had to, the talk turn answers, or the choice is made again. */
export type Step = "done" | "talk" | { retry: string };

/** The words the host says itself (the local harness rebuild plan, sections 4.3 and 4.4). */
export const SAID = {
	failed: systemContext("dialogue.contexts.local.failed", {}),
	approved: systemContext("dialogue.contexts.local.approved", {}),
	declined: systemContext("dialogue.contexts.local.declined", {}),
	answered: systemContext("dialogue.contexts.local.answered", {}),
	checked: systemContext("dialogue.contexts.local.checked", {}),
};
const IMPACT_SAID: Record<string, string> = {
	modify_existing: systemContext("dialogue.contexts.local.impact-modify", {}),
	irreversible: systemContext(
		"dialogue.contexts.local.impact-irreversible",
		{},
	),
};
/** The request a confirmation statement quotes, at most. */
const CONFIRM_REQUEST_CHARS = 80;

/** The fields a hand-over takes besides the toolchain (`request`, `inputs`, `target`, `refs`, `resolveUnsaved`). */
export type Fields = Record<string, unknown>;

/**
 * The whole request so far for the ask step, within what a carried call keeps (no cut mark on it): after a question
 * asked before, the head of its request and the newest words, the newest kept whole while both do not fit.
 */
export function askedRequest(before: string | undefined, utterance: string) {
	if (!before) return utterance.slice(0, ARGUMENT_CHARS);
	const newest = utterance.slice(
		0,
		Math.max(ARGUMENT_CHARS / 2, ARGUMENT_CHARS - before.length - 1),
	);
	return `${before.slice(0, ARGUMENT_CHARS - newest.length - 1)}\n${newest}`;
}

/** A question back: spoken, and kept as the step the next turn takes the user's answer with. */
export function askBack(turn: Turn, say: string): Step {
	turn.speak(say);
	recordQuestion(turn);
	return "done";
}

function recordQuestion(turn: Turn): void {
	turn.signal.throwIfAborted();
	turn.exchange.push({
		name: ASK_STEP,
		arguments: JSON.stringify({
			request: askedRequest(turn.routed?.asked?.request, turn.utterance),
		}),
		result: {},
	});
}

/** The package has no executable decision. The conversation may explain or clarify with no tools. */
export async function replyToUnresolved(
	turn: Turn,
	decision: Extract<RouteDecision, { to: "unresolved" }>,
): Promise<Step> {
	const requests = decision.requests.map(({ text, options }) => ({
		text,
		options: options.map((c) =>
			"card" in c ? c.card.title : "title" in c ? c.title : c.id,
		),
	}));
	await turn.talk(
		systemContext("dialogue.contexts.local.router-unresolved", {
			requests: JSON.stringify(requests),
		}),
		{ tools: false },
	);
	if (requests.some(({ options }) => options.length > 0)) recordQuestion(turn);
	return "done";
}

export function askRouterClarification(
	turn: Turn,
	decision: Extract<RouteDecision, { to: "clarify" }>,
): Step {
	return askBack(
		turn,
		[
			decision.question,
			systemContext("dialogue.contexts.local.router-clarify", {}),
			...decision.unhandled,
		].join("\n"),
	);
}

export async function routerUnperformed(
	turn: Turn,
	structuredEntry: boolean,
): Promise<Step> {
	const notice = systemContext(
		"dialogue.contexts.local.router-unperformed",
		{},
	);
	if (structuredEntry) turn.speak(notice);
	else await turn.talk(notice, { tools: false });
	return "done";
}

/** A memory request: said as `say` once the steward took it. */
export async function requestMemory(
	turn: Turn,
	fields: Fields,
	say: string,
): Promise<Step> {
	const asked = await turn.act(TOOL_NAMES.memory, {
		operation: "request",
		kind: fields.kind,
		what: fields.what,
		...(typeof fields.detail === "string" ? { detail: fields.detail } : {}),
	});
	if ("refused" in asked) return { retry: turn.reasonOf(asked.refused) };
	const accepted = (asked.outcome.result as { accepted?: unknown }).accepted;
	turn.speak(accepted === true ? say : SAID.failed);
	return "done";
}

/** A check only reads the work's record; the talk turn tells it (what it read is what the reply may report). */
export async function checkWork(turn: Turn, todo: string): Promise<Step> {
	const read = await turn.act(TOOL_NAMES.work, { todo, operation: "check" });
	if ("refused" in read) return { retry: turn.reasonOf(read.refused) };
	const result = read.outcome.result;
	if (typeof result !== "string")
		return {
			retry: String((result as { code?: unknown }).code ?? "todo_not_found"),
		};
	await turn.talk(`${SAID.checked}\n${result}`, { tools: false });
	return "done";
}

/** A correction or a cancellation of the work: said as `say` when the host took it. */
export async function operateWork(
	turn: Turn,
	todo: string,
	operation: unknown,
	text: unknown,
	say: string,
): Promise<Step> {
	const worked = await turn.act(TOOL_NAMES.work, {
		todo,
		operation,
		...(typeof text === "string" ? { text } : {}),
	});
	if ("refused" in worked) return { retry: turn.reasonOf(worked.refused) };
	const ok = (worked.outcome.result as { ok?: unknown }).ok;
	turn.speak(ok === false ? SAID.failed : say);
	return "done";
}

/** A read tool: the host reads; the talk turn tells it, with no tool of its own (conversation-read-tools §2.6). */
export async function readWith(
	turn: Turn,
	candidate: ChoiceCandidate,
	inputs: unknown,
): Promise<Step> {
	const read = await turn.act(
		candidate.id,
		(inputs ?? {}) as Record<string, unknown>,
	);
	if ("refused" in read) return { retry: turn.reasonOf(read.refused) };
	await turn.talk(
		String((read.outcome.result as { text?: unknown }).text ?? ""),
		{
			tools: false,
		},
	);
	return "done";
}

/**
 * An instant toolchain answers from the inputs: the host says its answer. One that ran and has no answer leaves the
 * request to the talk turn, with a notice of what could not be answered.
 */
export async function instantWith(
	turn: Turn,
	candidate: ChoiceCandidate,
	inputs: unknown,
): Promise<Step> {
	const answered = await turn.act(TOOL_NAMES.delegate, {
		mode: "execute",
		toolchain: candidate.id,
		impact: "none",
		inputs: inputs ?? {},
	});
	if ("refused" in answered) return { retry: turn.reasonOf(answered.refused) };
	const result = answered.outcome.result as {
		answered?: unknown;
		answer?: unknown;
		code?: unknown;
	};
	if (result.answered === true && typeof result.answer === "string") {
		turn.speak(result.answer);
		return "done";
	}
	// The toolchain could not answer: the request is still open, so the talk turn takes it, told what failed (the
	// reply may have means of its own, research for one). The host starts nothing else itself.
	await turn.talk(
		systemContext("dialogue.contexts.local.instant-unanswered", {
			title: lineText(candidate.title).slice(0, 30),
			code:
				typeof result.code === "string" && /^[\w.-]{1,60}$/u.test(result.code)
					? result.code
					: "no_answer",
		}),
	);
	return "done";
}

/**
 * A hand-over to the toolchain: announced as `announcement`, or confirmed first when it changes something that
 * exists or cannot be undone (section 6.7). `words` are what the request is when the fields have none.
 */
export async function handWith(
	turn: Turn,
	candidate: ChoiceCandidate,
	fields: Fields,
	announcement: string,
	words: string,
	routedSteps?: readonly RoutedPipelineStep[],
): Promise<Step> {
	const request = {
		toolchain: candidate.id,
		announcement,
		// Keep the complete words for request-based delegation.
		request: typeof fields.request === "string" ? fields.request : words,
		// `new` makes something new: the request names no saved item.
		...(typeof fields.target === "string" && fields.target !== NEW_TARGET
			? { target: fields.target }
			: {}),
		...(Array.isArray(fields.refs) && fields.refs.length
			? { refs: fields.refs }
			: {}),
		// Only the hand-over the user's word waits for may let the unsaved work go: the cloud's strict schema carries
		// the field on every branch.
		...(fields.resolveUnsaved === "discard" &&
		candidate.id === turn.routed?.switching
			? { resolveUnsaved: "discard" as const }
			: {}),
		// The user's own words, when the request carries more than they said: the TODO's title and the statement's quote.
		...(typeof fields.words === "string" ? { words: fields.words } : {}),
	};
	const handed = await turn.act(
		TOOL_NAMES.delegate,
		{ mode: "execute", ...request },
		routedSteps,
	);
	if ("refused" in handed) {
		if (handed.refused.message !== "confirmation_required" || routedSteps)
			return { retry: turn.reasonOf(handed.refused) };
		// A change of something that exists, or one that cannot be undone, is confirmed first (section 6.7).
		const issued = await turn.act(TOOL_NAMES.delegate, {
			mode: "confirm",
			...request,
		});
		if ("refused" in issued) return { retry: turn.reasonOf(issued.refused) };
		if (!issued.outcome.confirmation)
			return {
				retry: String(
					(issued.outcome.result as { code?: unknown }).code ??
						"confirmation_failed",
				),
			};
		turn.speak(
			confirmStatement(candidate, {
				request: request.words ?? request.request,
				...(request.target ? { target: request.target } : {}),
			}),
		);
		return "done";
	}
	if (handed.outcome.end) return "done";
	const code = (handed.outcome.result as { code?: unknown }).code;
	return { retry: `${candidate.title}: ${String(code ?? "not_delegated")}` };
}

/** The user said yes to the confirmation `c<n>`: handed over as it was issued, or the host's failure words. */
export async function approveConfirmation(
	turn: Turn,
	confirmation: string,
): Promise<Step> {
	const approved = await turn.act(TOOL_NAMES.delegate, {
		mode: "approve",
		confirmation,
		announcement: SAID.approved,
	});
	if (!("outcome" in approved) || !approved.outcome.end)
		turn.speak(SAID.failed);
	return "done";
}

/** The user declined the confirmation `c<n>`. */
export async function declineConfirmation(
	turn: Turn,
	confirmation: string,
): Promise<Step> {
	const closed = await turn.decline(Number(confirmation.slice(1)));
	turn.speak(closed ? SAID.declined : SAID.failed);
	return "done";
}

/** The user answered the question work `t<n>` asked. */
export async function answerQuestion(
	turn: Turn,
	todo: string,
	text: string,
): Promise<Step> {
	const answer = (words: string) =>
		turn.act(TOOL_NAMES.work, { todo, operation: "answer", text: words });
	let worked = await answer(text);
	// A question that asks for a structured answer refuses the words as they are and names its shape: the
	// conversation model writes them in that shape once (the router decides only that they answer it).
	const refused =
		"outcome" in worked
			? (worked.outcome.result as { code?: unknown; inputSchema?: unknown })
			: null;
	if (
		refused?.code === "invalid_answer" &&
		refused.inputSchema &&
		typeof refused.inputSchema === "object" &&
		turn.canChoose
	) {
		const inputSchema = refused.inputSchema as Record<string, unknown>;
		const question =
			turn.routed?.pending.questions.find((q) => `t${q.ref}` === todo)
				?.question ?? "";
		const filled = await turn.choose(
			answerMessages({
				routed: turn.routed!,
				question,
				inputSchema,
				utterance: text,
			}),
			answerSchema(inputSchema),
		);
		if (filled && filled !== "cut" && filled.choice === "answer")
			worked = await answer(JSON.stringify(filled.answer));
	}
	if (
		!("outcome" in worked) ||
		(worked.outcome.result as { ok?: unknown }).ok === false
	)
		turn.speak(SAID.failed);
	// A command's question resumes its work under this run (a hand-over): nothing is said now, the work's report is
	// the run's answer. A task takes the answer in its own control, and the host tells it was passed on.
	else if (worked.outcome.end !== true) turn.speak(SAID.answered);
	return "done";
}

/** What a hand-over of the candidate does to what exists: a saved target is a change; the toolchain's own least impact raises it. */
function impactOf(candidate: ChoiceCandidate, target: string | undefined) {
	const declared = target ? "modify_existing" : "none";
	return IMPACT_ORDER[
		Math.max(
			IMPACT_ORDER.indexOf(declared),
			candidate.minImpact
				? IMPACT_ORDER.indexOf(
						candidate.minImpact as (typeof IMPACT_ORDER)[number],
					)
				: 0,
		)
	]!;
}

/** Whether handing the candidate over needs the user's yes first (a change of what exists, or what cannot be undone). */
export function needsConfirmation(
	candidate: ChoiceCandidate,
	target: unknown,
): boolean {
	const impact = impactOf(
		candidate,
		typeof target === "string" && target !== NEW_TARGET ? target : undefined,
	);
	return impact === "modify_existing" || impact === "irreversible";
}

/** The host's confirmation statement: the toolchain, the request and what it does to what exists (section 6.7). */
function confirmStatement(
	candidate: ChoiceCandidate,
	request: { request?: string; target?: string },
): string {
	const impact = impactOf(candidate, request.target);
	const words = {
		title: lineText(candidate.title),
		request: lineText(request.request ?? "").slice(0, CONFIRM_REQUEST_CHARS),
		impact: IMPACT_SAID[impact] ?? IMPACT_SAID.modify_existing!,
	};
	// The item it changes is named as the candidate showed it: the user approves that item, not any.
	const target = candidate.targets?.find((t) => t.ref === request.target);
	return target
		? systemContext("dialogue.contexts.local.confirm-target", {
				...words,
				target: lineText(target.label),
			})
		: systemContext("dialogue.contexts.local.confirm", words);
}
