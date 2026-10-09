import type { Database } from "bun:sqlite";
import type { WorkTask, TaskOrigin } from "./contracts";

/** Only trusted application wiring provides origins and transaction callbacks. */
export interface TaskKindDefinition {
	kind: "coding";
	version: 1;
	available(): boolean;
	startInTransaction(tx: Database, task: WorkTask): void;
	stopInTransaction(
		tx: Database,
		task: WorkTask,
		context?: { executionStopped: boolean },
	): void;
	amendInTransaction?(tx: Database, previous: WorkTask, task: WorkTask): void;
	answerInTransaction?(tx: Database, task: WorkTask, questionId: string): void;
	terminalInTransaction?(tx: Database, task: WorkTask): void;
}
export interface TaskFence {
	taskId: string;
	expectedRevision: number;
	authorityEpoch: number;
	executionGeneration: number;
}
export interface TasksOptions {
	now?: () => number;
	id?: () => string;
	maxLiveTasks?: number;
	maxTasks?: number;
	maxStorageBytes?: number;
	kinds?: TaskKindDefinition[];
}
export type TrustedTaskContext = { origin: TaskOrigin };
