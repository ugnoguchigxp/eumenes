import type { Database } from "bun:sqlite";
/** Only already saved legacy task refs use this port. New work is registered through DomainAdapter. */
export interface DelegationPort {
	executionTaskInTransaction?(
		db: Database,
		conversationId: string,
		taskId: string,
	): unknown;
	cancelExecutionTaskInTransaction?(
		db: Database,
		conversationId: string,
		taskId: string,
	): void;
}
