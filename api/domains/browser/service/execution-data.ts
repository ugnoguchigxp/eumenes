import type { Database } from "bun:sqlite";
import { taskRow, type TaskRow } from "../repository";

export function isCollaborationTaskInTransaction(
	db: Database,
	id: string,
	conversationId: string,
	sessionId: string,
) {
	const row = taskRow(db, id);
	if (row?.origin !== "child" || row.conversation_id !== conversationId)
		return false;
	const caller = JSON.parse(row.frozen_json ?? "{}").caller;
	return (
		caller?.kind === "collaboration" &&
		caller.source?.specialistSessionId === sessionId
	);
}

/** A delegated execution's view of its task: the status plus the calls made, the result text and the deadline. */
export function taskExecutionResult<V extends object>(view: V, row: TaskRow) {
	const core = JSON.parse(row.core_state_json ?? "{}");
	return {
		...view,
		callsMade: core.callsMade ?? core.core?.callsMade ?? 0,
		result: row.result_text,
		deadline: row.deadline,
		...(core.ended === true && "lastTabRef" in core
			? { lastTabRef: core.lastTabRef as string | null }
			: {}),
		...(core.ended === true && typeof core.excerpt === "string"
			? { excerpt: core.excerpt as string }
			: {}),
	};
}

/** Remove delegated source copies after the owning execution is forgotten. */
export function purgeTaskExecution(
	db: Database,
	executionId: string,
	cancel: (db: Database, owner: string, id: string) => unknown,
) {
	const rows = db
		.query(
			`SELECT id,owner FROM browser_tasks
			 WHERE (origin='task' AND json_extract(frozen_json,'$.execution.executionId')=?)
			    OR (origin='child' AND json_extract(frozen_json,'$.caller.kind')='collaboration'
			        AND json_extract(frozen_json,'$.caller.workRef')=?)`,
		)
		.all(executionId, executionId) as { id: string; owner: string }[];
	for (const row of rows) {
		cancel(db, row.owner, row.id);
		db.query(
			"UPDATE browser_tasks SET request='',frozen_json=NULL,core_state_json=NULL,script_json=NULL,result_text=NULL WHERE id=?",
		).run(row.id);
	}
}
