import type { AgentRuntime } from "../../domains/agent-runtime";
import type { DomainAdapter } from "../../domains/tool-runtime";
export const TASK_ADAPTER_REF = "adapter:task-execution@1";
export const describeTaskAdapter = () => ({
	owner: "agent-runtime",
	operations: new Map(),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:task-execution@1",
	task: true,
});
/** Registry entry only; the agent-runtime owns every transition and persisted record. */
export function createTaskAdapter(
	runtime: () => AgentRuntime | undefined,
): DomainAdapter {
	return {
		ref: TASK_ADAPTER_REF,
		describe: describeTaskAdapter,
		task: {
			startInTransaction: (db, input) => {
				const agent = runtime();
				if (!agent) throw new Error("execution_unavailable");
				return agent.executions.startInTransaction(db, input);
			},
			controlInTransaction: (db, conversationId, input, messageId) => {
				const agent = runtime();
				if (!agent) throw new Error("execution_unavailable");
				return agent.executions.controlInTransaction(
					db,
					conversationId,
					input,
					messageId,
				);
			},
			viewInTransaction: (db, id) =>
				runtime()?.executions.viewInTransaction(db, id) ?? null,
		},
		availableInTransaction: (db) =>
			runtime()?.executions.availableInTransaction(db) ?? false,
		snapshotInTransaction: () => null,
		invokeInTransaction() {
			throw new Error("task_lifecycle_required");
		},
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
	};
}
