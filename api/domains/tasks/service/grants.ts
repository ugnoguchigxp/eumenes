import type { Database } from "bun:sqlite";
import { amendTaskSchema, taskOriginSchema } from "../contracts";
import * as repo from "../repository";
import type { TrustedTaskContext } from "../types";
import type { TaskCore } from "./core";
import { iso, manual, syncHook, terminal } from "./helpers";
import type { createTaskLifecycle } from "./lifecycle";

/** Grant amendment: restriction detection, runtime budget adjustment and the stop it may trigger. */
export function createTaskGrants(
	core: TaskCore,
	lifecycle: ReturnType<typeof createTaskLifecycle>,
) {
	const { now, kindFor, requireTask, revision, record, once } = core;
	const { settleStopInTransaction } = lifecycle;
	function amendGrantInTransaction(
		tx: Database,
		taskId: string,
		input: unknown,
		context: TrustedTaskContext = manual,
	) {
		const parsed = amendTaskSchema.safeParse(input);
		if (!parsed.success || !taskOriginSchema.safeParse(context.origin).success)
			throw new Error("invalid_task_input");
		let restriction = false;
		return once(
			tx,
			parsed.data.requestId,
			{ op: "amend", taskId, ...parsed.data, origin: context.origin },
			() => {
				const t = requireTask(tx, taskId);
				revision(t, parsed.data.expectedRevision);
				if (terminal(t.state) || ["stopping", "reconciling"].includes(t.state))
					throw new Error("task_state_conflict");
				if ((t.kind === "coding") !== "workspaceId" in parsed.data.grant)
					throw new Error("invalid_task_input");
				if (
					t.kind === "orchestration" &&
					"connectionRef" in parsed.data.grant &&
					(t.grant.connectionRef !== parsed.data.grant.connectionRef ||
						t.grant.projectRef !== parsed.data.grant.projectRef)
				)
					throw new Error("invalid_task_input");
				const previous = structuredClone(t);
				const before = t.grant,
					after = parsed.data.grant;
				restriction =
					"workspaceId" in before &&
					"workspaceId" in after &&
					after.workspaceId === before.workspaceId &&
					after.branch === before.branch &&
					after.remote === before.remote &&
					after.operations.every((op) => before.operations.includes(op)) &&
					(after.network === before.network || after.network === "none") &&
					Date.parse(after.expiresAt) <= Date.parse(before.expiresAt) &&
					after.maxRuntimeMs <= before.maxRuntimeMs &&
					after.maxDecisions <= before.maxDecisions &&
					(after.operations.length < before.operations.length ||
						after.network !== before.network ||
						Date.parse(after.expiresAt) < Date.parse(before.expiresAt) ||
						after.maxRuntimeMs < before.maxRuntimeMs ||
						after.maxDecisions < before.maxDecisions);
				if (t.executionDeadlineAt !== null) {
					const deadline = Date.parse(t.executionDeadlineAt);
					if (deadline <= now()) throw new Error("task_runtime_expired");
					// Only an explicit grant change adjusts the budget, anchored to the first start.
					t.executionDeadlineAt = iso(
						deadline + parsed.data.grant.maxRuntimeMs - t.grant.maxRuntimeMs,
					);
				}
				if (t.kind === "coding" && "workspaceId" in after) t.grant = after;
				else if (t.kind === "orchestration" && "connectionRef" in after)
					t.grant = after;
				else throw new Error("invalid_task_input");
				if (Date.parse(t.grant.expiresAt) <= now())
					throw new Error("task_grant_expired");
				const budgetExpired =
					t.executionDeadlineAt !== null &&
					Date.parse(t.executionDeadlineAt) <= now();
				t.authorityEpoch++;
				repo.grant(tx, t, context.origin);
				const q = repo.openQuestion(tx, taskId);
				if (q) repo.putQuestion(tx, { ...q, state: "superseded" });
				if (
					budgetExpired ||
					["queued", "active", "waiting_user"].includes(t.state)
				) {
					t.state = "stopping";
					t.stopIntent = budgetExpired ? "cancel" : "pause";
				}
				record(tx, t, "grant_amended");
				syncHook(kindFor(t)?.amendInTransaction?.(tx, previous, t));
				if (t.state === "stopping") {
					const executionStopped =
						previous.state === "paused" || t.executionGeneration === 0;
					syncHook(kindFor(t)?.stopInTransaction(tx, t, { executionStopped }));
					if (executionStopped)
						settleStopInTransaction(tx, {
							taskId: t.id,
							expectedRevision: t.revision,
							authorityEpoch: t.authorityEpoch,
							executionGeneration: t.executionGeneration,
						});
				}
				return requireTask(tx, t.id);
			},
			() => !restriction,
		);
	}
	return { amendGrantInTransaction };
}
