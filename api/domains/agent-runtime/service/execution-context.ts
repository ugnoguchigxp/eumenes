import type { SqliteStore } from "../../../infrastructure/sqlite";
import type { InferencePort } from "../../inference";
import type { QueueService } from "../../queue";
import type { ToolchainExecutionPort } from "../../tool-runtime";
export type ExecutionContext = {
	store: SqliteStore;
	queue: QueueService;
	inference: InferencePort;
	now: () => number;
	port: () => ToolchainExecutionPort;
};
export const PARENT_STEP = "agent.execution.step";
export const CHILD_STEP = "agent.execution.child";
