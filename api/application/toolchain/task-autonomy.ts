import type { Database } from "bun:sqlite";
import type { TaskExecutionHost } from "./task-execution-port";
import type { TaskChildContext } from "./task-execution-catalog";

/** Execution contracts and declared effects, never the topic or wording of a request. */
export function taskAutonomy(host: TaskExecutionHost, context: Pick<TaskChildContext, "available">) {
	return (db: Database, revisionId: string) => {
		const entry = context.available(db).find((e) => e.revisionId === revisionId);
		if (!entry) return { automatic: false, reason: "capability_unavailable", operations: [] as string[] };
		const { execution, binding } = entry.runtime;
		if (execution === "session") return { automatic: false, reason: "interactive_handoff", operations: [] as string[] };
		if (execution === "task" || execution === "read" || execution === "music-playback") return { automatic: false, reason: "approval_required", operations: [] as string[] };
		if (execution === "command" || execution === "instant") {
			const set = host.capabilities.toolchainBindingInTransaction(db, revisionId)?.binding.document;
			if (!set) return { automatic: false, reason: "approval_required", operations: [] as string[] };
			const described = host.registry.get(set.adapterRef)?.describe().operations;
			const operations = set.tools.filter((tool) => {
				const op = described?.get(tool.operationId);
				return op?.effect === "read" || op?.autonomy === "create";
			}).map((tool) => tool.operationId);
			return { automatic: operations.length > 0, reason: operations.length ? "available" : "approval_required", operations };
		}
		const card = host.routing.cardInTransaction(db, revisionId);
		const automatic = !!card && (card.minImpact === "none" || card.minImpact === "create");
		return { automatic, reason: automatic ? "available" : "approval_required", operations: [] as string[] };
	};
}
