import type { Database } from "bun:sqlite";
import type { Migration } from "../../../infrastructure/sqlite";
import type { AcquisitionMode, Task, TaskDto } from "../contracts";
export const migration = `
CREATE TABLE agent_tasks(id TEXT PRIMARY KEY,kind TEXT NOT NULL,root_run_id TEXT NOT NULL,parent_task_id TEXT,package_revision_id TEXT,input_json TEXT,state TEXT NOT NULL,phase TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 0,cancel_epoch INTEGER NOT NULL DEFAULT 0,data_epoch INTEGER NOT NULL DEFAULT 0,report_state TEXT NOT NULL DEFAULT 'none',report_task_id TEXT,current_step INTEGER NOT NULL DEFAULT 0,deadline INTEGER NOT NULL,model_calls INTEGER NOT NULL DEFAULT 0,tool_calls INTEGER NOT NULL DEFAULT 0,json_repairs INTEGER NOT NULL DEFAULT 0,refinements INTEGER NOT NULL DEFAULT 0,job_id TEXT,invocation_id TEXT,error_code TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE UNIQUE INDEX agent_root_once ON agent_tasks(root_run_id) WHERE kind='coordinator';
CREATE TABLE agent_steps(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,ordinal INTEGER NOT NULL,state TEXT NOT NULL,job_id TEXT NOT NULL,inference_request_id TEXT,manifest_digest TEXT,action_kind TEXT,error_code TEXT,UNIQUE(task_id,ordinal));
CREATE TABLE agent_task_bindings(task_id TEXT NOT NULL,kind TEXT NOT NULL,revision_id TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(task_id,revision_id));
CREATE TABLE agent_reports(task_id TEXT PRIMARY KEY,report_json TEXT NOT NULL,report_digest TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE agent_events(id TEXT PRIMARY KEY,task_id TEXT NOT NULL,root_run_id TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,answer_job_id TEXT,created_at INTEGER NOT NULL,consumed_at INTEGER,UNIQUE(task_id,kind));
CREATE INDEX agent_waiting ON agent_tasks(state,deadline);
`;
/** Appended migration: acquisition-plan JSON, host/model step origin, safe projection storage. */
export const acquisitionMigration = `
ALTER TABLE agent_tasks ADD COLUMN acquisition_plan_json TEXT;
ALTER TABLE agent_tasks ADD COLUMN acquisition_binding_json TEXT;
ALTER TABLE agent_steps ADD COLUMN action_origin TEXT NOT NULL DEFAULT 'model';
ALTER TABLE agent_reports ADD COLUMN safe_projection_json TEXT;
ALTER TABLE agent_reports ADD COLUMN safe_projection_digest TEXT;
ALTER TABLE agent_reports ADD COLUMN acquisition_binding_json TEXT;
`;
export const actionResultMigration = `
CREATE TABLE agent_action_results (
  task_id TEXT PRIMARY KEY,
  invocation_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  receipt_digest TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;
export const get = (db: Database, id: string) =>
	db.query("SELECT * FROM agent_tasks WHERE id=?").get(id) as Task | null;
export const byRoot = (db: Database, id: string) =>
	db
		.query(
			"SELECT * FROM agent_tasks WHERE root_run_id=? AND kind='coordinator'",
		)
		.get(id) as Task | null;
function acquisitionMode(t: Task): AcquisitionMode | null {
	try {
		if (t.acquisition_binding_json) {
			const b = JSON.parse(t.acquisition_binding_json);
			// A site failure replaced the saved route with a fresh search on this child.
			if ((b.replacements ?? 0) >= 1) return "rediscover";
			const k = b.initialAction?.kind;
			return k === "host-lookup"
				? "search"
				: k === "candidate-import"
					? "candidate"
					: k === "direct-invoke"
						? "cached"
						: null;
		}
		if (t.acquisition_plan_json) {
			const k = JSON.parse(t.acquisition_plan_json).kind;
			return k === "search-first"
				? "search"
				: k === "candidate"
					? "candidate"
					: k === "direct"
						? "cached"
						: null;
		}
	} catch {
		return null;
	}
	return null;
}
export const dto = (t: Task): TaskDto => ({
	id: t.id,
	kind: t.kind,
	rootRunId: t.root_run_id,
	parentTaskId: t.parent_task_id,
	packageRevisionId: t.package_revision_id,
	status: t.state,
	phase: t.phase,
	modelCalls: t.model_calls,
	toolCalls: t.tool_calls,
	errorCode: t.error_code,
	createdAt: new Date(t.created_at).toISOString(),
	deadlineAt: new Date(t.deadline).toISOString(),
	reportState: t.report_state,
	acquisitionMode: acquisitionMode(t),
});
export function update(
	db: Database,
	t: Task,
	state: string,
	phase = state,
	errorCode: string | null = null,
) {
	if (
		db
			.query(
				"UPDATE agent_tasks SET state=?,phase=?,error_code=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?",
			)
			.run(state, phase, errorCode, Date.now(), t.id, t.revision).changes !== 1
	)
		throw new Error("task_changed");
	return get(db, t.id)!;
}

/** Named migrations of this domain; the SQL above is frozen once deployed. */
export const explorationMigration = `ALTER TABLE agent_tasks ADD COLUMN exploration_json TEXT;`;
export const requirementsMigration = `
CREATE TABLE agent_requirement_contracts(task_id TEXT PRIMARY KEY,version INTEGER NOT NULL,contract_json TEXT NOT NULL,contract_digest TEXT NOT NULL,created_at INTEGER NOT NULL);
CREATE TABLE agent_requirement_drafts(task_id TEXT PRIMARY KEY,contract_digest TEXT NOT NULL,draft_json TEXT NOT NULL,draft_digest TEXT NOT NULL,state TEXT NOT NULL,verification_json TEXT,verification_digest TEXT,created_at INTEGER NOT NULL);
`;
export const migrations: readonly Migration[] = [
	{ id: "agent-runtime/0001-init", sql: migration },
	{ id: "agent-runtime/0002-acquisition", sql: acquisitionMigration },
	{ id: "agent-runtime/0003-action-result", sql: actionResultMigration },
	{
		id: "agent-runtime/0004-exploration",
		sql: explorationMigration,
		after: ["agent-runtime/0003-action-result"],
	},
	{
		id: "agent-runtime/0005-requirements",
		sql: requirementsMigration,
		after: ["agent-runtime/0004-exploration"],
	},
];
