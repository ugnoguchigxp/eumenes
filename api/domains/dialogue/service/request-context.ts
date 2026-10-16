import { systemContext } from "../../../infrastructure/system-context";
import type { Database } from "bun:sqlite";
import type { ConversationService } from "../../conversation";
import type { Run } from "../contracts";
import type { ChatMessage, GenerateInput } from "./context";

/** Host-owned identity and position, fixed before results or repair data can be added. */
export type CurrentRequest = { messageId: string; messageIndex: number };

export const currentRequestRules = systemContext(
	"dialogue.contexts.request-context.current-request-rules",
	{},
);

export function currentRequestMessage(
	input: Pick<GenerateInput, "messages" | "currentRequest">,
) {
	const message = input.messages[input.currentRequest.messageIndex];
	if (!input.currentRequest.messageId || message?.role !== "user")
		throw new Error("run_input_missing");
	return message;
}

/** Mark the exact host-selected message without copying its text or changing attachments. */
export function markCurrentRequest(
	messages: ChatMessage[],
	message: ChatMessage,
	messageId: string,
) {
	const index = messages.indexOf(message);
	if (index < 0) throw new Error("run_input_missing");
	const marked = messages.slice(0, index);
	// Host-added state travels before the anchored input, with no change to its payload.
	if (index + 1 < messages.length)
		marked.push(
			{
				role: "system",
				content: systemContext("dialogue.contexts.request-context.content", {}),
			},
			...messages.slice(index + 1),
		);
	marked.push({
		role: "system",
		content:
			"CURRENT_REQUEST=" +
			JSON.stringify({ messageId }) +
			systemContext("dialogue.contexts.request-context.content-2", {}),
	});
	marked.push(message);
	// Keep the rule in the leading instruction layer even for SDKs which serialize later turns.
	if (marked[0]?.role === "system")
		marked[0] = {
			...marked[0],
			content: marked[0].content + "\n" + currentRequestRules,
		};
	else marked.unshift({ role: "system", content: currentRequestRules });
	return marked;
}

/** Every delegation reads the original from this run's input, never a recalled selection. */
export function originalRequestInTransaction(
	db: Database,
	conversation: ConversationService,
	run: Run,
) {
	const input = conversation.messageInTransaction(db, run.inputMessageId);
	if (!input || input.message.conversationId !== run.conversationId)
		throw new Error("run_input_missing");
	return input.message.text;
}
