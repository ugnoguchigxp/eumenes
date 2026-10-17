import type { DialogueDeps, GenerateInput } from "./context";
import type { SpeechPreparation } from "../../delivery";
import { generateConversation } from "./conversation-generation";
import { answerSession } from "./generation-stream";
import { currentRequestMessage } from "./request-context";
import { prepareDecision, recordRejected } from "./selection-trace";

/** The second phase runs only after the conversation asks for available specialists. */
export async function generateSelection(
	deps: DialogueDeps,
	input: GenerateInput,
	signal: AbortSignal,
	repair: () => void,
	preparation?: SpeechPreparation,
) {
	const decision = await prepareDecision(deps, input, signal);
	try {
		const generated = await generateConversation({
			inference: deps.larm,
			requestId: input.requestId,
			messages: decision.selectionMessages ?? decision.messages,
			requestMessage: currentRequestMessage(input),
			signal,
			delta: () => {},
			preparation: decision.selectionMessages ? undefined : preparation,
			briefReply: input.briefReply,
			tools: decision.tools,
			cards: decision.cards,
			openQuestions: decision.openQuestions,
			sessions: decision.sessions,
			sessionRole: decision.selectionMessages ? "auxiliary" : "main",
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
