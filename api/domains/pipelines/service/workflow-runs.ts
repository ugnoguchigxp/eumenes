import type { Database } from "bun:sqlite";
import { z } from "zod";
import { canonicalJson, sha256Hex } from "../../../infrastructure/digest";
import { workflowInputs } from "./workflow-definition";
import { workflowRevisionInTransaction } from "./workflow-save";

const id = z.string().min(1).max(160);
const request = z.strictObject({
	scope: id,
	workflowId: id,
	revision: z.number().int().positive(),
	origin: z.discriminatedUnion("kind", [
		z.strictObject({ kind: z.literal("manual"), operationId: z.uuid() }),
		z.strictObject({
			kind: z.literal("schedule"),
			operationId: id,
			scheduledAt: z.number().int().nonnegative(),
		}),
	]),
	inputs: z.record(z.string(), z.json()),
});

type RunRow = {
	id: string;
	scope: string;
	workflow_id: string;
	definition_revision: number;
	input_digest: string;
	inputs_json: string;
	state:
		| "accepted"
		| "running"
		| "publishing"
		| "completed"
		| "failed"
		| "cancelled"
		| "expired";
	deadline: number;
	scheduled_at: number | null;
	parent_id: string | null;
	job_id: string | null;
	result_json: string | null;
	publication_json: string | null;
	version: number;
};
type Saved = NonNullable<ReturnType<typeof workflowRevisionInTransaction>>;
type Admit = z.infer<typeof request>;

const byId = (db: Database, scope: string, runId: string) =>
	db
		.query<RunRow, [string, string]>(
			"SELECT * FROM workflow_runs WHERE scope=? AND id=?",
		)
		.get(scope, runId);

export function activeCheckpointWorkflowInTransaction(
	db: Database,
	scope: string,
	workflowId: string,
) {
	return activeWorkflow(db, scope, workflowId, "checkpoint");
}

function activeWorkflow(
	db: Database,
	scope: string,
	workflowId: string,
	lockKey: string,
) {
	return (
		db
			.query<{ id: string }, [string, string, string]>(
				"SELECT id FROM workflow_runs WHERE scope=? AND workflow_id=? AND lock_key=?",
			)
			.get(scope, workflowId, lockKey)?.id ?? null
	);
}

export function admitWorkflowInTransaction(
	db: Database,
	raw: unknown,
	ports: {
		nowMs: number;
		deadlineMs: number;
		schema(ref: string): z.ZodType | null;
		authorized(input: Admit, saved: Saved): boolean;
		enqueue(run: { runId: string; scope: string }): string;
	},
) {
	const input = request.parse(raw);
	const { scope, workflowId, origin } = input;
	const saved = workflowRevisionInTransaction(
		db,
		scope,
		workflowId,
		input.revision,
	);
	if (
		!saved?.value.grant ||
		!ports.authorized(input, saved) ||
		(origin.kind === "schedule" &&
			saved.value.definition.trigger !== "schedule")
	)
		throw new Error("workflow_run_forbidden");
	const declaredInput = saved.value.definition.input;
	const schema = ports.schema(declaredInput.schemaRef);
	if (!schema) throw new Error("workflow_schema_unavailable");
	const inputs = workflowInputs(schema, declaredInput.fixed, input.inputs);
	const inputsJson = canonicalJson(inputs, {
		omitUndefined: true,
		keyOrder: "codeUnit",
	});
	const inputDigest = sha256Hex(
		JSON.stringify([
			workflowId,
			saved.revision,
			saved.digest,
			origin,
			inputsJson,
		]),
	);
	const prior = db
		.query<RunRow, [string, string, string]>(
			"SELECT * FROM workflow_runs WHERE scope=? AND origin=? AND operation_id=?",
		)
		.get(scope, origin.kind, origin.operationId);
	if (prior) {
		if (prior.input_digest !== inputDigest) throw new Error("request_conflict");
		if (!prior.job_id) throw new Error("workflow_progress_job_missing");
		return { runId: prior.id, jobId: prior.job_id, fresh: false };
	}
	const lockKey = saved.value.definition.checkpoint
		? "checkpoint"
		: `input:${sha256Hex(JSON.stringify([saved.revision, inputsJson]))}`;
	const active = activeWorkflow(db, scope, workflowId, lockKey);
	if (active) return { runId: active, jobId: null, fresh: false };
	if (
		!Number.isSafeInteger(ports.deadlineMs) ||
		ports.deadlineMs <= ports.nowMs
	)
		throw new Error("workflow_deadline_invalid");
	const runId = crypto.randomUUID();
	db.query(
		`INSERT INTO workflow_runs(id,scope,workflow_id,definition_revision,origin,operation_id,input_digest,inputs_json,state,lock_key,deadline,scheduled_at,version)
		VALUES(?,?,?,?,?,?,?,?,'accepted',?,?,?,1)`,
	).run(
		runId,
		scope,
		workflowId,
		saved.revision,
		origin.kind,
		origin.operationId,
		inputDigest,
		inputsJson,
		lockKey,
		ports.deadlineMs,
		origin.kind === "schedule" ? origin.scheduledAt : null,
	);
	const jobId = ports.enqueue({ runId, scope });
	db.query("UPDATE workflow_runs SET job_id=? WHERE id=?").run(jobId, runId);
	return { runId, jobId, fresh: true };
}

export function workflowRunInTransaction(
	db: Database,
	scope: string,
	runId: string,
) {
	const row = byId(db, scope, runId);
	if (!row) return null;
	return {
		runId: row.id,
		scope: row.scope,
		workflowId: row.workflow_id,
		revision: row.definition_revision,
		inputDigest: row.input_digest,
		state: row.state,
		deadlineMs: row.deadline,
		scheduledAtMs: row.scheduled_at,
		inputs: JSON.parse(row.inputs_json) as Admit["inputs"],
		parentId: row.parent_id,
		jobId: row.job_id,
		result:
			row.result_json === null
				? null
				: (JSON.parse(row.result_json) as unknown),
		publication:
			row.publication_json === null
				? null
				: (JSON.parse(row.publication_json) as unknown),
		version: row.version,
	};
}

export function recordWorkflowParentInTransaction(
	db: Database,
	scope: string,
	runId: string,
	parentId: string,
	version: number,
) {
	return (
		db
			.query(
				"UPDATE workflow_runs SET parent_id=?,state='running',version=version+1 WHERE scope=? AND id=? AND state='accepted' AND version=?",
			)
			.run(parentId, scope, runId, version).changes === 1
	);
}

export function finishWorkflowInTransaction(
	db: Database,
	scope: string,
	runId: string,
	state: "completed" | "failed" | "cancelled" | "expired",
	version: number,
	result?: unknown,
) {
	return (
		db
			.query(
				"UPDATE workflow_runs SET result_json=?,state=?,lock_key=NULL,version=version+1 WHERE scope=? AND id=? AND state IN ('accepted','running','publishing') AND (state!='accepted' OR ?!='completed') AND version=?",
			)
			.run(
				result === undefined ? null : JSON.stringify(result),
				state,
				scope,
				runId,
				state,
				version,
			).changes === 1
	);
}
