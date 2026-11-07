import type { Database } from "bun:sqlite";
import type { ChildExecution, ChildResult } from "../../domains/tool-runtime";
import type { TaskExecutionHost } from "./task-execution-port";
/** Derives resource links from the capability's registered output adapters. */
export function adoptTaskResources(
	host: TaskExecutionHost,
	db: Database,
	child: ChildExecution,
	outcome: ChildResult,
) {
	if (outcome.state === "completed" && host.resources) {
		const card = host.routing.cardInTransaction(db, child.chainRevisionId);
		const links = card
			? host.capabilities
					.producesInTransaction(db, card.id)
					.flatMap(
						(kind) =>
							host
								.resources!.adapter(kind)
								?.fromResultInTransaction(db, outcome.output, {
									conversationId: child.source.conversationId,
									runId: child.source.runId,
								}) ?? [],
					)
					.map((resource) => resource.uri)
			: [];
		outcome.links = [...new Set([...(outcome.links ?? []), ...links])];
	}
}
