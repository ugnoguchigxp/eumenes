import type { Database } from "bun:sqlite";
export interface ImagePort {
	startInTransaction(
		db: Database,
		input: {
			runId: string;
			conversationId: string;
			question: string;
			originalRequest: string;
			/** The earlier steps of the same request (a continuation run only): reference data. */
			priorSteps?: unknown[];
			deadline: number;
		},
	): { id: string; jobId: string };
	resultInTransaction(db: Database, runId: string): unknown | null;
	/** What a later step of the same request reads of this run's result: that it was made, and its reference. */
	referenceInTransaction?(db: Database, runId: string): unknown | null;
}
