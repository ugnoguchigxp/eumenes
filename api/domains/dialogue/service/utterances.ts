import type { Database } from "bun:sqlite";
import type { UtteranceToolCall } from "../../conversation";
import type { DialogueDeps } from "./context";

/**
 * The utterances of the conversation's input (the conversation input specification, section 6.3): the user's as
 * they were accepted, the agent's once they reached the user (only what was heard of a reply cut short). A host
 * notice, a specialist's words and the words said to a specialist are never written here.
 */
export function recordUtteranceInTransaction(
	deps: Pick<DialogueDeps, "conversation">,
	db: Database,
	input: {
		conversationId: string;
		speaker: "user" | "agent";
		text: string;
		messageId: string | null;
		at: string;
		/** The tool calls of the turn an agent utterance ends. */
		toolCalls?: readonly UtteranceToolCall[];
		/** The host notice an agent utterance reports (`reportNoticeInTransaction`). */
		notice?: string;
	},
): void {
	if (!input.text.trim()) return;
	deps.conversation.input.appendUtteranceInTransaction(db, input);
}
