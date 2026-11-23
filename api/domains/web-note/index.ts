export {
	createWebNote,
	INSPECT_SOURCE_ADAPTER,
	WEB_NOTE_RESOURCE,
	type WebNoteDeps,
	type WebNoteService,
} from "./service";
export { migrations } from "./repository";
export { ADAPTER as webNoteAdapterRef } from "./service/context";
export type {
	GoalWebNoteOwner,
	GoalWebNoteReceipt,
	InspectSource,
	SourcePort,
	WebNoteAttempt,
	WebNoteTurn,
} from "./contracts";
export { parseNote, today } from "./service/note";
export { createConversationLookup } from "./service/lookup";
