import { z } from "zod";
import type { Database } from "bun:sqlite";
import { getLogger } from "../../../infrastructure/logger";
import {
	ACTIVE_TASK_LIMIT,
	activeTaskStates,
	type ApprovalRequest,
	type ApprovedItem,
	type InputValueApproval,
	type TaskStepInput,
	type TaskView,
} from "../contracts";
import {
	activeTaskCount,
	endTaskApprovals,
	dueTasks,
	ownedTask,
	patchTask,
	taskByRequest,
	taskOperations,
	taskRow,
	taskView,
	insertTask,
	tabRow,
	type TaskRow,
} from "../repository";
import type { Approvals } from "./approvals";
import { codeOf, type Ctx, type TaskApi } from "./context";
import { connectedConnection } from "./connection";
import { finishTask } from "./lifecycle";
import { checkNavigationTarget } from "./navigation";
import { openTab } from "./tabs";

const log = getLogger("browser");
const PAYLOAD = z.object({ id: z.uuid(), step: z.number().int() });

function stepInput(r: TaskRow): TaskStepInput {
	return {
		taskId: r.id,
		scriptRequired: !!r.script_required,
		owner: r.owner,
		request: r.request,
		tabRef: r.tab_ref,
		url: r.start_url,
		frozen: r.frozen_json ? JSON.parse(r.frozen_json) : null,
		coreState: r.core_state_json ? JSON.parse(r.core_state_json) : null,
		step: r.step,
		deadline: r.deadline,
	};
}

export type StartTaskInput = {
	deadline?: number;
	scriptRequired?: boolean;
	owner: string;
	conversationId: string;
	origin: "conversation" | "screen" | "child" | "task";
	requestId: string;
	request: string;
	tabRef?: string;
	url?: string;
	/** Frozen package/binding references; stored as given and handed back to every step. */
	frozen?: unknown;
	/** The serialized task-core state before the first model call. */
	coreState?: unknown;
	/**
	 * The earlier task of this conversation that ended as `needs_input` waiting for the user's approval, and
	 * whether the user's request approves it. Approval moves that task's pending approvals to this one (and only
	 * then, only within 10 minutes); anything else is ignored without an error and nothing moves.
	 */
	continueFrom?: string;
	approvePending?: boolean;
};

/** A started task and the approvals it holds from the start. */
export type StartedTask = TaskView & {
	approved: ApprovedItem[];
	jobId: string;
};

/** Single-shot page-operation tasks: accepted in one transaction, then run one queue job per model step. */
export function createTasks(
	ctx: Ctx,
	apiFor: (task: TaskRow, signal: AbortSignal) => TaskApi,
	approvals: Approvals,
) {
	function enqueue(db: Database, id: string, delayMs = 0) {
		const r = taskRow(db, id)!;
		const step = r.step + 1;
		patchTask(db, id, { step }, ctx.now());
		ctx.queue.enqueueInTransaction(db, {
			scope: "browser",
			kind: "browser.task.step",
			dedupeKey: `${id}:${step}`,
			payload: { id, step },
			subjectRef: id,
			lane: "interactive",
			concurrencyKey: `browser:task:${id}`,
			deadlineAtMs: r.deadline,
			availableAtMs: ctx.now() + delayMs,
			maxAttempts: 1,
		});
	}

	ctx.queue.registerHandler<
		{ id: string; step: number },
		TaskStepInput,
		| { kind: "continue"; coreState: unknown; delayMs: number }
		| {
				kind: "done";
				state: "completed" | "needs_input" | "failed";
				coreState: unknown;
				text: string;
				errorCode: string | null;
				approvals: (ApprovalRequest | InputValueApproval)[];
		  }
	>({
		kind: "browser.task.step",
		payloadVersions: [1],
		schema: PAYLOAD,
		recovery: "interrupt",
		prepareInTransaction(db, claim) {
			const r = taskRow(db, claim.payload.id);
			if (
				r?.origin === "task" &&
				!ctx.taskExecutionSource?.(db, JSON.parse(r.frozen_json ?? "{}"))
			) {
				finishTask(
					ctx,
					db,
					r.id,
					"cancelled",
					"execution_source_invalid",
					null,
				);
				return { status: "stale", reason: "execution_source_invalid" };
			}
			if (
				!r ||
				r.step !== claim.payload.step ||
				!activeTaskStates.includes(r.state)
			)
				return { status: "stale", reason: "browser_task_state_changed" };
			if (
				r.origin === "child" &&
				!ctx.childValid?.(db, JSON.parse(r.frozen_json ?? "{}").caller)
			) {
				finishTask(ctx, db, r.id, "cancelled", "child_authority_revoked", null);
				return { status: "stale", reason: "child_authority_revoked" };
			}
			if (ctx.now() >= r.deadline) {
				finishTask(ctx, db, r.id, "expired", "task_expired", null);
				return { status: "stale", reason: "task_expired" };
			}
			const running =
				r.state === "queued"
					? patchTask(db, r.id, { state: "running" }, ctx.now())
					: r;
			return { status: "ready", input: stepInput(running) };
		},
		async execute(input, { signal }) {
			if (!ctx.runTaskStep) throw new Error("browser_task_runner_missing");
			const controller = new AbortController();
			ctx.inflight.set(`task:${input.taskId}`, controller);
			const link = AbortSignal.any([signal, controller.signal]);
			try {
				const row = ctx.store.read((db) => taskRow(db, input.taskId));
				if (!row) throw new Error("browser_task_not_found");
				const out = await ctx.runTaskStep(input, {
					signal: link,
					api: apiFor(row, link),
				});
				return out.kind === "continue"
					? {
							kind: "continue",
							coreState: out.coreState,
							delayMs: out.delayMs ?? 0,
						}
					: {
							kind: "done",
							state: out.state,
							coreState: out.coreState,
							text: out.text,
							errorCode: out.errorCode ?? null,
							approvals: out.approvals ?? [],
						};
			} catch (e) {
				// Only a code of this domain's grammar leaves the step; anything else is a plain failure.
				throw new Error(codeOf(e, "browser_task_failed"));
			} finally {
				ctx.inflight.delete(`task:${input.taskId}`);
			}
		},
		classify: () => "fail",
		settleInTransaction(db, claim, _input, outcome) {
			const r = taskRow(db, claim.payload.id);
			if (
				!r ||
				r.step !== claim.payload.step ||
				!activeTaskStates.includes(r.state)
			)
				return "stale";
			if (outcome.type === "expired" || ctx.now() >= r.deadline) {
				finishTask(ctx, db, r.id, "expired", "task_expired", null);
				return "applied";
			}
			if (r.state !== "running") return "stale";
			if (
				r.origin === "child" &&
				!ctx.childValid?.(db, JSON.parse(r.frozen_json ?? "{}").caller)
			) {
				finishTask(ctx, db, r.id, "cancelled", "child_authority_revoked", null);
				return "stale";
			}
			if (outcome.type === "retry") return "applied";
			if (outcome.type === "success") {
				const out = outcome.result;
				const core = JSON.stringify(out.coreState ?? null);
				if (out.kind === "continue") {
					patchTask(db, r.id, { core_state_json: core }, ctx.now());
					enqueue(db, r.id, out.delayMs);
				} else {
					const ended = finishTask(
						ctx,
						db,
						r.id,
						out.state,
						out.state === "failed" ? safeCode(out.errorCode) : null,
						out.text.slice(0, 4000),
						core,
					);
					if (ended && out.state === "needs_input")
						approvals.persistPending(db, ended, out.approvals);
				}
				return "applied";
			}
			if (outcome.type === "interrupted")
				finishTask(ctx, db, r.id, "failed", "task_interrupted", null);
			else
				finishTask(ctx, db, r.id, "failed", safeCode(outcome.errorCode), null);
			return "applied";
		},
		cancelInTransaction(db, job) {
			const r = taskRow(db, job.payload.id);
			if (r && r.step === job.payload.step)
				finishTask(ctx, db, r.id, "cancelled", null, null);
		},
	});
	const safeCode = (code: string | null | undefined) =>
		code && /^[a-z][a-z0-9_]*$/.test(code) ? code : "browser_task_failed";

	const started = (db: Database, r: TaskRow): StartedTask => ({
		...taskView(r),
		jobId: ctx.queue.findByDedupeInTransaction(
			db,
			"browser",
			"browser.task.step",
			`${r.id}:${r.step}`,
		)!.id,
		approved: approvals.approved(db, r.id),
	});

	function startInTransaction(
		db: Database,
		input: StartTaskInput,
	): StartedTask {
		if (!ctx.runTaskStep) throw new Error("browser_task_runner_missing");
		const request = input.request.trim();
		if (!request || request.length > (input.origin === "child" ? 8000 : 4000))
			throw new Error("invalid_browser_request");
		const existing = taskByRequest(db, input.requestId);
		if (existing) {
			if (
				existing.script_required !== (input.scriptRequired ? 1 : 0) ||
				existing.owner !== input.owner ||
				existing.request !== request ||
				existing.tab_ref !== (input.tabRef ?? null) ||
				existing.start_url !== (input.url ?? null) ||
				existing.origin !== input.origin ||
				existing.frozen_json !==
					(input.frozen == null ? null : JSON.stringify(input.frozen))
			)
				throw new Error("request_conflict");
			return started(db, existing);
		}
		if (
			input.origin !== "child" &&
			(!input.scriptRequired || !ctx.canAutoConnect())
		)
			connectedConnection(ctx, db);
		if (input.tabRef) openTab(tabRow(db, input.tabRef));
		if (input.url) {
			const v = checkNavigationTarget(input.url, ctx.webOrigins);
			if (!v.ok) throw new Error(v.code);
		}
		if (activeTaskCount(db, input.owner) >= ACTIVE_TASK_LIMIT)
			throw new Error("browser_capacity");
		const id = crypto.randomUUID();
		insertTask(
			db,
			{
				id,
				owner: input.owner,
				conversationId: input.conversationId,
				origin: input.origin,
				requestId: input.requestId,
				request,
				tabRef: input.tabRef ?? null,
				startUrl: input.url ?? null,
				frozen: input.frozen,
				coreState: input.coreState,
				deadline: Math.min(ctx.now() + ctx.taskMs, input.deadline ?? Infinity),
			},
			ctx.now(),
		);
		db.query(
			"UPDATE browser_tasks SET script_required=?, continued_from=? WHERE id=?",
		).run(input.scriptRequired ? 1 : 0, input.continueFrom ?? null, id);
		if (input.continueFrom && input.approvePending)
			approvals.transferInTransaction(db, {
				owner: input.owner,
				conversationId: input.conversationId,
				from: input.continueFrom,
				to: id,
			});
		enqueue(db, id);
		return started(db, taskRow(db, id)!);
	}

	function cancelInTransaction(db: Database, owner: string, id: string) {
		const r = ownedTask(db, id, owner);
		if (r.state === "needs_input") {
			endTaskApprovals(db, id, ctx.now());
			patchTask(db, id, { state: "cancelled", epoch: r.epoch + 1 }, ctx.now());
		}
		finishTask(ctx, db, id, "cancelled", null, null);
		return taskView(taskRow(db, r.id)!);
	}
	/** Aborts the step and its operations that are running now; call after the cancelling transaction commits. */
	function abortRunning(id: string) {
		ctx.inflight.get(`task:${id}`)?.abort(new Error("task_not_active"));
		const ops = ctx.store.read(
			(db) =>
				db
					.query(
						"SELECT id FROM browser_operations WHERE task_id=? AND state IN ('prepared','dispatched')",
					)
					.all(id) as { id: string }[],
		);
		for (const o of ops)
			ctx.inflight.get(`op:${o.id}`)?.abort(new Error("task_not_active"));
		const captures = ctx.store.read(
			(db) =>
				db.query("SELECT id FROM browser_captures WHERE task_id=?").all(id) as {
					id: string;
				}[],
		);
		for (const c of captures)
			ctx.inflight.get(`capture:${c.id}`)?.abort(new Error("task_not_active"));
	}

	return {
		startInTransaction,
		cancelInTransaction,
		abortRunning,
		/** Tasks past their deadline end as expired; their running step is aborted. */
		expireDue(db: Database) {
			const ended: string[] = [];
			for (const t of dueTasks(db, ctx.now()))
				if (finishTask(ctx, db, t.id, "expired", "task_expired", null))
					ended.push(t.id);
			return ended;
		},
		status(db: Database, owner: string, id: string) {
			const r = ownedTask(db, id, owner);
			return { ...taskView(r), operations: taskOperations(db, id) };
		},
		log,
		codeOf,
	};
}
export type Tasks = ReturnType<typeof createTasks>;
