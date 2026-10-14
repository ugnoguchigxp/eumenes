import type { Database } from "bun:sqlite";
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

export const dispatchOf = (run: RunRow): KanbanDispatch => ({
	runId: run.id,
	cardId: run.cardId,
	kind: run.kind,
	claudeSessionId: run.claudeSessionId,
	target: run.kind === "task" ? "new" : "conversation",
	mode: run.kind === "commit_push" ? "commit" : "work",
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
	): boolean {
		if (getQueue(tx).state === "paused") return false;
		setQueue(tx, { state: "paused", reason });
		bumpBoard(tx);
		notify(
			tx,
			"queue_paused",
			noticeText("queue_paused", "", QUEUE_PAUSED_TEXT[reason]),
		);
		return true;
	}

	/** Hands the oldest waiting run over when the queue runs and no run is in progress. */
	function nextDispatch(tx: Database): KanbanDispatch | undefined {
		if (getQueue(tx).state === "paused" || handedRuns(tx).length > 0)
			return undefined;
		const next = oldestWaiting(tx);
		if (!next) return undefined;
		transitionRun(tx, next.id, ["waiting_turn"], {
			state: "handed",
			handedAt: now(),
		});
		bumpBoard(tx);
		return dispatchOf({ ...next, state: "handed" });
	}

	return { notify, pauseQueue, nextDispatch };
}
export type Queue = ReturnType<typeof createQueue>;
