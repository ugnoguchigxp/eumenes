import type { DialogueDeps, GenerateInput } from "./context";
import { generateConversation } from "./conversation-generation";
import type { RequestAnalysis } from "./initial-decision";
import { answerSession } from "./generation-stream";
import { currentRequestMessage } from "./request-context";
import { prepareSelection, recordRejected } from "./selection-trace";

/**
 * The second round of a request the analysis sent to the toolchains: one function call, a candidate's or
 * `report_unavailable`. Prose is never adopted; it goes back for the one structural repair.
 */
export async function generateSelection(
	deps: DialogueDeps,
	input: GenerateInput,
	analysis: RequestAnalysis,
	signal: AbortSignal,
	repair: () => void,
) {
	const decision = await prepareSelection(deps, input, analysis, signal);
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
