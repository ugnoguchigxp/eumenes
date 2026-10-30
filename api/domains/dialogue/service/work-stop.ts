import type { Database } from "bun:sqlite";
import { byId } from "../repository";
import type { WorkRow } from "../repository/work";
import type { DialogueDeps } from "./context";
import { endRun } from "./run-end";

/**
 * Stops the run a TODO waits on (the work tool's cancel and the TODO screen's archive): its sub-agents, its job and
 * the run itself, which ends the TODO as cancelled. The run `except` (the generation asking) is left running.
 * Returns the job to flush after commit, or null.
 */
export function stopWaitingRunInTransaction(
	deps: DialogueDeps,
	tx: Database,
	row: WorkRow,
	except?: string,
): string | null {
	const waiting = byId(tx, row.runId);
	if (
		!waiting ||
		(waiting.status !== "queued" && waiting.status !== "running") ||
		waiting.id === except
	)
		return null;
	deps.agents?.cancelTreeInTransaction(tx, waiting.id);
	if (waiting.jobId)
		deps.queue.cancelInTransaction(tx, waiting.jobId, "cancel_requested");
	endRun(deps, tx, waiting, "cancelled", "cancel_requested");
	return waiting.jobId ?? null;
}

/**
 * The user archived a TODO on the TODO screen (the TODO completion notice design, section 3.4): work still going is
 * stopped first, so no later result is taken, and the TODO is archived as cancelled, with no notice. A TODO already
 * archived stays as it is. Returns the TODO as it now is and the jobs to flush after commit.
 */
export function archiveByUserInTransaction(
	deps: DialogueDeps,
	tx: Database,
	todoId: string,
): { row: WorkRow; jobs: string[] } {
	const ledger = deps.work;
	const row = ledger?.workInTransaction(tx, todoId);
	if (!ledger || !row) throw new Error("work_not_found");
	if (row.archivedAt) return { row, jobs: [] };
	// Task and pipeline work runs as an execution of its own (the run that handed it over is not its to stop);
	// other work runs in the run that waits for it.
	const executions = deps.agents?.executions;
	let job: string | null = null;
	if (row.sourceRef && executions?.viewInTransaction(tx, row.sourceRef))
		executions.cancelByUserInTransaction(tx, row.conversationId, row.sourceRef);
	else job = stopWaitingRunInTransaction(deps, tx, row);
	ledger.reportInTransaction(tx, row.id, {
		status: "done",
		outcome: "cancelled",
		result: null,
	});
	return { row: ledger.workInTransaction(tx, row.id)!, jobs: job ? [job] : [] };
}

/**
 * What the screen does with the TODOs (the TODO completion notice design): the finished TODOs' notices
 * (`GET /api/todo-notices`, `POST /api/todo-notices/:id/read`) and the TODO screen's archive.
 */
export function createTodoScreenPorts(deps: DialogueDeps) {
	return {
		/** The finished TODOs' notices, newest first, with the unread count. */
		todoNotices: (limit: number) =>
			deps.store.readSnapshot(
				(db) =>
					deps.work?.noticesInTransaction(db, limit) ?? {
						notices: [],
						unread: 0,
					},
			),
		archiveTodoNotices: () =>
			deps.store.write((db) => deps.work?.archiveNoticesInTransaction(db) ?? 0),
		/** False when the TODO has no notice. */
		readTodoNotice: (todoId: string) =>
			deps.store.write(
				(db) => deps.work?.readNoticeInTransaction(db, todoId) ?? false,
			),
		/**
		 * The TODO screen's archive (its adapter's write, inside the action's transaction): work still going is stopped
		 * and the TODO archived as cancelled. The jobs it returns are flushed after commit (`flushTodoCancellations`).
		 */
		archiveTodoInTransaction: (db: Database, todoId: string) =>
			archiveByUserInTransaction(deps, db, todoId),
		/** Aborts the stopped jobs once the archive committed. */
		flushTodoCancellations: (jobs: readonly string[]) => {
			if (jobs.length) deps.queue.flushCancellations([...jobs]);
		},
	};
}
