import type { Database } from "bun:sqlite";
import type { Task } from "../contracts";
import { get, update, hasExecutionScope } from "../repository";
import { stepDeadline } from "./exploration";
import { safeCode } from "./control-output";
import {
	STEP_KIND,
	active,
	owner,
	type RuntimeContext,
} from "./runtime-context";

/** Upper bound of one operation result handed to the answer. */
const MAX_ACTION_CONTEXT_BYTES = 32_768;

function actionInvocation(db: Database, taskId: string) {
	const table = db
		.query(
			"SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='agent_action_results'",
		)
		.get() as { ok: number } | null;
	if (!table) return null;
	const row = db
		.query("SELECT invocation_id FROM agent_action_results WHERE task_id=?")
		.get(taskId) as { invocation_id: string } | null;
	return row?.invocation_id ?? null;
}
export function createTaskOps(ctx: RuntimeContext) {
	const { tools, inference, queue, now } = ctx.deps;
	const { traceIds, abortJobs, abortRequests, releases } = ctx.state;
	/** The adapter's short projection of a saved operation, or the refusal of one that failed. */
	function currentActionPayload(db: Database, task: Task) {
		const invocation = actionInvocation(db, task.id);
		if (!invocation) {
			if (
				JSON.parse(task.input_json ?? "{}").actionRequested &&
				task.error_code
			)
				return JSON.stringify({
					version: 1,
					kind: "action_result",
					action: "failed",
					observedAt: new Date(now()).toISOString(),
					errorCode: task.error_code,
				});
			return null;
		}
		const envelope = tools.readActionInTransaction(db, owner(task), invocation);
		const context = envelope.answerContext;
		const json =
			context && typeof context === "object" && !Array.isArray(context)
				? JSON.stringify(context)
				: null;
		// The adapter's projection is the only thing the answer sees; it must be a bounded object.
		if (
			!json ||
			new TextEncoder().encode(json).length > MAX_ACTION_CONTEXT_BYTES
		)
			throw new Error("invalid_action_result");
		return json;
	}
	function enqueue(db: Database, t: Task, parentJobId?: string) {
		traceIds.add(t.id);
		const ordinal = t.current_step + 1,
			stepId = crypto.randomUUID();
		const { job } = queue.enqueueInTransaction(db, {
			scope: "agent",
			kind: STEP_KIND,
			dedupeKey: stepId,
			payload: { taskId: t.id, stepId },
			subjectRef: t.id,
			parentJobId,
			lane: "background",
			resourceKey: "inference.llm",
			concurrencyKey: `agent:${t.id}`,
			maxAttempts: 1,
			deadlineAtMs: stepDeadline(t, now(), ctx.state.prepared.get(t.id)),
		});
		db.query(
			"INSERT INTO agent_steps(id,task_id,ordinal,state,job_id) VALUES(?,?,?,'queued',?)",
		).run(stepId, t.id, ordinal, job.id);
		db.query("UPDATE agent_tasks SET current_step=?,job_id=? WHERE id=?").run(
			ordinal,
			job.id,
			t.id,
		);
		return job.id;
	}
	function insertTask(
		db: Database,
		kind: Task["kind"],
		rootRunId: string,
		input: unknown,
		deadline: number,
		parentTaskId: string | null = null,
	) {
		const id = crypto.randomUUID();
		const execution = (
			input as { execution?: { id: string; dispatchId?: string } }
		).execution;
		const scoped = hasExecutionScope(db);
		if (execution && !scoped) throw new Error("execution_schema_unavailable");
		db.query(
			`INSERT INTO agent_tasks(id,kind,root_run_id,parent_task_id,input_json,state,phase,deadline,created_at,updated_at${scoped ? ",execution_call_id" : ""}) VALUES(?,?,?,?,?,'queued',?,?,?,?${scoped ? ",?" : ""})`,
		).run(
			id,
			kind,
			rootRunId,
			parentTaskId,
			JSON.stringify(input),
			kind === "coordinator" ? "created" : "research",
			deadline,
			now(),
			now(),
			...(scoped
				? [execution ? (execution.dispatchId ?? execution.id) : null]
				: []),
		);
		return get(db, id)!;
	}
	function ready(
		db: Database,
		t: Task,
		reason: string | null = null,
		reportTaskId: string | null = null,
	) {
		const current = get(db, t.id);
		if (!active(current) || current.state === "ready_for_answer") return;
		update(db, current, "ready_for_answer", "answer", reason);
		db.query(
			"UPDATE agent_tasks SET report_task_id=?,report_state=? WHERE id=?",
		).run(reportTaskId, reportTaskId ? "available" : "none", t.id);
		db.query(
			"INSERT OR IGNORE INTO agent_events(id,task_id,root_run_id,kind,state,created_at) VALUES(?,?,?,'ready','pending',?)",
		).run(crypto.randomUUID(), t.id, t.root_run_id, now());
	}
	function fail(db: Database, t: Task, code: string) {
		const current = get(db, t.id);
		if (!active(current)) return;
		endSteps(db, t.id, "failed", code);
		if (t.kind === "worker") {
			update(db, current, "failed", "failed", code);
			const parent = current.parent_task_id
				? get(db, current.parent_task_id)
				: null;
			if (active(parent)) ready(db, parent, code);
		} else if (current.deadline <= now())
			update(db, current, "failed", "failed", code);
		else ready(db, current, code);
	}
	function endSteps(db: Database, taskId: string, state: string, code: string) {
		db.query(
			"UPDATE agent_steps SET state=?,error_code=? WHERE task_id=? AND state IN ('queued','running')",
		).run(state, code, taskId);
	}
	function next(
		db: Database,
		t: Task,
		parentJobId?: string,
		repairCode: string | null = null,
	) {
		db.exec("SAVEPOINT agent_next");
		try {
			const current = update(db, t, "queued", t.phase, repairCode);
			enqueue(db, current, parentJobId);
			db.exec("RELEASE agent_next");
		} catch (e) {
			db.exec("ROLLBACK TO agent_next");
			db.exec("RELEASE agent_next");
			fail(db, get(db, t.id)!, safeCode(e));
		}
	}
	function waitForTools(db: Database, t: Task, parentJobId?: string) {
		const calls = tools
			.invocationsInTransaction(db, t.id)
			.filter((i) => !i.superseded);
		if (calls.some((i) => i.state === "pending"))
			update(db, get(db, t.id)!, "waiting_tool", t.phase);
		else next(db, get(db, t.id)!, parentJobId, "research_no_progress");
	}
	function cancelTreeInTransaction(
		db: Database,
		rootRunId: string,
		reason = "cancel_requested",
		state = "cancelled",
		rootTaskId?: string,
	) {
		const jobs = new Set<string>();
		const requests = new Set<string>();
		const rows = db
			.query(
				rootTaskId
					? "SELECT * FROM agent_tasks WHERE id=? OR parent_task_id=? ORDER BY kind"
					: "SELECT * FROM agent_tasks WHERE root_run_id=? ORDER BY kind",
			)
			.all(...(rootTaskId ? [rootTaskId, rootTaskId] : [rootRunId])) as Task[];
		for (const t of rows) {
			traceIds.add(t.id);
			// Mark the task before queue callbacks, which may re-enter cancellation.
			if (active(t)) update(db, t, state, state, reason);
			endSteps(db, t.id, state, reason);
			db.query(
				"UPDATE agent_tasks SET cancel_epoch=cancel_epoch+1 WHERE id=?",
			).run(t.id);
			const steps = db
				.query(
					"SELECT job_id,inference_request_id FROM agent_steps WHERE task_id=?",
				)
				.all(t.id) as { job_id: string; inference_request_id: string | null }[];
			for (const step of steps) {
				jobs.add(step.job_id);
				queue.cancelInTransaction(db, step.job_id, reason);
				if (step.inference_request_id) requests.add(step.inference_request_id);
			}
			for (const job of tools.cancelInTransaction(db, t.id)) jobs.add(job);
			releases.add(t.id);
		}
		for (const t of rows)
			db.query(
				"UPDATE agent_events SET state='cancelled' WHERE task_id=? AND state!='consumed'",
			).run(t.id);
		const answerId = rootTaskId
			? undefined
			: inference.requestFor?.(db, rootRunId, "llm");
		if (answerId) requests.add(answerId);
		// Only this tree may be mutated. Deferred effects can contain identifiers
		// from rolled-back transactions; those are rechecked against committed state.
		inference.cancelRequestsInTransaction?.(db, [...requests]);
		for (const job of jobs) abortJobs.add(job);
		for (const request of requests) abortRequests.add(request);
		return { jobIds: [...jobs], requestIds: [...requests] };
	}
	return {
		currentActionPayload,
		enqueue,
		insertTask,
		ready,
		fail,
		endSteps,
		next,
		waitForTools,
		cancelTreeInTransaction,
	};
}
export type TaskOps = ReturnType<typeof createTaskOps>;
