import type { Database } from "bun:sqlite";
import {
	SUMMARY_CHARS,
	activeTaskStates,
	errorLabel,
	type GrantProvenance,
	type OperationState,
	type OperationView,
	type TaskState,
	type TaskView,
	type TaskPhase,
	type ToolKind,
} from "../contracts";
import { originPath } from "../contracts/url";
import type { ScriptView } from "../contracts/script";
import { historyRow } from "./histories";
import { patchRow } from "./sql";

export type TaskRow = {
	phase: TaskPhase;
	id: string;
	script_required: number;
	script_json: string | null;
	continued_from: string | null;
	owner: string;
	conversation_id: string;
	origin: "conversation" | "screen" | "child" | "task";
	request_id: string;
	request: string;
	tab_ref: string | null;
	start_url: string | null;
	frozen_json: string | null;
	core_state_json: string | null;
	state: TaskState;
	epoch: number;
	step: number;
	deadline: number;
	result_text: string | null;
	error_code: string | null;
	announced: number;
	revision: number;
	created_at: number;
	updated_at: number;
};

export const taskRow = (db: Database, id: string) =>
	db.query("SELECT * FROM browser_tasks WHERE id=?").get(id) as TaskRow | null;
export const taskByRequest = (db: Database, requestId: string) =>
	db
		.query("SELECT * FROM browser_tasks WHERE request_id=?")
		.get(requestId) as TaskRow | null;
export function ownedTask(db: Database, id: string, owner: string) {
	const r = taskRow(db, id);
	if (!r || r.owner !== owner) throw new Error("browser_task_not_found");
	return r;
}

export function taskView(r: TaskRow): TaskView {
	return {
		taskId: r.id,
		phase: activeTaskStates.includes(r.state) ? r.phase : null,
		conversationId: r.conversation_id,
		continuedFrom: r.continued_from,
		script: r.script_json ? JSON.parse(r.script_json) : null,
		requestSummary: r.request.slice(0, SUMMARY_CHARS),
		state: r.state,
		...(r.result_text
			? { resultSummary: r.result_text.slice(0, SUMMARY_CHARS) }
			: {}),
		errorCode: r.error_code,
		errorLabel: errorLabel(r.error_code),
		tabRef: r.tab_ref,
		origin: r.origin,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		revision: r.revision,
	};
}

/** The history the task's last Script follows, when it still exists for the task's owner. */
export function taskHistory(db: Database, r: TaskRow) {
	const id = r.script_json
		? (JSON.parse(r.script_json) as ScriptView).historyId
		: undefined;
	const h = id ? historyRow(db, id) : null;
	return h && h.owner === r.owner
		? { historyId: h.id, title: h.title }
		: undefined;
}

/** The task as the screen reads it: its view, operations and followed history. */
export function taskDetail(db: Database, r: TaskRow) {
	const history = taskHistory(db, r);
	return {
		...taskView(r),
		...(history ? { history } : {}),
		operations: taskOperations(db, r.id),
	};
}

export function insertTask(
	db: Database,
	t: {
		id: string;
		owner: string;
		conversationId: string;
		origin: "conversation" | "screen" | "child" | "task";
		requestId: string;
		request: string;
		tabRef: string | null;
		startUrl: string | null;
		frozen: unknown;
		coreState: unknown;
		deadline: number;
	},
	now: number,
) {
	db.query(
		`INSERT INTO browser_tasks(id,owner,conversation_id,origin,request_id,request,tab_ref,start_url,frozen_json,
		 core_state_json,state,deadline,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		t.id,
		t.owner,
		t.conversationId,
		t.origin,
		t.requestId,
		t.request,
		t.tabRef,
		t.startUrl,
		t.frozen === undefined ? null : JSON.stringify(t.frozen),
		t.coreState === undefined ? null : JSON.stringify(t.coreState),
		"queued",
		t.deadline,
		now,
		now,
	);
}

type TaskChange = Partial<
	Pick<
		TaskRow,
		| "tab_ref"
		| "script_json"
		| "phase"
		| "core_state_json"
		| "state"
		| "epoch"
		| "step"
		| "result_text"
		| "error_code"
		| "announced"
	>
>;
export function patchTask(
	db: Database,
	id: string,
	change: TaskChange,
	now: number,
) {
	patchRow(db, "browser_tasks", "id", id, change, now);
	return taskRow(db, id)!;
}

export const listTasks = (
	db: Database,
	owner: string,
	limit = 20,
	conversationId?: string,
) =>
	(
		db
			.query(
				`SELECT * FROM browser_tasks WHERE owner=? ${conversationId === undefined ? "" : "AND conversation_id=?"} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
			)
			.all(
				owner,
				...(conversationId === undefined ? [] : [conversationId]),
				limit,
			) as TaskRow[]
	).map((r) => taskDetail(db, r));

export const activeTaskCount = (db: Database, owner: string) =>
	(
		db
			.query(
				`SELECT COUNT(*) AS n FROM browser_tasks WHERE owner=? AND state IN (${activeTaskStates.map(() => "?").join(",")})`,
			)
			.get(owner, ...activeTaskStates) as { n: number }
	).n;

export const dueTasks = (db: Database, now: number) =>
	db
		.query(
			"SELECT * FROM browser_tasks WHERE state IN ('queued','running') AND deadline<=?",
		)
		.all(now) as TaskRow[];

export const activeTasks = (db: Database) =>
	db
		.query("SELECT * FROM browser_tasks WHERE state IN ('queued','running')")
		.all() as TaskRow[];

export type OperationRow = {
	script_revision: number | null;
	script_step_id: string | null;
	id: string;
	task_id: string | null;
	tab_ref: string;
	tool_kind: ToolKind;
	input_digest: string;
	observation_ref: string | null;
	generation: number;
	state: OperationState;
	error_code: string | null;
	result_url: string | null;
	result_title: string | null;
	/** The Playwright code MCP reported for the operation (kept with the task, 7 days). */
	code: string | null;
	/** What the operation was given, as the history reads it (see `service/operation-detail.ts`). */
	detail_json: string | null;
	created_at: number;
	updated_at: number;
};

export const operationRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_operations WHERE id=?")
		.get(id) as OperationRow | null;

export function insertOperation(
	db: Database,
	o: {
		id: string;
		taskId: string | null;
		tabRef: string;
		toolKind: ToolKind;
		inputDigest: string;
		observationRef: string | null;
		generation: number;
		detail?: Record<string, unknown>;
	},
	now: number,
) {
	db.query(
		`INSERT INTO browser_operations(id,task_id,tab_ref,tool_kind,input_digest,observation_ref,generation,state,detail_json,created_at,updated_at)
		 VALUES(?,?,?,?,?,?,?,'prepared',?,?,?)`,
	).run(
		o.id,
		o.taskId,
		o.tabRef,
		o.toolKind,
		o.inputDigest,
		o.observationRef,
		o.generation,
		o.detail ? JSON.stringify(o.detail) : null,
		now,
		now,
	);
}

/** The operation needed the user's approval (declared or judged by the host): the history keeps that. */
export const markOperationCommit = (db: Database, id: string) =>
	db
		.query(
			"UPDATE browser_operations SET detail_json=json_set(COALESCE(detail_json,'{}'),'$.commit',json('true')) WHERE id=?",
		)
		.run(id);

/** Moves an operation forward only from the states in `from`; false when someone else already settled it. */
export function transitionOperation(
	db: Database,
	id: string,
	from: readonly OperationState[],
	to: OperationState,
	extra: {
		errorCode?: string | null;
		url?: string;
		title?: string;
		code?: string;
	},
	now: number,
) {
	const r = db
		.query(
			`UPDATE browser_operations SET state=?, error_code=?, result_url=COALESCE(?,result_url),
			 result_title=COALESCE(?,result_title), code=COALESCE(?,code), updated_at=?
			 WHERE id=? AND state IN (${from.map(() => "?").join(",")})`,
		)
		.run(
			to,
			extra.errorCode ?? null,
			extra.url === undefined ? null : originPath(extra.url),
			extra.title ?? null,
			extra.code ?? null,
			now,
			id,
			...from,
		);
	return r.changes > 0;
}

/** Operations a connection loss or restart leaves unresolved. */
export const inFlightOperations = (db: Database) =>
	db
		.query(
			"SELECT * FROM browser_operations WHERE state IN ('prepared','dispatched')",
		)
		.all() as OperationRow[];

export const taskOperations = (db: Database, taskId: string): OperationView[] =>
	(
		db
			.query(
				"SELECT * FROM browser_operations WHERE task_id=? ORDER BY created_at, rowid",
			)
			.all(taskId) as OperationRow[]
	).map((o, index) => ({
		sequence: index + 1,
		scriptRevision: o.script_revision,
		stepId: o.script_step_id,
		observedAt: o.updated_at,
		observationRef: o.observation_ref,
		errorLabel: errorLabel(o.error_code),
		operationId: o.id,
		toolKind: o.tool_kind,
		state: o.state,
		errorCode: o.error_code,
	}));

export const hasIndeterminateOperation = (db: Database, taskId: string) =>
	!!db
		.query(
			"SELECT 1 FROM browser_operations WHERE task_id=? AND state='indeterminate' LIMIT 1",
		)
		.get(taskId);

export type GrantRow = {
	id: string;
	task_id: string;
	origin: string;
	purpose: string;
	provenance: GrantProvenance;
	/** Null once the task has ended: a finished task keeps no typed value. */
	value: string | null;
	/** The Script variable the value was granted for. */
	variable: string | null;
	expires_at: number;
	used_count: number;
	revoked_at: number | null;
	created_at: number;
};

export const grantRow = (db: Database, id: string) =>
	db
		.query("SELECT * FROM browser_input_grants WHERE id=?")
		.get(id) as GrantRow | null;

export function insertGrant(
	db: Database,
	g: Omit<GrantRow, "used_count" | "revoked_at" | "created_at"> & {
		value: string;
	},
	now: number,
) {
	db.query(
		`INSERT INTO browser_input_grants(id,task_id,origin,purpose,provenance,value,variable,expires_at,created_at)
		 VALUES(?,?,?,?,?,?,?,?,?)`,
	).run(
		g.id,
		g.task_id,
		g.origin,
		g.purpose,
		g.provenance,
		g.value,
		g.variable,
		g.expires_at,
		now,
	);
}
export const useGrantRow = (db: Database, id: string) =>
	db
		.query("UPDATE browser_input_grants SET used_count=used_count+1 WHERE id=?")
		.run(id);
/** A finished task takes its grants with it, and the typed values are erased. */
export const revokeGrants = (db: Database, taskId: string, now: number) =>
	db
		.query(
			"UPDATE browser_input_grants SET revoked_at=COALESCE(revoked_at,?), value=NULL WHERE task_id=?",
		)
		.run(now, taskId);

/**
 * Deletes tasks that ended before `before` with their operations, grants and approvals, and the operations
 * that belonged to no task. Active tasks and anything younger stay.
 */
export function purgeEnded(db: Database, before: number) {
	const ended =
		"SELECT id FROM browser_tasks WHERE state NOT IN ('queued','running') AND updated_at<?";
	for (const table of [
		"browser_operations",
		"browser_input_grants",
		"browser_approvals",
	])
		db.query(`DELETE FROM ${table} WHERE task_id IN (${ended})`).run(before);
	db.query(
		"DELETE FROM browser_operations WHERE task_id IS NULL AND state NOT IN ('prepared','dispatched') AND updated_at<?",
	).run(before);
	db.query(
		"DELETE FROM browser_approvals WHERE status IN ('consumed','expired') AND updated_at<?",
	).run(before);
	db.query(
		"DELETE FROM browser_tasks WHERE state NOT IN ('queued','running') AND updated_at<?",
	).run(before);
	db.query(
		"DELETE FROM browser_replays WHERE state!='running' AND ended_at<?",
	).run(before);
}

export const tasksRevision = (db: Database) =>
	(
		db
			.query(
				"SELECT COALESCE(SUM(revision+1),0) AS n, COALESCE(MAX(updated_at),0) AS t FROM browser_tasks",
			)
			.get() as { n: number; t: number }
	).n;
