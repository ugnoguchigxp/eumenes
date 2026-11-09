import type { Database } from "bun:sqlite";
import { canonicalJson } from "../../../infrastructure/digest";
import { workflowRunInTransaction } from "./workflow-runs";

export function activeWorkflowRunsInTransaction(db: Database) {
	return db
		.query<{ id: string; scope: string }, []>(
			"SELECT id,scope FROM workflow_runs WHERE state IN ('accepted','running','publishing') ORDER BY rowid",
		)
		.all();
}

export function latestWorkflowRunInTransaction(
	db: Database,
	scope: string,
	workflowId: string,
	revision: number,
	completedInputs?: Record<string, unknown>,
) {
	const inputs = completedInputs
		? canonicalJson(completedInputs, {
				omitUndefined: true,
				keyOrder: "codeUnit",
			})
		: null;
	const row = db
		.query<
			{ id: string },
			[string, string, number, string | null, string | null]
		>(
			`SELECT id FROM workflow_runs WHERE scope=? AND workflow_id=? AND definition_revision=?
			 AND (? IS NULL OR (state='completed' AND inputs_json=?)) ORDER BY rowid DESC LIMIT 1`,
		)
		.get(scope, workflowId, revision, inputs, inputs);
	return row ? workflowRunInTransaction(db, scope, row.id) : null;
}

export function setWorkflowJobInTransaction(
	db: Database,
	scope: string,
	runId: string,
	version: number,
	jobId: string,
) {
	return (
		db.run(
			"UPDATE workflow_runs SET job_id=?,version=version+1 WHERE scope=? AND id=? AND version=? AND state IN ('accepted','running','publishing')",
			[jobId, scope, runId, version],
		).changes === 1
	);
}

export function stageWorkflowPublicationInTransaction(
	db: Database,
	scope: string,
	runId: string,
	version: number,
	publication: unknown,
) {
	return (
		db.run(
			"UPDATE workflow_runs SET state='publishing',publication_json=?,version=version+1 WHERE scope=? AND id=? AND version=? AND state='running'",
			[JSON.stringify(publication), scope, runId, version],
		).changes === 1
	);
}

export function workflowScheduleInTransaction(
	db: Database,
	scope: string,
	workflowId: string,
	scheduleId?: string,
) {
	return db
		.query<
			{ schedule_id: string; definition_revision: number },
			[string, string, string | null]
		>(
			"SELECT schedule_id,definition_revision FROM workflow_schedules WHERE scope=? AND workflow_id=? AND active=1 AND schedule_id=COALESCE(?,schedule_id)",
		)
		.get(scope, workflowId, scheduleId ?? null);
}

export function linkWorkflowScheduleInTransaction(
	db: Database,
	scope: string,
	workflowId: string,
	revision: number,
	scheduleId: string,
) {
	db.run("INSERT INTO workflow_schedules VALUES(?,?,?,?,1)", [
		scope,
		workflowId,
		revision,
		scheduleId,
	]);
}

export function unlinkWorkflowScheduleInTransaction(
	db: Database,
	scope: string,
	workflowId: string,
	scheduleId: string,
) {
	db.run(
		"UPDATE workflow_schedules SET active=0 WHERE scope=? AND workflow_id=? AND schedule_id=?",
		[scope, workflowId, scheduleId],
	);
}

type Owner = { scope: string; workflowId: string; compatibility: string };
type Candidate = { key: string; previous: string | null; current: string };

export function workflowCheckpointsInTransaction(db: Database, owner: Owner) {
	const rows = db
		.query<{ unit_key: string; value: string }, [string, string, string]>(
			"SELECT unit_key,value FROM workflow_checkpoints WHERE scope=? AND workflow_id=? AND compatibility=?",
		)
		.all(owner.scope, owner.workflowId, owner.compatibility);
	return Object.fromEntries(rows.map((row) => [row.unit_key, row.value]));
}

export function adoptWorkflowCheckpointsInTransaction(
	db: Database,
	owner: Owner,
	candidates: Candidate[],
) {
	const current = workflowCheckpointsInTransaction(db, owner);
	if (
		new Set(candidates.map(({ key }) => key)).size !== candidates.length ||
		candidates.some(({ key, previous }) => (current[key] ?? null) !== previous)
	)
		return false;
	for (const item of candidates)
		db.run(
			"INSERT INTO workflow_checkpoints VALUES(?,?,?,?,?) ON CONFLICT(scope,workflow_id,compatibility,unit_key) DO UPDATE SET value=excluded.value",
			[
				owner.scope,
				owner.workflowId,
				owner.compatibility,
				item.key,
				item.current,
			],
		);
	return true;
}

export function markWorkflowPublicationCheckInTransaction(
	db: Database,
	scope: string,
	runId: string,
	version: number,
	checked: boolean,
) {
	return (
		db.run(
			"UPDATE workflow_runs SET publication_json=json_set(publication_json,'$.checked',?),result_json=? WHERE scope=? AND id=? AND version=? AND state='publishing'",
			[
				checked ? 1 : 0,
				JSON.stringify({ code: "workflow_markdown_needs_confirmation" }),
				scope,
				runId,
				version,
			],
		).changes === 1
	);
}
