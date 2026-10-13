import type { Database } from "bun:sqlite";
export interface ObjectRecognitionPort {
	snapshotInTransaction(db: Database, conversationId: string): unknown;
	invokeInTransaction(
		db: Database,
		runId: string,
		conversationId: string,
		command: unknown,
	): void;
	resultInTransaction(db: Database, runId: string): unknown | null;
}
