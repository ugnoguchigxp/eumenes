import { createToolSelection } from "./tool-selection";
import { acceptReport } from "./accept-report";
import { z } from "zod";
import { getLogger, type LogFields } from "../../../infrastructure/logger";
import {
	ValidationFailure,
	validationIssues,
} from "../../../infrastructure/validation-log";
import type { Database } from "bun:sqlite";
import type { SqliteStore } from "../../../infrastructure/sqlite";
import {
	hash,
	researchInput,
	type Capabilities,
	type Prepared,
	type Owner,
} from "../../capabilities";
import type { InferencePort, Receipt } from "../../inference";
import type { QueueService, HandlerDefinition } from "../../queue";
import type { ToolRuntime, Source } from "../../tool-runtime";
import {
	type Task,
	type Report,
	type AnswerTicket,
	type AcquisitionPlanPort,
	type AcquisitionProposal,
	type AcquisitionLookupProvenance,
	type AdoptedEvidence,
	type StoredBinding,
} from "../contracts";
import { timerCommand } from "../../capabilities";
import { get, byRoot, update, dto } from "../repository";
import { workerContext } from "./context";
import { EvidenceCatalog } from "./evidence-catalog";
import { researchAction } from "./research-contract";
import { requestUrls } from "./request-urls";
import { parentProjection } from "./verify-report";
import { createAcquisitionTools, siteFailureCodes } from "./acquisition-tools";
import {
	isHistory,
	explorationBudget,
	modelLimit,
	workerDeadline,
	stepDeadline,
} from "./exploration";
import { parseControlOutput, codeOf, safeCode } from "./control-output";

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
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);
const active = (t: Task | null): t is Task => !!t && !terminal.has(t.state);
const owner = (t: Task): Owner => ({
	rootRunId: t.root_run_id,
	taskId: t.id,
	cancelEpoch: t.cancel_epoch,
});
export const STEP_KIND = "agent.step";
type StepInput = {
	catalog: EvidenceCatalog;
	taskId: string;
	stepId: string;
	revision: number;
	requestId: string;
	messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
	visible: Source[];
	manifestDigest: string;
	grants: Array<{ id: string; executionRef: string }>;
	actionSnapshot?: unknown;
};
type StepOutput = {
	receipt: Receipt;
	action: unknown;
	invalid: boolean;
	diagnostic?: LogFields;
};
export function createAgentRuntime({
	store,
	capabilities,
	tools,
	inference,
	queue,
	now = Date.now,
	invocationHint,
	reportFeedback,
	acquisition,
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
	/** Domain feedback may request another in-scope read, within the existing repair budget. */
	reportFeedback?: (question: string, report: Report) => string | null;
	/** Optional generic acquisition plan. Without it every path is the pre-port one. */
	acquisition?: AcquisitionPlanPort;
}) {
	const log = getLogger("agent-runtime");
	function logRejection(
		t: Task,
		input: StepInput,
		result: StepOutput,
		jobId: string,
		code: string,
		diagnostic: LogFields,
		issues: LogFields[] = [],
		issueCount = issues.length,
		error?: unknown,
	) {
		// A rejection is logged only after its transaction commits. A rollback or
		// stale result must not look like an accepted state transition.
		void Promise.resolve()
			.then(() => {
				const step = store.read((db) =>
					db
						.query("SELECT state,error_code FROM agent_steps WHERE id=?")
						.get(input.stepId),
				) as { state: string; error_code: string | null } | null;
				if (
					!step ||
					!["rejected", "failed"].includes(step.state) ||
					step.error_code !== code
				)
					return;
				const current = store.read((db) => get(db, t.id));
				const fields: LogFields = {
					runId: t.root_run_id,
					taskId: t.id,
					jobId,
					stepId: input.stepId,
					inferenceId: input.requestId,
					attemptId: result.receipt.attemptId,
					kind: t.kind,
					phase: t.phase,
					repairAttempt: t.json_repairs,
					status: current?.state === "queued" ? "repair_scheduled" : "failed",
					controlSchema:
						t.kind === "worker"
							? "worker"
							: t.phase === "route"
								? "route"
								: "select",
					...result.diagnostic,
					...diagnostic,
					issueCount,
					reportedIssueCount: issues.length,
				};
				log.warn("agent.control_rejected", fields, error);
				for (const issue of issues)
					log.warn("agent.control_validation_issue", { ...fields, ...issue });
			})
			.catch(() => {});
	}
	const traceIds = new Set<string>();
	const traced = new Map<string, string>();
	const prepared = new Map<string, Prepared>();
	const catalogs = new Map<string, EvidenceCatalog>();
	const actionPrepared = new Map<string, Prepared>();
	function currentActionPayload(db: Database, task: Task) {
		const invocation = actionInvocation(db, task.id);
		if (!invocation) return null;
		return JSON.stringify(
			tools.readActionInTransaction(db, owner(task), invocation).payload,
		);
	}
	const bindings = new Map<string, ReturnType<ToolRuntime["bind"]>>();
	let closed = false,
		started = false,
		dirty = false;
	let reconciling: Promise<void> | null = null;
	let timer: ReturnType<typeof setTimeout> | null = null;
	const abortJobs = new Set<string>(),
		abortRequests = new Set<string>(),
		releases = new Set<string>();
	const releaseTokens = new Set<string>();
	let maintaining: Promise<void> | null = null;
	let maintenanceTimer: ReturnType<typeof setInterval> | null = null;
	const storedBinding = (t: Task | null): StoredBinding | null => {
		if (!t?.acquisition_binding_json) return null;
		try {
			return JSON.parse(t.acquisition_binding_json) as StoredBinding;
		} catch {
			return null;
		}
	};
	/** tool-runtime may expose per-invocation rows; absent until it does (then `tools` is empty). */
	function invocationDigests(db: Database, taskId: string) {
		const fn = (
			tools as unknown as {
				invocationsInTransaction?: (
					db: Database,
					taskId: string,
				) => {
					toolRevisionId: string;
					stepId: string;
					argsDigest: string;
					state: string;
					origin?: string;
					superseded?: boolean;
				}[];
			}
		).invocationsInTransaction;
		const p = prepared.get(taskId);
		if (!fn || !p) return [];
		const ids = new Map(p.dependencies.map((d) => [d.revisionId, d.id]));
		return fn(db, taskId).map((r) => ({
			toolId: ids.get(r.toolRevisionId) ?? r.toolRevisionId,
			stepId: r.stepId,
			argsDigest: r.argsDigest,
			state: r.state,
			origin: r.origin,
			superseded: r.superseded,
		}));
	}
	/** A cached (direct) plan may be swapped for a normal search once, only for site-side failures. */
	function canReplace(t: Task | null) {
		const b = storedBinding(t);
		return (
			!!acquisitionTools &&
			!!b &&
			b.initialAction.kind === "direct-invoke" &&
			(b.replacements ?? 0) < 1
		);
	}
	function replaceOrFail(
		db: Database,
		childId: string,
		code: string,
		parentJobId: string,
	) {
		try {
			acquisitionTools!.replace(db, childId, code, parentJobId);
		} catch {
			// No replacement: report the original site failure, never an older value.
			// The swap rolled back, but the route's failure is a separate durable fact.
			const t = get(db, childId);
			if (t) releaseBinding(db, t, code);
			if (active(t)) fail(db, t, code);
		}
	}
	function releaseBinding(db: Database, t: Task, reason?: string) {
		const b = storedBinding(t);
		if (!b || !acquisition) return;
		try {
			acquisition.releaseInTransaction(db, {
				bindingToken: b.bindingToken,
				owner: owner(t),
				reason,
			});
			releaseTokens.add(b.bindingToken);
		} catch {
			// release is best effort; the port re-checks ownership on every use
		}
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
			lane: t.kind === "coordinator" ? "interactive" : "background",
			resourceKey: "inference.llm",
			concurrencyKey: `agent:${t.id}`,
			maxAttempts: 1,
			deadlineAtMs: stepDeadline(t, prepared.get(t.id), now()),
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
			// A failed bound child hands its route verdict/candidates to the port durably.
			releaseBinding(db, current, code);
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
			releaseBinding(db, t);
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
	const { toolLimit, usableTools } = createToolSelection({
		tools,
		bindings,
		prepared,
		storedBinding,
		now,
		invocationHint,
	});

	function runTimer(
		db: Database,
		t: Task,
		rawCommand: unknown,
		snapshot: unknown,
		stepId: string,
	) {
		const action = { command: rawCommand };
		if (t.kind !== "coordinator" || t.phase !== "route")
			throw new Error("capability_unavailable");
		if (!tools.actionsEnabled()) throw new Error("capability_unavailable");
		const parsed = timerCommand.safeParse(action.command);
		if (!parsed.success) throw new Error("invalid_timer_input");
		if (
			parsed.data.operation === "cancel" ||
			(parsed.data.operation === "list" && parsed.data.timerId)
		) {
			const targets = snapshot as
				| { items?: Array<{ id: string; revision: number }> }
				| undefined;
			const command = parsed.data;
			if (
				!targets?.items?.some(
					(item) =>
						item.id === command.timerId &&
						(command.operation !== "cancel" ||
							item.revision === command.expectedRevision),
				)
			)
				throw new Error("timer_target_invalid");
		}
		const routeBundle = actionPrepared.get(t.id);
		if (!routeBundle) throw new Error("required_context_missing");
		capabilities.validateInTransaction(db, routeBundle);
		const preparedTimer = capabilities.prepareActiveByIdInTransaction(
			db,
			owner(t),
			"package:timers.manage@1",
			parsed.data,
			{
				hash: routeBundle.package.hash,
				generation: routeBundle.package.generation,
			},
		);
		prepared.set(t.id, preparedTimer);
		const bound = tools.bind(owner(t), preparedTimer, t.deadline);
		const toolId =
			parsed.data.operation === "start"
				? "timer.start"
				: parsed.data.operation === "cancel"
					? "timer.cancel"
					: "timer.list";
		const picked = bound.find((item) => item.tool.id === toolId);
		if (!picked) throw new Error("capability_unavailable");
		const command = parsed.data;
		const args =
			command.operation === "start"
				? {
						durationSeconds: command.durationSeconds,
						...(command.label ? { label: command.label } : {}),
					}
				: command.operation === "cancel"
					? {
							timerId: command.timerId,
							expectedRevision: command.expectedRevision,
						}
					: {
							...(command.timerId ? { timerId: command.timerId } : {}),
							...(command.state ? { state: command.state } : {}),
						};
		const saved = tools.invokeActionInTransaction(
			db,
			owner(t),
			picked.executionRef,
			args,
			stepId,
			t.deadline,
			`${t.root_run_id}:${t.cancel_epoch}`,
		);
		db.query(
			`INSERT INTO agent_action_results(task_id,invocation_id,operation_id,receipt_digest,payload_json,created_at)
             VALUES(?,?,?,?,?,?)`,
		).run(
			t.id,
			saved.invocationId,
			saved.operationId,
			saved.receiptDigest,
			JSON.stringify(saved.payload),
			now(),
		);
		ready(db, get(db, t.id)!);
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
				t.model_calls >=
					(t.kind === "worker" ? modelLimit(prepared.get(t.id)) : 4)
			) {
				fail(db, t, "agent_budget_exhausted");
				return { status: "stale", reason: "agent_budget_exhausted" };
			}
			if (!inference.captureControlInTransaction || !inference.executeControl) {
				fail(db, t, "control_unavailable");
				return { status: "stale", reason: "control_unavailable" };
			}
			try {
				const p = prepared.get(t.id);
				if (!p || t.kind !== "worker")
					throw new Error("capability_ref_invalid");
				capabilities.validateInTransaction(db, p);
				const obs = tools.observationsInTransaction(db, t.id);
				const catalog = (catalogs.get(t.id) ?? new EvidenceCatalog()).copy();
				const context = workerContext(
					t,
					p,
					catalog.full ? [] : usableTools(db, t, true),
					obs.flatMap((o) => o.sources),
					obs.map((o) => ({
						tool: tools
							.invocationsInTransaction(db, t.id)
							.find((i) => i.id === o.invocationId)?.toolRevisionId,
						state: o.state,
						errorCode: "errorCode" in o ? o.errorCode : null,
						failures: o.failures,
						notes: "notes" in o ? o.notes : null,
					})),
					null,
					catalog,
					now(),
				);
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
						catalog,
						taskId: t.id,
						stepId: claim.payload.stepId,
						revision: current.revision,
						requestId,
						messages: context.messages,
						visible: context.visible ?? [],
						manifestDigest: context.manifestDigest,
						grants: context.grants,
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
			return { receipt, ...parseControlOutput(receipt.value) };
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
			const step = db
				.query(
					"SELECT state,manifest_digest FROM agent_steps WHERE id=? AND task_id=?",
				)
				.get(input.stepId, t.id) as {
				state: string;
				manifest_digest: string;
			} | null;
			if (
				step?.state !== "running" ||
				step.manifest_digest !== input.manifestDigest
			)
				return "stale";
			if (t.deadline <= now()) {
				fail(db, t, "deadline_exceeded");
				return "applied";
			}
			catalogs.set(t.id, input.catalog);
			const parsed = researchAction.safeParse(outcome.result.action);
			if (outcome.result.invalid || !parsed.success) {
				const issues =
					!outcome.result.invalid && !parsed.success
						? validationIssues(parsed.error, outcome.result.action)
						: [];
				logRejection(
					t,
					input,
					outcome.result,
					claim.jobId,
					"invalid_control_json",
					{
						reason: outcome.result.invalid
							? (outcome.result.diagnostic?.reason ?? "control_json_syntax")
							: "control_schema_invalid",
					},
					issues,
					!outcome.result.invalid && !parsed.success
						? parsed.error.issues.length
						: 0,
				);
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
					next(db, get(db, t.id)!, claim.jobId, "invalid_control_json");
				}
				return "applied";
			}
			const action = parsed.data;
			db.exec("SAVEPOINT agent_action");
			try {
				if (action.action === "invoke") {
					const p = prepared.get(t.id);
					if (!p) throw new Error("capability_ref_invalid");
					capabilities.validateInTransaction(db, p);
					const root = byRoot(db, t.root_run_id);
					if (!active(root) || root.state !== "waiting_child")
						throw new Error("task_cancelled");
					// Authority at prepare is immutable for this step. Cancellation,
					// registry revision and the hard deadline are still checked at invoke.
					const grant = input.grants.find((g) => g.id === action.tool);
					const tool = (bindings.get(t.id) ?? []).find(
						(b) => b.executionRef === grant?.executionRef,
					);
					if (!tool)
						throw new ValidationFailure("invalid_tool_input", [
							{ validationPath: "tool", validationCode: "unknown_tool" },
						]);
					const count = tools.countInTransaction(
						db,
						t.id,
						tool.tool.revisionId,
					);
					if (count >= toolLimit(t, tool.tool.id))
						throw new Error("agent_budget_exhausted");
					if (isHistory(p) && tool.tool.id === "history.search") {
						const stale = tools
							.observationsInTransaction(db, t.id)
							.filter(
								(o) =>
									"errorCode" in o && o.errorCode === "history_cursor_stale",
							).length;
						if (stale > 1) throw new Error("agent_budget_exhausted");
					}
					const taskInput = researchInput.parse(p.input);
					const obs = tools.observationsInTransaction(db, t.id);
					const urls = [
						...(taskInput.urls ?? []),
						...obs.flatMap((o) =>
							o.sources.flatMap((s) => (s.url ? [s.url] : [])),
						),
					];
					const inv = tools.invokeInTransaction(
						db,
						owner(t),
						tool.executionRef,
						catalogs.get(t.id)!.arguments(action.arguments),
						input.stepId,
						t.deadline,
						claim.jobId,
						urls,
						taskInput.question,
					);
					db.query(
						"UPDATE agent_tasks SET tool_calls=tool_calls+1,invocation_id=? WHERE id=?",
					).run(inv.id, t.id);
					if (inv.state !== "pending") {
						next(db, get(db, t.id)!, claim.jobId);
					} else
						update(
							db,
							get(db, t.id)!,
							"waiting_tool",
							tool.tool.id === "web.lookup" ? "search" : "read",
						);
				} else if (action.action === "finish") {
					const catalog = catalogs.get(t.id)!;
					const operations = tools.invocationsInTransaction(db, t.id);
					const report = catalog.report(action.report, [
						`確認した操作${operations.length}件。`,
					]);
					acceptReport(
						db,
						t,
						{ report },
						{ ...input, visible: catalog.sources() },
						{
							tools,
							prepared: prepared.get(t.id),
							canRead: usableTools(db, t).some((b) => b.tool.id === "web.read"),
							now,
							acquisition,
							reportFeedback,
							storedBinding,
							invocationDigests: () => invocationDigests(db, t.id),
						},
					);
					db.query(
						"UPDATE agent_tasks SET report_state='available' WHERE id=?",
					).run(t.id);
					update(db, get(db, t.id)!, "completed", "completed");
					const parent = t.parent_task_id ? get(db, t.parent_task_id) : null;
					if (!active(parent)) throw new Error("task_cancelled");
					ready(db, parent, null, t.id);
					releases.add(t.id);
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
				logRejection(
					t,
					input,
					outcome.result,
					claim.jobId,
					code,
					{ reason: code, controlAction: action.action },
					e instanceof ValidationFailure ? e.issues : [],
					e instanceof ValidationFailure ? e.issueCount : 0,
					e,
				);
				inference.rejectControlInTransaction?.(
					db,
					outcome.result.receipt,
					code,
				);
				if (
					code === "source_unusable" &&
					t.kind === "worker" &&
					canReplace(get(db, t.id))
				) {
					db.query(
						"UPDATE agent_steps SET state='rejected',error_code=? WHERE id=?",
					).run(code, input.stepId);
					replaceOrFail(db, t.id, code, claim.jobId);
				} else if (
					code === "source_unusable" &&
					t.kind === "worker" &&
					!!storedBinding(t) &&
					explorationBudget(
						t,
						prepared.get(t.id),
						tools.invocationsInTransaction(db, t.id),
						now(),
					).canOperate
				) {
					// A source mismatch is a research result, not a JSON repair.
					db.query(
						"UPDATE agent_steps SET state='rejected',error_code=? WHERE id=?",
					).run(code, input.stepId);
					next(db, get(db, t.id)!, claim.jobId, code);
				} else if (
					([
						"invalid_tool_input",
						"invalid_evidence",
						"invalid_report",
					].includes(code) ||
						code === "tool_url_out_of_scope") &&
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
	const acquisitionTools = acquisition
		? createAcquisitionTools({
				acquisition,
				capabilities,
				tools,
				now,
				get,
				byRoot,
				update,
				next,
				owner,
				storedBinding,
				bindAcquisition,
				prepared,
				bindings,
				releaseTokens,
				releaseBinding,
				codeOf,
				safeCode,
			})
		: null;
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
				catalogs.delete(id);
				prepared.delete(id);
				actionPrepared.delete(id);
			}
		}
		releases.clear();
		// Grants of a replaced/cancelled binding leave memory only once the DB confirms no live
		// task still holds that token (a rolled-back replacement keeps its grants).
		for (const token of releaseTokens) {
			const holders = store.read(
				(db) =>
					db
						.query(
							"SELECT * FROM agent_tasks WHERE acquisition_binding_json LIKE ?",
						)
						.all(`%${token}%`) as Task[],
			);
			if (
				!holders.some(
					(t) =>
						!terminal.has(t.state) && storedBinding(t)?.bindingToken === token,
				)
			)
				tools.releaseBinding(token);
		}
		releaseTokens.clear();
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
				])) {
					const task = store.read((db) => get(db, taskId));
					const root = task
						? store.read((db) => byRoot(db, task.root_run_id))
						: null;
					if (!task || !root || terminal.has(root.state)) {
						tools.release(taskId);
						capabilities.releaseOwner(taskId);
						prepared.delete(taskId);
						actionPrepared.delete(taskId);
						bindings.delete(taskId);
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
						const applied = await store.write((db) => {
							if (!tools.settleInTransaction(db, inv, operation)) return;
							const settled = tools.getInTransaction(db, inv.id)!;
							const t = get(db, inv.owner_task_id);
							if (t?.state !== "waiting_tool" || t.invocation_id !== inv.id)
								return settled;
							// Failure is an observation too. The worker may choose a different in-scope source within its budget.
							if (
								settled.state === "cancelled" ||
								settled.state === "interrupted"
							)
								fail(db, t, settled.error_code ?? "tool_failed");
							else if (
								settled.state === "failed" &&
								canReplace(t) &&
								siteFailureCodes.has(settled.error_code ?? "")
							)
								replaceOrFail(db, t.id, settled.error_code!, inv.job_id);
							else next(db, t, inv.job_id);
							return settled;
						});
						if (applied) {
							const fields: LogFields = {
								runId: inv.root_run_id,
								taskId: inv.owner_task_id,
								invocationId: inv.id,
								operationId: inv.operation_id,
								jobId: inv.job_id,
								status: applied.state,
								reason: applied.error_code
									? codeOf(applied.error_code, "tool_failed")
									: undefined,
								kind: inv.tool_revision_id,
							};
							if (["succeeded", "partial"].includes(applied.state))
								log.info("agent.tool_completed", fields);
							else log.warn("agent.tool_failed", fields);
						}
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
	function bindAcquisition(
		db: Database,
		rootTaskId: string,
		childTaskId: string,
	): StoredBinding {
		if (!acquisition) throw new Error("acquisition_unavailable");
		const root = get(db, rootTaskId);
		const child = get(db, childTaskId);
		if (
			!active(root) ||
			!active(child) ||
			root.kind !== "coordinator" ||
			child.kind !== "worker" ||
			child.parent_task_id !== root.id ||
			child.root_run_id !== root.root_run_id
		)
			throw new Error("task_cancelled");
		const plan = root.acquisition_plan_json
			? (JSON.parse(root.acquisition_plan_json) as AcquisitionProposal)
			: null;
		if (
			!plan ||
			(plan.kind !== "search-first" &&
				plan.kind !== "candidate" &&
				plan.kind !== "direct")
		)
			throw new Error("acquisition_plan_missing");
		const bound = acquisition.bindInTransaction(db, {
			proposalToken: plan.proposalToken,
			childOwner: owner(child),
			deadline: child.deadline,
		});
		if (bound.kind !== "bound")
			throw new Error(codeOf(bound.code, "acquisition_rejected"));
		const stored: StoredBinding = {
			bindingToken: bound.bindingToken,
			packageRevisionId: bound.packageRevisionId,
			initialAction: bound.initialAction,
			lookupProvenance: null,
		};
		db.query(
			"UPDATE agent_tasks SET acquisition_binding_json=? WHERE id=?",
		).run(JSON.stringify(stored), child.id);
		return stored;
	}
	function safeRow(db: Database, taskId: string) {
		return db
			.query(
				"SELECT safe_projection_json,safe_projection_digest FROM agent_reports WHERE task_id=?",
			)
			.get(taskId) as {
			safe_projection_json: string | null;
			safe_projection_digest: string | null;
		} | null;
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
		if (
			child &&
			report?.version === 2 &&
			!tools.validateEvidenceInTransaction(db, owner(child), report.sources)
		)
			throw new Error("evidence_invalidated");
		// Only operational progress reaches the parent on failure, never unverified
		// snippets, page bodies or rejected worker claims.
		const progress =
			root.error_code && root.error_code !== "clarification_required"
				? (
						db
							.query(
								"SELECT id FROM agent_tasks WHERE root_run_id=? AND kind='worker'",
							)
							.all(rootRunId) as { id: string }[]
					).flatMap(
						(task) => tools.invocationsInTransaction?.(db, task.id) ?? [],
					)
				: [];
		const succeeded = (state: string) =>
			state === "succeeded" || state === "partial";
		const searches = progress.filter(
			(item) =>
				item.origin === "tool" &&
				item.toolRevisionId.startsWith("tool:web.lookup@"),
		);
		const reads = progress.filter((item) =>
			item.toolRevisionId.startsWith("tool:web.read@"),
		);
		if (root.report_task_id && !report) throw new Error("report_deleted");
		const safe = child ? safeRow(db, child.id) : null;
		const binding = storedBinding(child);
		if (binding) {
			// Cached authority is rechecked at adoption: clear/disable/disqualified results are refused.
			if (!acquisition || !safe?.safe_projection_digest)
				throw new Error("acquisition_unavailable");
			const ok = acquisition.validateAdoptionInTransaction(db, {
				bindingToken: binding.bindingToken,
				owner: owner(child!),
				projectionDigest: safe.safe_projection_digest,
			});
			if (ok.kind !== "allowed")
				throw new Error(codeOf(ok.code, "acquisition_rejected"));
		}
		return {
			projectionDigest: safe?.safe_projection_digest ?? null,
			acquisitionBindingToken: binding?.bindingToken ?? null,
			actionPayload: currentActionPayload(db, root),
			actionFailure:
				!!root.error_code &&
				JSON.parse(root.input_json ?? "{}").timerRequested === true,
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
				? (safe?.safe_projection_json ??
					JSON.stringify(parentProjection(report)))
				: root.error_code
					? JSON.stringify(
							root.error_code === "clarification_required"
								? {
										clarification: JSON.parse(root.input_json ?? "{}")
											.clarificationQuestion,
									}
								: {
										failure: root.error_code,
										researchProgress: {
											searchAttempts: searches.length,
											searchesSucceeded: searches.filter((item) =>
												succeeded(item.state),
											).length,
											readAttempts: reads.length,
											readsSucceeded: reads.filter((item) =>
												succeeded(item.state),
											).length,
											verifiedReport: false,
										},
									},
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
			// Time fields may advance; authority and state must still match the ticket.
			const state = (payload: string | null | undefined): unknown =>
				payload
					? JSON.parse(payload, (key, value) =>
							key === "serverNow" || key === "remainingSeconds"
								? undefined
								: value,
						)
					: null;
			if (
				hash(state(ticket.actionPayload)) !==
				hash(state(currentActionPayload(db, t)))
			)
				return false;
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
			if (
				report.version === 2 &&
				!tools.validateEvidenceInTransaction(db, owner(child), report.sources)
			)
				return false;
			const binding = storedBinding(child);
			if (binding || ticket.projectionDigest) {
				const safe = safeRow(db, child.id);
				if (
					!binding ||
					!acquisition ||
					!safe?.safe_projection_digest ||
					safe.safe_projection_digest !== ticket.projectionDigest
				)
					return false;
				try {
					const ok = acquisition.validateAdoptionInTransaction(db, {
						bindingToken: binding.bindingToken,
						owner: owner(child),
						projectionDigest: safe.safe_projection_digest,
					});
					if (ok.kind !== "allowed") return false;
				} catch {
					return false;
				}
			}
		}
		return true;
	}
	function adoptedEvidence(
		db: Database,
		input: { rootRunId: string; ticketId: string; reportEpoch: number },
	): AdoptedEvidence | null {
		const root = byRoot(db, input.rootRunId);
		if (!root || root.state !== "completed" || !root.report_task_id)
			return null;
		const event = db
			.query(
				"SELECT id,state FROM agent_events WHERE id=? AND task_id=? AND state='consumed'",
			)
			.get(input.ticketId, root.id) as { id: string } | null;
		const child = get(db, root.report_task_id);
		if (
			!event ||
			!child ||
			child.state !== "completed" ||
			root.report_state !== "available" ||
			child.report_state !== "available" ||
			child.data_epoch !== input.reportEpoch
		)
			return null;
		const report = reportInTransaction(db, child.id);
		if (!report) return null;
		return {
			rootRunId: root.root_run_id,
			rootTaskId: root.id,
			childTaskId: child.id,
			ticketId: event.id,
			rootDataEpoch: root.data_epoch,
			reportEpoch: child.data_epoch,
			reportDigest: hash(report),
			projectionDigest: safeRow(db, child.id)?.safe_projection_digest ?? null,
			bindingToken: storedBinding(child)?.bindingToken ?? null,
		};
	}
	return {
		authorizeReadOwnerInTransaction(
			db: Database,
			input: Owner,
			stage: "read" | "adopt",
		) {
			const task = get(db, input.taskId),
				root = byRoot(db, input.rootRunId);
			if (
				!task ||
				!root ||
				task.root_run_id !== input.rootRunId ||
				task.cancel_epoch !== input.cancelEpoch ||
				task.kind !== "worker" ||
				root.deadline <= now() ||
				!["waiting_child", "ready_for_answer"].includes(root.state) ||
				(stage === "read" && (!active(task) || task.deadline <= now())) ||
				["cancelled", "failed", "interrupted"].includes(task.state)
			)
				throw new Error("source_ref_invalid");
			return { deadline: root.deadline };
		},
		usesViewEvidenceInTransaction(db: Database, taskId: string) {
			return !!get(db, taskId) && prepared.has(taskId);
		},
		handler,
		/** Host (non-inference) step handler; undefined without an acquisition port. */

		cancelTreeInTransaction,
		prepareAnswerInTransaction,
		validAnswerInTransaction,
		validateActionOwnerInTransaction(db: Database, input: Owner) {
			const task = get(db, input.taskId);
			if (
				!active(task) ||
				task.kind !== "coordinator" ||
				task.phase !== "route" ||
				task.root_run_id !== input.rootRunId ||
				task.cancel_epoch !== input.cancelEpoch
			)
				throw new Error("origin_invalid");
		},
		conversationContextInTransaction(db: Database, rootRunId: string) {
			let snapshot: unknown;
			let timerCapability: Prepared | undefined;
			if (tools.actionsEnabled()) {
				try {
					const p = capabilities.prepareActiveByIdInTransaction(
						db,
						{ rootRunId, taskId: rootRunId, cancelEpoch: 0 },
						"package:timers.manage@1",
						{ operation: "list" },
					);
					timerCapability = p;
					snapshot = tools.actionContextInTransaction(db, {
						rootRunId,
						taskId: rootRunId,
						cancelEpoch: 0,
					});
				} catch (e) {
					if (
						!["capability_unavailable", "capability_revoked"].includes(
							safeCode(e),
						)
					)
						throw e;
				}
			}
			return {
				timers: snapshot,
				timersEnabled: !!timerCapability,
				timerCapability,
			};
		},
		startInTransaction(
			db: Database,
			input: {
				rootRunId: string;
				input: unknown;
				deadline: number;
				parentJobId?: string;
				actionSnapshot?: unknown;
				timerCapability?: Prepared;
				onCreated?: (taskId: string) => void;
			},
		) {
			const existing = byRoot(db, input.rootRunId);
			if (existing)
				return {
					taskId: existing.id,
					jobId: existing.job_id ?? input.parentJobId ?? existing.id,
				};
			const request = input.input as {
				kind?: "web" | "history" | "timer";
				question: string;
				originalRequest?: string;
				urls?: string[];
				command?: unknown;
			};
			const root = insertTask(
				db,
				"coordinator",
				input.rootRunId,
				request,
				input.deadline,
			);
			input.onCreated?.(root.id);
			if (request.kind === "timer") {
				const p = input.timerCapability;
				if (p) actionPrepared.set(root.id, p);
				db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
					JSON.stringify({ ...request, timerRequested: true }),
					root.id,
				);
				try {
					runTimer(
						db,
						get(db, root.id)!,
						request.command,
						input.actionSnapshot,
						crypto.randomUUID(),
					);
				} catch (e) {
					fail(db, get(db, root.id)!, safeCode(e));
				}
				return { taskId: root.id, jobId: input.parentJobId ?? root.id };
			}
			const packageId =
				request.kind === "history"
					? "package:history.research@1"
					: "package:web.research@7";
			const workerInput = {
				question: request.question,
				detail: "normal",
				...(request.kind !== "history"
					? {
							urls: requestUrls(
								request.originalRequest ?? request.question,
								request.urls,
							),
						}
					: {}),
			};
			let childId: string | undefined;
			db.exec("SAVEPOINT start_worker");
			try {
				// Every entry creates exactly one child with the same deadline policy.
				const child = insertTask(
					db,
					"worker",
					root.root_run_id,
					{ ...workerInput, originalRequest: request.originalRequest },
					workerDeadline({} as Prepared, root.deadline, now()),
					root.id,
				);
				childId = child.id;
				update(db, root, "waiting_child", "research");
				const initialized =
					request.kind !== "history" &&
					acquisitionTools?.initialize(
						db,
						root,
						child,
						input.parentJobId ?? "",
					);
				if (!initialized) {
					const p = capabilities.prepareActiveByIdInTransaction(
						db,
						owner(child),
						packageId,
						workerInput,
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
					prepared.set(root.id, p);
					bindings.set(child.id, tools.bind(owner(child), p, child.deadline));
					const jobId = enqueue(db, child, input.parentJobId);
					db.exec("RELEASE start_worker");
					return { taskId: root.id, jobId };
				}
				db.exec("RELEASE start_worker");
				return {
					taskId: root.id,
					jobId: get(db, child.id)!.job_id ?? input.parentJobId ?? root.id,
				};
			} catch (e) {
				const metadata = get(db, root.id)!.input_json;
				db.exec("ROLLBACK TO start_worker");
				db.exec("RELEASE start_worker");
				if (safeCode(e) === "clarification_required")
					db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
						metadata,
						root.id,
					);
				if (childId) {
					tools.release(childId);
					prepared.delete(childId);
					bindings.delete(childId);
				}
				prepared.delete(root.id);
				fail(db, get(db, root.id)!, safeCode(e));
				return { taskId: root.id, jobId: input.parentJobId ?? root.id };
			}
		},
		byRootInTransaction: byRoot,
		/** Ask the port for a root proposal; stored on the coordinator, never a read grant. */
		resolveAcquisitionInTransaction(
			db: Database,
			rootTaskId: string,
			requestAtMs: number,
		): AcquisitionProposal {
			if (!acquisition) return { kind: "unmatched" };
			const root = get(db, rootTaskId);
			if (!active(root) || root.kind !== "coordinator")
				throw new Error("task_not_active");
			const question = JSON.parse(root.input_json ?? "{}").question;
			if (typeof question !== "string") return { kind: "unmatched" };
			const proposal = acquisition.resolveInTransaction(db, {
				rootRunId: root.root_run_id,
				coordinatorTaskId: root.id,
				question,
				requestAtMs,
			});
			db.query("UPDATE agent_tasks SET acquisition_plan_json=? WHERE id=?").run(
				JSON.stringify({ ...proposal, requestAtMs }),
				root.id,
			);
			return proposal;
		},
		/** Bind the stored root proposal to a freshly created child (parent/root/cancel epoch checked). */
		bindAcquisitionInTransaction: bindAcquisition,
		bindingInTransaction(db: Database, taskId: string) {
			return storedBinding(get(db, taskId));
		},
		/** Record the provenance of the host lookup / candidate import for later proof. */
		setLookupProvenanceInTransaction(
			db: Database,
			childTaskId: string,
			provenance: AcquisitionLookupProvenance,
		) {
			const b = storedBinding(get(db, childTaskId));
			if (!b) throw new Error("acquisition_binding_missing");
			db.query(
				"UPDATE agent_tasks SET acquisition_binding_json=? WHERE id=?",
			).run(
				JSON.stringify({ ...b, lookupProvenance: provenance }),
				childTaskId,
			);
		},
		/** Stage check by the port (prepare/finish). */
		validateAcquisitionInTransaction(
			db: Database,
			childTaskId: string,
			stage: "prepare" | "finish",
		) {
			const child = get(db, childTaskId);
			const b = storedBinding(child);
			if (!child || !b || !acquisition)
				return { kind: "rejected", code: "acquisition_unavailable" } as const;
			return acquisition.validateInTransaction(db, {
				bindingToken: b.bindingToken,
				owner: owner(child),
				stage,
			});
		},
		/**
		 * Host-only: swap a failed cached plan of an active child for a normal search plan.
		 * Same owner / deadline / step ordinals / budgets; at most once per child.
		 */
		replaceAcquisitionPlanInTransaction(
			db: Database,
			childTaskId: string,
			reason: string,
			parentJobId: string,
		) {
			if (!acquisitionTools) throw new Error("acquisition_unavailable");
			return acquisitionTools.replace(db, childTaskId, reason, parentJobId);
		},
		releaseAcquisitionInTransaction(db: Database, taskId: string) {
			const t = get(db, taskId);
			if (t) releaseBinding(db, t);
		},
		/**
		 * Host-only: evidence of a consumed, completed answer. Unlike validAnswer this does not
		 * depend on ready_for_answer or on the revision that completion bumped.
		 */
		getAdoptedEvidenceInTransaction: adoptedEvidence,
		/** Re-check previously obtained evidence: deletion, cancel or a report change refuse it. */
		validateAdoptedEvidenceInTransaction(
			db: Database,
			evidence: AdoptedEvidence,
		): boolean {
			const current = adoptedEvidence(db, {
				rootRunId: evidence.rootRunId,
				ticketId: evidence.ticketId,
				reportEpoch: evidence.reportEpoch,
			});
			return (
				!!current &&
				current.rootTaskId === evidence.rootTaskId &&
				current.childTaskId === evidence.childTaskId &&
				current.rootDataEpoch === evidence.rootDataEpoch &&
				current.reportDigest === evidence.reportDigest &&
				current.projectionDigest === evidence.projectionDigest
			);
		},
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
			catalogs.clear();
			actionPrepared.clear();
			bindings.clear();
			traceIds.clear();
			traced.clear();
			tools.close();
		},
	};
}
export type AgentRuntime = ReturnType<typeof createAgentRuntime>;
