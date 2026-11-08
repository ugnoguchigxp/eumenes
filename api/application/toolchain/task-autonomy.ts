import type { Database } from "bun:sqlite";
import type { TaskExecutionHost } from "./task-execution-port";
import type { TaskChildContext } from "./task-execution-catalog";

/** Execution contracts and declared effects, never the topic or wording of a request. */
export function taskAutonomy(
	host: TaskExecutionHost,
	context: Pick<TaskChildContext, "available">,
) {
	return (db: Database, revisionId: string) => {
		const registered = host.routing
			.catalogInTransaction(db)
			.find((e) => e.revisionId === revisionId);
		const entry =
			context.available(db).find((e) => e.revisionId === revisionId) ??
			(registered &&
			["task", "pipeline"].includes(registered.runtime.execution) &&
			registered.runtime.binding?.available
				? registered
				: undefined);
		if (!entry)
			return {
				automatic: false,
				reason: "capability_unavailable",
				operations: [] as string[],
			};
		const { execution } = entry.runtime;
		if (execution === "session")
			return {
				automatic: false,
				reason: "interactive_handoff",
				operations: [] as string[],
			};
		if (execution === "read" || execution === "music-playback")
			return {
				automatic: false,
				reason: "approval_required",
				operations: [] as string[],
			};
		if (execution === "task" || execution === "pipeline") {
			const effect =
				entry.runtime.binding &&
				host.registry.get(entry.runtime.binding.adapterRef)?.describe()
					.autonomy;
			const owner =
				execution === "task"
					? host.routing.taskInTransaction?.(db, revisionId)
					: undefined;
			const lifecycle =
				execution === "pipeline" ||
				(!!owner?.cancelInTransaction && !!owner.forgetInTransaction);
			const automatic = (effect === "read" || effect === "create") && lifecycle;
			return {
				automatic,
				...(automatic && (effect === "read" || effect === "create")
					? { effect }
					: {}),
				reason: automatic
					? "available"
					: !lifecycle
						? "lifecycle_unavailable"
						: "approval_required",
				operations: [] as string[],
			};
		}
		if (execution === "command" || execution === "instant") {
			const set = host.capabilities.toolchainBindingInTransaction(
				db,
				revisionId,
			)?.binding.document;
			if (!set)
				return {
					automatic: false,
					reason: "approval_required",
					operations: [] as string[],
				};
			const described = host.registry
				.get(set.adapterRef)
				?.describe().operations;
			const operations = set.tools
				.filter((tool) => {
					const op = described?.get(tool.operationId);
					return op?.effect === "read" || op?.autonomy === "create";
				})
				.map((tool) => tool.operationId);
			return {
				automatic: operations.length > 0,
				...(operations.length
					? {
							effect: operations.every(
								(id) => described?.get(id)?.effect === "read",
							)
								? ("read" as const)
								: ("create" as const),
						}
					: {}),
				reason: operations.length ? "available" : "approval_required",
				operations,
			};
		}
		const card = host.routing.cardInTransaction(db, revisionId);
		const automatic =
			!!card &&
			(entry.runtime.autonomy === "read" ||
				entry.runtime.autonomy === "create") &&
			card.minImpact !== "modify_existing" &&
			card.minImpact !== "irreversible";
		return {
			automatic,
			...(automatic &&
			(entry.runtime.autonomy === "read" || entry.runtime.autonomy === "create")
				? { effect: entry.runtime.autonomy }
				: {}),
			reason: automatic ? "available" : "approval_required",
			operations: [] as string[],
		};
	};
}
