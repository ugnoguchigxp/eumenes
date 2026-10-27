import type { Database } from "bun:sqlite";
import type { DialogueDeps } from "./context";

/**
 * The utterances of the conversation's input (the conversation input specification, section 6.3): the user's as
 * they were accepted, the agent's once they reached the user (only what was heard of a reply cut short). A host
 * notice, a specialist's words and the words said to a specialist are never written here.
 */
export function recordUtteranceInTransaction(
	deps: Pick<DialogueDeps, "conversation" | "contextKeeper">,
	db: Database,
	input: {
		conversationId: string;
		speaker: "user" | "agent";
		text: string;
		messageId: string | null;
		at: string;
	},
	/** Tell the context keeper (false for a reply whose playback is still to come: its delivery tells it). */
	notify = true,
): void {
	if (!input.text.trim()) return;
	if (deps.conversation.input.appendUtteranceInTransaction(db, input) && notify)
		deps.contextKeeper?.noteUtterance(input.conversationId, input.speaker);
}
