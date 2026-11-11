import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { HostState } from "../contracts";
import { active, rowOf, save, stateOf, type RunRow } from "../repository";
import { current, type Context } from "./context";
import { core } from "./core";
import { model } from "./model";

const payload = z.strictObject({
	id: z.uuid(),
	epoch: z.int().min(0),
	operationId: z.uuid(),
});
type Payload = z.infer<typeof payload>;

export function queueDecision(
	ctx: Context,
	db: Database,
	row: RunRow,
	state: HostState,
	operationId: string,
) {
	if (state.decision?.operationId === operationId) return;
	if (state.decision) throw new Error("pursuit_decision_conflict");
	const { job } = ctx.queue.enqueueInTransaction(db, {
		scope: "pursuit",
		kind: "pursuit.decision",
		dedupeKey: operationId,
		subjectRef: row.id,
		lane: "background",
		deadlineAtMs: row.deadline,
		payload: { id: row.id, epoch: row.epoch, operationId },
		maxAttempts: 1,
	});
	state.decision = { operationId, jobId: job.id };
}

export function registerDecision(ctx: Context) {
	ctx.queue.registerHandler<Payload, Payload & { coreId: string }, void>({
		kind: "pursuit.decision",
		payloadVersions: [1],
		schema: payload,
		recovery: "interrupt",
		resourceKey: "inference.llm",
		prepareInTransaction(db, claim) {
			const { id, epoch, operationId } = claim.payload;
			const row = rowOf(db, id);
			const decision = row?.data_json ? stateOf(row).decision : undefined;
			if (
				!row?.core_id ||
				!active(row) ||
				row.epoch !== epoch ||
				decision?.jobId !== claim.jobId ||
				decision.operationId !== operationId ||
				decision.response ||
				decision.errorCode
			)
				return { status: "stale", reason: "pursuit_decision_not_pending" };
			return {
				status: "ready",
				input: { ...claim.payload, coreId: row.core_id },
			};
		},
		async execute({ id, epoch, coreId, operationId }, { signal }) {
			const { engine } = core(ctx, id, epoch);
			const request = await engine.decisionRequest(coreId, operationId);
			await model(ctx, id, epoch, operationId).complete(request, signal);
		},
		settleInTransaction(db, claim, _input, outcome) {
			const { id, epoch, operationId } = claim.payload;
			const row = rowOf(db, id);
			if (
				!row?.data_json ||
				!active(row) ||
				row.epoch !== epoch ||
				row.deadline <= ctx.now()
			)
				return "stale";
			try {
				current(ctx, db, id, epoch);
			} catch {
				ctx.forget(db, id);
				return "stale";
			}
			const state = stateOf(row);
			const decision = state.decision;
			if (
				decision?.jobId !== claim.jobId ||
				decision.operationId !== operationId
			)
				return "stale";
			if (!decision.response)
				decision.errorCode =
					"errorCode" in outcome
						? outcome.errorCode
						: "pursuit_decision_receipt_missing";
			if (row.state === "waiting_child" && !row.job_id) {
				row.state = "queued";
				ctx.enqueue(db, row);
			}
			save(db, row, state, ctx.now());
			return "applied";
		},
		cancelInTransaction() {
			// The pursuit lifecycle revokes the run before accepting any late result.
		},
	});
}
