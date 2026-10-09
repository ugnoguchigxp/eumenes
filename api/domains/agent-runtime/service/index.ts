import { z } from "zod";
import { getLogger } from "../../../infrastructure/logger";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	bytes,
	hash,
	researchInput,
	type Capabilities,
	type Prepared,
	type Owner,
	type Candidate,
} from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import type { QueueService, HandlerDefinition } from "../../queue";
import type { ToolRuntime, Source } from "../../tool-runtime";
import {
	routeSchema,
	selectSchema,
	workerSchema,
	type Task,
	type Report,
	type AnswerTicket,
} from "../contracts";
import { get, byRoot, update, dto } from "../repository";
import { coordinatorContext, workerContext } from "./context";
import { verifyReport, parentProjection } from "./verify-report";
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const active = (t: Task | null): t is Task => !!t && !terminal.has(t.state);
const owner = (t: Task): Owner => ({
	rootRunId: t.root_run_id,
	taskId: t.id,
	cancelEpoch: t.cancel_epoch,
});
const safeCode = (e: unknown) =>
	e instanceof Error && /^[a-z_]{1,80}$/.test(e.message)
		? e.message
		: "agent_failed";
export const STEP_KIND = "agent.step";
type StepInput = {
	taskId: string;
	stepId: string;
	revision: number;
	requestId: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	visible: Source[];
	manifestDigest: string;
};
type StepOutput = { receipt: Receipt; action: unknown; invalid: boolean };
export function createAgentRuntime({
	store,
	capabilities,
	tools,
	inference,
	queue,
	now = Date.now,
	invocationHint,
}: {
	store: SqliteStore;
	capabilities: Capabilities;
	tools: ToolRuntime;
	inference: InferencePort;
	queue: QueueService;
	now?: () => number;
	invocationHint?: (
		question: string,
	) => { toolId: string; arguments: unknown } | null;
}) {
	const log = getLogger("agent-runtime");
	const traceIds = new Set<string>();
	const traced = new Map<string, string>();
	const prepared = new Map<string, Prepared>();
	const candidates = new Map<string, Candidate[]>();
	const bindings = new Map<string, ReturnType<ToolRuntime["bind"]>>();
	let closed = false,
		started = false,
		dirty = false;
	let reconciling: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const abortJobs = new Set<string>(),
		abortRequests = new Set<string>(),
		releases = new Set<string>();
	let maintaining: Promise<void> | null = null;
	let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
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
			lane: t.kind === "coordinator" ? "interactive" : "background",
			resourceKey: "inference.llm",
			concurrencyKey: `agent:${t.id}`,
			maxAttempts: 1,
			deadlineAtMs: Math.min(
				t.deadline,
				now() + (t.kind === "worker" ? 30000 : 15000),
			),
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
		db.query(
			"INSERT INTO agent_tasks(id,kind,root_run_id,parent_task_id,input_json,state,phase,deadline,created_at,updated_at) VALUES(?,?,?,?,?,'queued',?,?,?,?)",
		).run(
			id,
			kind,
			rootRunId,
			parentTaskId,
			JSON.stringify(input),
			kind === "coordinator" ? "route" : "research",
			deadline,
			now(),
			now(),
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
	function cancelTreeInTransaction(
		db: Database,
		rootRunId: string,
		reason = "cancel_requested",
		state = "cancelled",
	) {
		const jobs = new Set<string>();
		const requests = new Set<string>();
		const rows = db
			.query("SELECT * FROM agent_tasks WHERE root_run_id=? ORDER BY kind")
			.all(rootRunId) as Task[];
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
		db.query(
			"UPDATE agent_events SET state='cancelled' WHERE root_run_id=? AND state!='consumed'",
		).run(rootRunId);
		const answerId = inference.requestFor?.(db, rootRunId, "llm");
		if (answerId) requests.add(answerId);
		// Only this tree may be mutated. Deferred effects can contain identifiers
		// from rolled-back transactions; those are rechecked against committed state.
		inference.cancelRequestsInTransaction?.(db, [...requests]);
		for (const job of jobs) abortJobs.add(job);
		for (const request of requests) abortRequests.add(request);
		return { jobIds: [...jobs], requestIds: [...requests] };
	}
	function usableTools(db: Database, t: Task) {
		return (bindings.get(t.id) ?? []).filter(
			(b) =>
				tools.countInTransaction(db, t.id, b.tool.revisionId) <
				(b.tool.id === "web.lookup" ? 2 : b.tool.id === "web.read" ? 3 : 1),
		);
	}
	const handler: HandlerDefinition<
		{ taskId: string; stepId: string },
		StepInput,
		StepOutput
	> = {
		kind: STEP_KIND,
		payloadVersions: [1],
		schema: z.object({ taskId: z.string(), stepId: z.string() }),
		resourceKey: "inference.llm",
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const t = get(db, claim.payload.taskId);
			if (!t || t.state !== "queued" || t.job_id !== claim.jobId)
				return { status: "stale", reason: "task_not_queued" };
			if (
				t.deadline <= now() ||
				t.model_calls >= (t.kind === "worker" ? 8 : 4)
			) {
				fail(db, t, "agent_budget_exhausted");
				return { status: "stale", reason: "agent_budget_exhausted" };
			}
			if (!inference.captureControlInTransaction || !inference.executeControl) {
				fail(db, t, "control_unavailable");
				return { status: "stale", reason: "control_unavailable" };
			}
			try {
				let context: ReturnType<typeof coordinatorContext> & {
					visible?: Source[];
				};
				if (t.kind === "coordinator") {
					const cards = (candidates.get(t.id) ?? []).map((c) => ({
						...c,
						inputSchema: {
							question: "string <= 8000",
							urls: "optional http/https URLs <= 3",
							detail: "brief | normal",
						},
					}));
					context = coordinatorContext(t, cards);
				} else {
					const p = prepared.get(t.id);
					if (!p) throw new Error("capability_ref_invalid");
					capabilities.validateInTransaction(db, p);
					const obs = tools.observationsInTransaction(db, t.id);
					context = workerContext(
						t,
						p,
						usableTools(db, t),
						obs.flatMap((o) => o.sources),
						obs.map((o) => ({
							state: o.state,
							errorCode: "errorCode" in o ? o.errorCode : null,
							failures: o.failures,
						})),
						invocationHint?.(researchInput.parse(p.input).question),
					);
				}
				const requestId = inference.captureControlInTransaction(db, {
					subject: `agent:${t.id}:step:${t.current_step}`,
					policySubject: t.root_run_id,
					deadline: claim.deadlineAtMs ?? t.deadline,
					maxOutputTokens: 2048,
				});
				const current = update(db, t, "running", t.phase);
				db.query(
					"UPDATE agent_tasks SET model_calls=model_calls+1 WHERE id=?",
				).run(t.id);
				db.query(
					"UPDATE agent_steps SET state='running',inference_request_id=?,manifest_digest=? WHERE id=? AND state='queued'",
				).run(requestId, context.manifestDigest, claim.payload.stepId);
				return {
					status: "ready",
					input: {
						taskId: t.id,
						stepId: claim.payload.stepId,
						revision: current.revision,
						requestId,
						messages: context.messages,
						visible: context.visible ?? [],
						manifestDigest: context.manifestDigest,
					},
				};
			} catch (e) {
				fail(db, get(db, t.id)!, safeCode(e));
				return { status: "stale", reason: safeCode(e) };
			}
		},
		async execute(input, { signal }) {
			const receipt = await inference.executeControl!(
				input.requestId,
				input.messages,
				signal,
			);
			let action: unknown,
				invalid = false;
			try {
				if (typeof receipt.value !== "string" || bytes(receipt.value) > 12288)
					throw new Error("invalid_control_json");
				action = JSON.parse(receipt.value.trim());
			} catch {
				invalid = true;
			}
			return { receipt, action, invalid };
		},
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const t = get(db, claim.payload.taskId);
			if (!active(t)) return "stale";
			if (outcome.type !== "success") {
				fail(
					db,
					t,
					outcome.type === "expired"
						? "deadline_exceeded"
						: outcome.type === "failed" ||
							  outcome.type === "retry" ||
							  outcome.type === "interrupted"
							? outcome.errorCode
							: "agent_failed",
				);
				return "applied";
			}
			if (!input || t.state !== "running" || t.revision !== input.revision)
				return "stale";
			const schema =
				t.kind === "worker"
					? workerSchema
					: t.phase === "route"
						? routeSchema
						: selectSchema;
			const parsed = schema.safeParse(outcome.result.action);
			if (outcome.result.invalid || !parsed.success) {
				inference.rejectControlInTransaction?.(
					db,
					outcome.result.receipt,
					"invalid_control_json",
				);
				db.query(
					"UPDATE agent_steps SET state='rejected',error_code='invalid_control_json' WHERE id=?",
				).run(input.stepId);
				if (t.json_repairs >= 1) fail(db, t, "invalid_control_json");
				else {
					db.query(
						"UPDATE agent_tasks SET json_repairs=json_repairs+1 WHERE id=?",
					).run(t.id);
					next(db, get(db, t.id)!, claim.jobId);
				}
				return "applied";
			}
			const action = parsed.data;
			db.exec("SAVEPOINT agent_action");
			try {
				if (action.action === "respond") ready(db, t);
				else if (action.action === "clarify") {
					db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
						JSON.stringify({
							...JSON.parse(t.input_json ?? "{}"),
							clarificationQuestion: action.question,
						}),
						t.id,
					);
					ready(db, get(db, t.id)!, "clarification_required");
				} else if (action.action === "unavailable")
					ready(db, t, "capability_unavailable");
				else if (action.action === "discover" || action.action === "refine") {
					if (action.action === "refine" && t.refinements >= 1)
						throw new Error("capability_unavailable");
					const cards = capabilities.searchInTransaction(
						db,
						owner(t),
						action.intent,
						action.terms,
						t.deadline,
					);
					candidates.set(t.id, cards);
					db.query(
						"UPDATE agent_tasks SET phase='select',refinements=refinements+? WHERE id=?",
					).run(action.action === "refine" ? 1 : 0, t.id);
					next(db, get(db, t.id)!, claim.jobId);
				} else if (action.action === "select") {
					if (t.deadline - now() <= 15000)
						throw new Error("agent_budget_exhausted");
					const supplied = researchInput.parse(action.input);
					const original = JSON.parse(t.input_json ?? "{}").question as string;
					if (supplied.urls?.some((url) => !original.includes(url)))
						throw new Error("tool_url_out_of_scope");
					const p = capabilities.prepareInTransaction(
						db,
						owner(t),
						action.candidateRef,
						{ ...supplied, question: original },
					);
					const child = insertTask(
						db,
						"worker",
						t.root_run_id,
						p.input,
						Math.min(now() + 90000, t.deadline - 15000),
						t.id,
					);
					db.query(
						"UPDATE agent_tasks SET package_revision_id=? WHERE id=?",
					).run(p.package.revisionId, child.id);
					for (const d of [p.package, ...p.dependencies])
						db.query("INSERT INTO agent_task_bindings VALUES(?,?,?,?)").run(
							child.id,
							d.kind,
							d.revisionId,
							d.hash,
						);
					prepared.set(child.id, p);
					prepared.set(t.id, p);
					bindings.set(child.id, tools.bind(owner(child), p, child.deadline));
					enqueue(db, child, claim.jobId);
					update(db, t, "waiting_child", "research");
				} else if (action.action === "invoke") {
					const p = prepared.get(t.id);
					if (!p) throw new Error("capability_ref_invalid");
					capabilities.validateInTransaction(db, p);
					const root = byRoot(db, t.root_run_id);
					if (!active(root) || root.state !== "waiting_child")
						throw new Error("task_cancelled");
					const tool = bindings
						.get(t.id)
						?.find((b) => b.executionRef === action.executionRef);
					if (!tool) throw new Error("tool_ref_invalid");
					const expected = workerContext(
						t,
						p,
						usableTools(db, t),
						[],
						[],
					).manifestDigest;
					if (expected !== input.manifestDigest)
						throw new Error("context_manifest_invalid");
					const count = tools.countInTransaction(
						db,
						t.id,
						tool.tool.revisionId,
					);
					if (
						t.tool_calls >= 5 ||
						count >=
							(tool.tool.id === "web.lookup"
								? 2
								: tool.tool.id === "web.read"
									? 3
									: 1)
					)
						throw new Error("agent_budget_exhausted");
					const taskInput = researchInput.parse(p.input);
					const obs = tools.observationsInTransaction(db, t.id);
					const urls = [
						...(taskInput.urls ?? []),
						...obs.flatMap((o) => o.sources.map((s) => s.url)),
					];
					const inv = tools.invokeInTransaction(
						db,
						owner(t),
						action.executionRef,
						action.arguments,
						input.stepId,
						t.deadline,
						claim.jobId,
						urls,
						taskInput.question,
					);
					db.query(
						"UPDATE agent_tasks SET tool_calls=tool_calls+1,invocation_id=? WHERE id=?",
					).run(inv.id, t.id);
					update(
						db,
						get(db, t.id)!,
						"waiting_tool",
						tool.tool.id === "web.lookup" ? "search" : "read",
					);
				} else if (action.action === "finish") {
					// Re-resolve all source operations while accepting; expired/cancelled data cannot be adopted.
					const obs = tools.observationsInTransaction(db, t.id);
					const report = verifyReport(
						action.report,
						input.visible,
						obs.some((o) => o.state !== "succeeded" || o.failures.length > 0),
					);
					db.query("INSERT INTO agent_reports VALUES(?,?,?,?)").run(
						t.id,
						JSON.stringify(report),
						hash(report),
						now(),
					);
					db.query(
						"UPDATE agent_tasks SET report_state='available' WHERE id=?",
					).run(t.id);
					update(db, get(db, t.id)!, "completed", "completed");
					const parent = t.parent_task_id ? get(db, t.parent_task_id) : null;
					if (!active(parent)) throw new Error("task_cancelled");
					ready(db, parent, null, t.id);
				}
				if (!inference.acceptInTransaction?.(db, outcome.result.receipt))
					throw new Error("permission_revoked");
				db.query(
					"UPDATE agent_steps SET state='completed',action_kind=? WHERE id=?",
				).run(action.action, input.stepId);
				db.exec("RELEASE agent_action");
			} catch (e) {
				db.exec("ROLLBACK TO agent_action");
				db.exec("RELEASE agent_action");
				const code = safeCode(e);
				inference.rejectControlInTransaction?.(
					db,
					outcome.result.receipt,
					code,
				);
				if (
					["invalid_tool_input", "invalid_evidence", "invalid_report"].includes(
						code,
					) &&
					t.kind === "worker" &&
					t.json_repairs < 1
				) {
					db.query(
						"UPDATE agent_tasks SET json_repairs=json_repairs+1 WHERE id=?",
					).run(t.id);
					db.query(
						"UPDATE agent_steps SET state='rejected',error_code=? WHERE id=?",
					).run(code, input.stepId);
					next(db, get(db, t.id)!, claim.jobId, code);
				} else fail(db, get(db, t.id)!, code);
			}
			return "applied";
		},
		cancelInTransaction(db, job, reason) {
			const t = get(db, job.payload.taskId);
			if (active(t)) {
				endSteps(db, t.id, "cancelled", reason);
				update(db, t, "cancelled", "cancelled", reason);
				if (t.kind === "worker") {
					const parent = t.parent_task_id ? get(db, t.parent_task_id) : null;
					if (active(parent)) ready(db, parent, reason);
				}
			}
		},
	};
	queue.registerHandler(handler);
	function flush() {
		for (const id of traceIds) {
			const task = store.read((db) => get(db, id));
			if (!task) {
				traceIds.delete(id);
				traced.delete(id);
				continue;
			}
			const signature = `${task.state}:${task.revision}`;
			if (traced.get(id) !== signature) {
				traced.set(id, signature);
				log.info("agent.state_changed", {
					runId: task.root_run_id,
					taskId: task.id,
					jobId: task.job_id ?? undefined,
					invocationId: task.invocation_id ?? undefined,
					status: task.state,
					kind: task.kind,
					reason: task.error_code?.startsWith("clarify:")
						? "clarification_required"
						: task.error_code && /^[a-z_]{1,80}$/.test(task.error_code)
							? task.error_code
							: undefined,
				});
			}
			if (terminal.has(task.state)) {
				traceIds.delete(id);
				traced.delete(id);
			}
		}

		for (const id of releases) {
			const task = store.read((db) => get(db, id));
			if (task && (terminal.has(task.state) || task.cancel_epoch > 0)) {
				tools.release(id);
				bindings.delete(id);
				candidates.delete(id);
				prepared.delete(id);
			}
		}
		releases.clear();
		queue.flushCancellations([...abortJobs]);
		inference.flushCancelledRequests?.([...abortRequests]);
		abortJobs.clear();
		abortRequests.clear();
	}
	function schedule() {
		if (closed || !started) return;
		dirty = true;
		if (!reconciling)
			queueMicrotask(() => {
				if (!closed && !reconciling) void reconcile();
			});
	}
	function maintenance(): Promise<void> {
		if (maintaining) return maintaining;
		if (closed) return Promise.resolve();
		maintaining = runMaintenance().finally(() => {
			maintaining = null;
		});
		return maintaining;
	}
	async function runMaintenance() {
		const cutoff = now() - 14 * 86400000;
		const roots = store.read(
			(db) =>
				db
					.query(
						"SELECT * FROM agent_tasks WHERE kind='coordinator' AND state IN ('completed','failed','cancelled','interrupted') AND updated_at<? AND report_state NOT IN ('deleted','expired') LIMIT 100",
					)
					.all(cutoff) as Task[],
		);
		if (roots.length)
			await store.write((db) => {
				for (const root of roots) {
					cancelTreeInTransaction(db, root.root_run_id, "report_deleted");
					db.query(
						"UPDATE agent_tasks SET input_json=NULL,data_epoch=data_epoch+1,report_state='expired' WHERE root_run_id=?",
					).run(root.root_run_id);
					db.query(
						"DELETE FROM agent_reports WHERE task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?)",
					).run(root.root_run_id);
					tools.deleteDataInTransaction(db, root.root_run_id);
				}
			});
		const old = store.read(
			(db) =>
				db
					.query(
						"SELECT root_run_id FROM agent_tasks WHERE kind='coordinator' AND state IN ('completed','failed','cancelled','interrupted') AND updated_at<? LIMIT 100",
					)
					.all(now() - 30 * 86400000) as { root_run_id: string }[],
		);
		if (old.length)
			await store.write((db) => {
				for (const root of old) {
					tools.purgeMetadataInTransaction(db, root.root_run_id);
					for (const table of [
						"agent_steps",
						"agent_task_bindings",
						"agent_reports",
					])
						db.query(
							`DELETE FROM ${table} WHERE task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?)`,
						).run(root.root_run_id);
					db.query("DELETE FROM agent_events WHERE root_run_id=?").run(
						root.root_run_id,
					);
					db.query("DELETE FROM agent_tasks WHERE root_run_id=?").run(
						root.root_run_id,
					);
				}
			});
	}
	async function reconcile() {
		if (reconciling) return reconciling;
		reconciling = (async () => {
			while (dirty && !closed) {
				dirty = false;
				flush();
				for (const taskId of new Set([
					...prepared.keys(),
					...bindings.keys(),
					...candidates.keys(),
				])) {
					const task = store.read((db) => get(db, taskId));
					const root = task
						? store.read((db) => byRoot(db, task.root_run_id))
						: null;
					if (!task || !root || terminal.has(root.state)) {
						tools.release(taskId);
						capabilities.releaseOwner(taskId);
						prepared.delete(taskId);
						bindings.delete(taskId);
						candidates.delete(taskId);
					}
				}
				for (let cursor = ""; !closed;) {
					const batch = tools.pending(cursor);
					if (!batch.length) break;
					cursor = batch.at(-1)!.id;
					for (const inv of batch) {
						const operation = tools.inspect(inv);
						const job = queue.get(inv.job_id);
						if (
							operation?.state === "pending" &&
							job &&
							![
								"failed",
								"expired",
								"interrupted",
								"cancelled",
								"completed",
							].includes(job.state) &&
							inv.deadline > now()
						)
							continue;
						await store.write((db) => {
							if (!tools.settleInTransaction(db, inv, operation)) return;
							const t = get(db, inv.owner_task_id);
							if (t?.state !== "waiting_tool" || t.invocation_id !== inv.id)
								return;
							const settled = tools.getInTransaction(db, inv.id)!;
							// Failure is an observation too. The worker may choose a different in-scope source within its budget.
							if (
								settled.state === "cancelled" ||
								settled.state === "interrupted"
							)
								fail(db, t, settled.error_code ?? "tool_failed");
							else next(db, t, inv.job_id);
						});
					}
				}
				const expired = store.read(
					(db) =>
						db
							.query(
								"SELECT * FROM agent_tasks WHERE state NOT IN ('completed','failed','cancelled','interrupted') AND deadline<=? LIMIT 100",
							)
							.all(now()) as Task[],
				);
				for (const t of expired)
					await store.write((db) => {
						const current = get(db, t.id);
						if (!active(current)) return;
						if (current.kind === "coordinator") {
							cancelTreeInTransaction(
								db,
								t.root_run_id,
								"deadline_exceeded",
								"failed",
							);
						} else {
							for (const id of tools.cancelInTransaction(db, t.id))
								abortJobs.add(id);
							fail(db, current, "deadline_exceeded");
						}
					});
			}
		})().finally(() => {
			reconciling = null;
			if (!closed) {
				arm();
				if (dirty) schedule();
			}
		});
		return reconciling;
	}
	function arm() {
		if (timer) clearTimeout(timer);
		if (closed) return;
		const deadline = store.read(
			(db) =>
				db
					.query(
						"SELECT MIN(deadline) AS deadline FROM agent_tasks WHERE state NOT IN ('completed','failed','cancelled','interrupted')",
					)
					.get() as { deadline: number | null },
		);
		if (deadline.deadline !== null) {
			timer = setTimeout(schedule, Math.max(1, deadline.deadline - now()));
			timer.unref();
		}
	}
	const stop = store.onCommit(schedule);
	function reportInTransaction(db: Database, taskId: string): Report | null {
		const t = get(db, taskId);
		if (!t) return null;
		const target = t.report_task_id ? get(db, t.report_task_id) : t;
		if (!target || target.report_state !== "available") return null;
		const row = db
			.query("SELECT report_json FROM agent_reports WHERE task_id=?")
			.get(target.id) as { report_json: string } | null;
		return row ? (JSON.parse(row.report_json) as Report) : null;
	}
	function prepareAnswerInTransaction(
		db: Database,
		rootRunId: string,
	): AnswerTicket {
		const root = byRoot(db, rootRunId);
		if (!root || root.state !== "ready_for_answer")
			throw new Error("task_not_ready");
		const event = db
			.query(
				"SELECT id FROM agent_events WHERE task_id=? AND state IN ('pending','reserved')",
			)
			.get(root.id) as { id: string } | null;
		if (!event) throw new Error("task_not_ready");
		const p = prepared.get(root.id);
		if (p) capabilities.validateInTransaction(db, p);
		const child = root.report_task_id ? get(db, root.report_task_id) : null;
		const report = reportInTransaction(db, root.id);
		if (root.report_task_id && !report) throw new Error("report_deleted");
		return {
			taskId: root.id,
			eventId: event.id,
			revision: root.revision,
			dataEpoch: root.data_epoch,
			reportTaskId: child?.id ?? null,
			reportEpoch: child?.data_epoch ?? null,
			reportDigest: report ? hash(report) : null,
			failureCode:
				root.error_code === "clarification_required" ? null : root.error_code,
			projection: report
				? JSON.stringify(parentProjection(report))
				: root.error_code
					? JSON.stringify(
							root.error_code === "clarification_required"
								? {
										clarification: JSON.parse(root.input_json ?? "{}")
											.clarificationQuestion,
									}
								: { failure: root.error_code },
						)
					: null,
		};
	}
	function validAnswerInTransaction(db: Database, ticket: AnswerTicket) {
		const t = get(db, ticket.taskId);
		if (
			!t ||
			t.state !== "ready_for_answer" ||
			t.revision !== ticket.revision ||
			t.data_epoch !== ticket.dataEpoch ||
			t.deadline <= now()
		)
			return false;
		try {
			const p = prepared.get(t.id);
			if (p) capabilities.validateInTransaction(db, p);
		} catch {
			return false;
		}
		if (ticket.reportTaskId) {
			const child = get(db, ticket.reportTaskId);
			const report = reportInTransaction(db, ticket.reportTaskId);
			if (
				!child ||
				child.data_epoch !== ticket.reportEpoch ||
				!report ||
				hash(report) !== ticket.reportDigest
			)
				return false;
		}
		return true;
	}
	return {
		handler,
		cancelTreeInTransaction,
		prepareAnswerInTransaction,
		validAnswerInTransaction,
		startInTransaction(
			db: Database,
			input: { rootRunId: string; input: unknown; deadline: number },
		) {
			const t = insertTask(
				db,
				"coordinator",
				input.rootRunId,
				input.input,
				input.deadline,
			);
			return { taskId: t.id, jobId: enqueue(db, t) };
		},
		byRootInTransaction: byRoot,
		pendingEvents: () =>
			store.read(
				(db) =>
					db
						.query(
							"SELECT * FROM agent_events WHERE state='pending' ORDER BY created_at LIMIT 100",
						)
						.all() as { id: string; task_id: string; root_run_id: string }[],
			),
		reserveAnswerInTransaction(db: Database, eventId: string, jobId: string) {
			if (
				db
					.query(
						"UPDATE agent_events SET state='reserved',answer_job_id=? WHERE id=? AND state='pending'",
					)
					.run(jobId, eventId).changes !== 1
			)
				throw new Error("task_changed");
		},
		completeAnswerInTransaction(db: Database, ticket: AnswerTicket) {
			if (!validAnswerInTransaction(db, ticket))
				throw new Error("report_invalidated");
			const root = get(db, ticket.taskId)!;
			update(db, root, "completed", "completed", root.error_code);
			db.query(
				"UPDATE agent_events SET state='consumed',consumed_at=? WHERE id=?",
			).run(now(), ticket.eventId);
		},
		failAnswerInTransaction(db: Database, rootRunId: string, code: string) {
			const t = byRoot(db, rootRunId);
			if (active(t)) update(db, t, "failed", "failed", code);
			db.query(
				"UPDATE agent_events SET state='failed' WHERE root_run_id=? AND state!='consumed'",
			).run(rootRunId);
		},
		get(id: string) {
			return store.read((db) => {
				const t = get(db, id);
				return t
					? { ...dto(t), toolOutcomes: tools.summaryInTransaction(db, t.id) }
					: null;
			});
		},
		list(rootRunId: string) {
			return store.read((db) =>
				(
					db
						.query(
							"SELECT * FROM agent_tasks WHERE root_run_id=? ORDER BY created_at,id",
						)
						.all(rootRunId) as Task[]
				).map((t) => ({
					...dto(t),
					toolOutcomes: tools.summaryInTransaction(db, t.id),
				})),
			);
		},
		report(id: string) {
			return store.read((db) => {
				const t = get(db, id);
				if (!t) throw new Error("task_not_found");
				if (["deleted", "expired"].includes(t.report_state))
					throw new Error("report_deleted");
				if (!["completed", "ready_for_answer"].includes(t.state))
					throw new Error("report_not_ready");
				return reportInTransaction(db, id);
			});
		},
		deleteTaskDataInTransaction(
			db: Database,
			rootRunId: string,
			expired = false,
		) {
			cancelTreeInTransaction(db, rootRunId, "report_deleted");
			db.query(
				"UPDATE agent_tasks SET input_json=NULL,data_epoch=data_epoch+1,report_state=? WHERE root_run_id=?",
			).run(expired ? "expired" : "deleted", rootRunId);
			db.query(
				"DELETE FROM agent_reports WHERE task_id IN (SELECT id FROM agent_tasks WHERE root_run_id=?)",
			).run(rootRunId);
			tools.deleteDataInTransaction(db, rootRunId);
		},
		async recover() {
			await store.write((db) => {
				const roots = db
					.query(
						"SELECT * FROM agent_tasks WHERE kind='coordinator' AND state NOT IN ('completed','failed','cancelled','interrupted')",
					)
					.all() as Task[];
				for (const t of roots)
					cancelTreeInTransaction(
						db,
						t.root_run_id,
						"backend_restarted",
						"interrupted",
					);
			});
			flush();
		},
		start() {
			started = true;
			schedule();
			maintenanceTimer = setInterval(() => {
				void maintenance().catch(() => {
					log.warn("agent.maintenance_failed", {
						reason: "maintenance_failed",
					});
				});
			}, 3600000);
			maintenanceTimer.unref();
			void maintenance().catch(() => {
				log.warn("agent.maintenance_failed", { reason: "maintenance_failed" });
			});
		},
		maintenance,
		reconcile() {
			dirty = true;
			return reconcile();
		},
		async close() {
			closed = true;
			stop();
			if (maintenanceTimer) clearInterval(maintenanceTimer);
			if (timer) clearTimeout(timer);
			await reconciling;
			await maintaining?.catch(() => {});
			await store.write((db) => {
				for (const t of db
					.query(
						"SELECT * FROM agent_tasks WHERE kind='coordinator' AND state NOT IN ('completed','failed','cancelled','interrupted')",
					)
					.all() as Task[])
					cancelTreeInTransaction(
						db,
						t.root_run_id,
						"backend_stopped",
						"interrupted",
					);
			});
			flush();
			prepared.clear();
			bindings.clear();
			candidates.clear();
			traceIds.clear();
			traced.clear();
			tools.close();
		},
	};
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
