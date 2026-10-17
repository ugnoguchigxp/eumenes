import type { DialogueDeps, GenerateInput } from "./context";
import { generateConversation } from "./conversation-generation";
import type { FirstRound } from "./initial-decision";
import { answerSession } from "./generation-stream";
import { currentRequestMessage } from "./request-context";
import {
	prepareSelection,
	recordRejected,
	type Candidates,
} from "./selection-trace";

/**
 * The second round of a request the first round gave to a toolchain: one call of that toolchain's function,
 * which carries the request for the specialist. Prose is never adopted; it goes back for the one structural repair.
 */
export async function generateSelection(
	deps: DialogueDeps,
	input: GenerateInput,
	found: Candidates,
	analysis: FirstRound & { next: "toolchain" },
	signal: AbortSignal,
	repair: () => void,
) {
	const decision = prepareSelection(deps, input, found, analysis);
	try {
		const generated = await generateConversation({
			inference: deps.larm,
			requestId: input.requestId,
			messages: decision.messages,
			requestMessage: currentRequestMessage(input),
			signal,
			delta: () => {},
			briefReply: input.briefReply,
			tools: decision.tools,
			cards: decision.cards,
			openQuestions: decision.openQuestions,
			sessions: decision.sessions,
			sessionRole: "auxiliary",
			session: answerSession(input, decision.recallPins),
			repair,
		});
		return { decision, generated };
	} catch (error) {
		if (
			error instanceof Error &&
			error.message === "invalid_conversation_operation"
		)
			await recordRejected(deps, input.runId, decision.draft);
		throw error;
	}
}
