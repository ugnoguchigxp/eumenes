import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { Capabilities } from "../../capabilities";
import type { QueueService } from "../../queue";
import type { SourcePort, WebNoteAttempt, WebNoteTurn } from "../contracts";

export const ADAPTER = "adapter:web-note@1";
/** The queue resource the Codex runs share. */
export const WEB_NOTE_RESOURCE = "codex.search";

export type WebNoteDeps = {
	store: SqliteStore;
	queue: QueueService;
	capabilities: Capabilities;
	/** One Codex turn (the host's Codex SDK; a fake in tests). Absent: the task is not offered. */
	turn?: WebNoteTurn;
	/** Records a finished turn in the inference ledger (a Codex SDK attempt, with its tokens). */
	record?(attempt: WebNoteAttempt): Promise<void>;
	now?: () => number;
	id?: () => string;
};
export type Context = WebNoteDeps & {
	now: () => number;
	source: () => SourcePort;
	/** The jobs to abort once the transaction that cancelled them has committed. */
	abortJobs: Set<string>;
};
