import type { Database } from "bun:sqlite";
import type { ExecutionReference } from "../../tool-runtime";
export interface MusicPort {
	startInTransaction(
		db: Database,
		input: {
			runId: string;
			conversationId: string;
			question: string;
			originalRequest: string;
			deadline: number;
		},
	): { id: string; jobId: string };
	/** `references`: the resources handed over with the request (a track to play opens without a search). */
	startPlaybackInTransaction(
		db: Database,
		input: Parameters<MusicPort["startInTransaction"]>[1] & {
			references?: ExecutionReference[];
		},
	): { id: string; jobId: string };
	resultInTransaction(db: Database, runId: string): unknown | null;
}
