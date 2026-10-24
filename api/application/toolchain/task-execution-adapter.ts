import type { AgentRuntime } from "../../domains/agent-runtime";
import type { DomainAdapter } from "../../domains/tool-runtime";
import { workSourceQuery } from "../../domains/agent-runtime/contracts";
export const TASK_ADAPTER_REF = "adapter:task-execution@1";
export const TASK_TODOS_QUERY = "query:agent-runtime.todos@1";
export const describeTaskAdapter = () => ({
	owner: "agent-runtime",
	operations: new Map(),
	queries: new Set([TASK_TODOS_QUERY]),
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
		artifactAvailableInTransaction: () => runtime() !== undefined,
		snapshotInTransaction: () => null,
		invokeInTransaction() {
			throw new Error("task_lifecycle_required");
		},
		readInTransaction: () => null,
		sourceInTransaction(tx, query, targetRef, params) {
			if (query !== TASK_TODOS_QUERY || targetRef !== undefined) return null;
			const input = workSourceQuery.safeParse(params);
			const agent = runtime();
			if (!input.success || !agent) return null;
			const data = agent.executions.agencyWorkPageInTransaction(
				tx,
				input.data.conversationId,
				input.data,
			);
			return {
				revision: Math.max(
					0,
					...data.rows.map((row) =>
						Math.max(row.updatedAt, row.releasedAt ?? 0),
					),
				),
				data,
			};
		},
		targetInput: () => ({}),
	};
}
