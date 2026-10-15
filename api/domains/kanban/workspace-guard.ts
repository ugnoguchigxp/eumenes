import type { Database } from "bun:sqlite";

export type WorkspaceGuard = {
	workspaceRef: string;
	ownerRef: string;
	executorId: string;
	epoch: string;
	state: "held" | "releasing" | "unknown";
};
export function readWorkspaceGuard(
	tx: Database,
	workspaceRef: string,
): WorkspaceGuard | null {
	return tx
		.query(
			"SELECT workspace_ref AS workspaceRef,owner_ref AS ownerRef,executor_id AS executorId,epoch,state FROM kanban_workspace_guards WHERE workspace_ref=?",
		)
		.get(workspaceRef) as WorkspaceGuard | null;
}
/** Host resolves equivalent cwd paths to one registered workspaceRef before this call. */
export function reserveWorkspaceInTransaction(
	tx: Database,
	guard: WorkspaceGuard,
): boolean {
	const current = readWorkspaceGuard(tx, guard.workspaceRef);
	if (current)
		return (
			current.ownerRef === guard.ownerRef &&
			current.executorId === guard.executorId &&
			current.epoch === guard.epoch &&
			current.state === "held"
		);
	tx.query(
		"INSERT INTO kanban_workspace_guards(workspace_ref,owner_ref,executor_id,epoch,state) VALUES(?,?,?,?,?)",
	).run(
		guard.workspaceRef,
		guard.ownerRef,
		guard.executorId,
		guard.epoch,
		guard.state,
	);
	return true;
}
export function beginWorkspaceReleaseInTransaction(
	tx: Database,
	guard: WorkspaceGuard,
): boolean {
	return (
		tx
			.query(
				"UPDATE kanban_workspace_guards SET state='releasing' WHERE workspace_ref=? AND owner_ref=? AND executor_id=? AND epoch=? AND state='held'",
			)
			.run(guard.workspaceRef, guard.ownerRef, guard.executorId, guard.epoch)
			.changes === 1
	);
}
export function markWorkspaceUnknownInTransaction(
	tx: Database,
	guard: WorkspaceGuard,
): boolean {
	return (
		tx
			.query(
				"UPDATE kanban_workspace_guards SET state='unknown' WHERE workspace_ref=? AND owner_ref=? AND executor_id=? AND epoch=? AND state='held'",
			)
			.run(guard.workspaceRef, guard.ownerRef, guard.executorId, guard.epoch)
			.changes === 1
	);
}
export function finishWorkspaceReleaseInTransaction(
	tx: Database,
	guard: WorkspaceGuard,
	confirmed: boolean,
): boolean {
	if (!confirmed) {
		tx.query(
			"UPDATE kanban_workspace_guards SET state='unknown' WHERE workspace_ref=? AND owner_ref=? AND executor_id=? AND epoch=? AND state='releasing'",
		).run(guard.workspaceRef, guard.ownerRef, guard.executorId, guard.epoch);
		return false;
	}
	return (
		tx
			.query(
				"DELETE FROM kanban_workspace_guards WHERE workspace_ref=? AND owner_ref=? AND executor_id=? AND epoch=? AND state='releasing'",
			)
			.run(guard.workspaceRef, guard.ownerRef, guard.executorId, guard.epoch)
			.changes === 1
	);
}
