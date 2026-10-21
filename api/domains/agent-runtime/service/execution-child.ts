import type { HandlerDefinition } from "../../queue";
import type { ChildExecution, ChildResult } from "../../tool-runtime";
import { CHILD_STEP, type ExecutionContext } from "./execution-context";
import { executionPayload } from "./execution-step";
import type { ExecutionOps } from "./execution-store";

export function executionChild(
	ctx: ExecutionContext,
	ops: ExecutionOps,
): HandlerDefinition<
	{ id: string; epoch: number; ordinal: number },
	{ child: ChildExecution; prepared: unknown },
	ChildResult
> {
	return {
		kind: CHILD_STEP,
		payloadVersions: [1],
		schema: executionPayload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const active = ops.active(
				db,
				claim.payload.id,
				claim.payload.epoch,
				claim.payload.ordinal,
			);
			if (!active?.state.pending || active.row.state !== "waiting_child")
				return { status: "stale", reason: "execution_changed" };
			const child = active.state.pending.child;
			return {
				status: "ready",
				input: { child, prepared: ctx.port().prepareInTransaction(db, child) },
			};
		},
		execute: (input, { signal }) =>
			ctx.port().execute(input.prepared, input.child, signal),
		classify: () => "fail",
		settleInTransaction(db, claim, input, outcome) {
			const active = ops.active(
				db,
				claim.payload.id,
				claim.payload.epoch,
				claim.payload.ordinal,
			);
			if (!active) return "stale";
			if (outcome.type === "success") {
				db.exec("SAVEPOINT execution_child_adoption");
				try {
					ops.adoptChild(db, active.row, active.state, outcome.result);
					db.exec("RELEASE execution_child_adoption");
				} catch {
					db.exec("ROLLBACK TO execution_child_adoption");
					db.exec("RELEASE execution_child_adoption");
					const current = ops.active(
						db,
						claim.payload.id,
						claim.payload.epoch,
						claim.payload.ordinal,
					);
					if (current)
						ops.fail(
							db,
							current.row,
							current.state,
							"execution_child_result_rejected",
						);
				}
			} else
				ops.fail(
					db,
					active.row,
					active.state,
					"errorCode" in outcome ? outcome.errorCode : "execution_child_failed",
				);
			return "applied";
		},
		cancelInTransaction(db, job, reason) {
			const active = ops.active(
				db,
				job.payload.id,
				job.payload.epoch,
				job.payload.ordinal,
			);
			if (active) ops.fail(db, active.row, active.state, reason, "interrupted");
		},
	};
}
