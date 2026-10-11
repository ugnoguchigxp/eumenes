import type { Database } from "bun:sqlite";
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
	resultInTransaction(db: Database, runId: string): unknown | null;
}
