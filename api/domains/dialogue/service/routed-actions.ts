import { systemContext } from "../../../infrastructure/system-context";
import { IMPACT_ORDER } from "./executor-context";
import { TOOL_NAMES } from "./generation-tools";
import { lineText } from "./input-text";
import {
	NEW_TARGET,
	answerMessages,
	answerSchema,
	type ChoiceCandidate,
} from "./routed-choice";
import type { Turn } from "./routed-turn";
import { ARGUMENT_CHARS, ASK_STEP } from "./tool-exchange";

/** A work tool either finishes the reply, returns control to the conversation, or explains a refusal. */
export type Step = "done" | "talk" | { retry: string };

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

/**
 * A question back: spoken, and kept as the step the next turn takes the user's answer with. `request` is what was
 * asked about when it is not the user's own words (the talk turn's reply wrote it; theirs may be a bare yes).
 */
export function askBack(turn: Turn, say: string, request?: string): Step {
	turn.speak(say);
	recordQuestion(turn, request);
	return "done";
}

function recordQuestion(turn: Turn, request?: string): void {
	turn.signal.throwIfAborted();
	turn.exchange.push({
		name: ASK_STEP,
		arguments: JSON.stringify({
			request:
				request === undefined
					? askedRequest(turn.routed?.asked?.request, turn.utterance)
					: request.slice(0, ARGUMENT_CHARS),
		}),
		result: {},
	});
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
): Promise<Step> {
	const request = {
		toolchain: candidate.id,
		announcement,
		// Keep the complete words for request-based delegation.
		request: typeof fields.request === "string" ? fields.request : words,
		...(typeof fields.diagnosticRef === "string"
			? { diagnosticRef: fields.diagnosticRef }
			: {}),
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
	const handed = await turn.act(TOOL_NAMES.delegate, {
		mode: "execute",
		...request,
	});
	if ("refused" in handed) {
		if (handed.refused.message !== "confirmation_required")
			return { retry: turn.reasonOf(handed.refused) };
		// A change of something that exists, or one that cannot be undone, is confirmed first (section 6.7).
		const issued = await turn.act(TOOL_NAMES.delegate, {
			mode: "confirm",
			...request,
		});
		if ("refused" in issued) return { retry: turn.reasonOf(issued.refused) };
		if (!issued.outcome.confirmationId)
			return {
				retry: String(
					(issued.outcome.result as { code?: unknown }).code ??
						"confirmation_failed",
				),
			};
		turn.speak(
			confirmStatement(candidate, {
				request: request.diagnosticRef
					? `診断 ${request.diagnosticRef} の原因分析を依頼する。${request.request}`
					: request.request,
				...(request.target ? { target: request.target } : {}),
			}),
		);
		return "done";
	}
	if (handed.outcome.end) return "done";
	const code = (handed.outcome.result as { code?: unknown }).code;
	return { retry: `${candidate.title}: ${String(code ?? "not_delegated")}` };
}

/** The user answered the question work `t<n>` asked. */
export async function answerQuestion(turn: Turn, todo: string, text: string) {
	const answer = (words: string) =>
		turn.act(TOOL_NAMES.work, { todo, operation: "answer", text: words });
	let worked = await answer(text);
	// A question that asks for a structured answer refuses the words as they are and names its shape: the
	// conversation model writes them in that shape once using the question as context.
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
	return worked;
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
