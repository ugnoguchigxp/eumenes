import { migration as initMigration, retentionMigration } from "./repository";
export { createTasks, type TasksService } from "./service";
/**
 * The full schema as one script, for throw-away test databases that pass a single SQL string.
 * Production uses `migrations`, which keeps each step's frozen SQL and checksum separate.
 */
export const migration = `${initMigration}\n${retentionMigration}`;
export { registerTasks } from "./controller";
export type {
	TaskFence,
	TaskKindDefinition,
	TasksOptions,
	TrustedTaskContext,
} from "./types";
export type {
	WorkTask,
	TaskReceipt,
	TaskGrant,
	TaskOrigin,
	TaskQuestion,
} from "./contracts";
export { migrations } from "./repository";
