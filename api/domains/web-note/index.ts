export {
	createWebNote,
	WEB_NOTE_RESOURCE,
	type WebNoteDeps,
	type WebNoteService,
} from "./service";
export { migrations } from "./repository";
export type { SourcePort, WebNoteAttempt, WebNoteTurn } from "./contracts";
export { parseNote, today } from "./service/note";
