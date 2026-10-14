import type { Database } from "bun:sqlite";
import type {
	BlockerReason,
	KanbanCardRefInput,
	KanbanDispatch,
	KanbanFollowupInput,
	KanbanOperationContext,
	KanbanQueueReceipt,
	KanbanRunFinish,
	NoticeKind,
	QueueState,
	RunKind,
} from "./contracts";
import { hasConversation } from "./board";
import type { Applied, Core, KanbanOutcome } from "./core";
import { bumpBoard, getCard, updateCard, type CardRow } from "./repository";
import {
	getQueue,
	getRun,
	handedRuns,
	insertNotice,
	insertRun,
	oldestWaiting,
	setQueue,
	setStopRequested,
	stopRequestedIds,
	transitionRun,
	type RunRow,
} from "./runs-repository";
import {
	BLOCKER_TEXT,
	blockerReason,
	commitPushBody,
	followupBody,
	noticeText,
	pausesQueue,
	QUEUE_PAUSED_TEXT,
	quietReason,
	taskBody,
} from "./text";

/** How the application cancels a request that terminals has not sent yet. */
export type CancelUnsent = (runId: string) => boolean;

const dispatchOf = (run: RunRow): KanbanDispatch => ({
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

const mergeFiles = (a: readonly string[], b: readonly string[]): string[] =>
	[...new Set([...a, ...b])].slice(0, 200);

/**
 * Runs and the single execution queue (plan §3.6, §3.8): one run is handed to terminals at a time
 * and the next only after it reached a final state. Every function runs inside the caller's
 * writer transaction; the application hands the returned `KanbanDispatch` to terminals in it.
 */
export function createRuns(core: Core) {
	const { now, newId, operate, target, receiptOf, appendToColumn } = core;

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

	const action = (kind: RunKind) =>
		kind === "task" ? "run" : kind === "followup" ? "followup" : "commit_push";

	/** Creates a run for the card, puts the card in `running` and hands over what is ready. */
	function startRun(
		tx: Database,
		card: CardRow,
		kind: RunKind,
		body: string,
		context: KanbanOperationContext,
		claudeSessionId: string,
	): Applied {
		const at = now();
		const run: Omit<RunRow, "seq"> = {
			id: newId(),
			cardId: card.id,
			kind,
			state: "waiting_turn",
			reason: null,
			cardRevision: card.revision,
			title: card.title,
			prompt: card.prompt,
			body,
			claudeSessionId,
			projectId: card.projectId,
			origin: context.origin,
			conversationId: context.conversationId ?? null,
			stopRequested: false,
			createdAt: at,
			handedAt: null,
			finishedAt: null,
		};
		insertRun(tx, run);
		const fresh = kind === "task";
		const running: CardRow = {
			...card,
			column: "running",
			label: null,
			reason: null,
			claudeSessionId,
			currentRunId: run.id,
			// A new task starts a new conversation: nothing of the earlier one is carried over.
			...(fresh
				? { reviewed: false, commitPushReported: false, lastReport: null, files: [] }
				: {}),
			revision: card.revision + 1,
			updatedAt: at,
		};
		updateCard(tx, running);
		appendToColumn(tx, running, card.column);
		bumpBoard(tx);
		const dispatch = nextDispatch(tx);
		return { receipt: receiptOf(action(kind), running, run.id), dispatch };
	}

	/** Moves a running card to `finished` with a label (and the run-dependent fields). */
	function finishCard(
		tx: Database,
		card: CardRow,
		change: Partial<CardRow> & Pick<CardRow, "label" | "reason">,
	): CardRow {
		const done: CardRow = {
			...card,
			...change,
			column: "finished",
			revision: card.revision + 1,
			updatedAt: now(),
		};
		updateCard(tx, done);
		appendToColumn(tx, done, card.column);
		bumpBoard(tx);
		return done;
	}

	/** A run that ended without completing: the card becomes a Blocker, the queue may stop. */
	function blockRun(
		tx: Database,
		run: RunRow,
		reason: BlockerReason,
		runState: "blocked" | "cancelled",
	) {
		transitionRun(tx, run.id, ["waiting_turn", "handed"], {
			state: runState,
			reason,
			finishedAt: now(),
		});
		const card = getCard(tx, run.cardId);
		if (card && card.currentRunId === run.id)
			finishCard(tx, card, { label: "blocker", reason });
		if (card && !quietReason(reason))
			notify(
				tx,
				"blocker",
				noticeText("blocker", run.title, BLOCKER_TEXT[reason]),
				card,
				run.id,
			);
		if (pausesQueue(reason))
			pauseQueue(tx, reason === "restarted" ? "restarted" : "tracking_lost");
	}

	function runnable(context: KanbanOperationContext) {
		if (!context.runnable) throw new Error("kanban_not_runnable");
	}
	function idle(card: CardRow) {
		if (card.column === "running") throw new Error("kanban_card_busy");
	}

	function runInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
		context: KanbanOperationContext,
	): KanbanOutcome {
		return operate(tx, requestId, "run", input, () => {
			const card = core.target(tx, input.cardId, input.expectedRevision);
			idle(card);
			runnable(context);
			return startRun(tx, card, "task", taskBody(card.prompt), context, newId());
		});
	}

	function followupInTransaction(
		tx: Database,
		input: KanbanFollowupInput,
		requestId: string,
		context: KanbanOperationContext,
	): KanbanOutcome {
		return operate(tx, requestId, "followup", input, () => {
			const card = core.target(tx, input.cardId, input.expectedRevision);
			idle(card);
			if (card.column !== "finished" || !hasConversation(card))
				throw new Error("kanban_state_invalid");
			runnable(context);
			const body = followupBody({
				title: card.title,
				prompt: card.prompt,
				lastReport: card.lastReport,
				note: input.note,
			});
			return startRun(tx, card, "followup", body, context, card.claudeSessionId!);
		});
	}

	/** Commit & push exists only as the board's button; a conversation cannot create it. */
	function commitPushInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
		context: KanbanOperationContext,
	): KanbanOutcome {
		return operate(tx, requestId, "commit_push", input, () => {
			if (context.origin !== "board")
				throw new Error("commit_push_requires_board");
			const card = core.target(tx, input.cardId, input.expectedRevision);
			idle(card);
			if (card.label !== "done" || !card.claudeSessionId)
				throw new Error("kanban_state_invalid");
			runnable(context);
			return startRun(
				tx,
				card,
				"commit_push",
				commitPushBody(card),
				context,
				card.claudeSessionId,
			);
		});
	}

	/** The card's run that is not final yet. */
	function openRun(tx: Database, card: CardRow): RunRow {
		const run = card.currentRunId ? getRun(tx, card.currentRunId) : null;
		if (
			card.column !== "running" ||
			!run ||
			(run.state !== "waiting_turn" && run.state !== "handed")
		)
			throw new Error("kanban_state_invalid");
		return run;
	}

	/** Cancels a run that was not sent (queue-waiting, or handed but still unsent). */
	function cancelRun(tx: Database, run: RunRow): Applied {
		blockRun(tx, run, "cancelled", "cancelled");
		const card = getCard(tx, run.cardId)!;
		return {
			receipt: receiptOf("cancelled", card, run.id),
			dispatch: nextDispatch(tx),
		};
	}

	function cancelInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
		cancelUnsent: CancelUnsent,
	): KanbanOutcome {
		return operate(tx, requestId, "cancel", input, () => {
			const card = core.target(tx, input.cardId, input.expectedRevision);
			const run = openRun(tx, card);
			// Sent runs cannot be cancelled: they are stopped.
			if (run.state === "handed" && !cancelUnsent(run.id))
				throw new Error("kanban_card_busy");
			return cancelRun(tx, run);
		});
	}

	/**
	 * Marks a sent run to be stopped; the application then ends its process and the run becomes a
	 * Blocker when terminals writes the final state. An unsent run is cancelled instead.
	 */
	function stopInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
		cancelUnsent: CancelUnsent,
	): KanbanOutcome {
		return operate(tx, requestId, "stop", input, () => {
			const card = core.target(tx, input.cardId, input.expectedRevision);
			const run = openRun(tx, card);
			if (run.state === "waiting_turn" || cancelUnsent(run.id))
				return cancelRun(tx, run);
			setStopRequested(tx, run.id, true);
			bumpBoard(tx);
			return { receipt: receiptOf("stop_requested", card, run.id) };
		});
	}

	/** Runs whose stop was asked for and not carried out yet. */
	const pendingStops = (tx: Database) => stopRequestedIds(tx);

	/** The process of a stopped run could not be confirmed to be gone: the queue stops. */
	function stopUnconfirmed(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (!run || run.state !== "handed") return;
		setStopRequested(tx, runId, false);
		pauseQueue(tx, "stop_unconfirmed");
		bumpBoard(tx);
	}

	function resumeQueueInTransaction(
		tx: Database,
		requestId: string,
	): KanbanOutcome<KanbanQueueReceipt> {
		return operate<KanbanQueueReceipt>(tx, requestId, "resume_queue", {}, () => {
			if (getQueue(tx).state === "paused") {
				setQueue(tx, { state: "running" });
				bumpBoard(tx);
			}
			return {
				receipt: { action: "queue_resumed", queue: "running" },
				dispatch: nextDispatch(tx),
			};
		});
	}

	/**
	 * A terminals request reached a final state. Only the card's current run changes the card; the
	 * notice is saved with it; the queue moves on unless it was stopped. Returns what to hand over
	 * next, or null when this is not a handed-over run of this board.
	 */
	function finishRunInTransaction(
		tx: Database,
		finish: KanbanRunFinish,
	): { dispatch?: KanbanDispatch } | null {
		const run = getRun(tx, finish.runId);
		if (!run || run.state !== "handed") return null;
		if (finish.state === "completed") {
			transitionRun(tx, run.id, ["handed"], {
				state: "completed",
				finishedAt: now(),
			});
			const card = getCard(tx, run.cardId);
			if (card && card.currentRunId === run.id) {
				const report = finish.lastReport || card.lastReport;
				const changed =
					run.kind === "commit_push"
						? { commitPushReported: true }
						: {
								reviewed: false,
								commitPushReported: false,
								files:
									run.kind === "task"
										? [...finish.files]
										: mergeFiles(card.files, finish.files),
							};
				finishCard(tx, card, {
					label: "done",
					reason: null,
					lastReport: report,
					...changed,
				});
				const kind = run.kind === "commit_push" ? "commit_push" : "done";
				notify(tx, kind, noticeText(kind, run.title), card, run.id);
			}
		} else {
			blockRun(
				tx,
				run,
				blockerReason(finish),
				finish.state === "cancelled" ? "cancelled" : "blocked",
			);
		}
		bumpBoard(tx);
		return { dispatch: nextDispatch(tx) };
	}

	/**
	 * Handing the run to terminals failed in the transaction that was to do it (tracking became
	 * unavailable): the run is blocked and the queue stops.
	 */
	function dispatchFailedInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (run?.state === "handed") blockRun(tx, run, "send_failed", "blocked");
		pauseQueue(tx, "tracking_lost");
	}

	/** The run's request waits for the person's permission (once per run). */
	function waitingInTransaction(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (run?.state !== "handed") return;
		const card = getCard(tx, run.cardId);
		if (card)
			notify(tx, "waiting", noticeText("waiting", run.title), card, run.id);
	}

	return {
		runInTransaction,
		followupInTransaction,
		commitPushInTransaction,
		cancelInTransaction,
		stopInTransaction,
		resumeQueueInTransaction,
		finishRunInTransaction,
		dispatchFailedInTransaction,
		waitingInTransaction,
		pauseQueueInTransaction: pauseQueue,
		pendingStops,
		stopUnconfirmed,
	};
}
