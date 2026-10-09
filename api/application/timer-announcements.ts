import type { Database } from "bun:sqlite";
import type { ConversationService } from "../domains/conversation";
import type { TimerCompletion } from "../domains/timers/contracts";

/** Expiry, the durable notice and the assistant message share one writer transaction. */
export function createTimerAnnouncements(conversation: ConversationService) {
	return (tx: Database, event: TimerCompletion) => {
		if (!event.conversationId) return;
		const id = `timer-completion:${event.notificationId}`;
		if (conversation.messageInTransaction(tx, id)) return;
		conversation.appendInTransaction(tx, {
			id,
			conversationId: event.conversationId,
			role: "assistant",
			text: event.message,
			createdAt: event.at,
			runId: null,
		});
	};
}
