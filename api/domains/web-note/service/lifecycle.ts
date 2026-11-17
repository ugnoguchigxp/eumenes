import type { Database } from "bun:sqlite";
import type { ExecutionResult, ExecutionView } from "../../tool-runtime";
import type { HostState } from "../contracts";
import { active, rowOf, save, stateOf, type RunRow } from "../repository";
import type { Context } from "./context";
import { failedResult } from "./note";

// The conversation message contract limits visual replies to 32,768 characters.
const DISPLAY_LIMIT = 32_768;

function conversationResult(state: HostState): ExecutionResult | null {
	const { result, source } = state;
	if (
		state.inspection ||
		source.origin ||
		!source.messageId ||
		result?.status !== "completed" ||
		!result.answer
	)
		return result;

	const markdown = `## ${result.title}\n\n${result.answer}`;
	if (markdown.length <= DISPLAY_LIMIT)
		return { ...result, replyInConversation: true, displayAnswer: markdown };

	const sources = (result.sources ?? [])
		.map(({ url }) => `- <${url}>`)
		.join("\n");
	const summary = `## ${result.title}\n\n${result.summary}\n\n全文は調査記録に保存しました。`;
	const withSources = sources
		? `${summary}\n\n### 出典\n\n${sources}`
		: summary;
	return {
		...result,
		replyInConversation: true,
		displayAnswer: withSources.length <= DISPLAY_LIMIT ? withSources : summary,
	};
}

export const viewOf = (row: RunRow, state: HostState): ExecutionView => ({
	id: row.id,
	conversationId: row.conversation_id,
	request: state.request,
	revision: row.revision,
	status: row.state,
	deadline: row.deadline,
	question: null,
	result: conversationResult(state),
});
export function viewInTransaction(
	db: Database,
	id: string,
): ExecutionView | null {
	const row = rowOf(db, id);
	return row?.data_json ? viewOf(row, stateOf(row)) : null;
}
/** The run, with the authority it was started under still holding. */
export function current(
	ctx: Context,
	db: Database,
	id: string,
	terminal = false,
): RunRow {
	const row = rowOf(db, id);
	if (!row?.data_json || (!terminal && !active(row)))
		throw new Error("web_note_run_stale");
	const state = stateOf(row);
	if (!ctx.source().validSourceInTransaction(db, state.source))
		throw new Error("web_note_source_invalid");
	if (
		ctx.capabilities.toolchainBindingInTransaction(
			db,
			state.toolchainRevisionId,
		)?.binding.revisionId !== state.bindingRevisionId
	)
		throw new Error("web_note_capability_revoked");
	if (!terminal && row.deadline <= ctx.now())
		throw new Error("web_note_deadline_exceeded");
	return row;
}
/** Hands the finished run's notice to the conversation (an agency run is read from the ledger instead). */
function announce(
	ctx: Context,
	db: Database,
	row: RunRow,
	view: ExecutionView,
) {
	row.notice = "pending";
	const delivered = ctx
		.source()
		.deliverInTransaction(db, view, `web-note:${row.id}`);
	row.notice = delivered ? "delivered" : "accepted";
}
export function finish(
	ctx: Context,
	db: Database,
	row: RunRow,
	status: ExecutionResult["status"],
	result: ExecutionResult,
) {
	if (row.job_id) {
		ctx.queue.cancelInTransaction(db, row.job_id, "web_note_finished");
		ctx.abortJobs.add(row.job_id);
	}
	row.job_id = null;
	row.state = status as RunRow["state"];
	const state = stateOf(row);
	state.result = result;
	// The view is the one `save` is about to store.
	announce(ctx, db, row, { ...viewOf(row, state), revision: row.revision + 1 });
	save(db, row, state, ctx.now());
}
export function end(
	ctx: Context,
	db: Database,
	row: RunRow,
	status: "failed" | "cancelled" | "interrupted",
	code: string,
) {
	const result = failedResult(status, code);
	if (status !== "cancelled" && stateOf(row).inspection) {
		result.title = "ソース調査";
		result.summary = "今回は表示できる抜粋がありません。";
		result.answer = result.summary;
		result.replyInConversation = true;
		result.displayAnswer = `**一部抜粋**\n\n${result.summary}`;
		result.status = "partial";
	}
	finish(ctx, db, row, result.status, result);
}
export function forget(ctx: Context, db: Database, id: string) {
	const row = rowOf(db, id);
	if (!row?.data_json) return;
	if (row.job_id) {
		ctx.queue.cancelInTransaction(db, row.job_id, "web_note_forgotten");
		ctx.abortJobs.add(row.job_id);
	}
	if (row.notice !== "none")
		ctx.source().revokeDeliveryInTransaction?.(db, `web-note:${id}`);
	db.query(
		"UPDATE web_note_runs SET data_json=NULL,job_id=NULL,notice='none',state='cancelled',revision=revision+1,updated_at=? WHERE id=?",
	).run(ctx.now(), id);
}
/** Runs that lost their job or passed their deadline end; notices not yet delivered are handed on again. */
export function reconcile(ctx: Context, db: Database) {
	const rows = db
		.query("SELECT * FROM web_note_runs WHERE data_json IS NOT NULL")
		.all() as RunRow[];
	for (const row of rows) {
		if (active(row)) {
			try {
				current(ctx, db, row.id, true);
			} catch {
				forget(ctx, db, row.id);
				continue;
			}
			if (row.deadline <= ctx.now()) {
				end(ctx, db, row, "failed", "web_note_deadline_exceeded");
				continue;
			}
			const job = row.job_id
				? ctx.queue.getInTransaction(db, row.job_id)
				: null;
			if (!job || !["queued", "running", "retry_wait"].includes(job.state))
				end(ctx, db, row, "failed", job?.errorCode ?? "web_note_job_lost");
		} else if (row.notice === "pending" || row.notice === "accepted") {
			const view = viewInTransaction(db, row.id);
			if (!view) continue;
			if (row.notice === "pending") announce(ctx, db, row, view);
			else {
				const status = ctx
					.source()
					.deliveryStateInTransaction?.(db, `web-note:${row.id}`);
				if (status === "delivered" || status === "failed")
					row.notice = "delivered";
			}
			save(db, row, stateOf(row), ctx.now());
		}
	}
}
