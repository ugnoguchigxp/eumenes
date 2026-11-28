import { TOOL_NAMES } from "./generation-tools";
import { NEW_TARGET, type ChoiceCandidate } from "./routed-choice";
import type { Turn } from "./routed-turn";
import { ARGUMENT_CHARS, ASK_STEP } from "./tool-exchange";

/** A work tool either finishes the reply, returns control to the conversation, or explains a refusal. */
export type Step = "done" | "talk" | { retry: string };

/** A hand-over's end: the reply is finished, the work is the agent's assignment (the reply goes on), or it is refused. */
export type Handed = Step | { assigned: Record<string, unknown> };

/** The fields a hand-over takes besides the toolchain (`request`, `diagnosticRef`, `target`, `refs`, `resolveUnsaved`). */
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
 * A hand-over to the toolchain through `delegate`: a session takes the conversation over after the host's
 * announcement, anything else becomes the agent's assignment. `words` are what the request is when the fields have none.
 */
export async function handWith(
	turn: Turn,
	candidate: ChoiceCandidate,
	fields: Fields,
	words: string,
): Promise<Handed> {
	const handed = await turn.act(TOOL_NAMES.delegate, {
		toolchain: candidate.id,
		// Keep the complete words for request-based delegation.
		request: typeof fields.request === "string" ? fields.request : words,
		...(candidate.execution === "task" &&
		candidate.inputs &&
		fields.inputs !== undefined
			? { inputs: fields.inputs }
			: {}),
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
	});
	if ("refused" in handed) return { retry: turn.reasonOf(handed.refused) };
	if (handed.outcome.end) return "done";
	const result = handed.outcome.result as {
		delegated?: unknown;
		code?: unknown;
	};
	if (result.delegated === true)
		return { assigned: result as Record<string, unknown> };
	return {
		retry: `${candidate.title}: ${String(result.code ?? "not_delegated")}`,
	};
}
