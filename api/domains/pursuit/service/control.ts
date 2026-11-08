import type { Database } from "bun:sqlite";
import { z } from "zod";
import { executionControl, type TaskLifecyclePort } from "../../tool-runtime";
import { active, save, stateOf } from "../repository";
import { current, type Context } from "./context";
import { end, stopChildren } from "./lifecycle";
import { viewInTransaction } from "./view";

export function controls(
	ctx: Context,
): TaskLifecyclePort["controlInTransaction"] {
	return (
		db: Database,
		conversationId: string,
		raw: unknown,
		messageId: string,
	) => {
		const input = executionControl.parse(raw),
			row = current(ctx, db, input.workRef, undefined, true);
		if (row.conversation_id !== conversationId)
			throw new Error("pursuit_conversation_mismatch");
		if (input.action === "status") return viewInTransaction(db, row.id)!;
		if (input.expectedRevision !== row.revision)
			throw new Error("execution_revision_conflict");
		if (!active(row)) throw new Error("execution_terminal");
		const state = stateOf(row),
			control = ctx
				.source()
				.controlSourceInTransaction(
					db,
					conversationId,
					messageId,
					state.source,
				);
		if (!control) throw new Error("pursuit_control_source_invalid");
		if (input.action === "cancel")
			end(ctx, db, row, "cancelled", "pursuit_user_cancelled");
		else {
			if (row.deadline <= ctx.now())
				throw new Error("pursuit_deadline_exceeded");
			if (input.action === "answer") {
				const view = viewInTransaction(db, row.id)!;
				if (
					row.state !== "waiting_user" ||
					view.question?.id !== input.questionRef
				)
					throw new Error("pursuit_question_stale");
				const answer = z
					.strictObject({ answer: z.string().trim().min(1).max(8000) })
					.parse(input.input);
				state.command = {
					kind: "answer",
					consultationId: input.questionRef!,
					text: answer.answer,
				};
				state.source.responses = [...(state.source.responses ?? []), control];
			} else {
				if (!input.request || row.epoch >= state.limits.parentCalls)
					throw new Error("pursuit_amendment_invalid");
				stopChildren(ctx, db, row);
				// A new immutable goal/acceptance epoch; spent calls and the original deadline remain.
				row.epoch++;
				row.core_id = null;
				state.request = input.request;
				state.draft = null;
				state.snapshots = {};
				state.result = null;
				delete state.publication;
				delete state.command;
				state.source.amendments = [...(state.source.amendments ?? []), control];
			}
			// A superseded question/result must not be delivered by a queued notice.
			const notices = db
				.query(
					"SELECT id FROM pursuit_notices WHERE run_id=? AND state IN ('pending','accepted')",
				)
				.all(row.id) as Array<{ id: string }>;
			for (const n of notices)
				ctx.source().revokeDeliveryInTransaction?.(db, n.id);
			db.query(
				"UPDATE pursuit_notices SET state='revoked' WHERE run_id=? AND state IN ('pending','accepted')",
			).run(row.id);
			row.state = "queued";
			ctx.enqueue(db, row);
			save(db, row, state, ctx.now());
		}
		return viewInTransaction(db, row.id)!;
	};
}
