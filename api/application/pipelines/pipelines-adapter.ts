import type { AgentRuntime } from "../../domains/agent-runtime";
import type { DomainAdapter } from "../../domains/tool-runtime";
export const PIPELINES_ADAPTER_REF = "adapter:pipelines@2";
export const describePipelinesAdapter = () => ({
	owner: "pipelines",
	operations: new Map(),
	queries: new Set<string>(),
	inputAdapters: new Map(),
	projections: new Set<string>(),
	availability: "availability:pipelines@2",
	pipeline: true,
});
/** Pipeline work uses the existing parent execution and its TODO; it has no separate screen or mutation API. */
export function createPipelinesAdapter(
	runtime: () => AgentRuntime | undefined,
): DomainAdapter {
	return {
		ref: PIPELINES_ADAPTER_REF,
		describe: describePipelinesAdapter,
		availableInTransaction: (db) =>
			runtime()?.executions.pipelinesAvailableInTransaction(db) ?? false,
		snapshotInTransaction: () => null,
		invokeInTransaction() {
			throw new Error("pipeline_operation_unknown");
		},
		readInTransaction: () => null,
		sourceInTransaction: () => null,
		targetInput: () => ({}),
	};
}
