import type { Database } from "bun:sqlite";

export type WorkspaceGuard = {
	workspaceRef: string;
	ownerRef: string;
	executorId: string;
	epoch: string;
	state: "held" | "releasing" | "unknown";
	mode?: WorkspaceGuardMode;
};
export type WorkspaceGuardMode = "read" | "edit" | "exclusive";
type Holder = Pick<WorkspaceGuard, "ownerRef" | "executorId"> & {
	epoch?: string;
};

export function readWorkspaceGuards(tx: Database, workspaceRef: string) {
	return tx
		.query<WorkspaceGuard & { mode: WorkspaceGuardMode }, [string]>(
			`SELECT workspace_ref AS workspaceRef,owner_ref AS ownerRef,executor_id AS executorId,epoch,state,mode
			 FROM kanban_workspace_guards WHERE workspace_ref=?
			 ORDER BY CASE state WHEN 'unknown' THEN 0 WHEN 'releasing' THEN 1 ELSE 2 END, mode`,
		)
		.all(workspaceRef);
}

export function readWorkspaceGuard(
	tx: Database,
	workspaceRef: string,
	holder?: Holder,
): WorkspaceGuard | null {
	const current = readWorkspaceGuards(tx, workspaceRef).find(
		(guard) =>
			!holder ||
			(guard.ownerRef === holder.ownerRef &&
				guard.executorId === holder.executorId &&
				(holder.epoch === undefined || guard.epoch === holder.epoch)),
	);
	if (!holder && current?.mode === "exclusive") {
		const { mode: _mode, ...legacy } = current;
		return legacy;
	}
	return current ?? null;
}
/** Host resolves equivalent cwd paths to one registered workspaceRef before this call. */
export function reserveWorkspaceInTransaction(
	tx: Database,
	guard: WorkspaceGuard,
): boolean {
	const mode = guard.mode ?? "exclusive";
	if (guard.state !== "held" && mode !== "exclusive") return false;
	const holders = readWorkspaceGuards(tx, guard.workspaceRef);
	const current = holders.find(
		(entry) =>
			entry.ownerRef === guard.ownerRef &&
			entry.executorId === guard.executorId,
	);
	if (current)
		return (
			guard.state === "held" &&
			current.epoch === guard.epoch &&
			current.mode === mode &&
			current.state === "held"
		);
	if (
		holders.some(
			(holder) =>
				holder.state !== "held" ||
				holder.mode === "exclusive" ||
				mode === "exclusive" ||
				holder.mode === mode,
		)
	)
		return false;
	tx.query(
		"INSERT INTO kanban_workspace_guards(workspace_ref,owner_ref,executor_id,epoch,state,mode) VALUES(?,?,?,?,?,?)",
	).run(
		guard.workspaceRef,
		guard.ownerRef,
		guard.executorId,
		guard.epoch,
		guard.state,
		mode,
	);
	return true;
}
/** The caller must first confirm the same runner receipt stopped. */
export function recoverWorkspaceReleaseInTransaction(
	tx: Database,
	guard: WorkspaceGuard,
) {
	return (
		tx
			.query(
				"DELETE FROM kanban_workspace_guards WHERE workspace_ref=? AND owner_ref=? AND executor_id=? AND epoch=? AND state='unknown'",
			)
			.run(guard.workspaceRef, guard.ownerRef, guard.executorId, guard.epoch)
			.changes === 1
	);
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
