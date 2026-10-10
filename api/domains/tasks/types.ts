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
	/** Removes this kind's rows that reference the task, before tasks deletes the task row. */
	purgeInTransaction?(tx: Database, task: WorkTask): void;
}
export interface TaskFence {
	taskId: string;
	expectedRevision: number;
	authorityEpoch: number;
	executionGeneration: number;
}
export interface TasksOptions {
	/** Application composition hook; synchronous, in the same writer transaction. */
	changedInTransaction?: (tx: Database, task: WorkTask) => void;
	now?: () => number;
	id?: () => string;
	maxLiveTasks?: number;
	maxTasks?: number;
	maxStorageBytes?: number;
	kinds?: TaskKindDefinition[];
	/**
	 * Kind-independent purge hook: removes other domains' rows that reference the
	 * task, in the same writer transaction, before the task row is deleted. Runs
	 * for every purged task, including kinds that are not registered in this process.
	 */
	purgeInTransaction?: (tx: Database, task: WorkTask) => void;
}
export type TrustedTaskContext = { origin: TaskOrigin };
