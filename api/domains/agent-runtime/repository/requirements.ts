import type { Database } from "bun:sqlite";
export function deleteRequirementData(db: Database, rootRunId: string) {
	for (const table of [
		"agent_requirement_contracts",
		"agent_requirement_drafts",
	])
		db.query(
			`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?)`,
		).run(rootRunId);
}
