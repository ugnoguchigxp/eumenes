import { operationBlock } from "./context-blocks";
import type { ChatMessage } from "./context";
import { z } from "zod";
import { hash } from "../../capabilities";
import { executionNoticeResult } from "../../tool-runtime";
import type { Run } from "../contracts";
import type { Database } from "bun:sqlite";
import type { ExecutionView } from "../../tool-runtime";
import { byRequest } from "../repository";
import type { DialogueDeps } from "./context";
import { endRun } from "./run-end";

/** State is formatted after the control transaction, rather than guessed before it. */
export function executionStatusText(view: ExecutionView) {
	const labels = {
		queued: "受付済みです。",
		deciding: "次の操作を確認しています。",
		waiting_child: "操作の結果を待っています。",
		waiting_user: "確認への回答を待っています。",
		completed: "完了しました。",
		partial: "要求を完了できませんでした。",
		failed: "実行に失敗しました。",
		cancelled: "後続の操作を取り消しました。",
		interrupted: "中断しました。",
	};
	const summary =
		view.result?.summary === view.result?.code
			? undefined
			: view.result?.summary;
	const uncertainty = [
		"operation_stop_unconfirmed",
		"operation_indeterminate",
	].includes(view.result?.code ?? "")
		? "操作を停止できたか確認できていません。"
		: undefined;
	return [labels[view.status], view.question?.prompt ?? uncertainty ?? summary]
		.filter(Boolean)
		.join("\n");
}

/** An unfinished task reports its bounded execution result without another promise-generating inference. */
export function executionStoppedReply(
	view: ExecutionView & { kind: "task_question" | "task_result" },
) {
	if (
		view.kind !== "task_result" ||
		!view.result ||
		!["partial", "failed", "interrupted", "cancelled"].includes(view.status)
	)
		return undefined;
	return executionStatusText(view);
}

/** A forgotten source cannot leave an already queued result answer adoptable. */
export function revokeExecutionNotice(
	deps: DialogueDeps,
	db: Database,
	eventId: string,
) {
	const run = byRequest(db, eventId);
	if (!run || !["queued", "running"].includes(run.status)) return;
	endRun(deps, db, run, "cancelled", "execution_source_forgotten");
	if (run.jobId)
		deps.queue.cancelInTransaction(db, run.jobId, "execution_source_forgotten");
	deps.larm.revokeAgentAttemptsInTransaction?.(db, {
		messageIds: [run.inputMessageId],
		itemIds: [],
		deletedSummaryConversationIds: [],
	});
}

const taskNotice = z.object({
	kind: z.enum(["task_question", "task_result"]),
	workRef: z.uuid(),
	revision: z.number().int().nonnegative(),
	question: z.object({ id: z.uuid() }).nullable(),
	result: z.unknown().nullable(),
});
export type ExecutionNoticeBinding = {
	id: string;
	revision: number;
	questionRef?: string;
	resultHash?: string;
};
type NoticeDeps = Pick<DialogueDeps, "agents" | "conversation" | "clock">;
/** Only host notice runs may supply this protocol. Its current owning work validates every field. */
export function executionNoticeInTransaction(
	deps: NoticeDeps,
	db: Database,
	run: Run,
) {
	if (run.sourceKind !== "notice") return null;
	const text = deps.conversation.messageInTransaction(db, run.inputMessageId)
		?.message.text;
	let raw: unknown;
	try {
		raw = JSON.parse(text ?? "");
	} catch {
		return null;
	}
	const parsed = taskNotice.safeParse(raw);
	if (!parsed.success) return null;
	const n = parsed.data;
	const binding: ExecutionNoticeBinding = {
		id: n.workRef,
		revision: n.revision,
		...(n.kind === "task_question"
			? { questionRef: n.question?.id }
			: { resultHash: hash(n.result) }),
	};
	if (!validExecutionNotice(deps, db, run.conversationId, binding))
		return { stale: true as const };
	return {
		stale: false as const,
		binding,
		data: {
			kind: n.kind,
			...deps.agents!.executions.viewInTransaction(db, n.workRef)!,
		},
	};
}
export function executionNoticeContext(
	notice: ReturnType<typeof executionNoticeInTransaction>,
) {
	return notice && !notice.stale
		? {
				executionNotice: notice.binding,
				executionNoticeReply: executionStoppedReply(notice.data),
			}
		: {};
}
export function validExecutionNotice(
	deps: Pick<DialogueDeps, "agents" | "clock">,
	db: Database,
	conversationId: string,
	binding: ExecutionNoticeBinding,
) {
	const view = deps.agents?.executions.viewInTransaction(db, binding.id);
	if (
		!view ||
		view.conversationId !== conversationId ||
		view.revision !== binding.revision
	)
		return false;
	return binding.questionRef
		? view.status === "waiting_user" &&
				view.question?.id === binding.questionRef &&
				view.question.expiresAt > Date.parse(deps.clock())
		: !!view.result &&
				binding.resultHash === hash(executionNoticeResult(view.result));
}

/** Existing result/question frames keep the notice out of the user's task instructions. */
export function renderExecutionNotice(
	data: ExecutionView & { kind: "task_question" | "task_result" },
	input: ChatMessage,
) {
	return {
		block:
			data.kind === "task_question"
				? operationBlock("operation.command_question", data.question)
				: operationBlock("operation.action", {
						kind: "task_result",
						action: data.status === "failed" ? "failed" : "task",
						status: data.status,
						complete: data.status === "completed",
						...executionNoticeResult(data.result),
					}),
		input: {
			...input,
			content: JSON.stringify({
				kind: data.kind,
				workRef: data.id,
				revision: data.revision,
			}),
		},
	};
}
