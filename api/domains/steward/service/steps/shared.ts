import type { ConversationEvent } from "../../../continuity";
import type { LoadedEvent } from "../context";
import type { StepEnv } from "../types";

/**
 * Whether the utterance asked the memory for something (the conversation log's `memory.request` act names its
 * message): the memory tool applied it at the time, and the steward answers it as a request, never as an event to
 * learn from.
 */
export function isRequestEvent(
	env: StepEnv,
	event: ConversationEvent,
): boolean {
	const { db, deps } = env;
	return event.messageIds.some((messageId) =>
		deps.continuity.events
			.ofMessageInTransaction(db, messageId)
			.some((other) => {
				if (other.type !== "acted" || other.text === null) return false;
				try {
					return (
						(JSON.parse(other.text) as { action?: unknown }).action ===
						"memory.request"
					);
				} catch {
					return false;
				}
			}),
	);
}

/**
 * The handled events the memory reflection still has to read, oldest first. Events that carry nothing to learn
 * from (a delivery, an action, a notice, a specialist session's words, a forgotten event, a message of the block
 * ledger, an utterance that made a request to the memory: the immediate layer applied it already) are marked
 * handled here: they are never offered. A forgotten event shows only that it existed.
 */
/** How many of the agent's words just before the user's are read with them (what the user answers). */
const AGENT_CONTEXT = 2;

export function pendingEvents(env: StepEnv): ConversationEvent[] {
	const { db, deps, conversationId } = env;
	const uncurated = deps.continuity.events.uncuratedInTransaction(
		db,
		conversationId,
	);
	if (uncurated.length === 0) return [];
	const blocked = deps.memory.blockedMessageIdsInTransaction(
		db,
		uncurated.flatMap((event) => event.messageIds),
	);
	const skip: number[] = [];
	const todo: ConversationEvent[] = [];
	for (const event of uncurated) {
		if (
			event.type !== "said" ||
			event.by === "host" ||
			event.by === "specialist" ||
			event.forgotten ||
			event.messageIds.some((id) => blocked.has(id)) ||
			isRequestEvent(env, event)
		)
			skip.push(event.seq);
		else todo.push(event);
	}
	// Only the user's words can ground a record: the agent's words wait for the user's next words (the context they
	// answer), and only the last few of them before it are kept as that context.
	const firstUser = todo.findIndex((event) => event.by === "user");
	const stale =
		firstUser < 0 ? [] : todo.splice(0, Math.max(0, firstUser - AGENT_CONTEXT));
	skip.push(...stale.map((event) => event.seq));
	if (skip.length > 0)
		deps.continuity.events.markCuratedInTransaction(db, conversationId, skip);
	return firstUser < 0 ? [] : todo;
}

/**
 * The label the model reads for a loaded event: the conversation's own event id (`e<seq>`, the id the
 * conversation's log shows), or `x<n>` for a message shown as context that no event stands for.
 */
export function eventLabel(event: LoadedEvent, index: number): string {
	return event.seq === null ? `x${index + 1}` : `e${event.seq}`;
}
