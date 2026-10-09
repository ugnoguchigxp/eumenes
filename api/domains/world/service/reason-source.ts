import type { Database } from "bun:sqlite";
import type { SourceRef } from "eumenes-memory";
import type { ScopeRef } from "eumenes-world-model";
import {
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
	CONVERSATION_SOURCE_REPRESENTATION,
	type ConversationService,
} from "../../conversation";

/**
 * The statement that makes a correction or retraction explicit: a CONFIRMED
 * message of the person, in the Scope, that is still current. Anything else
 * (an assistant message, another Scope, retracted, unknown) is the same
 * answer, null.
 */
export function conversationReasonSource(
	conversation: Pick<ConversationService, "sourceInTransaction">,
	scope: ScopeRef,
): (db: Database, messageId: string) => SourceRef | null {
	return (db, messageId) => {
		if (typeof messageId !== "string" || messageId === "") return null;
		const state = conversation.sourceInTransaction(db, messageId);
		if (
			state.state !== "available" ||
			state.message.role !== "user" ||
			state.principal !== scope.principal ||
			state.scopeKey !== scope.scopeKey
		)
			return null;
		return {
			namespace: CONVERSATION_SOURCE_NAMESPACE,
			kind: CONVERSATION_SOURCE_KIND,
			id: messageId,
			representation: CONVERSATION_SOURCE_REPRESENTATION,
			revision: state.revision,
			digest: state.digest,
		};
	};
}
