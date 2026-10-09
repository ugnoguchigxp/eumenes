import { z } from "zod";
import type { Database } from "bun:sqlite";
import {
	hash,
	type Capabilities,
	type Owner,
	type Prepared,
} from "../../capabilities";
import type { HandlerDefinition, QueueService } from "../../queue";
import type { ToolRuntime } from "../../tool-runtime";
import type {
	AcquisitionPlanPort,
	AcquisitionProposal,
	StoredBinding,
	Task,
} from "../contracts";

export const ROUTE_STEP_KIND = "agent.route-step";
/** Site-side failures that justify one replacement by a normal search plan. Guard/safety/cancel never do. */
export const siteFailureCodes = new Set([
	"web_attempt_timeout",
	"web_timeout",
	"web_acquisition_failed",
	"web_result_too_large",
	"web_quote_symbol_mismatch",
	"result_expired",
]);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

type Binding = ReturnType<ToolRuntime["bind"]>;
export type RouteStepContext = {
	acquisition: AcquisitionPlanPort;
	capabilities: Capabilities;
	tools: ToolRuntime;
	queue: QueueService;
	now: () => number;
	get(db: Database, id: string): Task | null;
	byRoot(db: Database, rootRunId: string): Task | null;
	update(
		db: Database,
		t: Task,
		state: string,
		phase?: string,
		code?: string | null,
	): Task;
	insertTask(
		db: Database,
		kind: Task["kind"],
		rootRunId: string,
		input: unknown,
		deadline: number,
		parentTaskId?: string | null,
	): Task;
	ready(
		db: Database,
		t: Task,
		reason?: string | null,
		reportTaskId?: string | null,
	): void;
	fail(db: Database, t: Task, code: string): void;
	next(
		db: Database,
		t: Task,
		parentJobId?: string,
		repairCode?: string | null,
	): void;
	owner(t: Task): Owner;
	storedBinding(t: Task | null): StoredBinding | null;
	bindAcquisition(
		db: Database,
		rootTaskId: string,
		childTaskId: string,
	): StoredBinding;
	prepared: Map<string, Prepared>;
	bindings: Map<string, Binding>;
	releaseTokens: Set<string>;
	releaseBinding(db: Database, t: Task, reason?: string): void;
	codeOf(code: string, fallback: string): string;
	safeCode(e: unknown): string;
};

export function createRouteStep(ctx: RouteStepContext) {
	const { acquisition, capabilities, tools, queue, now } = ctx;
	const active = (t: Task | null): t is Task => !!t && !terminal.has(t.state);

	/** Enqueue a host (non-inference) step. No resourceKey: it never holds an LLM slot. */
	function enqueueHost(db: Database, t: Task, parentJobId?: string) {
		const ordinal = t.current_step + 1,
			stepId = crypto.randomUUID();
		const { job } = queue.enqueueInTransaction(db, {
			scope: "agent",
			kind: ROUTE_STEP_KIND,
			dedupeKey: stepId,
			payload: { taskId: t.id, stepId },
			subjectRef: t.id,
			parentJobId,
			lane: t.kind === "coordinator" ? "interactive" : "background",
			concurrencyKey: `agent:${t.id}`,
			maxAttempts: 1,
			deadlineAtMs: Math.min(t.deadline, now() + 15000),
		});
		db.query(
			"INSERT INTO agent_steps(id,task_id,ordinal,state,job_id,action_origin) VALUES(?,?,?,'queued',?,'host')",
		).run(stepId, t.id, ordinal, job.id);
		db.query("UPDATE agent_tasks SET current_step=?,job_id=? WHERE id=?").run(
			ordinal,
			job.id,
			t.id,
		);
		return job.id;
	}

	function install(db: Database, root: Task, child: Task, p: Prepared) {
		db.query(
			"UPDATE agent_tasks SET package_revision_id=?,input_json=? WHERE id=?",
		).run(p.package.revisionId, JSON.stringify(p.input), child.id);
		db.query("DELETE FROM agent_task_bindings WHERE task_id=?").run(child.id);
		for (const d of [p.package, ...p.dependencies])
			db.query("INSERT INTO agent_task_bindings VALUES(?,?,?,?)").run(
				child.id,
				d.kind,
				d.revisionId,
				d.hash,
			);
		ctx.prepared.set(child.id, p);
		ctx.prepared.set(root.id, p);
	}

	/** Issue the child's own execution references for the bound plan and run its first action. */
	function runInitialAction(
		db: Database,
		child: Task,
		binding: StoredBinding,
		p: Prepared,
		stepId: string,
		parentJobId: string,
		question: string,
	) {
		const owner = ctx.owner(child);
		const action = binding.initialAction;
		const invoke = (ref: string, args: unknown, phase: string) => {
			const inv = tools.invokeInTransaction(
				db,
				owner,
				ref,
				args,
				stepId,
				child.deadline,
				parentJobId,
				[],
				question,
			);
			db.query(
				"UPDATE agent_tasks SET tool_calls=tool_calls+1,invocation_id=? WHERE id=?",
			).run(inv.id, child.id);
			ctx.update(db, ctx.get(db, child.id)!, "waiting_tool", phase);
		};
		const setProvenance = (
			lookupProvenance: StoredBinding["lookupProvenance"],
		) =>
			db
				.query("UPDATE agent_tasks SET acquisition_binding_json=? WHERE id=?")
				.run(JSON.stringify({ ...binding, lookupProvenance }), child.id);
		if (action.kind === "direct-invoke") {
			const grant = tools.issueCachedGrantInTransaction(db, {
				owner,
				prepared: p,
				bindingToken: binding.bindingToken,
				toolId: action.toolId,
				arguments: action.arguments,
				exactUrl: action.exactUrl,
				deadline: child.deadline,
				attemptTimeoutMs: action.attemptTimeoutMs,
			});
			ctx.bindings.set(child.id, [grant]);
			invoke(grant.executionRef, action.arguments, "read");
			return;
		}
		ctx.bindings.set(child.id, tools.bind(owner, p, child.deadline));
		if (action.kind === "host-lookup") {
			const lookup = ctx.bindings
				.get(child.id)!
				.find((b) => b.tool.id === "web.lookup");
			if (!lookup) throw new Error("tool_ref_invalid");
			const args = {
				query: action.query,
				language: action.language,
				region: action.region,
			};
			invoke(lookup.executionRef, args, "search");
			setProvenance({
				origin: "lookup",
				runId: child.root_run_id,
				stepId,
				query: action.query,
				searchedAt: now(),
				provider: "web-research",
				digest: hash({ ...args, stepId }),
			});
			return;
		}
		// candidate-import: an observation owned by this child, never a fake lookup.
		const inv = tools.importSearchCandidatesInTransaction(db, {
			owner,
			prepared: p,
			bindingToken: binding.bindingToken,
			stepId,
			deadline: child.deadline,
			query: action.query,
			searchedAt: new Date(action.searchedAt).toISOString(),
			provenanceDigest: action.provenanceDigest,
			hits: action.hits,
		});
		db.query(
			"UPDATE agent_tasks SET tool_calls=tool_calls+1,invocation_id=? WHERE id=?",
		).run(inv.id, child.id);
		setProvenance(action.provenance);
		ctx.next(db, ctx.get(db, child.id)!, parentJobId);
	}

	/** Root host step: resolve → child → bind → prepare by ID → first host action. */
	function rootStep(
		db: Database,
		root: Task,
		stepId: string,
		parentJobId: string,
	) {
		const question = JSON.parse(root.input_json ?? "{}").question;
		if (typeof question !== "string") {
			ctx.ready(db, root, "capability_unavailable");
			return;
		}
		const requestAtMs = now();
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
		if (proposal.kind === "unmatched") {
			// Legacy coordinator path: the only place a root model step is created.
			ctx.next(db, root, parentJobId);
			return;
		}
		if (proposal.kind === "clarification") {
			db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
				JSON.stringify({
					...JSON.parse(root.input_json ?? "{}"),
					clarificationQuestion: proposal.question,
				}),
				root.id,
			);
			ctx.ready(db, ctx.get(db, root.id)!, "clarification_required");
			return;
		}
		if (proposal.kind === "unavailable") {
			// Authority is gone: finish without searching around it.
			ctx.ready(db, root, ctx.codeOf(proposal.code, "capability_unavailable"));
			return;
		}
		db.exec("SAVEPOINT agent_host_child");
		let childId: string | null = null;
		try {
			const child = ctx.insertTask(
				db,
				"worker",
				root.root_run_id,
				{},
				Math.min(now() + 90000, root.deadline - 15000),
				root.id,
			);
			childId = child.id;
			if (child.deadline <= now()) throw new Error("agent_budget_exhausted");
			const stored = ctx.bindAcquisition(db, root.id, child.id);
			const ok = acquisition.validateInTransaction(db, {
				bindingToken: stored.bindingToken,
				owner: ctx.owner(child),
				stage: "prepare",
			});
			if (ok.kind !== "allowed")
				throw new Error(ctx.codeOf(ok.code, "acquisition_rejected"));
			const prepare = (input: unknown) =>
				capabilities.prepareActiveByIdInTransaction(
					db,
					ctx.owner(child),
					stored.packageRevisionId,
					input,
				);
			let p: ReturnType<typeof prepare>;
			try {
				p = prepare({ question });
			} catch (e) {
				// A learned package takes its tool's schema: retry with the fixed recipe arguments.
				if (
					stored.initialAction.kind !== "direct-invoke" ||
					!(e instanceof Error) ||
					e.message !== "invalid_capability_input"
				)
					throw e;
				p = prepare(stored.initialAction.arguments);
			}
			install(db, root, child, p);
			runInitialAction(db, child, stored, p, stepId, parentJobId, question);
			ctx.update(db, ctx.get(db, root.id)!, "waiting_child", "research");
			db.exec("RELEASE agent_host_child");
		} catch (e) {
			db.exec("ROLLBACK TO agent_host_child");
			db.exec("RELEASE agent_host_child");
			if (childId) {
				tools.release(childId);
				ctx.prepared.delete(childId);
				ctx.bindings.delete(childId);
			}
			ctx.prepared.delete(root.id);
			// Explicit failure: never a silent fallback to a different (unvalidated) route.
			ctx.fail(db, ctx.get(db, root.id)!, ctx.safeCode(e));
		}
	}

	type Input = { taskId: string; stepId: string };
	const handler: HandlerDefinition<Input, Input, null> = {
		kind: ROUTE_STEP_KIND,
		payloadVersions: [1],
		schema: z.object({ taskId: z.string(), stepId: z.string() }),
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const t = ctx.get(db, claim.payload.taskId);
			if (
				!t ||
				t.state !== "queued" ||
				t.job_id !== claim.jobId ||
				t.kind !== "coordinator"
			)
				return { status: "stale", reason: "task_not_queued" };
			if (t.deadline <= now()) {
				ctx.fail(db, t, "deadline_exceeded");
				return { status: "stale", reason: "deadline_exceeded" };
			}
			db.query(
				"UPDATE agent_steps SET state='running' WHERE id=? AND state='queued'",
			).run(claim.payload.stepId);
			// The whole host transition happens here; there is no model call and no receipt.
			rootStep(db, t, claim.payload.stepId, claim.jobId);
			return { status: "ready", input: claim.payload };
		},
		async execute() {
			return null;
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			db.query(
				"UPDATE agent_steps SET state=?,action_kind='route',error_code=? WHERE id=? AND state IN ('queued','running')",
			).run(
				outcome.type === "success" ? "completed" : "failed",
				outcome.type === "success"
					? null
					: outcome.type === "expired"
						? "deadline_exceeded"
						: "errorCode" in outcome
							? outcome.errorCode
							: "agent_failed",
				claim.payload.stepId,
			);
			if (outcome.type !== "success") {
				const t = ctx.get(db, claim.payload.taskId);
				if (active(t) && t.state === "queued")
					ctx.fail(
						db,
						t,
						outcome.type === "expired"
							? "deadline_exceeded"
							: "errorCode" in outcome
								? ctx.codeOf(outcome.errorCode, "agent_failed")
								: "agent_failed",
					);
			}
			return "applied";
		},
		cancelInTransaction() {
			// The agent tree cancellation already ended the task and its steps.
		},
	};

	/**
	 * Replace a failed cached (direct) plan by a normal search plan for the SAME child:
	 * owner, cancel epoch, deadline, step ordinals and cumulative budgets are kept.
	 */
	function replace(
		db: Database,
		childTaskId: string,
		reason: string,
		parentJobId: string,
	) {
		const child = ctx.get(db, childTaskId);
		const old = ctx.storedBinding(child);
		if (!active(child) || child.kind !== "worker" || !old)
			throw new Error("replacement_unavailable");
		if ((old.replacements ?? 0) >= 1) throw new Error("replacement_exhausted");
		const root = ctx.byRoot(db, child.root_run_id);
		if (!active(root) || root.state !== "waiting_child")
			throw new Error("task_cancelled");
		const question = JSON.parse(root.input_json ?? "{}").question as string;
		const plan = root.acquisition_plan_json
			? (JSON.parse(root.acquisition_plan_json) as AcquisitionProposal & {
					requestAtMs?: number;
				})
			: null;
		db.exec("SAVEPOINT agent_replace");
		try {
			// 1. The old route loses authority in the DB; memory refs are dropped after commit.
			ctx.releaseBinding(db, child, reason);
			ctx.releaseTokens.add(old.bindingToken);
			// 2. Old observations never feed the new plan.
			const supersede = (
				tools as unknown as {
					supersedeInvocationsInTransaction?: (
						db: Database,
						taskId: string,
					) => void;
				}
			).supersedeInvocationsInTransaction;
			if (supersede) supersede(db, child.id);
			else if (
				tools
					.observationsInTransaction(db, child.id)
					.some((o) => "sources" in o && o.sources.length)
			)
				throw new Error("replacement_unavailable");
			// 3. The route port re-resolves under the same request binding (disqualified route → search).
			const next = acquisition.resolveInTransaction(db, {
				rootRunId: root.root_run_id,
				coordinatorTaskId: root.id,
				question,
				requestAtMs: plan?.requestAtMs ?? now(),
			});
			if (next.kind !== "search-first")
				throw new Error("replacement_unavailable");
			db.query("UPDATE agent_tasks SET acquisition_plan_json=? WHERE id=?").run(
				JSON.stringify({ ...next, requestAtMs: plan?.requestAtMs ?? now() }),
				root.id,
			);
			const fresh = ctx.bindAcquisition(db, root.id, child.id);
			if (fresh.initialAction.kind !== "host-lookup")
				throw new Error("replacement_unavailable");
			const stored: StoredBinding = {
				...fresh,
				replacements: (old.replacements ?? 0) + 1,
			};
			db.query(
				"UPDATE agent_tasks SET acquisition_binding_json=? WHERE id=?",
			).run(JSON.stringify(stored), child.id);
			const p = capabilities.prepareActiveByIdInTransaction(
				db,
				ctx.owner(child),
				stored.packageRevisionId,
				{ question },
			);
			install(db, root, child, p);
			// 4. A real lookup under a new step id; the model budget and ordinals continue.
			const stepId = crypto.randomUUID();
			const ordinal = child.current_step + 1;
			db.query(
				"INSERT INTO agent_steps(id,task_id,ordinal,state,job_id,action_origin,action_kind) VALUES(?,?,?,'completed',?,'host','replace')",
			).run(stepId, child.id, ordinal, parentJobId);
			db.query("UPDATE agent_tasks SET current_step=? WHERE id=?").run(
				ordinal,
				child.id,
			);
			runInitialAction(
				db,
				ctx.get(db, child.id)!,
				stored,
				p,
				stepId,
				parentJobId,
				question,
			);
			db.exec("RELEASE agent_replace");
			return stored;
		} catch (e) {
			db.exec("ROLLBACK TO agent_replace");
			db.exec("RELEASE agent_replace");
			throw e;
		}
	}
	return { handler, enqueueHost, replace };
}
