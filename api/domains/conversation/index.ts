export { registerConversation } from "./controller";
export {
	migration,
	avatarMotionMigration,
	answerDeliveryMigration,
	outboxMigration,
	retractionMigration,
} from "./repository";
export type {
	ChangeResult,
	ConversationSourceState,
	OutboxEvent,
	OutboxKind,
} from "./contracts";
export {
	CONVERSATION_DEFAULT_PRINCIPAL,
	CONVERSATION_DEFAULT_SCOPE,
	CONVERSATION_SOURCE_KIND,
	CONVERSATION_SOURCE_NAMESPACE,
	CONVERSATION_SOURCE_REPRESENTATION,
} from "./contracts";
export type {
	ConversationService,
	ConversationServiceOptions,
} from "./service";
export { createConversationService } from "./service";
export { migrations } from "./repository";

export type {
	HistoryOwner,
	HistoryView,
	HistoryScope,
} from "./contracts/history";
