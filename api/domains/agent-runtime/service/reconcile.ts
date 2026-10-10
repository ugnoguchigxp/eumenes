import { isTransientStoreError } from "../../../infrastructure/error-code";
import type { LogFields } from "../../../infrastructure/logger";
import type { Task } from "../contracts";
import { get, byRoot } from "../repository";
import { codeOf } from "./control-output";
import {
	active,
	failureCode,
	terminal,
	type RuntimeContext,
} from "./runtime-context";
import type { TaskOps } from "./task-ops";

export function createReconcile(
	ctx: RuntimeContext,
	ops: TaskOps,
	flush: () => void,
) {
	const { store, capabilities, tools, queue, now, log } = ctx.deps;
	const {
		prepared,
		catalogs,
		actionPrepared,
		bindings,
		abortJobs,
		reconcileFailures,
	} = ctx.state;
	const { state } = ctx;
	const { reconcileThrottleMs, timers } = ctx.deps;
	const { fail, next, cancelTreeInTransaction } = ops;
	function runScheduled() {
		if (!state.closed && !state.reconciling)
			void reconcile().catch((error) =>
				log.error(
					"agent.reconcile_failed",
					{ reason: failureCode(error) },
					error,
				),
			);
	}
	function schedule() {
		if (state.closed || !state.started) return;
		state.dirty = true;
		if (state.reconciling || state.throttleTimer) return;
		const wait = state.lastPassEnded + reconcileThrottleMs - now();
		if (wait > 0) {
			state.throttleTimer = timers.setTimeout(() => {
				state.throttleTimer = null;
				runScheduled();
			}, wait);
			state.throttleTimer.unref?.();
			return;
		}
		queueMicrotask(runScheduled);
	}
	async function failOwnerAfterRepeatedFailure(taskId: string, key: string) {
		try {
			await store.write((db) => {
				const t = get(db, taskId);
				if (!active(t)) return;
				for (const id of tools.cancelInTransaction(db, t.id)) abortJobs.add(id);
				fail(db, t, "reconcile_failed");
			});
			reconcileFailures.delete(key);
		} catch (error) {
			log.error(
				"agent.reconcile_give_up_failed",
				{ taskId, reason: failureCode(error) },
				error,
			);
		}
	}
	async function reconcile() {
		if (state.reconciling) return state.reconciling;
		state.reconciling = (async () => {
			while (state.dirty && !state.closed) {
				state.dirty = false;
				let passFailed = false;
				flush();
				for (const taskId of new Set([
					...prepared.keys(),
					...bindings.keys(),
				])) {
					try {
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
							catalogs.delete(taskId);
							reconcileFailures.delete(`task:${taskId}`);
						}
					} catch (error) {
						log.warn(
							"agent.reconcile_item_failed",
							{ taskId, reason: failureCode(error) },
							error,
						);
					}
				}
				for (let cursor = ""; !state.closed;) {
					const batch = tools.pending(cursor);
					if (!batch.length) break;
					cursor = batch.at(-1)!.id;
					for (const inv of batch) {
						try {
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
							reconcileFailures.delete(`inv:${inv.id}`);
						} catch (error) {
							passFailed = true;
							log.warn(
								"agent.reconcile_item_failed",
								{
									runId: inv.root_run_id,
									taskId: inv.owner_task_id,
									invocationId: inv.id,
									reason: failureCode(error),
								},
								error,
							);
							// A busy/closing writer is not this item's fault: retry, but never count it toward giving up.
							if (!isTransientStoreError(error)) {
								const key = `inv:${inv.id}`;
								const n = (reconcileFailures.get(key) ?? 0) + 1;
								reconcileFailures.set(key, n);
								if (n >= 5)
									await failOwnerAfterRepeatedFailure(inv.owner_task_id, key);
							}
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
					try {
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
						reconcileFailures.delete(`task:${t.id}`);
					} catch (error) {
						passFailed = true;
						log.warn(
							"agent.reconcile_item_failed",
							{
								runId: t.root_run_id,
								taskId: t.id,
								reason: failureCode(error),
							},
							error,
						);
						if (!isTransientStoreError(error)) {
							const key = `task:${t.id}`;
							const n = (reconcileFailures.get(key) ?? 0) + 1;
							reconcileFailures.set(key, n);
							if (n >= 5) await failOwnerAfterRepeatedFailure(t.id, key);
						}
					}
				if (passFailed) state.consecutiveFailedPasses++;
				else state.consecutiveFailedPasses = 0;
			}
		})().finally(() => {
			state.reconciling = null;
			state.lastPassEnded = now();
			if (state.closed) return;
			try {
				arm();
			} catch (error) {
				log.warn(
					"agent.reconcile_arm_failed",
					{ reason: failureCode(error) },
					error,
				);
			}
			if (state.consecutiveFailedPasses > 0 && !state.retryTimer) {
				const backoff = Math.min(
					30_000,
					250 * 2 ** (state.consecutiveFailedPasses - 1),
				);
				state.retryTimer = setTimeout(() => {
					state.retryTimer = null;
					schedule();
				}, backoff);
				state.retryTimer.unref();
			}
			if (state.dirty) schedule();
		});
		return state.reconciling;
	}
	function arm() {
		if (state.timer) clearTimeout(state.timer);
		if (state.closed) return;
		const deadline = store.read(
			(db) =>
				db
					.query(
						"SELECT MIN(deadline) AS deadline FROM agent_tasks WHERE state NOT IN ('completed','failed','cancelled','interrupted')",
					)
					.get() as { deadline: number | null },
		);
		if (deadline.deadline !== null) {
			state.timer = setTimeout(
				schedule,
				Math.max(1, deadline.deadline - now()),
			);
			state.timer.unref();
		}
	}
	const stop = store.onCommit(schedule);
	return { schedule, reconcile, stop };
}
export type Reconcile = ReturnType<typeof createReconcile>;
