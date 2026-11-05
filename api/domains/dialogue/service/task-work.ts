import type { Database } from "bun:sqlite";
import type { WorkRow } from "../repository/work";
import type { DialogueDeps } from "./context";
import type { TaskLifecyclePort } from "../../tool-runtime";

/** The exact task owner stored in the TODO; a binding is never inferred from task prose. */
export function taskForWork(
	deps: Partial<Pick<DialogueDeps, "toolchains" | "agents">>,
	db: Database,
	row: WorkRow | null | undefined,
): Omit<TaskLifecyclePort, "startInTransaction"> | undefined {
	if (row) {
		const registered = deps.toolchains?.taskInTransaction?.(
			db,
			row.toolchainRevisionId,
		);
		if (registered) return registered;
	}
	const executions = deps.agents?.executions;
	return executions
		? {
				viewInTransaction: (tx, id) => executions.viewInTransaction(tx, id),
				controlInTransaction: (tx, conversationId, input, messageId) =>
					executions.controlInTransaction(tx, conversationId, input, messageId),
				cancelInTransaction: (tx, conversationId, id) =>
					executions.cancelByUserInTransaction(tx, conversationId, id),
			}
		: undefined;
}
