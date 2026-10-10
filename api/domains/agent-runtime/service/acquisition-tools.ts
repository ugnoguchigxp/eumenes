import type { Database } from "bun:sqlite";
import {
	hash,
	type Capabilities,
	type Owner,
	type Prepared,
} from "../../capabilities";
import type { ToolRuntime } from "../../tool-runtime";
import type {
	AcquisitionPlanPort,
	AcquisitionProposal,
	StoredBinding,
	Task,
} from "../contracts";

/** Site-side failures that justify one replacement by a normal search plan. Guard/safety/cancel never do. */
export const siteFailureCodes = new Set([
	"web_attempt_timeout",
	"web_timeout",
	"web_acquisition_failed",
	"web_result_too_large",
	"web_quote_symbol_mismatch",
	"result_expired",
	// Codes the real acquisition path emits (web_${LlmFetchError.code}): HTTP errors, a changed
	// page shape, and provider throttling all justify one fresh search; guard/unsafe/cancel never do.
	"web_upstream_http",
	"web_parse_changed",
	"web_content_insufficient",
	"web_unsupported_content_type",
	"web_response_too_large",
	"web_rate_limited",
	"web_bot_challenge",
]);
const terminal = new Set(["completed", "failed", "cancelled", "interrupted"]);

type Binding = ReturnType<ToolRuntime["bind"]>;
export type AcquisitionToolsContext = {
	acquisition: AcquisitionPlanPort;
	capabilities: Capabilities;
	tools: ToolRuntime;
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

export function createAcquisitionTools(ctx: AcquisitionToolsContext) {
	const { acquisition, capabilities, tools, now } = ctx;
	const active = (t: Task | null): t is Task => !!t && !terminal.has(t.state);

	function install(db: Database, root: Task, child: Task, p: Prepared) {
		db.query(
			"UPDATE agent_tasks SET package_revision_id=?,input_json=? WHERE id=?",
		).run(
			p.package.revisionId,
			JSON.stringify({
				...(p.input as object),
				originalRequest: JSON.parse(child.input_json ?? "{}").originalRequest,
			}),
			child.id,
		);
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
		ctx.next(db, ctx.get(db, child.id)!, parentJobId || undefined);
	}

	/** Attach acquisition optimization to an already-created worker. */
	function initialize(
		db: Database,
		root: Task,
		child: Task,
		parentJobId: string,
	) {
		const question = JSON.parse(root.input_json ?? "{}").question as string;
		const requestAtMs = now();
		const proposal = acquisition.resolveInTransaction(db, {
			rootRunId: root.root_run_id,
			coordinatorTaskId: root.id,
			question,
			requestAtMs,
		});
		if (proposal.kind === "unmatched") return false;
		if (proposal.kind === "clarification") {
			db.query("UPDATE agent_tasks SET input_json=? WHERE id=?").run(
				JSON.stringify({
					...JSON.parse(root.input_json ?? "{}"),
					clarificationQuestion: proposal.question,
				}),
				root.id,
			);
			throw new Error("clarification_required");
		}
		if (proposal.kind === "unavailable")
			throw new Error(ctx.codeOf(proposal.code, "capability_unavailable"));
		db.query("UPDATE agent_tasks SET acquisition_plan_json=? WHERE id=?").run(
			JSON.stringify({ ...proposal, requestAtMs }),
			root.id,
		);
		const stored = ctx.bindAcquisition(db, root.id, child.id);
		const ok = acquisition.validateInTransaction(db, {
			bindingToken: stored.bindingToken,
			owner: ctx.owner(child),
			stage: "prepare",
		});
		if (ok.kind !== "allowed")
			throw new Error(ctx.codeOf(ok.code, "acquisition_rejected"));
		let p: Prepared;
		try {
			p = capabilities.prepareActiveByIdInTransaction(
				db,
				ctx.owner(child),
				stored.packageRevisionId,
				{ question },
			);
		} catch (e) {
			if (
				stored.initialAction.kind !== "direct-invoke" ||
				!(e instanceof Error) ||
				e.message !== "invalid_capability_input"
			)
				throw e;
			p = capabilities.prepareActiveByIdInTransaction(
				db,
				ctx.owner(child),
				stored.packageRevisionId,
				stored.initialAction.arguments,
			);
		}
		install(db, root, child, p);
		const stepId = crypto.randomUUID();
		runInitialAction(db, child, stored, p, stepId, parentJobId, question);
		return true;
	}

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
				replaceReason: reason,
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
	return { initialize, replace };
}
