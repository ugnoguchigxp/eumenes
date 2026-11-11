import type { Database } from "bun:sqlite";
import { findPursuitByOperation, forgetPursuit } from "eumenes-pursuit/sqlite";
import { active, rowOf, save, stateOf, type RunRow } from "../repository";
import { current, type Context } from "./context";
import { finalResult, viewInTransaction } from "./view";
import { operationKey } from "./core";

export function stopChildren(
	ctx: Context,
	db: Database,
	row: RunRow,
	forget = false,
) {
	const state = stateOf(row),
		publication = state.publication;
	const documents = forget
		? new Set([
				...(state.documentIds ?? []),
				...(publication ? [publication.id] : []),
			])
		: new Set(publication ? [publication.id] : []);
	for (const id of documents)
		ctx.documents?.cancelInTransaction(db, id, forget);
	if (row.job_id) {
		ctx.queue.cancelInTransaction(db, row.job_id, "pursuit_stopped");
		ctx.abortJobs.add(row.job_id);
	}
	if (state.decision) {
		ctx.queue.cancelInTransaction(db, state.decision.jobId, "pursuit_stopped");
		ctx.abortJobs.add(state.decision.jobId);
	}
	if (row.active_request) {
		ctx.inference.cancelRequestsInTransaction?.(db, [row.active_request]);
		ctx.abortRequests.add(row.active_request);
	}
	const operations = db
		.query(
			"SELECT external_id,job_id FROM pursuit_web_operations WHERE run_id=?",
		)
		.all(row.id) as Array<{ external_id: string; job_id: string }>;
	for (const op of operations) {
		if (forget) ctx.web.forgetInTransaction(db, op.external_id);
		else ctx.web.cancelInTransaction(db, op.external_id);
		ctx.abortJobs.add(op.job_id);
	}
	row.job_id = row.active_request = null;
}
export function end(
	ctx: Context,
	db: Database,
	row: RunRow,
	status: "failed" | "partial" | "cancelled",
	code: string,
) {
	stopChildren(ctx, db, row);
	row.state = status;
	row.step++;
	const state = stateOf(row);
	delete state.decision;
	state.result = finalResult(db, row, code);
	save(db, row, state, ctx.now());
	ctx.notice(db, row);
}
export function forget(ctx: Context, db: Database, id: string) {
	const row = rowOf(db, id);
	if (!row?.data_json) return;
	const state = stateOf(row);
	stopChildren(ctx, db, row, true);
	const cores = new Set(state.coreIds);
	// Core.start and host correspondence use separate transactions. Close that crash window too.
	for (let epoch = 0; epoch <= row.epoch; epoch++) {
		const orphan = findPursuitByOperation(db, operationKey(id, epoch));
		if (orphan) cores.add(orphan);
	}
	for (const core of cores) forgetPursuit(db, core, ctx.now());
	const notices = db
		.query("SELECT id FROM pursuit_notices WHERE run_id=?")
		.all(id) as Array<{
		id: string;
	}>;
	for (const notice of notices)
		ctx.source().revokeDeliveryInTransaction?.(db, notice.id);
	for (const table of [
		"pursuit_documents",
		"pursuit_web_operations",
		"pursuit_notices",
	])
		db.query(`DELETE FROM ${table} WHERE run_id=?`).run(id);
	db.query(
		"UPDATE pursuit_runs SET data_json=NULL,core_id=NULL,job_id=NULL,active_request=NULL,state='cancelled',revision=revision+1,updated_at=? WHERE id=?",
	).run(ctx.now(), id);
}
export function notice(ctx: Context, db: Database, row: RunRow) {
	const existing = db
		.query(
			"SELECT id FROM pursuit_notices WHERE run_id=? AND epoch=? AND ordinal=?",
		)
		.get(row.id, row.epoch, row.step);
	if (!existing)
		db.query(
			"INSERT INTO pursuit_notices(id,run_id,epoch,ordinal,state) VALUES (?,?,?,?,'pending')",
		).run(ctx.id(), row.id, row.epoch, row.step);
}
export function reconcile(ctx: Context, db: Database, recovering = false) {
	const rows = db
		.query("SELECT * FROM pursuit_runs WHERE data_json IS NOT NULL")
		.all() as RunRow[];
	for (const candidate of rows) {
		let row: RunRow;
		try {
			row = current(ctx, db, candidate.id, undefined, true);
		} catch {
			ctx.forget(db, candidate.id);
			continue;
		}
		const state = stateOf(row);
		if (!active(row) || state.publication) continue;
		if (row.deadline <= ctx.now()) {
			end(
				ctx,
				db,
				row,
				state.draft ? "partial" : "failed",
				"pursuit_deadline_exceeded",
			);
			continue;
		}
		if (row.state === "waiting_child" && !row.job_id && state.decision) {
			const job = ctx.queue.getInTransaction(db, state.decision.jobId);
			if (
				!job ||
				!["queued", "running", "retry_wait", "cancel_requested"].includes(
					job.state,
				)
			) {
				if (!state.decision.response)
					state.decision.errorCode ??=
						job?.errorCode ?? "pursuit_decision_job_lost";
				row.state = "queued";
				ctx.enqueue(db, row);
				save(db, row, state, ctx.now());
				continue;
			}
		}
		if (
			recovering &&
			row.state !== "waiting_user" &&
			row.state !== "waiting_child"
		) {
			row.state = "queued";
			ctx.enqueue(db, row);
			save(db, row, state, ctx.now());
		} else if (["queued", "deciding"].includes(row.state) && row.job_id) {
			const job = ctx.queue.getInTransaction(db, row.job_id);
			if (!job || !["queued", "running", "retry_wait"].includes(job.state))
				end(
					ctx,
					db,
					row,
					state.draft ? "partial" : "failed",
					job?.errorCode ?? "pursuit_job_lost",
				);
		}
	}
	const notices = db
		.query(
			"SELECT * FROM pursuit_notices WHERE state IN ('pending','accepted')",
		)
		.all() as Array<{
		id: string;
		run_id: string;
		epoch: number;
		state: string;
	}>;
	for (const n of notices) {
		const row = rowOf(db, n.run_id),
			view =
				row && row.epoch === n.epoch ? viewInTransaction(db, row.id) : null;
		if (!view) {
			ctx.source().revokeDeliveryInTransaction?.(db, n.id);
			db.query("DELETE FROM pursuit_notices WHERE id=?").run(n.id);
			continue;
		}
		if (n.state === "pending") {
			const delivered = ctx.source().deliverInTransaction(db, view, n.id);
			db.query("UPDATE pursuit_notices SET state=? WHERE id=?").run(
				delivered ? "delivered" : "accepted",
				n.id,
			);
		} else {
			const status = ctx.source().deliveryStateInTransaction?.(db, n.id);
			if (status === "delivered" || status === "failed")
				db.query("UPDATE pursuit_notices SET state=? WHERE id=?").run(
					status,
					n.id,
				);
		}
	}
}
