import type { Database } from "bun:sqlite";
import type {
	ChildExecution,
	ChildResult,
	ExecutionReference,
	ExecutionResult,
	ExecutionSource,
	ExecutionStatus,
	ExecutionView,
} from "../../tool-runtime";
import type { PipelineDefinition } from "../../capabilities";
import type { StepValues } from "../../pipelines";

export const taskExecutionMigration = `
CREATE TABLE agent_executions (
 id TEXT PRIMARY KEY, start_key TEXT NOT NULL UNIQUE, input_digest TEXT NOT NULL,
 conversation_id TEXT NOT NULL, source_json TEXT, request TEXT NOT NULL, request_revision INTEGER NOT NULL DEFAULT 0,
 epoch INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, state_json TEXT NOT NULL, deadline INTEGER NOT NULL,
 result_json TEXT, job_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX agent_executions_active ON agent_executions(state,deadline);
CREATE TABLE agent_execution_steps (
 id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, request_revision INTEGER NOT NULL, ordinal INTEGER NOT NULL,
 input_digest TEXT NOT NULL, input_json TEXT, result_json TEXT, state TEXT NOT NULL,
 UNIQUE(execution_id,request_revision,ordinal)
);
CREATE TABLE agent_execution_refs (execution_id TEXT NOT NULL, ref TEXT NOT NULL, reference_json TEXT NOT NULL, PRIMARY KEY(execution_id,ref));
CREATE TABLE agent_execution_questions (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, request_revision INTEGER NOT NULL, prompt TEXT, answer_json TEXT, state TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TABLE agent_execution_events (id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', UNIQUE(execution_id,kind));
`;
export type ParentState = {
	version: 1;
	bindingRevisionId: string;
	instructions: string;
	calls: number;
	consumed: number;
	searches: number;
	children: number;
	ordinal: number;
	questions: number;
	selecting: boolean;
	offered: string[];
	retained: string[];
	refs: ExecutionReference[];
	notes: Array<{
		id: string;
		state: string;
		summary: string;
		refs: string[];
		/** Resource URIs the child made (`ChildResult.links`). */
		links?: string[];
		question?: string;
		read?: { ref: string; start: number; limit: number };
	}>;
	pending: {
		child: ChildExecution;
		result: ChildResult | null;
		allocation: number;
	} | null;
	question: {
		id: string;
		prompt: string;
		expiresAt: number;
		inputSchema: Record<string, unknown>;
	} | null;
	limits: {
		parentCalls: number;
		childCalls: number;
		searches: number;
		modelCalls: number;
	};
	correction?: string;
	amending?: boolean;
	activeRequestId?: string;
	planRequired?: boolean;
	/**
	 * A task pipeline's run (spec task-pipeline-design 2026-10-22 §13.4): the host takes the steps in order, so no
	 * parent decision is asked. `values` holds each finished step's result; `children` its child's id.
	 */
	pipeline?: {
		toolchainRevisionId: string;
		definition: Omit<PipelineDefinition, "tests">;
		inputs: Record<string, unknown>;
		values: Record<string, StepValues>;
		cursor: number;
		children: Record<string, string>;
		/** The structural repair an extract step's next attempt carries. */
		correction?: string;
	};
	plan?: {
		revision: number;
		requestRevision: number;
		observedAt: number;
		goal: string;
		report: string;
		items: ExecutionPlanItem[];
	};
};
export type ExecutionPlanItem = {
	stepRef: string;
	request: string;
	check: string;
	dependsOn: string[];
	childId: string;
	inputDigest?: string;
	resultRef?: string;
	resultState?: ChildResult["state"];
};
export type ExecutionRow = {
	id: string;
	start_key: string;
	input_digest: string;
	conversation_id: string;
	source_json: string | null;
	request: string;
	request_revision: number;
	epoch: number;
	state: ExecutionStatus;
	state_json: string;
	deadline: number;
	result_json: string | null;
	job_id: string | null;
	created_at: number;
	updated_at: number;
};
export const executionRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM agent_executions WHERE id=?")
		.get(id) as ExecutionRow | null;
export const executionObservations = (db: Database, id: string) =>
	(
		db
			.query(
				"SELECT input_json,result_json FROM agent_execution_steps WHERE execution_id=? AND input_json IS NOT NULL ORDER BY ordinal",
			)
			.all(id) as { input_json: string; result_json: string | null }[]
	).map((step) => ({
		child: JSON.parse(step.input_json) as ChildExecution,
		result: step.result_json
			? (JSON.parse(step.result_json) as ChildResult)
			: null,
	}));
export function executionObservation(db: Database, id: string) {
	const step = db
		.query(
			"SELECT input_json,result_json FROM agent_execution_steps WHERE id=?",
		)
		.get(id) as {
		input_json: string | null;
		result_json: string | null;
	} | null;
	if (!step?.input_json) throw new Error("execution_child_missing");
	return {
		child: JSON.parse(step.input_json) as ChildExecution,
		result: step.result_json
			? (JSON.parse(step.result_json) as ChildResult)
			: null,
	};
}
export const executionSource = (row: ExecutionRow): ExecutionSource => {
	if (!row.source_json) throw new Error("execution_source_expired");
	return JSON.parse(row.source_json);
};
export const executionState = (row: ExecutionRow): ParentState => {
	const state = JSON.parse(row.state_json) as ParentState;
	if (state.version !== 1) throw new Error("execution_version_unsupported");
	return state;
};
export const isExecutionActive = (row: ExecutionRow) =>
	["queued", "deciding", "waiting_child", "waiting_user"].includes(row.state);
export function saveExecution(
	db: Database,
	row: ExecutionRow,
	state: ParentState,
	now: number,
) {
	const text = JSON.stringify(state);
	if (new TextEncoder().encode(text).length > 65_536)
		throw new Error("execution_state_capacity");
	db.query(
		"UPDATE agent_executions SET state_json=?,state=?,request=?,request_revision=?,epoch=?,result_json=?,job_id=?,updated_at=? WHERE id=?",
	).run(
		text,
		row.state,
		row.request,
		row.request_revision,
		row.epoch,
		row.result_json,
		row.job_id,
		now,
		row.id,
	);
}
export const executionView = (row: ExecutionRow): ExecutionView => ({
	id: row.id,
	conversationId: row.conversation_id,
	request: row.request,
	revision: row.request_revision,
	status: row.state,
	deadline: row.deadline,
	question: executionState(row).question,
	result: row.result_json
		? (JSON.parse(row.result_json) as ExecutionResult)
		: null,
	...(executionState(row).pipeline ? { pipeline: true as const } : {}),
});
/** Erase bodies while preserving the start key as a replay tombstone. */
export function eraseExecutionBodies(
	db: Database,
	row: ExecutionRow,
	now: number,
) {
	const state = executionState(row);
	state.instructions = "";
	state.refs = [];
	state.notes = [];
	state.pending = null;
	state.question = null;
	state.offered = [];
	state.retained = [];
	state.plan = undefined;
	state.planRequired = undefined;
	row.request = "";
	row.source_json = null;
	row.result_json = JSON.stringify({
		status: row.state,
		summary: "execution_data_expired",
		fulfilled: [],
		missing: [],
		refs: [],
		code: "execution_data_expired",
	});
	db.query("UPDATE agent_executions SET source_json=NULL WHERE id=?").run(
		row.id,
	);
	db.query(
		"UPDATE agent_execution_steps SET input_json=NULL,result_json=NULL WHERE execution_id=?",
	).run(row.id);
	db.query(
		"UPDATE agent_execution_questions SET prompt=NULL,answer_json=NULL WHERE execution_id=?",
	).run(row.id);
	db.query("DELETE FROM agent_execution_refs WHERE execution_id=?").run(row.id);
	db.query(
		"UPDATE agent_execution_events SET state='cancelled' WHERE execution_id=? AND state IN ('pending','accepted')",
	).run(row.id);
	saveExecution(db, row, state, now);
}
