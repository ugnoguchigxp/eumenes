import type { Database } from "bun:sqlite";
import { DEFAULT_EXECUTOR_ID } from "./shared-contracts";
import type { KanbanDispatch, NoticeKind, QueueState } from "./contracts";
import type { Core } from "./core";
import { bumpBoard } from "./repository";
import {
	getQueue,
	handedRuns,
	insertNotice,
	oldestWaiting,
	setQueue,
	transitionRun,
	type RunRow,
} from "./runs-repository";
import { noticeText, QUEUE_PAUSED_TEXT } from "./text";
import { readWorkspaceGuard } from "./workspace-guard";

export const dispatchOf = (run: RunRow): KanbanDispatch => ({
	runId: run.id,
	executorId: run.executorId,
	executorRevision: run.executorRevision,
	workspaceRef: run.workspaceRef,
	sessionRef: run.sessionRef,
	cardId: run.cardId,
	kind: run.kind,
	claudeSessionId: run.claudeSessionId,
	target: run.kind === "task" ? "new" : "conversation",
	mode: ["commit_push", "commit", "push"].includes(run.kind)
		? "commit"
		: "work",
	projectId: run.projectId,
	prompt: run.body,
	task: run.title.slice(0, 40),
	origin: run.origin,
	...(run.conversationId ? { conversationId: run.conversationId } : {}),
});

/**
 * The single execution queue (plan §3.6): one run is handed over at a time, and the next only
 * after it reached a final state and while the queue is not stopped. Notices are saved here too.
 */
export function createQueue(core: Core) {
	const { now, newId } = core;

	function notify(
		tx: Database,
		kind: NoticeKind,
		text: string,
		card?: { id: string },
		runId?: string,
	) {
		insertNotice(tx, {
			id: newId(),
			kind,
			cardId: card?.id ?? null,
			runId: runId ?? null,
			text,
			read: false,
			createdAt: now(),
		});
	}

	/** Pauses the queue (keeping the first reason when already paused). */
	function pauseQueue(
		tx: Database,
		reason: Extract<QueueState, { state: "paused" }>["reason"],
		executorId = DEFAULT_EXECUTOR_ID,
	): boolean {
		if (getQueue(tx, executorId).state === "paused") return false;
		setQueue(tx, { state: "paused", reason }, executorId);
		bumpBoard(tx);
		notify(
			tx,
			"queue_paused",
			noticeText("queue_paused", "", QUEUE_PAUSED_TEXT[reason]),
		);
		return true;
	}

	/** Hands the oldest waiting run over when the queue runs and no run is in progress. */
	function nextDispatch(
		tx: Database,
		executorId = DEFAULT_EXECUTOR_ID,
	): KanbanDispatch | undefined {
		if (
			getQueue(tx, executorId).state === "paused" ||
			handedRuns(tx, executorId).length > 0
		)
			return undefined;
		const next = oldestWaiting(tx, executorId);
		if (!next) return undefined;
		const registered = core.executor(executorId);
		if (!registered.available || registered.revision !== next.executorRevision)
			return undefined;
		const guard = readWorkspaceGuard(tx, next.workspaceRef);
		if (
			guard &&
			(guard.state !== "held" ||
				guard.ownerRef !== `kanban:${next.cardId}` ||
				guard.executorId !== executorId)
		)
			return undefined;
		transitionRun(tx, next.id, ["queued"], {
			state: "dispatched",
			handedAt: now(),
		});
		bumpBoard(tx);
		const dispatch = dispatchOf({ ...next, state: "dispatched" });
		const grant = tx
			.query("SELECT grant_json FROM kanban_run_git_grants WHERE run_id=?")
			.get(next.id) as { grant_json: string } | null;
		if (grant) dispatch.git = JSON.parse(grant.grant_json);
		return dispatch;
	}

	return { notify, pauseQueue, nextDispatch };
}
export type Queue = ReturnType<typeof createQueue>;
