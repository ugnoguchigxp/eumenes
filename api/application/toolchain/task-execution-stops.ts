import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { AgentRuntime } from "../../domains/agent-runtime";
import type { QueueService } from "../../domains/queue";
import type {
	AdapterRegistry,
	ChildExecution,
} from "../../domains/tool-runtime";

/** Stop requests commit with the parent transition; process I/O occurs in its own queue job. */
export function taskExecutionStops(
	queue: QueueService,
	registry: AdapterRegistry,
	agents: AgentRuntime,
) {
	const payload = z.object({
		adapterRef: z.string(),
		operationId: z.string(),
		child: z.strictObject({ executionId: z.uuid(), id: z.uuid() }),
	});
	queue.registerHandler({
		kind: "agent.execution.stop-child",
		payloadVersions: [1],
		schema: payload,
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			if (
				!agents.executions.stopRequestedInTransaction(db, claim.payload.child)
			)
				return { status: "stale", reason: "execution_changed" };
			return { status: "ready", input: claim.payload };
		},
		async execute(input) {
			return (
				(await registry
					.get(input.adapterRef)
					?.execution?.stop?.(input.operationId)) ?? false
			);
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			if (outcome.type !== "success" || !outcome.result)
				agents.executions.stopUnconfirmedInTransaction(db, claim.payload.child);
			return "applied";
		},
		cancelInTransaction(db, job) {
			agents.executions.stopUnconfirmedInTransaction(db, job.payload.child);
		},
	});
	return (
		db: Database,
		adapterRef: string,
		operationId: string,
		child: ChildExecution,
	) => {
		if (!registry.get(adapterRef)?.execution?.stop) return;
		queue.enqueueInTransaction(db, {
			scope: "agent",
			kind: "agent.execution.stop-child",
			dedupeKey: `${child.dispatchId ?? child.id}:${operationId}`,
			payload: {
				adapterRef,
				operationId,
				child: { executionId: child.executionId, id: child.id },
			},
			lane: "interactive",
			maxAttempts: 1,
			deadlineAtMs: Date.now() + 15_000,
		});
	};
}
