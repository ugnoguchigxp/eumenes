import type { Database } from "bun:sqlite";
export interface ObjectRecognitionPort {
	/** `viewing` is the run's screen context; the port marks only a record it owns. */
	snapshotInTransaction(
		db: Database,
		conversationId: string,
		viewing?: { artifactRevisionId: string; targetRef: string } | null,
	): unknown;
	invokeInTransaction(
		db: Database,
		runId: string,
		conversationId: string,
		command: unknown,
		/** Images already on the run's input: the model sees them, so nothing is taken again. */
		input?: { inputImages: number; callId?: string },
	): void;
	resultInTransaction(db: Database, runId: string): unknown | null;
	resultForCallInTransaction?(db: Database, callId: string): unknown | null;
}
