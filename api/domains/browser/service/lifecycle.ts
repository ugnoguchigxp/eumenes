import type { Database } from "bun:sqlite";
import {
	activeCaptureStates,
	activeTaskStates,
	errorLabel,
	type TerminalTaskState,
} from "../contracts";
import {
	activeCaptures,
	activeTasks,
	captureRow,
	clearLeases,
	endTaskApprovals,
	hasIndeterminateOperation,
	inFlightOperations,
	patchCapture,
	patchTask,
	revokeGrants,
	taskRow,
	transitionOperation,
	type CaptureRow,
	type TaskRow,
} from "../repository";
import type { Ctx } from "./context";

export function announce(
	ctx: Ctx,
	db: Database,
	id: string,
	conversationId: string,
	message: string,
) {
	ctx.announce(db, {
		id,
		conversationId,
		message,
		at: new Date(ctx.now()).toISOString(),
	});
}

function taskMessage(
	r: TaskRow,
	state: TerminalTaskState,
	text: string | null,
) {
	switch (state) {
		case "completed":
			return text || "ブラウザの操作が完了しました。";
		case "needs_input":
			return text || "ブラウザの操作を続けるには、確認が必要です。";
		case "failed":
			return `ブラウザの操作を完了できませんでした（${errorLabel(r.error_code) ?? "失敗"}）。`;
		case "expired":
			return "ブラウザの操作が時間切れになりました。";
		case "indeterminate":
			return "ブラウザの操作が実行されたか確認できません。同じ操作は自動では繰り返しません。ページを画面で確認してください。";
		case "cancelled":
			return null;
	}
}

/**
 * Ends a running task once: the epoch moves so late work is refused, leases, grants and open approvals go
 * with it, and the conversation hears about it after commit. Whatever the page and the user's input left in
 * the ledgers is erased: the saved core state (unless the runner passes a light end state), typed values and
 * approval values. Returns null when the task had already ended.
 */
export function finishTask(
	ctx: Ctx,
	db: Database,
	id: string,
	state: TerminalTaskState,
	code: string | null,
	text: string | null,
	coreStateJson?: string | null,
) {
	const r = taskRow(db, id);
	if (!r || !activeTaskStates.includes(r.state)) return null;
	const now = ctx.now();
	const row = patchTask(
		db,
		id,
		{
			state,
			epoch: r.epoch + 1,
			error_code: code,
			result_text: text,
			core_state_json: coreStateJson ?? null,
		},
		now,
	);
	for (const c of activeCaptures(db))
		if (c.task_id === id)
			finishCapture(
				ctx,
				db,
				c.id,
				state === "cancelled"
					? "cancelled"
					: state === "expired"
						? "expired"
						: "failed",
				state === "cancelled" ? null : (code ?? "task_not_active"),
			);
	clearLeases(db, id, now);
	revokeGrants(db, id, now);
	endTaskApprovals(db, id, now);
	db.query(
		"UPDATE browser_operations SET state='failed', error_code='task_ended', updated_at=? WHERE task_id=? AND state='prepared'",
	).run(now, id);
	const message = taskMessage(row, state, text);
	if (message && row.origin === "conversation" && !row.announced) {
		patchTask(db, id, { announced: 1 }, now);
		announce(
			ctx,
			db,
			`browser-task:${id}:${state}`,
			row.conversation_id,
			message,
		);
	}
	return row;
}

/** Ends an active capture once; the epoch moves so a stage still running is refused when it settles. */
export function finishCapture(
	ctx: Ctx,
	db: Database,
	id: string,
	state: "failed" | "cancelled" | "expired",
	code: string | null,
) {
	const r = captureRow(db, id);
	if (!r || !activeCaptureStates.includes(r.state)) return null;
	const now = ctx.now();
	clearLeases(db, `capture:${id}`, now);
	const row = patchCapture(
		db,
		id,
		{ state, epoch: r.epoch + 1, error_code: code, temp_ref: null },
		now,
	);
	if (row.origin === "conversation" && !row.task_id && state !== "cancelled") {
		patchCapture(db, id, { announced: 1 }, now);
		announce(
			ctx,
			db,
			`browser-capture:${id}:${state}`,
			row.conversation_id,
			state === "expired"
				? "撮影が時間切れになりました。"
				: `撮影できませんでした（${errorLabel(code) ?? "失敗"}）。`,
		);
	}
	return row;
}

export function readyNotice(ctx: Ctx, db: Database, r: CaptureRow) {
	if (r.origin !== "conversation" || r.task_id || r.announced) return;
	patchCapture(db, r.id, { announced: 1 }, ctx.now());
	announce(
		ctx,
		db,
		`browser-capture:${r.id}:local_ready`,
		r.conversation_id,
		"ブラウザの画像を保存しました。画面で確認できます。",
	);
}

/**
 * The browser is gone (disconnect, Brave closed, backend restart): whatever was in flight may or may not have
 * reached the page. Operations become indeterminate, their tasks stop as indeterminate, the rest fail as lost.
 */
export function settleLostConnection(ctx: Ctx, db: Database) {
	const now = ctx.now();
	for (const op of inFlightOperations(db))
		transitionOperation(
			db,
			op.id,
			["prepared", "dispatched"],
			"indeterminate",
			{ errorCode: "browser_disconnected" },
			now,
		);
	for (const t of activeTasks(db)) {
		const unsure = hasIndeterminateOperation(db, t.id);
		finishTask(
			ctx,
			db,
			t.id,
			unsure ? "indeterminate" : "failed",
			unsure ? "operation_indeterminate" : "browser_disconnected",
			null,
		);
	}
	for (const c of activeCaptures(db))
		finishCapture(ctx, db, c.id, "failed", "browser_disconnected");
}
