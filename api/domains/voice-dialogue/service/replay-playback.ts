import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { DialogueService } from "../../dialogue";
import type { ReplayPlayed } from "../contracts";
import { SpeechSentences } from "./sentences";
import { spokenText } from "./spoken-text";

/** On-demand replay uses the same speech acknowledgement as a live voice answer. */
export function createReplayPlayback(
	store: SqliteStore,
	dialogue: Pick<DialogueService, "recordMessageHeardInTransaction">,
) {
	return {
		replayPlayed: (played: ReplayPlayed) =>
			store.write((db) => dialogue.recordMessageHeardInTransaction(db, played)),
		replaySentences: (text: string) =>
			new SpeechSentences().append(spokenText(text), true),
	};
}
