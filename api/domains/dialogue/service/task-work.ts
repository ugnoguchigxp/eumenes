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

/** The small projection needed to choose the parent or an individual task in a conversation. */
export function taskTargets(
	deps: DialogueDeps,
	db: Database,
	row: WorkRow | null | undefined,
) {
	if (
		!row?.sourceRef ||
		(row.execution !== "task" && row.execution !== "pipeline")
	)
		return undefined;
	const view = taskForWork(deps, db, row)?.viewInTransaction(db, row.sourceRef);
	if (!view?.tasks) return undefined;
	return {
		executionRevision: view.revision,
		tasks: view.tasks.map(({ taskId, revision, title, state, reason }) => ({
			taskId,
			revision,
			title,
			state,
			reason,
		})),
	};
}
