import type { Database } from "bun:sqlite";
import {
	DEFAULT_EXECUTOR_ID,
	OPEN_RUN_STATES,
	ACTIVE_RUN_STATES,
} from "../contracts/shared";
import type {
	KanbanCardRefInput,
	KanbanFollowupInput,
	KanbanOperationContext,
	KanbanQueueReceipt,
	RunKind,
	KanbanGitGrant,
} from "../contracts";
import { hasConversation } from "./board";
import type { Applied, Core, KanbanOutcome } from "./core";
import { createQueue } from "./queue";
import { bumpBoard, getCard, updateCard, type CardRow } from "../repository";
import {
	getQueue,
	getRun,
	insertRun,
	setQueue,
	setStopRequested,
	stopRequestedIds,
	type RunRow,
} from "../repository/runs";
import { createSettle } from "./settle";
import { commitPushBody, followupBody, taskBody } from "./text";

/** How the application cancels a request that terminals has not sent yet. */
export type CancelUnsent = (runId: string) => boolean;

/**
 * Runs and the single execution queue (plan §3.6, §3.8): one run is handed to terminals at a time
 * and the next only after it reached a final state. Every function runs inside the caller's
 * writer transaction; the application hands the returned `KanbanDispatch` to terminals in it.
 */
export function createRuns(core: Core) {
	const { now, newId, operate, receiptOf, appendToColumn } = core;
	const queue = createQueue(core);
	const { pauseQueue, nextDispatch } = queue;
	const { blockRun, ...settled } = createSettle(core, queue);

	const action = (kind: RunKind) =>
		kind === "task" ? "run" : kind === "followup" ? "followup" : kind;

	/** Creates a run for the card, puts the card in `running` and hands over what is ready. */
	function startRun(
		tx: Database,
		card: CardRow,
		kind: RunKind,
		body: string,
		context: KanbanOperationContext,
		claudeSessionId: string,
		git?: KanbanGitGrant,
	): Applied {
		const at = now();
		const executor = core.executor(card.executorId);
		if (!executor.available) throw new Error("kanban_executor_unavailable");
		const sessionRef =
			executor.sessionPolicy === "host-created"
				? claudeSessionId
				: kind === "task"
					? null
					: card.sessionRef;
		const legacySessionId =
			executor.sessionPolicy === "host-created" ? claudeSessionId : "";
		const run: Omit<RunRow, "seq"> = {
			id: newId(),
			cardId: card.id,
			executorId: executor.id,
			executorRevision: executor.revision,
			workspaceRef: executor.workspaceRef,
			sessionRef,
			executionStopped: false,
			attemptRef: null,
			kind,
			state: "queued",
			reason: null,
			cardRevision: card.revision,
			title: card.title,
			prompt: card.prompt,
			body,
			claudeSessionId: legacySessionId,
			projectId: card.projectId,
			origin: context.origin,
			conversationId: context.conversationId ?? null,
			stopRequested: false,
			createdAt: at,
			handedAt: null,
			finishedAt: null,
		};
		insertRun(tx, run);
		if (git)
			tx.query("INSERT INTO kanban_run_git_grants VALUES(?,?)").run(
				run.id,
				JSON.stringify(git),
			);
		const fresh = kind === "task";
		const running: CardRow = {
			...card,
			column: "running",
			label: null,
			reason: null,
			claudeSessionId: legacySessionId || null,
			sessionRef,
			currentRunId: run.id,
			// A new task starts a new conversation: nothing of the earlier one is carried over.
			...(fresh
				? {
						reviewed: false,
						commitPushReported: false,
						lastReport: null,
						files: [],
					}
				: {}),
			revision: card.revision + 1,
			updatedAt: at,
		};
		updateCard(tx, running);
		appendToColumn(tx, running, card.column);
		bumpBoard(tx);
		const dispatch = nextDispatch(tx, executor.id);
		return { receipt: receiptOf(action(kind), running, run.id), dispatch };
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
			return startRun(
				tx,
				card,
				"task",
				taskBody(card.prompt),
				context,
				newId(),
			);
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
			return startRun(
				tx,
				card,
				"followup",
				body,
				context,
				card.claudeSessionId ?? "",
			);
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
			if (card.label !== "done" || !hasConversation(card))
				throw new Error("kanban_state_invalid");
			runnable(context);
			return startRun(
				tx,
				card,
				"commit_push",
				commitPushBody(card),
				context,
				card.claudeSessionId ?? "",
			);
		});
	}

	const gitInTransaction = createGitOperation(core, startRun);

	/** The card's run that is not final yet. */
	function openRun(tx: Database, card: CardRow): RunRow {
		const run = card.currentRunId ? getRun(tx, card.currentRunId) : null;
		if (
			card.column !== "running" ||
			!run ||
			!OPEN_RUN_STATES.includes(run.state)
		)
			throw new Error("kanban_state_invalid");
		return run;
	}

	/** Cancels a run that was not sent (queue-waiting, or handed but still unsent). */
	function cancelRun(tx: Database, run: RunRow): Applied {
		tx.query("UPDATE kanban_runs SET execution_stopped=1 WHERE id=?").run(
			run.id,
		);
		blockRun(tx, run, "cancelled", "cancelled");
		const card = getCard(tx, run.cardId)!;
		return {
			receipt: receiptOf("cancelled", card, run.id),
			dispatch: nextDispatch(tx, run.executorId),
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
			if (ACTIVE_RUN_STATES.includes(run.state) && !cancelUnsent(run.id))
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
			if (run.state === "queued" || cancelUnsent(run.id))
				return cancelRun(tx, run);
			setStopRequested(tx, run.id, true);
			bumpBoard(tx);
			return { receipt: receiptOf("stop_requested", card, run.id) };
		});
	}

	/** Runs whose stop was asked for and not carried out yet. */
	const pendingStops = (tx: Database, executorId = DEFAULT_EXECUTOR_ID) =>
		stopRequestedIds(tx, executorId);

	/** The process of a stopped run could not be confirmed to be gone: the queue stops. */
	function stopUnconfirmed(tx: Database, runId: string) {
		const run = getRun(tx, runId);
		if (!run || !ACTIVE_RUN_STATES.includes(run.state)) return;
		setStopRequested(tx, runId, false);
		pauseQueue(tx, "stop_unconfirmed", run.executorId);
		bumpBoard(tx);
	}

	function resumeQueueInTransaction(
		tx: Database,
		requestId: string,
		executorId = DEFAULT_EXECUTOR_ID,
	): KanbanOutcome<KanbanQueueReceipt> {
		return operate<KanbanQueueReceipt>(
			tx,
			requestId,
			"resume_queue",
			executorId === DEFAULT_EXECUTOR_ID ? {} : { executorId },
			() => {
				if (getQueue(tx, executorId).state === "paused") {
					setQueue(tx, { state: "running" }, executorId);
					bumpBoard(tx);
				}
				return {
					receipt: { action: "queue_resumed", queue: "running" },
					dispatch: nextDispatch(tx, executorId),
				};
			},
		);
	}

	return {
		...settled,
		dispatchNextInTransaction: nextDispatch,
		runInTransaction,
		followupInTransaction,
		commitPushInTransaction,
		gitInTransaction,
		cancelInTransaction,
		stopInTransaction,
		resumeQueueInTransaction,
		pauseQueueInTransaction: pauseQueue,
		pendingStops,
		stopUnconfirmed,
	};
}

function createGitOperation(
	core: Core,
	startRun: (
		tx: Database,
		card: CardRow,
		kind: RunKind,
		body: string,
		context: KanbanOperationContext,
		sessionId: string,
		git?: KanbanGitGrant,
	) => Applied,
) {
	const { operate, now } = core;
	const idle = (card: CardRow) => {
		if (card.column === "running") throw new Error("kanban_card_busy");
	};
	const runnable = (context: KanbanOperationContext) => {
		if (!context.runnable) throw new Error("kanban_not_runnable");
	};
	return function gitInTransaction(
		tx: Database,
		input: KanbanCardRefInput,
		requestId: string,
		context: KanbanOperationContext,
		grant: KanbanGitGrant,
	): KanbanOutcome {
		return operate(tx, requestId, grant.mode, { ...input, grant }, () => {
			if (context.origin !== "board")
				throw new Error("commit_push_requires_board");
			const card = core.target(tx, input.cardId, input.expectedRevision);
			idle(card);
			runnable(context);
			const executor = core.executor(card.executorId);
			const capability =
				grant.mode === "commit_push" ? "commitPush" : grant.mode;
			if (
				!executor.capabilities[capability] ||
				!hasConversation(card) ||
				card.currentRunId !== grant.sourceRunId ||
				card.column !== "finished" ||
				(grant.mode !== "push" && card.label !== "done") ||
				Date.parse(grant.expiresAt) <= now()
			)
				throw new Error("kanban_git_grant_invalid");
			return startRun(
				tx,
				card,
				grant.mode,
				commitPushBody(card),
				context,
				card.claudeSessionId ?? "",
				grant,
			);
		});
	};
}
