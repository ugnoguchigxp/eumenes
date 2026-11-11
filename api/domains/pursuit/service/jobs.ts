import { z } from "zod";
import type { StepResult, ToolOutcome } from "eumenes-pursuit";
import { current, type Context } from "./context";
import { core, operationKey } from "./core";
import { active, pendingWeb, rowOf, save, stateOf } from "../repository";
import { end, stopChildren } from "./lifecycle";
import { finalResult } from "./view";
import { queueDecision, registerDecision } from "./decision";

const payload = z.strictObject({
	id: z.uuid(),
	epoch: z.int().min(0),
	step: z.int().min(1),
	receiptOnly: z.literal(true).optional(),
});
type Payload = z.infer<typeof payload>;
type Completed = {
	status: string;
	pending: boolean;
	completed: boolean;
	pendingDecision?: string;
};
export function registerJobs(ctx: Context) {
	registerDecision(ctx);
	ctx.queue.registerHandler<Payload, Payload, Completed>({
		kind: "pursuit.step",
		payloadVersions: [1],
		schema: payload,
		recovery: "replay_safe",
		prepareInTransaction(db, claim) {
			const row = rowOf(db, claim.payload.id);
			if (
				!row ||
				!active(row) ||
				row.epoch !== claim.payload.epoch ||
				row.job_id !== claim.jobId
			)
				return { status: "stale", reason: "pursuit_run_stale" };
			// A host execution is one engine step; the core may record several internal transitions in it.
			if (row.step > stateOf(row).limits.parentCalls) {
				row.job_id = null;
				end(
					ctx,
					db,
					row,
					stateOf(row).draft ? "partial" : "failed",
					"pursuit_step_budget_exceeded",
				);
				return { status: "stale", reason: "pursuit_step_budget_exceeded" };
			}
			if (row.deadline <= ctx.now()) {
				row.job_id = null;
				end(
					ctx,
					db,
					row,
					stateOf(row).draft ? "partial" : "failed",
					"pursuit_deadline_exceeded",
				);
				return { status: "stale", reason: "pursuit_deadline_exceeded" };
			}
			try {
				current(ctx, db, row.id, row.epoch);
			} catch {
				ctx.forget(db, row.id);
				return { status: "stale", reason: "pursuit_source_invalid" };
			}
			row.state = "deciding";
			save(db, row, stateOf(row), ctx.now());
			return { status: "ready", input: claim.payload };
		},
		async execute(input, execution) {
			const { id, epoch } = input,
				{ engine, runtime, startInput } = core(ctx, id, epoch);
			const started = await engine.start(startInput, operationKey(id, epoch));
			await ctx.store.write((db) => {
				const row = current(ctx, db, id, epoch),
					state = stateOf(row);
				if (row.core_id && row.core_id !== started.pursuitId)
					throw new Error("pursuit_core_mismatch");
				row.core_id = started.pursuitId;
				if (!state.coreIds.includes(started.pursuitId))
					state.coreIds.push(started.pursuitId);
				save(db, row, state, ctx.now());
			});
			const next = ctx.store.readSnapshot((db) => {
				const row = current(ctx, db, id, epoch);
				const state = stateOf(row);
				return {
					command: state.command,
					operation: pendingWeb(db, row).find((o) => o.outcome_json),
					decision: state.decision,
				};
			});
			const productive = startInput.conditions.execution === "productive";
			if (input.receiptOnly && (!productive || next.command || !next.operation))
				throw new Error("pursuit_tool_receipt_missing");
			let step: StepResult;
			if (next.command) {
				step = await engine.answer(
					started.pursuitId,
					next.command.consultationId,
					next.command.text,
				);
				await ctx.store.write((db) => {
					const row = current(ctx, db, id, epoch),
						state = stateOf(row);
					delete state.command;
					save(db, row, state, ctx.now());
				});
			} else if (next.operation) {
				const op = next.operation;
				step = await engine.completeTool(
					started.pursuitId,
					op.attempt_id,
					op.id,
					JSON.parse(op.outcome_json!) as ToolOutcome,
					runtime,
					execution.signal,
				);
				await ctx.store.write((db) => {
					current(ctx, db, id, epoch);
					db.query(
						"UPDATE pursuit_web_operations SET adopted=1 WHERE id=? AND adopted=0",
					).run(op.id);
				});
			} else if (next.decision?.response || next.decision?.errorCode) {
				const decision = next.decision;
				step = decision.response
					? await engine.completeDecision(
							started.pursuitId,
							decision.operationId,
							decision.response,
							runtime,
							execution.signal,
						)
					: await engine.cancel(
							started.pursuitId,
							`進捗判断の受領に失敗しました（${decision.errorCode}）`,
							runtime,
							execution.signal,
						);
				await ctx.store.write((db) => {
					const row = current(ctx, db, id, epoch);
					const state = stateOf(row);
					if (state.decision?.operationId !== decision.operationId)
						throw new Error("pursuit_decision_conflict");
					delete state.decision;
					save(db, row, state, ctx.now());
				});
			} else
				step = await engine.step(started.pursuitId, runtime, execution.signal);
			let view = await engine.view(started.pursuitId);
			if (!view) throw new Error("pursuit_core_missing");
			if (
				productive &&
				!input.receiptOnly &&
				view.report?.verificationIssue &&
				!execution.signal.aborted
			) {
				await engine.reverify(started.pursuitId, runtime, execution.signal);
				view = (await engine.view(started.pursuitId))!;
			}
			return {
				status: view.status,
				pending:
					step.workReady !== undefined
						? !step.workReady
						: view.attempts.some(
								(a) => a.state === "started" && a.pendingOperationId !== null,
							),
				pendingDecision: step.pendingDecision?.operationId,
				completed:
					view.status === "completed" &&
					view.report?.outcome === "completed" &&
					view.report.verified,
			};
		},
		settleInTransaction(db, claim, _input, outcome) {
			const row = rowOf(db, claim.payload.id);
			if (
				!row?.data_json ||
				!active(row) ||
				row.epoch !== claim.payload.epoch ||
				row.job_id !== claim.jobId
			)
				return "stale";
			if (row.deadline <= ctx.now()) {
				row.job_id = null;
				end(
					ctx,
					db,
					row,
					stateOf(row).draft ? "partial" : "failed",
					"pursuit_deadline_exceeded",
				);
				return "applied";
			}
			try {
				current(ctx, db, row.id, row.epoch);
			} catch {
				ctx.forget(db, row.id);
				return "stale";
			}
			if (outcome.type !== "success") {
				row.job_id = null;
				const state = stateOf(row);
				if (
					outcome.type === "interrupted" &&
					state.execution === "productive" &&
					(!row.active_request || claim.payload.receiptOnly || state.decision)
				) {
					row.state = "queued";
					ctx.enqueue(db, row);
					save(db, row, state, ctx.now());
					return "applied";
				}
				end(
					ctx,
					db,
					row,
					stateOf(row).draft ? "partial" : "failed",
					outcome.type === "failed" ||
						outcome.type === "interrupted" ||
						outcome.type === "retry"
						? outcome.errorCode
						: "pursuit_job_expired",
				);
				return "applied";
			}
			const result = outcome.result,
				state = stateOf(row);
			row.job_id = null;
			if (["completed", "incomplete", "stopped"].includes(result.status)) {
				if (state.execution === "productive") stopChildren(ctx, db, row);
				delete state.decision;
				row.state =
					result.completed && state.draft?.completion === "complete"
						? "completed"
						: "partial";
				state.result = finalResult(db, row);
				save(db, row, state, ctx.now());
				ctx.notice(db, row);
			} else if (result.status === "awaiting_consultation") {
				row.state = "waiting_user";
				save(db, row, state, ctx.now());
				ctx.notice(db, row);
			} else {
				if (result.pendingDecision)
					queueDecision(ctx, db, row, state, result.pendingDecision);
				const webReady = pendingWeb(db, row).some(
					(op) => op.outcome_json !== null,
				);
				const ready =
					!result.pending ||
					state.decision?.response ||
					state.decision?.errorCode ||
					webReady;
				row.state = ready ? "queued" : "waiting_child";
				if (ready)
					ctx.enqueue(db, row, webReady && state.execution === "productive");
				save(db, row, state, ctx.now());
			}
			return "applied";
		},
		cancelInTransaction() {
			/* The owner changes authority before requesting Queue cancellation. */
		},
	});
}
