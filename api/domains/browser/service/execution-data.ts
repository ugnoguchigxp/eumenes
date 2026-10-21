import type { Database } from "bun:sqlite";
/** Remove delegated source copies after the owning execution is forgotten. */
export function purgeTaskExecution(
	db: Database,
	executionId: string,
	cancel: (db: Database, owner: string, id: string) => unknown,
) {
	const rows = db
		.query(
			"SELECT id,owner FROM browser_tasks WHERE origin='task' AND json_extract(frozen_json,'$.execution.executionId')=?",
		)
		.all(executionId) as { id: string; owner: string }[];
	for (const row of rows) {
		cancel(db, row.owner, row.id);
		db.query(
			"UPDATE browser_tasks SET request='',frozen_json=NULL,core_state_json=NULL,script_json=NULL,result_text=NULL WHERE id=?",
		).run(row.id);
	}
}
